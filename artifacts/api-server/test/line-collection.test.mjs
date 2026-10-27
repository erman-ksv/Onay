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
const schema = `line_collection_${randomUUID().replaceAll("-", "")}`;
const applicationName = `line-collection-${randomUUID()}`;
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
  process.env.SESSION_SECRET = "line-collection-regression-secret-at-least-32-characters";
  process.env.LOG_LEVEL = "silent";
  process.env.REQUIRE_DRIVER_APPROVAL = "true";
  process.env.PYATAK_CENTER_LAT = "41.3111";
  process.env.PYATAK_CENTER_LNG = "69.2797";
  delete process.env.TEZJET_OFFER_TIMEOUT_SECONDS;
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".line-collection-test-"));
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
    let user = await adapter.createUser({ role, fullName: "Line collection regression", phoneNumber: `line-${randomUUID()}`, locale: "ru" });
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
function joinBody(route, capacity = 4, direction = "a_to_b") {
  return { route_choice: selection(route, direction), location: at(route, direction === "a_to_b" ? "A" : "B"), available_seats: capacity };
}
async function enroll(f, route, capacity = 4, direction = "a_to_b") {
  const driver = await f.planned(route, direction);
  const joined = await request("/queue/line", { token: driver.token, method: "POST", body: joinBody(route, capacity, direction) });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  return { ...driver, enrollment: joined.body.entry.collectionState, joined: joined.body.entry };
}
async function create(f, passenger, route, seats = 1, extra = {}) {
  const created = await request("/orders/route", { token: passenger.token, method: "POST", body: {
    ...selection(route), pickup_location: at(route), seats, ...extra,
  } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.order;
}
async function accept(driver, order) {
  const result = await request(`/orders/${order.id}/accept`, { token: driver.token, method: "POST" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.order;
}
async function arrive(driver, order) {
  const result = await request(`/orders/${order.id}/status`, { token: driver.token, method: "PATCH", body: { status: "arrived_at_c" } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.order;
}
async function board(driver, order) {
  const result = await request(`/orders/${order.id}/board`, { token: driver.token, method: "POST", body: {} });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.order.status, "boarded_waiting");
  return result.body.order;
}
function depart(driver, enrollmentId = driver.enrollment.enrollmentId) {
  return request("/queue/depart", { token: driver.token, method: "POST", body: { expected_enrollment_id: enrollmentId } });
}
async function capacityInvariant(adapter, driver, capacity) {
  const entry = await adapter.getQueueEntry(driver.user.id);
  const ids = [...new Set([...(entry.activeOrderIds ?? []), ...(entry.currentOrderId ? [entry.currentOrderId] : []), ...(entry.pendingOfferOrderId ? [entry.pendingOfferOrderId] : [])])];
  const held = (await Promise.all(ids.map(id => adapter.getOrder(id)))).reduce((sum, order) => sum + order.seats, 0);
  assert.equal(entry.availableSeats + held, capacity, "Free seats plus each owned reservation must equal vehicle capacity.");
  assert.ok(entry.availableSeats >= 0 && entry.availableSeats <= capacity);
  return entry;
}
async function waitForBlockedTransactions(count) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await adminPool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND wait_event_type = 'Lock'", [applicationName]);
    if (rows[0].count >= count) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${count} production PostgreSQL transactions blocked on actual row locks.`);
}
async function overlapping(table, idColumn, id, actions) {
  assert.ok(["tezjet_orders", "tezjet_driver_queue", "tezjet_users"].includes(table));
  assert.ok(["id", "driver_id"].includes(idColumn));
  const blocker = await adminPool.connect(), pending = [];
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT "${idColumn}" FROM "${schema}"."${table}" WHERE "${idColumn}" = $1 FOR UPDATE`, [id]);
    for (const action of actions) {
      pending.push(Promise.resolve().then(action).then(value => ({ value }), error => ({ error })));
      await waitForBlockedTransactions(pending.length);
    }
    await blocker.query("COMMIT");
    return await Promise.all(pending);
  } finally {
    await blocker.query("ROLLBACK"); blocker.release(); await Promise.all(pending);
  }
}

test("HTTP line enrollment is opt-in, immutable in capacity, idempotent while idle, and persists across adapters", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await enroll(f, route);
  assert.equal(driver.enrollment.version, 1); assert.equal(driver.enrollment.phase, "collecting");
  assert.equal(driver.enrollment.capacity, 4); assert.ok(driver.enrollment.enrollmentId);
  const repeated = await request("/queue/line", { token: driver.token, method: "POST", body: joinBody(route) });
  assert.equal(repeated.status, 201, JSON.stringify(repeated.body));
  assert.equal(repeated.body.entry.joinedAt, driver.joined.joinedAt);
  assert.equal(repeated.body.entry.collectionState.enrollmentId, driver.enrollment.enrollmentId);
  assert.equal(repeated.body.position, 1);
  assert.equal((await otherStore.getQueueEntry(driver.user.id)).collectionState.enrollmentId, driver.enrollment.enrollmentId);
  assertError(await request("/queue/line", { token: driver.token, method: "POST", body: joinBody(route, 8) }), 409, "QUEUE_BUSY");
  assertError(await request("/queue/join", { token: driver.token, method: "POST", body: joinBody(route) }), 409, "QUEUE_BUSY");
  await capacityInvariant(otherStore, driver, 4);
});

test("HTTP line commands require authentication, driver role, explicit route selection and server-owned state", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await f.planned(route), passenger = await f.createUser("passenger");
  assertError(await request("/queue/line", { method: "POST", body: joinBody(route) }), 401);
  assertError(await request("/queue/line", { token: passenger.token, method: "POST", body: joinBody(route) }), 403);
  const missing = joinBody(route); delete missing.route_choice;
  assertError(await request("/queue/line", { token: driver.token, method: "POST", body: missing }), 400, "VALIDATION_ERROR");
  assertError(await request("/queue/line", { token: driver.token, method: "POST", body: { ...joinBody(route), collectionState: { phase: "departed" } } }), 400, "VALIDATION_ERROR");
  assertError(await request("/queue/depart", { token: driver.token, method: "POST", body: {} }), 400, "VALIDATION_ERROR");
  assertError(await depart({ ...driver, enrollment: { enrollmentId: randomUUID() } }), 404, "NOT_IN_QUEUE");
});

test("HTTP legacy configured enrollment keeps its existing lifecycle and cannot silently become a line enrollment", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await f.planned(route), passenger = await f.createUser("passenger");
  const joined = await request("/queue/join", { token: driver.token, method: "POST", body: joinBody(route) });
  assert.equal(joined.status, 201); assert.equal(joined.body.entry.collectionState, undefined);
  assertError(await request("/queue/line", { token: driver.token, method: "POST", body: joinBody(route) }), 409, "QUEUE_BUSY");
  assertError(await depart({ ...driver, enrollment: { enrollmentId: randomUUID() } }), 409, "LINE_COLLECTION_REQUIRED");
  const order = await create(f, passenger, route); await accept(driver, order); await arrive(driver, order);
  const transit = await request(`/orders/${order.id}/status`, { token: driver.token, method: "PATCH", body: { status: "in_transit" } });
  assert.equal(transit.status, 200, JSON.stringify(transit.body));
  assert.equal((await otherStore.getQueueEntry(driver.user.id)).inFifo, false);
});

test("HTTP multiple accepted orders fill one car while preserving FIFO and charging each reservation only once", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
  const later = await enroll(f, route), position = await store.getQueuePosition(driver.user.id);
  const first = await create(f, passenger, route, 2); assert.equal(first.offered_driver_id, driver.user.id); await accept(driver, first);
  const second = await create(f, passenger, route, 2); assert.equal(second.offered_driver_id, driver.user.id); await accept(driver, second);
  let entry = await capacityInvariant(otherStore, driver, 4);
  assert.equal(entry.availableSeats, 0); assert.equal(entry.collectionState.phase, "collecting"); assert.equal(entry.inFifo, true);
  assert.equal(entry.joinedAt, driver.joined.joinedAt); assert.equal(await store.getQueuePosition(driver.user.id), position);
  assert.equal((await store.getQueueEntry(later.user.id)).availableSeats, 4);
  for (const order of [first, second]) { await arrive(driver, order); await board(driver, order); }
  entry = await capacityInvariant(otherStore, driver, 4); assert.equal(entry.availableSeats, 0);
  assert.equal(entry.inFifo, true, "A full and boarded car waits until its driver explicitly departs.");
  assert.equal((await otherStore.getOrder(first.id)).seatLockExpiresAt, undefined);
  const departed = await depart(driver); assert.equal(departed.status, 200, JSON.stringify(departed.body));
  assert.equal(departed.body.changed, true); assert.equal(departed.body.position, null);
  assert.deepEqual(departed.body.orders.map(order => order.status), ["in_transit", "in_transit"]);
  await capacityInvariant(otherStore, driver, 4);
});

test("HTTP one pending offer remains exclusive while previously accepted passengers keep their seats", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
  const accepted = await create(f, passenger, route); await accept(driver, accepted);
  const pending = await create(f, passenger, route);
  const refused = await request("/orders/route", { token: passenger.token, method: "POST", body: { ...selection(route), pickup_location: at(route), seats: 1 } });
  assertError(refused, 409, "NO_DRIVERS");
  const entry = await capacityInvariant(otherStore, driver, 4);
  assert.equal(entry.pendingOfferOrderId, pending.id); assert.deepEqual(entry.activeOrderIds, [accepted.id]);
  assertError(await depart(driver), 409, "QUEUE_BUSY");
  assert.equal((await otherStore.getQueueEntry(driver.user.id)).collectionState.phase, "collecting");
});

test("HTTP collecting GPS can leave and return without losing priority, including a pending offer or no active orders", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
  const originalPosition = await store.getQueuePosition(driver.user.id);
  let sampleTimestamp = driver.joined.lastLocation.timestamp;
  for (const code of ["C", "A"]) {
    // Simulate ten minutes of travel between GPS samples while retaining the
    // production speed validation. Client timestamps do not set server freshness.
    sampleTimestamp += 10 * 60_000;
    const receivedAfter = Date.now();
    const moved = await request("/queue/location", { token: driver.token, method: "PATCH", body: { location: { ...at(route, code), timestamp: sampleTimestamp } } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.entry.joinedAt, driver.joined.joinedAt); assert.equal(moved.body.position, originalPosition);
    assert.ok(moved.body.entry.collectionState.locationUpdatedAt >= receivedAfter);
    assert.ok(moved.body.entry.collectionState.locationUpdatedAt <= Date.now());
    assert.ok(moved.body.entry.collectionState.locationUpdatedAt < sampleTimestamp, "Freshness is stamped by the server, not the client's future clock.");
  }
  const order = await create(f, passenger, route);
  sampleTimestamp += 10 * 60_000;
  const moved = await request("/queue/location", { token: driver.token, method: "PATCH", body: { location: { ...at(route, "D"), timestamp: sampleTimestamp } } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.entry.pendingOfferOrderId, order.id); assert.equal(moved.body.entry.inFifo, true);
  assert.equal(moved.body.entry.collectionState.enrollmentId, driver.enrollment.enrollmentId);
});

test("HTTP only assigned approved drivers board arrived passengers and direct per-order departure is rejected", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger"), stranger = await f.createUser();
  const order = await create(f, passenger, route); await accept(driver, order);
  assertError(await request(`/orders/${order.id}/board`, { token: driver.token, method: "POST", body: {} }), 409);
  await arrive(driver, order);
  assertError(await request(`/orders/${order.id}/board`, { token: stranger.token, method: "POST", body: {} }), 404, "ORDER_NOT_FOUND");
  assertError(await request(`/orders/${order.id}/board`, { token: passenger.token, method: "POST", body: {} }), 403);
  assertError(await request(`/orders/${order.id}/status`, { token: driver.token, method: "PATCH", body: { status: "in_transit" } }), 409, "DEPART_REQUIRED");
  await board(driver, order);
  const before = await otherStore.getQueueEntry(driver.user.id);
  assertError(await request(`/orders/${order.id}/board`, { token: driver.token, method: "POST", body: {} }), 409);
  assert.deepEqual(await otherStore.getQueueEntry(driver.user.id), before);
});

test("HTTP boarding does not expire while another unboarded reservation expires independently", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
  const aboard = await create(f, passenger, route, 2); await accept(driver, aboard); await arrive(driver, aboard); await board(driver, aboard);
  const unboarded = await create(f, passenger, route); await accept(driver, unboarded); await arrive(driver, unboarded);
  // Move only the unboarded passenger's durable pickup deadline into the past.
  // The production expiry transaction must leave the boarded passenger intact.
  await database.query("UPDATE tezjet_orders SET payload = jsonb_set(payload, '{seatLockExpiresAt}', to_jsonb($2::bigint)) WHERE id = $1", [unboarded.id, Date.now() - 1]);
  await otherStore.clearExpiredSeatLocks(); await store.clearExpiredSeatLocks();
  const entry = await capacityInvariant(otherStore, driver, 4);
  assert.equal(entry.availableSeats, 2); assert.equal(entry.inFifo, true); assert.equal(entry.collectionState.phase, "collecting");
  assert.deepEqual(entry.activeOrderIds, [aboard.id]); assert.equal(entry.joinedAt, driver.joined.joinedAt);
  assert.equal((await store.getOrder(aboard.id)).status, "boarded_waiting");
  assert.equal((await store.getOrder(aboard.id)).seatLockExpiresAt, undefined);
  assert.equal((await store.getOrder(unboarded.id)).status, "searching");
});

test("HTTP cancelling a different passenger never releases boarded seats or departs the collecting car", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
  const aboard = await create(f, passenger, route, 2); await accept(driver, aboard); await arrive(driver, aboard); await board(driver, aboard);
  const other = await create(f, passenger, route); await accept(driver, other);
  const cancelled = await request(`/orders/${other.id}/cancel`, { token: passenger.token, method: "POST" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assertError(await request(`/orders/${other.id}/cancel`, { token: passenger.token, method: "POST" }), 409);
  const entry = await capacityInvariant(otherStore, driver, 4);
  assert.equal(entry.availableSeats, 2); assert.equal(entry.collectionState.phase, "collecting"); assert.equal(entry.inFifo, true);
  assert.deepEqual(entry.activeOrderIds, [aboard.id]); assert.equal((await otherStore.getOrder(aboard.id)).status, "boarded_waiting");
});

test("HTTP empty and partially occupied cars depart manually, retries are idempotent, and completed seats return once", async t => {
  for (const occupied of [0, 2]) await t.test(`${occupied} occupied seats`, async child => {
    const f = await fixture(child), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
    let order;
    if (occupied) { order = await create(f, passenger, route, occupied); await accept(driver, order); await arrive(driver, order); await board(driver, order); }
    const result = await depart(driver); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.changed, true);
    const entry = await capacityInvariant(otherStore, driver, 4);
    assert.equal(entry.collectionState.phase, "departed"); assert.equal(entry.inFifo, false); assert.ok(entry.collectionState.departedAt);
    assert.equal(await otherStore.getQueuePosition(driver.user.id), null);
    const retry = await depart(driver); assert.equal(retry.status, 200); assert.equal(retry.body.changed, false);
    assert.equal(retry.body.entry.collectionState.departedAt, entry.collectionState.departedAt);
    if (order) {
      const done = await request(`/orders/${order.id}/status`, { token: driver.token, method: "PATCH", body: { status: "completed" } });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assertError(await request(`/orders/${order.id}/status`, { token: driver.token, method: "PATCH", body: { status: "completed" } }), 409);
      const restored = await capacityInvariant(otherStore, driver, 4); assert.equal(restored.availableSeats, 4); assert.equal(restored.inFifo, false);
    }
    assert.equal((await store.getRouteOrderAvailability(choice(route), 1)).available, false, "Departure excludes this old origin enrollment from new offers.");
  });
});

test("HTTP departure requires boarding origin passengers but permits accepted future intermediate stops", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
  const origin = await create(f, passenger, route); await accept(driver, origin);
  assertError(await depart(driver), 409, "PASSENGERS_NOT_BOARDED");
  await arrive(driver, origin); assertError(await depart(driver), 409, "PASSENGERS_NOT_BOARDED");
  await board(driver, origin);
  const atStopC = await f.createUser("passenger");
  const future = await create(f, atStopC, route, 1, { pickup_stop_id: route.stops.find(stop => stop.code === "C").id, pickup_location: at(route, "C") });
  await accept(driver, future);
  const result = await depart(driver); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await otherStore.getOrder(origin.id)).status, "in_transit");
  assert.equal((await otherStore.getOrder(future.id)).status, "en_route_to_c", "The C pickup is not falsely marked boarded by departure from A.");
  await arrive(driver, future);
  const inTransit = await request(`/orders/${future.id}/status`, { token: driver.token, method: "PATCH", body: { status: "in_transit" } });
  assert.equal(inTransit.status, 200, JSON.stringify(inTransit.body));
  await capacityInvariant(otherStore, driver, 4);
});

test("HTTP an old departure request cannot remove a newly joined line enrollment", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await enroll(f, route);
  assert.equal((await depart(driver)).status, 200);
  assert.equal((await request("/queue/leave", { token: driver.token, method: "DELETE" })).status, 204);
  const again = await request("/queue/line", { token: driver.token, method: "POST", body: joinBody(route) });
  assert.equal(again.status, 201, JSON.stringify(again.body)); assert.notEqual(again.body.entry.collectionState.enrollmentId, driver.enrollment.enrollmentId);
  assertError(await depart(driver), 409, "QUEUE_ENROLLMENT_CHANGED");
  const durable = await otherStore.getQueueEntry(driver.user.id);
  assert.equal(durable.collectionState.phase, "collecting"); assert.equal(durable.inFifo, true);
});

test("HTTP departure and boarding check current approval and revoked sessions without changing reservations", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
  const order = await create(f, passenger, route); await accept(driver, order); await arrive(driver, order);
  const before = structuredClone(await otherStore.getQueueEntry(driver.user.id));
  await store.setDriverApproval(driver.user.id, "rejected");
  assertError(await depart(driver), 403);
  assertError(await request(`/orders/${order.id}/board`, { token: driver.token, method: "POST", body: {} }), 403);
  await store.setDriverApproval(driver.user.id, "approved");
  await store.invalidateSessions(driver.user.id);
  assertError(await depart(driver), 401);
  assertError(await request(`/orders/${order.id}/board`, { token: driver.token, method: "POST", body: {} }), 401);
  assert.deepEqual(await otherStore.getQueueEntry(driver.user.id), before);
  assert.equal((await otherStore.getOrder(order.id)).status, "arrived_at_c");
});

test("both adapters preserve the collection phase, seat conservation and waiting passengers through cancellation and departure", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    const f = await fixture(t, adapter), route = await f.configured(), driver = await f.planned(route), passenger = await f.createUser("passenger");
    const joined = await f.storedJoin(driver, route);
    const first = await f.storedOrder(passenger, route, 2); assert.ok(first);
    assert.ok(await adapter.acceptOrderOffer(first.id, driver.user.id));
    assert.ok(await adapter.transitionOrder(first.id, driver.user.id, "arrived_at_c"));
    const beforeBoarding = structuredClone(await adapter.getQueueEntry(driver.user.id));
    await adapter.setDriverApproval(driver.user.id, "rejected");
    // Internal callers may omit a session version. Approval still has to be
    // read from the live user before turning a pickup into unlimited waiting.
    await assert.rejects(async () => adapter.transitionOrder(first.id, driver.user.id, "boarded_waiting"), error => error.code === "DRIVER_NOT_APPROVED");
    assert.deepEqual(await adapter.getQueueEntry(driver.user.id), beforeBoarding);
    assert.equal((await adapter.getOrder(first.id)).status, "arrived_at_c");
    await adapter.setDriverApproval(driver.user.id, "approved");
    assert.ok(await adapter.transitionOrder(first.id, driver.user.id, "boarded_waiting"));
    const second = await f.storedOrder(passenger, route, 2); assert.ok(second);
    assert.ok(await adapter.acceptOrderOffer(second.id, driver.user.id));
    assert.ok(await adapter.transitionOrder(second.id, passenger.user.id, "cancelled"));
    let entry = await capacityInvariant(adapter, driver, 4); assert.equal(entry.inFifo, true); assert.equal(entry.availableSeats, 2);
    assert.equal(entry.collectionState.phase, "collecting"); assert.equal(entry.joinedAt, joined.joinedAt);
    const departed = await adapter.departQueue(driver.user.id, joined.collectionState.enrollmentId, driver.user.sessionVersion);
    assert.equal(departed.changed, true); assert.equal((await adapter.getOrder(first.id)).status, "in_transit");
    assert.ok(await adapter.transitionOrder(first.id, driver.user.id, "completed"));
    entry = await capacityInvariant(adapter, driver, 4); assert.equal(entry.availableSeats, 4); assert.equal(entry.inFifo, false);
  }
});

test("real PostgreSQL overlapping offers retain a single pending owner and never oversell a collecting car", { timeout: 15_000 }, async t => {
  const f = await fixture(t), route = await f.configured(), driver = await enroll(f, route), first = await f.createUser("passenger"), second = await f.createUser("passenger");
  const results = await overlapping("tezjet_driver_queue", "driver_id", driver.user.id, [
    () => f.storedOrder(first, route, 3),
    () => otherStore.createRouteOrderWithOffer({ passengerId: second.user.id, passengerPhone: second.user.phoneNumber, pickupLocation: at(route), seats: 3 }, choice(route), second.user.sessionVersion),
  ]);
  assert.ok(results.every(result => !result.error), JSON.stringify(results));
  assert.equal(results.filter(result => result.value).length, 1);
  const entry = await capacityInvariant(otherStore, driver, 4);
  assert.equal(entry.availableSeats, 1); assert.ok(entry.pendingOfferOrderId); assert.equal(entry.collectionState.phase, "collecting");
});

test("real PostgreSQL overlapping boarding and manual departure settle atomically without losing seats", { timeout: 20_000 }, async t => {
  for (const first of ["board", "depart"]) await t.test(first, async child => {
    const f = await fixture(child), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
    const order = await create(f, passenger, route, 2); await accept(driver, order); await arrive(driver, order);
    const boarding = () => store.transitionOrder(order.id, driver.user.id, "boarded_waiting", "arrived_at_c", driver.user.sessionVersion);
    const departure = () => otherStore.departQueue(driver.user.id, driver.enrollment.enrollmentId, driver.user.sessionVersion);
    const results = await overlapping("tezjet_orders", "id", order.id, first === "board" ? [boarding, departure] : [departure, boarding]);
    for (const result of results) if (result.error) assert.equal(result.error.code, "PASSENGERS_NOT_BOARDED");
    let entry = await capacityInvariant(otherStore, driver, 4);
    if (entry.collectionState.phase === "collecting") await otherStore.departQueue(driver.user.id, driver.enrollment.enrollmentId, driver.user.sessionVersion);
    entry = await capacityInvariant(otherStore, driver, 4);
    assert.equal(entry.collectionState.phase, "departed"); assert.equal(entry.inFifo, false);
    assert.equal((await otherStore.getOrder(order.id)).status, "in_transit"); assert.equal(entry.availableSeats, 2);
  });
});

test("real PostgreSQL overlapping cancellation and departure return seats once in either lock schedule", { timeout: 20_000 }, async t => {
  for (const first of ["cancel", "depart"]) await t.test(first, async child => {
    const f = await fixture(child), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
    const order = await create(f, passenger, route, 2); await accept(driver, order); await arrive(driver, order); await board(driver, order);
    const cancellation = () => store.transitionOrder(order.id, passenger.user.id, "cancelled", undefined, passenger.user.sessionVersion);
    const departure = () => otherStore.departQueue(driver.user.id, driver.enrollment.enrollmentId, driver.user.sessionVersion);
    const results = await overlapping("tezjet_orders", "id", order.id, first === "cancel" ? [cancellation, departure] : [departure, cancellation]);
    assert.ok(results.every(result => !result.error), JSON.stringify(results));
    const entry = await capacityInvariant(otherStore, driver, 4);
    assert.equal(entry.availableSeats, 4); assert.equal(entry.collectionState.phase, "departed"); assert.equal(entry.inFifo, false);
    assert.equal((await otherStore.getOrder(order.id)).status, "cancelled");
    assert.equal(await store.transitionOrder(order.id, passenger.user.id, "cancelled"), undefined);
    await capacityInvariant(otherStore, driver, 4);
  });
});

test("real PostgreSQL overlapping offer and empty departure cannot reserve a car after departure", { timeout: 20_000 }, async t => {
  for (const first of ["offer", "depart"]) await t.test(first, async child => {
    const f = await fixture(child), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
    const offering = () => f.storedOrder(passenger, route, 2);
    const departure = () => otherStore.departQueue(driver.user.id, driver.enrollment.enrollmentId, driver.user.sessionVersion);
    const results = await overlapping("tezjet_driver_queue", "driver_id", driver.user.id, first === "offer" ? [offering, departure] : [departure, offering]);
    const entry = await capacityInvariant(otherStore, driver, 4);
    if (entry.collectionState.phase === "departed") {
      assert.equal(entry.availableSeats, 4); assert.equal(entry.pendingOfferOrderId, undefined); assert.equal(entry.inFifo, false);
      assert.ok(results.every(result => !result.error), JSON.stringify(results));
      assert.equal(await f.storedOrder(passenger, route), undefined);
    } else {
      assert.equal(entry.collectionState.phase, "collecting"); assert.equal(entry.inFifo, true); assert.ok(entry.pendingOfferOrderId);
      assert.equal(results.find(result => result.error)?.error.code, "QUEUE_BUSY");
    }
  });
});

test("HTTP an elapsed pickup deadline cannot be converted into an unlimited boarded reservation", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
  const order = await create(f, passenger, route, 2); await accept(driver, order); await arrive(driver, order);
  const expiry = Date.now() - 1;
  await database.query("UPDATE tezjet_orders SET payload = jsonb_set(payload, '{seatLockExpiresAt}', to_jsonb($2::bigint)) WHERE id = $1", [order.id, expiry]);
  const before = await otherStore.getQueueEntry(driver.user.id);
  assertError(await request(`/orders/${order.id}/board`, { token: driver.token, method: "POST", body: {} }), 409, "PICKUP_EXPIRED");
  const current = await otherStore.getOrder(order.id);
  assert.equal(current.status, "arrived_at_c"); assert.equal(current.seatLockExpiresAt, expiry);
  assert.deepEqual(await otherStore.getQueueEntry(driver.user.id), before);
  await capacityInvariant(otherStore, driver, 4);
});

test("HTTP an elapsed future-stop reservation blocks departure until the passenger is released", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
  const order = await create(f, passenger, route, 2, { pickup_stop_id: route.stops.find(stop => stop.code === "C").id, pickup_location: at(route, "C") });
  await accept(driver, order);
  await database.query("UPDATE tezjet_orders SET payload = jsonb_set(payload, '{seatLockExpiresAt}', to_jsonb($2::bigint)) WHERE id = $1", [order.id, Date.now() - 1]);
  assertError(await depart(driver), 409, "PICKUP_EXPIRED");
  const entry = await capacityInvariant(otherStore, driver, 4);
  assert.equal(entry.collectionState.phase, "collecting"); assert.equal(entry.inFifo, true);
  assert.equal((await otherStore.getOrder(order.id)).status, "en_route_to_c");
  await otherStore.clearExpiredSeatLocks();
  assert.equal((await depart(driver)).status, 200);
  assert.equal((await otherStore.getQueueEntry(driver.user.id)).availableSeats, 4);
});

test("HTTP after departure a future-stop passenger cannot board through the legacy status PATCH after expiry", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
  const order = await create(f, passenger, route, 2, { pickup_stop_id: route.stops.find(stop => stop.code === "D").id, pickup_location: at(route, "D") });
  await accept(driver, order); assert.equal((await depart(driver)).status, 200); await arrive(driver, order);
  const expiry = Date.now() - 1;
  await database.query("UPDATE tezjet_orders SET payload = jsonb_set(payload, '{seatLockExpiresAt}', to_jsonb($2::bigint)) WHERE id = $1", [order.id, expiry]);
  assertError(await request(`/orders/${order.id}/status`, { token: driver.token, method: "PATCH", body: { status: "in_transit" } }), 409, "PICKUP_EXPIRED");
  const current = await otherStore.getOrder(order.id);
  assert.equal(current.status, "arrived_at_c"); assert.equal(current.seatLockExpiresAt, expiry);
  const entry = await capacityInvariant(otherStore, driver, 4);
  assert.equal(entry.collectionState.phase, "departed"); assert.equal(entry.inFifo, false); assert.equal(entry.availableSeats, 2);
});

test("real PostgreSQL overlapping acceptance and departure never start a car with an unboarded origin passenger", { timeout: 20_000 }, async t => {
  for (const first of ["accept", "depart"]) await t.test(first, async child => {
    const f = await fixture(child), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
    const order = await create(f, passenger, route, 2);
    const accepting = () => store.acceptOrderOffer(order.id, driver.user.id, undefined, driver.user.sessionVersion);
    const departure = () => otherStore.departQueue(driver.user.id, driver.enrollment.enrollmentId, driver.user.sessionVersion);
    const results = await overlapping("tezjet_orders", "id", order.id, first === "accept" ? [accepting, departure] : [departure, accepting]);
    const errors = results.filter(result => result.error).map(result => result.error.code);
    assert.equal(errors.length, 1); assert.ok(["QUEUE_BUSY", "PASSENGERS_NOT_BOARDED"].includes(errors[0]), JSON.stringify(errors));
    const entry = await capacityInvariant(otherStore, driver, 4);
    assert.equal(entry.collectionState.phase, "collecting"); assert.equal(entry.inFifo, true); assert.equal(entry.availableSeats, 2);
    assert.equal(entry.pendingOfferOrderId, undefined); assert.equal((await otherStore.getOrder(order.id)).status, "en_route_to_c");
  });
});
