import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Use the production HTTP app and adapters. PostgreSQL is mandatory, and
// all application tables are cloned with their real columns/indexes into a private
// schema. No public data is changed and no SQL results are substituted.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `admin_cancel_${randomUUID().replaceAll("-", "")}`;
const applicationName = `admin-cancel-${randomUUID()}`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes"];
const envKeys = ["DATABASE_URL", "TEZJET_STORAGE_ADAPTER", "NODE_ENV", "SESSION_SECRET", "LOG_LEVEL", "REQUIRE_DRIVER_APPROVAL", "PYATAK_CENTER_LAT", "PYATAK_CENTER_LNG", "TEZJET_OFFER_TIMEOUT_SECONDS"];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let moduleDirectory, production, database, adminPool, store, otherStore, server, baseUrl;
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
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".admin-cancel-test-"));
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
  // Execute the actual migration in this schema, including append-only triggers.
  await database.query(await readFile(new URL('../../../lib/db/drizzle/0009_admin_audit_events.sql', import.meta.url), 'utf8'));
  await database.query(await readFile(new URL('../../../lib/db/drizzle/0010_driver_approval_audit.sql', import.meta.url), 'utf8'));
  store = new production.PostgresStore();
  otherStore = new production.PostgresStore();
  assert.ok(production.runtimeStore instanceof production.PostgresStore, "The HTTP app must use the actual durable adapter.");
  await Promise.all([store.initialize(), otherStore.initialize(), production.runtimeStore.initialize()]);
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

const location = { lat: 41.3111, lng: 69.2797, timestamp: 1 };
const stops = [{ id: 'cancel-c', code: 'C', name: 'C', position: 1, sequence: 1 }, { id: 'cancel-d', code: 'D', name: 'D', position: 2, sequence: 2 }];
const fare = { currency: 'KZT', routeId: 'pyatak', pickupStop: stops[0], destinationStop: stops[1], pickupPosition: 1, destinationPosition: 2,
  distanceStops: 1, pricePerStopKzt: 500, minimumFareApplied: false, stops, totalKzt: 500, calculatedAt: new Date(0).toISOString() };
async function fixture(t, adapter = store) {
  const users = [], orders = [];
  if (adapter instanceof production.PostgresStore) t.after(async () => {
    await database.query('DELETE FROM tezjet_orders WHERE id = ANY($1::text[])', [orders]);
    await database.query('DELETE FROM tezjet_driver_queue WHERE driver_id = ANY($1::text[])', [users]);
    await database.query('DELETE FROM tezjet_users WHERE id = ANY($1::text[])', [users]);
  });
  async function user(role) {
    let value = await adapter.createUser({ role, fullName: 'Admin cancellation fixture', phoneNumber: `cancel-${randomUUID()}`, locale: 'ru' }); users.push(value.id);
    if (role === 'driver') { await adapter.setDriverApproval(value.id, 'approved'); value = await adapter.getUser(value.id); }
    return { ...value, token: production.createAccessToken({ sub: value.id, role, locale: 'ru', sessionVersion: value.sessionVersion, sessionId: randomUUID() }) };
  }
  const admin = await user('admin'), passenger = await user('passenger'), driver = await user('driver');
  await adapter.joinQueue({ driverId: driver.id, joinedAt: 1, status: 'searching', availableSeats: 4, lastLocation: location, priorityLock: false, inFifo: true, activeOrderIds: [] });
  const initial = await adapter.createOrder({ passengerId: passenger.id, passengerPhone: passenger.phoneNumber, pickupPoint: 'C', pickupLocation: location,
    routeStops: stops, fare, destination: 'D', seats: 2, status: 'searching' }); orders.push(initial.id);
  const offered = await adapter.dispatchOrderOffer(initial.id);
  assert.equal(offered.order.offeredDriverId, driver.id);
  return { adapter, admin, passenger, driver, order: offered.order };
}
async function request(id, token, body = { expected_status: 'searching' }) {
  const response = await fetch(`${baseUrl}/admin/orders/${id}/cancel`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
async function unchanged(f) {
  assert.equal((await f.adapter.getOrder(f.order.id)).status, 'searching');
  const entry = await f.adapter.getQueueEntry(f.driver.id); assert.equal(entry.availableSeats, 2); assert.equal(entry.pendingOfferOrderId, f.order.id);
}
async function released(f) {
  const order = await f.adapter.getOrder(f.order.id), entry = await f.adapter.getQueueEntry(f.driver.id);
  assert.equal(order.status, 'cancelled'); assert.equal(entry.availableSeats, 4); assert.equal(entry.pendingOfferOrderId, undefined); assert.deepEqual(entry.activeOrderIds, []);
}

test('HTTP administrator cancellation rejects anonymous/passenger/driver and validates the observed state', async t => {
  const f = await fixture(t);
  assert.equal((await request(f.order.id)).status, 401);
  for (const actor of [f.passenger, f.driver]) assert.equal((await request(f.order.id, actor.token)).status, 403);
  for (const body of [{}, { expected_status: 'bad' }, { expected_status: 'searching', seats: 8 }]) assert.equal((await request(f.order.id, f.admin.token, body)).status, 400);
  assert.equal((await request(f.order.id, f.admin.token, { expected_status: 'in_transit' })).status, 409);
  assert.equal((await request(randomUUID(), f.admin.token)).status, 404);
  await unchanged(f);
  const result = await request(f.order.id, f.admin.token); assert.equal(result.status, 200); assert.equal(result.body.order.status, 'cancelled');
  assert.equal((await store.getOrder(f.order.id)).cancelledBy, f.admin.id); await released(f);
  assert.equal((await request(f.order.id, f.admin.token)).status, 409); await released(f);
  assert.equal((await store.listAdminAuditEvents(f.order.id)).length, 1);
});

for (const label of ['PostgreSQL', 'Memory']) {
  const adapter = () => label === 'PostgreSQL' ? store : new production.MemoryStore();
  test(`${label} administrator cancellation rechecks role and session, without granting generic transitions`, async t => {
    const f = await fixture(t, adapter());
    for (const actor of [f.driver, f.passenger]) await assert.rejects(Promise.resolve().then(() => f.adapter.cancelOrderAsAdmin(f.order.id, actor.id, 'searching', actor.sessionVersion)), error => error.code === 'FORBIDDEN');
    assert.equal(await f.adapter.transitionOrder(f.order.id, f.admin.id, 'cancelled', 'searching', f.admin.sessionVersion), undefined);
    await f.adapter.invalidateSessions(f.admin.id);
    await assert.rejects(Promise.resolve().then(() => f.adapter.cancelOrderAsAdmin(f.order.id, f.admin.id, 'searching', f.admin.sessionVersion)), error => error.code === 'UNAUTHORIZED');
    await unchanged(f);
    assert.deepEqual(await f.adapter.listAdminAuditEvents(f.order.id), []);
  });
  test(`${label} administrator cancellation releases pending, assigned and in-transit seats exactly once`, async t => {
    for (const status of ['searching', 'en_route_to_c', 'in_transit', 'completed']) await t.test(status, async child => {
      const f = await fixture(child, adapter());
      if (status !== 'searching') await f.adapter.acceptOrderOffer(f.order.id, f.driver.id, Date.now(), f.driver.sessionVersion);
      if (status === 'in_transit' || status === 'completed') {
        await f.adapter.transitionOrder(f.order.id, f.driver.id, 'arrived_at_c', 'en_route_to_c', f.driver.sessionVersion);
        await f.adapter.transitionOrder(f.order.id, f.driver.id, 'in_transit', 'arrived_at_c', f.driver.sessionVersion);
      }
      if (status === 'completed') {
        await f.adapter.transitionOrder(f.order.id, f.driver.id, 'completed', 'in_transit', f.driver.sessionVersion);
        assert.equal(await f.adapter.cancelOrderAsAdmin(f.order.id, f.admin.id, status, f.admin.sessionVersion), undefined);
        assert.equal((await f.adapter.getOrder(f.order.id)).status, 'completed');
        assert.equal((await f.adapter.getQueueEntry(f.driver.id)).availableSeats, 4); return;
      }
      assert.ok(await f.adapter.cancelOrderAsAdmin(f.order.id, f.admin.id, status, f.admin.sessionVersion));
      assert.equal(await f.adapter.cancelOrderAsAdmin(f.order.id, f.admin.id, status, f.admin.sessionVersion), undefined);
      assert.equal((await f.adapter.getOrder(f.order.id)).cancelledBy, f.admin.id); await released(f);
      const events = await f.adapter.listAdminAuditEvents(f.order.id);
      assert.equal(events.length, 1); assert.equal(events[0].actorId, f.admin.id); assert.equal(events[0].fromStatus, status);
      assert.equal(events[0].toStatus, 'cancelled'); assert.equal(events[0].action, 'order.cancelled');
      events[0].actorId = 'mutated-client-copy';
      assert.equal((await f.adapter.listAdminAuditEvents(f.order.id))[0].actorId, f.admin.id);
    });
  });
}

async function waitForLocks(count) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await adminPool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [applicationName]);
    if (rows[0].count >= count) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Expected actual PostgreSQL row-lock waiters');
}
test('PostgreSQL overlapping administrator/passenger cancellation commits only once', async t => {
  const f = await fixture(t), blocker = await adminPool.connect(); let pending;
  try {
    await blocker.query('BEGIN'); await blocker.query(`SELECT id FROM "${schema}".tezjet_orders WHERE id=$1 FOR UPDATE`, [f.order.id]);
    pending = Promise.allSettled([
      store.cancelOrderAsAdmin(f.order.id, f.admin.id, 'searching', f.admin.sessionVersion),
      otherStore.cancelOrderAsAdmin(f.order.id, f.admin.id, 'searching', f.admin.sessionVersion),
      store.transitionOrder(f.order.id, f.passenger.id, 'cancelled', 'searching', f.passenger.sessionVersion),
    ]);
    await waitForLocks(3); await blocker.query('COMMIT');
    const outcomes = await pending; assert.ok(outcomes.every(result => result.status === 'fulfilled'));
    assert.equal(outcomes.filter(result => result.value).length, 1); await released(f);
    const winner = await store.getOrder(f.order.id);
    assert.equal((await store.listAdminAuditEvents(f.order.id)).length, winner.cancelledBy === f.admin.id ? 1 : 0);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
});

test('PostgreSQL session revocation during administrator cancellation prevents all mutations', async t => {
  const f = await fixture(t), blocker = await adminPool.connect(); let pending;
  try {
    await blocker.query('BEGIN'); await blocker.query(`SELECT id FROM "${schema}".tezjet_users WHERE id=$1 FOR UPDATE`, [f.admin.id]);
    pending = Promise.allSettled([store.cancelOrderAsAdmin(f.order.id, f.admin.id, 'searching', f.admin.sessionVersion)]);
    await waitForLocks(1);
    await blocker.query(`UPDATE "${schema}".tezjet_users SET session_version=session_version+1 WHERE id=$1`, [f.admin.id]);
    await blocker.query('COMMIT');
    const [result] = await pending; assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'UNAUTHORIZED'); await unchanged(f);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
});

test('PostgreSQL failed administrator order write rolls seat release back', async t => {
  const f = await fixture(t);
  await database.query(`CREATE FUNCTION fail_admin_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.order.id}' AND NEW.status='cancelled' THEN RAISE EXCEPTION 'injected admin cancellation failure'; END IF; RETURN NEW; END $$`);
  await database.query('CREATE TRIGGER fail_admin_cancel BEFORE UPDATE ON tezjet_orders FOR EACH ROW EXECUTE FUNCTION fail_admin_cancel()');
  try {
    await assert.rejects(store.cancelOrderAsAdmin(f.order.id, f.admin.id, 'searching', f.admin.sessionVersion)); await unchanged(f);
    assert.deepEqual(await store.listAdminAuditEvents(f.order.id), []);
  } finally { await database.query('DROP TRIGGER fail_admin_cancel ON tezjet_orders'); await database.query('DROP FUNCTION fail_admin_cancel()'); }
});

test('administrator audit read API is restricted, bounded, filterable and contains no sensitive snapshots', async t => {
  const f = await fixture(t);
  assert.equal((await request(f.order.id, f.admin.token)).status, 200);
  async function read(query, token) {
    const response = await fetch(`${baseUrl}/admin/audit-events${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  assert.equal((await read('', undefined)).status, 401);
  for (const actor of [f.driver, f.passenger]) assert.equal((await read('', actor.token)).status, 403);
  for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?limit=2&limit=3', '?unknown=1']) assert.equal((await read(query, f.admin.token)).status, 400);
  const result = await read(`?order_id=${f.order.id}&limit=1`, f.admin.token);
  assert.equal(result.status, 200); assert.equal(result.cache, 'no-store'); assert.equal(result.body.events.length, 1);
  assert.deepEqual(Object.keys(result.body.events[0]).sort(), ['action', 'actorId', 'createdAt', 'fromStatus', 'id', 'orderId', 'toStatus'].sort());
  assert.equal(result.body.events[0].actorId, f.admin.id);
  assert.deepEqual((await read(`?order_id=${randomUUID()}`, f.admin.token)).body.events, []);
  const freshStore = new production.PostgresStore(); await freshStore.initialize();
  assert.deepEqual(await freshStore.listAdminAuditEvents(f.order.id), result.body.events, 'Audit persists across store instances.');
});

test('PostgreSQL audit insertion failure rolls back cancellation and seat release together', async t => {
  const f = await fixture(t);
  await database.query(`CREATE FUNCTION fail_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.order_id='${f.order.id}' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`);
  await database.query('CREATE TRIGGER fail_audit_insert BEFORE INSERT ON tezjet_admin_audit_events FOR EACH ROW EXECUTE FUNCTION fail_audit_insert()');
  try {
    await assert.rejects(store.cancelOrderAsAdmin(f.order.id, f.admin.id, 'searching', f.admin.sessionVersion));
    await unchanged(f); assert.deepEqual(await store.listAdminAuditEvents(f.order.id), []);
  } finally { await database.query('DROP TRIGGER fail_audit_insert ON tezjet_admin_audit_events'); await database.query('DROP FUNCTION fail_audit_insert()'); }
});

test('PostgreSQL migration prevents UPDATE DELETE and TRUNCATE of audit history', async t => {
  const f = await fixture(t); await store.cancelOrderAsAdmin(f.order.id, f.admin.id, 'searching', f.admin.sessionVersion);
  const before = await store.listAdminAuditEvents(f.order.id);
  for (const statement of [
    `UPDATE tezjet_admin_audit_events SET actor_id='tamper' WHERE order_id='${f.order.id}'`,
    `DELETE FROM tezjet_admin_audit_events WHERE order_id='${f.order.id}'`,
    'TRUNCATE tezjet_admin_audit_events',
  ]) await assert.rejects(database.query(statement), error => error.code === '55000');
  assert.deepEqual(await store.listAdminAuditEvents(f.order.id), before);
});

test('HTTP driver approval writes one event per actual change and supports driver filtering', async t => {
  const f = await fixture(t);
  async function review(status, token = f.admin.token) {
    const response = await fetch(`${baseUrl}/admin/drivers/${f.driver.id}/approval`, { method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ status }) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await review('rejected', f.passenger.token)).status, 403);
  assert.equal((await review('rejected', f.driver.token)).status, 403);
  assert.equal((await review('bad')).status, 400);
  assert.equal((await review('rejected')).status, 200);
  assert.equal((await review('rejected')).status, 200);
  assert.equal((await review('approved')).status, 200);
  const response = await fetch(`${baseUrl}/admin/audit-events?driver_id=${f.driver.id}`, { headers: { authorization: `Bearer ${f.admin.token}` } });
  assert.equal(response.status, 200); const { events } = await response.json(); assert.equal(events.length, 2);
  assert.ok(events.every(event => event.action === 'driver.approval_changed' && event.driverId === f.driver.id && event.actorId === f.admin.id));
  assert.deepEqual(events.map(event => `${event.fromStatus}:${event.toStatus}`).sort(), ['approved:rejected', 'rejected:approved']);
  assert.ok(events.every(event => !Object.hasOwn(event, 'orderId') && !Object.hasOwn(event, 'vehicleRevision')));
  assert.equal((await store.listAdminAuditEvents(f.order.id)).length, 0);
});

for (const kind of ['PostgreSQL', 'Memory']) test(`${kind} audited approval rechecks authority and preserves revision-bound review`, async t => {
  const adapter = kind === 'PostgreSQL' ? store : new production.MemoryStore(), f = await fixture(t, adapter);
  await assert.rejects(Promise.resolve().then(() => adapter.setDriverApprovalAsAdmin(f.driver.id, 'rejected', undefined, f.passenger.id, f.passenger.sessionVersion)), error => error.code === 'FORBIDDEN');
  await adapter.invalidateSessions(f.admin.id);
  await assert.rejects(Promise.resolve().then(() => adapter.setDriverApprovalAsAdmin(f.driver.id, 'rejected', undefined, f.admin.id, f.admin.sessionVersion)), error => error.code === 'UNAUTHORIZED');
  assert.equal((await adapter.getUser(f.driver.id)).driverApprovalStatus, 'approved');
  assert.deepEqual(await adapter.listAdminAuditEvents(undefined, 50, f.driver.id), []);
  const currentAdmin = await adapter.getUser(f.admin.id);
  await adapter.transitionOrder(f.order.id, f.passenger.id, 'cancelled', 'searching', f.passenger.sessionVersion);
  await adapter.leaveQueue(f.driver.id);
  const vehicle = await adapter.setDriverVehicle(f.driver.id, { make: 'Chevrolet', model: 'Cobalt', plateNumber: '01A123BC', seatCapacity: 4, expectedRevision: null }, f.driver.sessionVersion);
  const revision = vehicle.driverVehicle.revision;
  await assert.rejects(Promise.resolve().then(() => adapter.setDriverApprovalAsAdmin(f.driver.id, 'approved', 'stale-revision', currentAdmin.id, currentAdmin.sessionVersion)));
  await adapter.setDriverApprovalAsAdmin(f.driver.id, 'approved', revision, currentAdmin.id, currentAdmin.sessionVersion);
  const [event] = await adapter.listAdminAuditEvents(undefined, 50, f.driver.id);
  assert.equal(event.vehicleRevision, revision); assert.equal(event.fromStatus, 'pending'); assert.equal(event.toStatus, 'approved');
});

test('PostgreSQL failed approval audit insertion rolls back the driver status', async t => {
  const f = await fixture(t);
  await database.query(`CREATE FUNCTION fail_driver_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.driver_id='${f.driver.id}' THEN RAISE EXCEPTION 'injected driver audit failure'; END IF; RETURN NEW; END $$`);
  await database.query('CREATE TRIGGER fail_driver_audit BEFORE INSERT ON tezjet_admin_audit_events FOR EACH ROW EXECUTE FUNCTION fail_driver_audit()');
  try {
    await assert.rejects(store.setDriverApprovalAsAdmin(f.driver.id, 'rejected', undefined, f.admin.id, f.admin.sessionVersion));
    assert.equal((await store.getUser(f.driver.id)).driverApprovalStatus, 'approved');
    assert.deepEqual(await store.listAdminAuditEvents(undefined, 50, f.driver.id), []);
  } finally { await database.query('DROP TRIGGER fail_driver_audit ON tezjet_admin_audit_events'); await database.query('DROP FUNCTION fail_driver_audit()'); }
});

test('PostgreSQL duplicate reviews overlap under real locks and create one event', async t => {
  const f = await fixture(t), blocker = await adminPool.connect(); let pending;
  try {
    await blocker.query('BEGIN'); await blocker.query(`SELECT id FROM "${schema}".tezjet_users WHERE id=$1 FOR UPDATE`, [f.driver.id]);
    pending = Promise.allSettled([
      store.setDriverApprovalAsAdmin(f.driver.id, 'rejected', undefined, f.admin.id, f.admin.sessionVersion),
      otherStore.setDriverApprovalAsAdmin(f.driver.id, 'rejected', undefined, f.admin.id, f.admin.sessionVersion),
    ]);
    await waitForLocks(2); await blocker.query('COMMIT');
    const result = await pending; assert.ok(result.every(item => item.status === 'fulfilled' && item.value.driverApprovalStatus === 'rejected'));
    assert.equal((await store.listAdminAuditEvents(undefined, 50, f.driver.id)).length, 1);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
});
