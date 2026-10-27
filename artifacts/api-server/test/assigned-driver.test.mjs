import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Exercise the real HTTP application and durable adapters. Private copies of
// migrated tables retain their actual columns and uniqueness constraints.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `assigned_driver_${randomUUID().replaceAll("-", "")}`;
const applicationName = `assigned-driver-${randomUUID()}`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes", "tezjet_admin_audit_events"];
const envKeys = ["DATABASE_URL", "TEZJET_STORAGE_ADAPTER", "NODE_ENV", "SESSION_SECRET", "LOG_LEVEL", "REQUIRE_DRIVER_APPROVAL", "PYATAK_CENTER_LAT", "PYATAK_CENTER_LNG", "TEZJET_OFFER_TIMEOUT_SECONDS"];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let moduleDirectory, production, database, adminPool, store, otherStore, server, baseUrl;
let schemaCreated = false;

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required: line collection regressions must execute real PostgreSQL.");
  const originalUrl = process.env.DATABASE_URL;
  const isolatedUrl = new URL(originalUrl);
  isolatedUrl.searchParams.set("options", `${isolatedUrl.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
  isolatedUrl.searchParams.set("application_name", applicationName);
  process.env.DATABASE_URL = isolatedUrl.href;
  process.env.TEZJET_STORAGE_ADAPTER = "postgres";
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET = "assigned-driver-regression-secret-at-least-32-characters";
  process.env.LOG_LEVEL = "silent";
  process.env.REQUIRE_DRIVER_APPROVAL = "true";
  process.env.PYATAK_CENTER_LAT = "41.3111";
  process.env.PYATAK_CENTER_LNG = "69.2797";
  delete process.env.TEZJET_OFFER_TIMEOUT_SECONDS;
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".assigned-driver-test-"));
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
  for (const table of tables) await adminPool.query(`CREATE TABLE "${schema}"."${table}" (LIKE "public"."${table}" INCLUDING ALL)`);
  store = new production.PostgresStore();
  otherStore = new production.PostgresStore();
  assert.ok(production.runtimeStore instanceof production.PostgresStore, "HTTP must run against the durable adapter.");
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

const pitaks = { aStopCode: "A", bStopCode: "B", radiusMeters: 175 };
function choice(route, direction = "a_to_b") { return { routeId: route.id, direction, expectedUpdatedAt: route.updatedAt }; }
function selection(route, direction = "a_to_b") { return { route_id: route.id, direction, expected_updated_at: route.updatedAt }; }
function at(route, code = "A") { return { ...route.stops.find(stop => stop.code === code).location, timestamp: Date.now() }; }
function assertError(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  if (code) assert.equal(result.body?.error?.code, code, JSON.stringify(result.body));
}
async function request(pathname, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const content = await response.text();
  return { status: response.status, body: content ? JSON.parse(content) : undefined };
}
async function fixture(t, adapter = store) {
  const users = [], routes = [];
  await adapter.initialize();
  if (adapter instanceof production.PostgresStore) t.after(async () => {
    await database.query("DELETE FROM tezjet_orders WHERE passenger_id = ANY($1::text[]) OR driver_id = ANY($1::text[]) OR offered_driver_id = ANY($1::text[])", [users]);
    await database.query("DELETE FROM tezjet_driver_queue WHERE driver_id = ANY($1::text[])", [users]);
    await database.query("DELETE FROM tezjet_device_registrations WHERE user_id = ANY($1::text[])", [users]);
    await database.query("DELETE FROM tezjet_users WHERE id = ANY($1::text[])", [users]);
    await database.query("DELETE FROM tezjet_routes WHERE id = ANY($1::text[])", [routes]);
  });
  const createUser = async (role = "driver", approval = "approved") => {
    let user = await adapter.createUser({ role, fullName: "Assigned driver regression", phoneNumber: `+7777${randomUUID().replace(/[^0-9]/g, "").padEnd(7, "0").slice(0, 7)}`, locale: "ru" });
    users.push(user.id);
    if (role === "driver" && approval) { await adapter.setDriverApproval(user.id, approval); user = await adapter.getUser(user.id); }
    return { user: structuredClone(user), token: production.createAccessToken({ sub: user.id, role: user.role, locale: user.locale, sessionVersion: user.sessionVersion, sessionId: randomUUID() }) };
  };
  const configured = async () => {
    const id = `line-${randomUUID()}`; routes.push(id);
    const empty = await adapter.createRoute({ id, name: "A↔B collection", pricePerStopKzt: 500, active: true });
    return adapter.updateRouteLayout(id, { expectedUpdatedAt: empty.updatedAt, pitaks, stops: [
      { code: "A", name: "Питак A", location: { lat: 42.9, lng: 71.3 } },
      { code: "C", name: "Остановка C", location: { lat: 42.91, lng: 71.34 } },
      { code: "D", name: "Остановка D", location: { lat: 42.93, lng: 71.39 } },
      { code: "B", name: "Питак B", location: { lat: 42.94, lng: 71.43 } },
    ] });
  };
  const planned = async (route, direction = "a_to_b") => {
    const driver = await createUser();
    await adapter.setDriverRouteChoice(driver.user.id, choice(route, direction), driver.user.sessionVersion);
    return driver;
  };
  const storedJoin = async (driver, route, capacity = 4, direction = "a_to_b", collection = true) => adapter.joinQueue({
    driverId: driver.user.id, joinedAt: Date.now(), status: "searching", availableSeats: capacity,
    lastLocation: at(route, direction === "a_to_b" ? "A" : "B"), priorityLock: false, inFifo: true, activeOrderIds: [],
  }, driver.user.sessionVersion, choice(route, direction), collection);
  const storedOrder = async (passenger, route, seats = 1, extra = {}) => adapter.createRouteOrderWithOffer({
    passengerId: passenger.user.id, passengerPhone: passenger.user.phoneNumber, pickupLocation: at(route), seats,
  }, { ...choice(route), ...extra }, passenger.user.sessionVersion);
  return { adapter, createUser, configured, planned, storedJoin, storedOrder };
}

async function assignedFixture(t, accept = true) {
  const f = await fixture(t), route = await f.configured();
  const driver = await f.planned(route), passenger = await f.createUser("passenger");
  await f.storedJoin(driver, route);
  const result = await f.storedOrder(passenger, route);
  const pending = result;
  assert.ok(pending?.id, "Actual store must create and offer a configured order");
  const order = accept ? await store.acceptOrderOffer(pending.id, driver.user.id, Date.now(), driver.user.sessionVersion) : pending;
  assert.ok(order);
  return { f, route, driver, passenger, order, contact: `/orders/${order.id}/driver` };
}

test("HTTP: only the booking passenger receives the assigned driver's minimal contact with no-store", async t => {
  const { driver, passenger, order, contact } = await assignedFixture(t);
  const response = await fetch(baseUrl + contact, { headers: { authorization: `Bearer ${passenger.token}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body, { driver: { id: driver.user.id, full_name: driver.user.fullName, phone_number: driver.user.phoneNumber } });
  const ordinary = await request(`/orders/${order.id}`, { token: passenger.token });
  assert.equal(ordinary.status, 200);
  assert.equal(Object.hasOwn(ordinary.body.order, "driver"), false, "Do not add contact data to shared order/socket serialization");
});

test("HTTP: searching and offered orders disclose no driver contact before acceptance", async t => {
  const { driver, passenger, order, contact } = await assignedFixture(t, false);
  assert.equal(order.offeredDriverId, driver.user.id);
  assertError(await request(contact, { token: passenger.token }), 404, "DRIVER_CONTACT_UNAVAILABLE");
  const accepted = await store.acceptOrderOffer(order.id, driver.user.id, Date.now(), driver.user.sessionVersion);
  assert.ok(accepted);
  assert.equal((await request(contact, { token: passenger.token })).status, 200);
});

test("HTTP: unrelated passenger and unknown order return no contact or existence oracle", async t => {
  const { f, contact } = await assignedFixture(t);
  const stranger = await f.createUser("passenger");
  const actual = await request(contact, { token: stranger.token });
  const absent = await request(`/orders/${randomUUID()}/driver`, { token: stranger.token });
  assertError(actual, 404, "ORDER_NOT_FOUND"); assertError(absent, 404, "ORDER_NOT_FOUND");
  assert.equal(actual.body.error.message, absent.body.error.message);
  for (const result of [actual, absent]) assert.equal(JSON.stringify(result.body).includes("phone_number"), false);
});

test("HTTP: unauthenticated, driver, admin and revoked passenger sessions cannot read contact", async t => {
  const { f, driver, passenger, contact } = await assignedFixture(t);
  assertError(await request(contact), 401, "UNAUTHORIZED");
  assertError(await request(contact, { token: driver.token }), 403, "FORBIDDEN");
  const admin = await f.createUser("admin");
  assertError(await request(contact, { token: admin.token }), 403, "FORBIDDEN");
  await store.invalidateSessions(passenger.user.id);
  assertError(await request(contact, { token: passenger.token }), 401, "UNAUTHORIZED");
});

test("HTTP: all accepted active trip stages allow contact; completion removes access", async t => {
  const { driver, passenger, order, contact } = await assignedFixture(t);
  const assertContact = async status => {
    const snapshot = await request(`/orders/${order.id}`, { token: passenger.token });
    assert.equal(snapshot.body.order.status, status);
    const result = await request(contact, { token: passenger.token });
    assert.equal(result.status, 200, status);
    assert.equal(result.body.driver.id, driver.user.id);
  };
  await assertContact("en_route_to_c");
  const arrived = await request(`/orders/${order.id}/status`, { token: driver.token, method: "PATCH", body: { status: "arrived_at_c" } });
  assert.equal(arrived.status, 200);
  await assertContact("arrived_at_c");
  const boarded = await request(`/orders/${order.id}/board`, { token: driver.token, method: "POST", body: {} });
  assert.equal(boarded.status, 200);
  await assertContact("boarded_waiting");
  const entry = await store.getQueueEntry(driver.user.id);
  const departed = await request("/queue/depart", { token: driver.token, method: "POST", body: { expected_enrollment_id: entry.collectionState.enrollmentId } });
  assert.equal(departed.status, 200);
  await assertContact("in_transit");
  const completed = await request(`/orders/${order.id}/status`, { token: driver.token, method: "PATCH", body: { status: "completed" } });
  assert.equal(completed.status, 200);
  assertError(await request(contact, { token: passenger.token }), 404, "DRIVER_CONTACT_UNAVAILABLE");
});

test("HTTP: cancelled rides and deleted driver accounts cannot disclose cached contact", async t => {
  const { passenger, order, contact } = await assignedFixture(t);
  const cancelled = await request(`/orders/${order.id}/cancel`, { token: passenger.token, method: "POST" });
  assert.equal(cancelled.status, 200);
  assertError(await request(contact, { token: passenger.token }), 404, "DRIVER_CONTACT_UNAVAILABLE");
  const missing = await assignedFixture(t);
  await database.query("DELETE FROM tezjet_users WHERE id = $1", [missing.driver.user.id]);
  assertError(await request(missing.contact, { token: missing.passenger.token }), 404, "DRIVER_CONTACT_UNAVAILABLE");
});
