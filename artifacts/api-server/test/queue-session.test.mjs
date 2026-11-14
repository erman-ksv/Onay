import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envKeys = ['NODE_ENV', 'TEZJET_STORAGE_ADAPTER', 'SESSION_SECRET', 'REQUIRE_DRIVER_APPROVAL'];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let directory, production;
let sequence = 0;
before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.TEZJET_STORAGE_ADAPTER = 'memory';
  process.env.SESSION_SECRET = 'queue-session-regression-secret-32-characters';
  process.env.REQUIRE_DRIVER_APPROVAL = 'true';
  directory = await mkdtemp(path.join(apiRoot, '.queue-session-test-'));
  const entry = path.join(directory, 'production.mjs');
  await build({
    stdin: { contents: 'export { store } from "./src/store"; export { leaveQueue, updateQueueStatus, updateQueueLocation } from "./src/controllers/queueController";', resolveDir: apiRoot, loader: 'ts' },
    outfile: entry, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    external: ['pg-native', 'pino', 'socket.io'],
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
  production = await import(pathToFileURL(entry).href);
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

// Pause a real controller after its authenticated queue snapshot, then rotate
// the live account session. No store result or mutation is substituted.
for (const operation of ['leaveQueue', 'updateQueueStatus', 'updateQueueLocation']) {
  test(`${operation} cannot mutate the queue after its authenticated session is revoked`, async () => {
    const { store } = production;
    const user = await store.createUser({ role: 'driver', fullName: operation, phoneNumber: '+99890' + String(++sequence).padStart(7, '0'), locale: 'ru' });
    await store.setDriverApproval(user.id, 'approved');
    const driver = structuredClone(await store.getUser(user.id));
    const location = { lat: 41.3111, lng: 69.2797, timestamp: Date.now() };
    await store.joinQueue({ driverId: driver.id, joinedAt: Date.now(), status: 'searching', availableSeats: 3, lastLocation: location, priorityLock: false, inFifo: true }, driver.sessionVersion);
    const before = structuredClone(await store.getQueueEntry(driver.id));
    const getQueueEntry = store.getQueueEntry;
    let release, reached;
    const paused = new Promise(resolve => { reached = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    store.getQueueEntry = async function (id) {
      const value = getQueueEntry.call(this, id);
      reached();
      await resume;
      return value;
    };
    const request = { auth: { userId: driver.id, user: driver, role: 'driver', locale: 'ru' }, body: { status: 'in_transit', location: { ...location, timestamp: location.timestamp + 1 } }, app: { locals: {} } };
    const response = { status() { return this; }, send() {}, json() {} };
    const pending = production[operation](request, response);
    try {
      await paused;
      await store.invalidateSessions(driver.id, driver.sessionVersion);
      release();
      await assert.rejects(pending, { statusCode: 401, code: 'UNAUTHORIZED' });
      assert.deepEqual(await getQueueEntry.call(store, driver.id), before);
    } finally {
      release();
      store.getQueueEntry = getQueueEntry;
      await store.leaveQueue(driver.id);
    }
  });
}
