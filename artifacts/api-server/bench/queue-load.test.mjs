import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { performance } from "node:perf_hooks";

// Use the production HTTP app and adapters. PostgreSQL is mandatory, and
// all application tables are cloned with their real columns/indexes into a private
// schema. No public data is changed and no SQL results are substituted.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `queue_load_${randomUUID().replaceAll("-", "")}`;
const applicationName = `queue-load-${randomUUID()}`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes"];
const envKeys = ["DATABASE_URL", "TEZJET_STORAGE_ADAPTER", "NODE_ENV", "SESSION_SECRET", "LOG_LEVEL", "REQUIRE_DRIVER_APPROVAL", "PYATAK_CENTER_LAT", "PYATAK_CENTER_LNG", "TEZJET_OFFER_TIMEOUT_SECONDS"];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const measurements = [];
let moduleDirectory, production, database, adminPool, store, server, baseUrl;
let schemaCreated = false;

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required: configured-route order regressions must execute real PostgreSQL.");
  const originalUrl = process.env.DATABASE_URL;
  const isolatedUrl = new URL(originalUrl);
  isolatedUrl.searchParams.set("options", `${isolatedUrl.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
  isolatedUrl.searchParams.set("application_name", applicationName);
  process.env.DATABASE_URL = isolatedUrl.href;
  process.env.TEZJET_STORAGE_ADAPTER = "postgres";
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET = "driver-route-regression-secret-at-least-32-characters";
  process.env.LOG_LEVEL = "silent";
  process.env.REQUIRE_DRIVER_APPROVAL = "true";
  delete process.env.TEZJET_OFFER_TIMEOUT_SECONDS;
  process.env.PYATAK_CENTER_LAT = "41.3111";
  process.env.PYATAK_CENTER_LNG = "69.2797";
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".queue-load-test-"));
  const entry = path.join(moduleDirectory, "production.mjs");
  await build({
    stdin: {
      contents: [
        'export { default as app } from "./src/app";',
        'export { PostgresStore } from "./src/store/postgresStore";',
        'export { MemoryStore } from "./src/store/memoryStore";',
        'export { pool } from "../../lib/db/src/index";',
        'export { store as runtimeStore } from "./src/store";',
        'export { createAccessToken } from "./src/utils/token";',
      ].join("\n"),
      resolveDir: apiRoot, loader: "ts",
    },
    outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["pg-native", "pino", "pino-http", "socket.io"],
    banner: { js: 'import { createRequire as testCreateRequire } from "node:module"; const require = testCreateRequire(import.meta.url);' },
  });
  production = await import(pathToFileURL(entry).href);
  database = production.pool;
  adminPool = new database.constructor({ connectionString: originalUrl, max: 4 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  for (const table of tables) {
    await adminPool.query(`CREATE TABLE "${schema}"."${table}" (LIKE "public"."${table}" INCLUDING ALL)`);
  }
  store = new production.PostgresStore();
  assert.ok(production.runtimeStore instanceof production.PostgresStore, "The HTTP app must use the actual durable adapter.");
  await Promise.all([store.initialize(), production.runtimeStore.initialize()]);
  server = await new Promise(resolve => {
    const listener = production.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
}, { timeout: 30_000 });

after(async () => {
  try {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (database) await database.end();
    if (schemaCreated && adminPool) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    if (adminPool) await adminPool.end();
    if (moduleDirectory) await rm(moduleDirectory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

async function parallel(items, action, concurrency = 20) {
  const results = new Array(items.length); let cursor = 0;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (cursor < items.length) { const index = cursor++; results[index] = await action(items[index], index); }
  }));
  const failure = settled.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
}

async function request(pathname, token, method = 'GET', body, requestKey) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${pathname}`, {
    method, signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(requestKey ? { 'idempotency-key': requestKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = { status: response.status, body: await response.json() };
  measurements.push({ milliseconds: performance.now() - started, status: response.status });
  return result;
}

function summary(samples, durationMs) {
  const times = samples.map(sample => sample.milliseconds).sort((a, b) => a - b);
  const percentile = p => Number(times[Math.min(times.length - 1, Math.ceil(times.length * p) - 1)].toFixed(2));
  return { requests: samples.length, durationMs: Number(durationMs.toFixed(2)), requestsPerSecond: Number((samples.length * 1000 / durationMs).toFixed(2)),
    latencyMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: percentile(1) },
    statusCounts: samples.reduce((counts, sample) => { counts[sample.status] = (counts[sample.status] ?? 0) + 1; return counts; }, {}) };
}

test('bounded HTTP load preserves FIFO, one offer per driver, idempotency and seat accounting', { timeout: 120000 }, async t => {
  const report = { status: 'running', environment: 'isolated CI PostgreSQL schema / loopback HTTP', drivers: 20, passengers: 80,
    maxConcurrency: 20, serverInstances: 1, productionCapacityClaim: false, phases: [] };
  const output = path.join(apiRoot, 'artifacts/queue-load');
  await mkdir(output, { recursive: true });
  async function phase(name, action) {
    const offset = measurements.length, started = performance.now();
    const result = await action();
    report.phases.push({ name, ...summary(measurements.slice(offset), performance.now() - started) });
    return result;
  }
  try {
    const empty = await store.createRoute({ id: `load-${randomUUID()}`, name: 'Synthetic load route', active: true, pricePerStopKzt: 500 });
    const route = await store.updateRouteLayout(empty.id, { expectedUpdatedAt: empty.updatedAt,
      stops: [{ code: 'A', name: 'Synthetic A', location: { lat: 42.9, lng: 71.3 } }, { code: 'B', name: 'Synthetic B', location: { lat: 42.94, lng: 71.43 } }],
      pitaks: { aStopCode: 'A', bStopCode: 'B', radiusMeters: 175 } });
    const selection = { route_id: route.id, direction: 'a_to_b', expected_updated_at: route.updatedAt };
    const atA = () => ({ ...route.stops[0].location, timestamp: Date.now() });
    async function user(role) {
      let value = await store.createUser({ role, fullName: 'Synthetic load fixture', phoneNumber: `load-${randomUUID()}`, locale: 'ru' });
      if (role === 'driver') { await store.setDriverApproval(value.id, 'approved'); value = await store.getUser(value.id); }
      return { id: value.id, token: production.createAccessToken({ sub: value.id, role, locale: 'ru', sessionVersion: value.sessionVersion, sessionId: randomUUID() }), key: randomUUID() };
    }
    const drivers = await parallel(Array.from({ length: 20 }), () => user('driver'), 5);
    const passengers = await parallel(Array.from({ length: 80 }), () => user('passenger'), 5);
    const tokensByDriver = new Map(drivers.map(driver => [driver.id, driver.token]));
    await phase('driver-queue-enrollment', async () => {
      // Sequential enrollment establishes a deterministic FIFO before concurrent bookings.
      for (const [index, driver] of drivers.entries()) {
        const planned = await request('/driver/route', driver.token, 'PUT', selection); assert.equal(planned.status, 200);
        const joined = await request('/queue/join', driver.token, 'POST', { route_choice: selection, location: atA(), available_seats: 4 });
        assert.equal(joined.status, 201);
        await store.updateQueueEntry(driver.id, { joinedAt: index + 1 });
      }
    });
    await phase('concurrent-availability', () => parallel(Array.from({ length: 120 }), async (_, index) => {
      const result = await request(`/orders/route/availability?${new URLSearchParams({ ...selection, seats: '2' })}`, passengers[index % passengers.length].token);
      assert.equal(result.status, 200); assert.equal(result.body.eligible_driver_count, 20);
    }));
    const body = () => ({ ...selection, pickup_location: atA(), seats: 2 });
    const created = [];
    await phase('concurrent-order-saturation', async () => {
      const first = await request('/orders/route', passengers[0].token, 'POST', body(), passengers[0].key);
      assert.equal(first.status, 201); assert.equal(first.body.order.offered_driver_id, drivers[0].id, 'The first queued driver must receive the first offer.');
      created.push({ passenger: passengers[0], order: first.body.order });
      await parallel(passengers.slice(1), async passenger => {
        const result = await request('/orders/route', passenger.token, 'POST', body(), passenger.key);
        if (result.status === 201) created.push({ passenger, order: result.body.order });
        else { assert.equal(result.status, 409); assert.equal(result.body.error.code, 'NO_DRIVERS'); }
      });
      assert.equal(created.length, 20, 'Exactly one pending offer per eligible driver.');
      assert.equal(new Set(created.map(item => item.order.offered_driver_id)).size, 20);
      for (const driver of drivers) {
        const entry = await store.getQueueEntry(driver.id);
        assert.equal(entry.availableSeats, 2); assert.ok(entry.pendingOfferOrderId);
      }
      assert.equal((await store.listOrders()).length, 20, 'Refused bookings must not create searching orders.');
    });
    await phase('concurrent-idempotent-retries', () => parallel(created.flatMap(item => [item, item]), async ({ passenger, order }) => {
      const result = await request('/orders/route', passenger.token, 'POST', body(), passenger.key);
      assert.equal(result.status, 200); assert.equal(result.body.order.id, order.id); assert.equal(result.body.replayed, true);
    }));
    await phase('concurrent-driver-acceptance', () => parallel(created, async ({ order }) => {
      const result = await request(`/orders/${order.id}/accept`, tokensByDriver.get(order.offered_driver_id), 'POST');
      assert.equal(result.status, 200);
    }));
    await phase('concurrent-duplicate-cancellations', async () => {
      const outcomes = await parallel(created.flatMap(item => [item, item]), async item => ({ id: item.order.id,
        result: await request(`/orders/${item.order.id}/cancel`, item.passenger.token, 'POST') }));
      for (const { order } of created) {
        const statuses = outcomes.filter(item => item.id === order.id).map(item => item.result.status).sort();
        assert.deepEqual(statuses, [200, 409], 'Only one cancellation may commit.');
      }
    });
    for (const driver of drivers) {
      const entry = await store.getQueueEntry(driver.id);
      assert.equal(entry.availableSeats, 4, 'Every reservation must be released exactly once.');
      assert.equal(entry.pendingOfferOrderId, undefined); assert.deepEqual(entry.activeOrderIds, []);
    }
    const orders = await store.listOrders();
    assert.equal(orders.length, 20); assert.ok(orders.every(order => order.status === 'cancelled'));
    assert.ok(measurements.every(sample => sample.status < 500));
    report.status = 'passed'; report.requests = measurements.length;
    t.diagnostic(JSON.stringify(report));
  } catch (error) { report.status = 'failed'; report.reasonCode = 'QUEUE_LOAD_INVARIANT_FAILED'; throw error; }
  finally { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
});


