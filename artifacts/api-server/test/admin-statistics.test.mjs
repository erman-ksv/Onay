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
const schema = `trip_stats_${randomUUID().replaceAll("-", "")}`;
const applicationName = `trip-stats-${randomUUID()}`;
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
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".trip-stats-test-"));
  const entry = path.join(moduleDirectory, "production.mjs");
  await build({
    stdin: {
      contents: [
        'export { default as app } from "./src/app";',
        'export { PostgresStore } from "./src/store/postgresStore";',
        'export { MemoryStore } from "./src/store/memoryStore";',
        'export { pool } from "../../lib/db/src/index";',
        'export { store as runtimeStore } from "./src/store";',
        'export { buildTripStatistics } from "./src/utils/tripStatistics";',
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
  await database.query(await readFile(new URL('../../../lib/db/drizzle/0011_route_metadata_audit.sql', import.meta.url), 'utf8'));
  await database.query(await readFile(new URL('../../../lib/db/drizzle/0016_offer_timeout_policy.sql', import.meta.url), 'utf8'));
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


const fare = (currency, total) => currency === 'KZT' ? { currency, totalKzt: total, pricePerStopKzt: total }
  : { currency, total, pricePerStop: total };
async function fixture(t) {
  const users = [], orders = [];
  t.after(async () => {
    await database.query('DELETE FROM tezjet_orders WHERE id = ANY($1::text[])', [orders]);
    await database.query('DELETE FROM tezjet_users WHERE id = ANY($1::text[])', [users]);
  });
  async function user(role) {
    const value = await store.createUser({ role, fullName: 'Private statistics fixture', phoneNumber: `stats-${randomUUID()}`, locale: 'ru' });
    users.push(value.id);
    return { ...value, token: production.createAccessToken({ sub: value.id, role, locale: 'ru', sessionVersion: value.sessionVersion, sessionId: randomUUID() }) };
  }
  const admin = await user('admin'), passenger = await user('passenger'), driver = await user('driver');
  return { admin, passenger, driver, async order(status, frozenFare, seats = 3) {
    const order = await store.createOrder({ passengerId: passenger.id, passengerPhone: passenger.phoneNumber, driverId: driver.id,
      pickupPoint: 'C', pickupLocation: { lat: 41.3111, lng: 69.2797, timestamp: 1 }, routeStops: [],
      destination: 'D', seats, status, fare: frozenFare });
    orders.push(order.id); return order;
  } };
}
async function statistics(token, method = 'GET') {
  const response = await fetch(`${baseUrl}/admin/statistics/trips`, { method,
    headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000) });
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  return { status: response.status, body: method === 'HEAD' ? null : await response.json() };
}

test('statistics retain the exact count contract and genuine empty fare summary', async t => {
  const f = await fixture(t), result = await statistics(f.admin.token);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.statistics, { total: 0, active: 0, completed: 0, cancelled: 0,
    by_status: { searching: 0, en_route_to_c: 0, arrived_at_c: 0, boarded_waiting: 0, in_transit: 0, completed: 0, cancelled: 0 } });
  assert.deepEqual(result.body.fare_summary, { basis: 'completed_order_fares', missing_fare_orders: 0, overflow: false, totals: [] });
});
test('real PostgreSQL statistics separate frozen UZS and legacy KZT, count zero and never multiply seats', async t => {
  const f = await fixture(t);
  await f.order('completed', fare('UZS', 20000), 3);
  await f.order('completed', fare('UZS', 0), 1);
  await f.order('completed', fare('KZT', 500));
  await f.order('completed', { currency: 'KZT', total: 300, pricePerStop: 300 });
  await f.order('cancelled', fare('UZS', 70000));
  await f.order('in_transit', fare('UZS', 90000));
  const before = await store.listOrders(), { body, status } = await statistics(f.admin.token);
  assert.equal(status, 200); assert.equal(body.statistics.total, 6); assert.equal(body.statistics.completed, 4);
  assert.equal(body.statistics.active, 1); assert.equal(body.statistics.cancelled, 1);
  assert.deepEqual(body.fare_summary.totals, [{ currency: 'KZT', total: 800, orders: 2 }, { currency: 'UZS', total: 20000, orders: 2 }]);
  assert.equal(body.fare_summary.missing_fare_orders, 0); assert.equal(body.fare_summary.overflow, false);
  assert.deepEqual(await store.listOrders(), before, 'Reading aggregates must not mutate persisted orders');
  const text = JSON.stringify(body);
  for (const privateValue of [f.passenger.id, f.passenger.phoneNumber, f.driver.id, ...before.map(order => order.id)]) assert.ok(!text.includes(privateValue));
});
test('incomplete historical fares suppress the full aggregate instead of publishing a partial income', async t => {
  const f = await fixture(t);
  await f.order('completed', fare('UZS', 20000)); await f.order('completed', undefined);
  await f.order('completed', { currency: 'UZS', totalKzt: 500 }); await f.order('cancelled', undefined);
  const { body } = await statistics(f.admin.token);
  assert.equal(body.statistics.completed, 3); assert.equal(body.statistics.cancelled, 1);
  assert.deepEqual(body.fare_summary, { basis: 'completed_order_fares', missing_fare_orders: 2, overflow: false, totals: null });
});
test('aggregate overflow remains explicit without rounded or partial totals', async t => {
  const f = await fixture(t); await f.order('completed', fare('KZT', Number.MAX_SAFE_INTEGER)); await f.order('completed', fare('KZT', 1));
  const { body } = await statistics(f.admin.token);
  assert.equal(body.statistics.completed, 2);
  assert.deepEqual(body.fare_summary, { basis: 'completed_order_fares', missing_fare_orders: 0, overflow: true, totals: null });
});
test('statistics remain administrator-only and no-store on GET HEAD and access failures', async t => {
  const f = await fixture(t);
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await statistics(undefined, method)).status, 401);
    for (const actor of [f.passenger, f.driver]) assert.equal((await statistics(actor.token, method)).status, 403);
    assert.equal((await statistics(f.admin.token, method)).status, 200);
  }
});
test('the production aggregator rejects ambiguous aliases and unsupported money without affecting counts', () => {
  for (const value of [null, { currency: 'USD', total: 5 }, { currency: 'KZT', total: 500, totalKzt: 501 },
    { currency: 'UZS', total: 500, pricePerStopKzt: 1 }, { currency: 'UZS', total: -1 }, { currency: 'UZS', total: 0.5 }]) {
    const result = production.buildTripStatistics([{ status: 'completed', fare: value }]);
    assert.equal(result.statistics.completed, 1); assert.equal(result.fare_summary.missing_fare_orders, 1); assert.equal(result.fare_summary.totals, null);
  }
});
