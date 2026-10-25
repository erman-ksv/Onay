import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Use the production HTTP app and adapters. PostgreSQL is mandatory, and
// all application tables are cloned with their real columns/indexes into a private
// schema. No public data is changed and no SQL results are substituted.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `route_order_requests_${randomUUID().replaceAll("-", "")}`;
const applicationName = `route-order-requests-${randomUUID()}`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes", "tezjet_route_order_requests", "tezjet_admin_audit_events"];
const envKeys = ["DATABASE_URL", "TEZJET_STORAGE_ADAPTER", "NODE_ENV", "SESSION_SECRET", "LOG_LEVEL", "REQUIRE_DRIVER_APPROVAL", "PYATAK_CENTER_LAT", "PYATAK_CENTER_LNG", "TEZJET_OFFER_TIMEOUT_SECONDS"];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let moduleDirectory, production, database, adminPool, store, otherStore, server, baseUrl;
let schemaCreated = false;

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required: route-order request recovery regressions must execute real PostgreSQL.");
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
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".route-order-requests-test-"));
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

const pitaks = { aStopCode: "A", bStopCode: "B", radiusMeters: 175 };
const legacyLocation = { lat: 41.3111, lng: 69.2797, timestamp: 1 };
function draftStops() {
  return [
    { code: "A", name: "Питак A администратора", location: { lat: 42.9, lng: 71.3 } },
    { code: "C", name: "Промежуточная остановка" },
    { code: "B", name: "Питак B администратора", location: { lat: 42.94, lng: 71.43 } },
  ];
}
function editStops(route) {
  return route.stops.map(({ id, code, name, location }) => ({
    id, code, name, ...(location ? { location: { lat: location.lat, lng: location.lng } } : {}),
  }));
}
function choiceInput(route, direction = "a_to_b") {
  return { routeId: route.id, direction, expectedUpdatedAt: route.updatedAt };
}
function selection(route, direction = "a_to_b") {
  return { route_id: route.id, direction, expected_updated_at: route.updatedAt };
}
function at(route, direction = "a_to_b") {
  const stop = direction === "a_to_b" ? route.stops[0] : route.stops.at(-1);
  return { ...stop.location, timestamp: Date.now() };
}
function assertError(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  if (code) assert.equal(result.body?.error?.code, code, JSON.stringify(result.body));
}
function availabilityState({ available, eligibleDriverCount }) {
  return { available, eligibleDriverCount };
}
async function request(pathname, { token, method = "GET", body, key } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key === undefined ? {} : { "idempotency-key": key }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const content = await response.text();
  return { status: response.status, body: content ? JSON.parse(content) : undefined };
}
async function fixture(t, adapter = store) {
  const users = [], routes = [];
  if (adapter instanceof production.PostgresStore) t.after(async () => {
    await database.query("DELETE FROM tezjet_route_order_requests WHERE passenger_id = ANY($1::text[])", [users]);
    await database.query("DELETE FROM tezjet_orders WHERE passenger_id = ANY($1::text[]) OR driver_id = ANY($1::text[]) OR offered_driver_id = ANY($1::text[])", [users]);
    await database.query("DELETE FROM tezjet_driver_queue WHERE driver_id = ANY($1::text[])", [users]);
    await database.query("DELETE FROM tezjet_device_registrations WHERE user_id = ANY($1::text[])", [users]);
    await database.query("DELETE FROM tezjet_users WHERE id = ANY($1::text[])", [users]);
    await database.query("DELETE FROM tezjet_routes WHERE id = ANY($1::text[])", [routes]);
  });
  const createUser = async (role = "driver", approval = "approved") => {
    let user = await adapter.createUser({ role, fullName: "Configured orders regression", phoneNumber: `route-order-${randomUUID()}`, locale: "ru" });
    users.push(user.id);
    if (role === "driver" && approval) {
      await adapter.setDriverApproval(user.id, approval);
      user = await adapter.getUser(user.id);
    }
    const token = production.createAccessToken({ sub: user.id, role: user.role, locale: user.locale, sessionVersion: user.sessionVersion, sessionId: randomUUID() });
    return { user: structuredClone(user), token };
  };
  const configured = async (patch = {}, stops = draftStops()) => {
    const id = `route-order-${randomUUID()}`;
    routes.push(id);
    const empty = await adapter.createRoute({ id, name: "Админский маршрут A↔B", pricePerStopKzt: 735, active: true, ...patch });
    return adapter.updateRouteLayout(empty.id, { expectedUpdatedAt: empty.updatedAt, stops, pitaks });
  };
  const enqueue = async (route, direction = "a_to_b", seats = 4, joinedAt = 1) => {
    const driver = await createUser();
    await adapter.setDriverRouteChoice(driver.user.id, choiceInput(route, direction), driver.user.sessionVersion);
    await adapter.joinQueue({
      driverId: driver.user.id, joinedAt, status: "searching", availableSeats: seats,
      lastLocation: at(route, direction), priorityLock: false, inFifo: true, activeOrderIds: [],
    }, driver.user.sessionVersion, choiceInput(route, direction));
    // Enrollment owns joinedAt. Set the FIFO fixture before reserving any
    // offer to make order assertions independent of clock/UUID tie breaking.
    await adapter.updateQueueEntry(driver.user.id, { joinedAt });
    return driver;
  };
  const legacyDriver = async (seats = 4) => {
    const driver = await createUser();
    await adapter.joinQueue({
      driverId: driver.user.id, joinedAt: 0, status: "searching", availableSeats: seats,
      lastLocation: legacyLocation, priorityLock: false, inFifo: true, activeOrderIds: [],
    }, driver.user.sessionVersion);
    await adapter.updateQueueEntry(driver.user.id, { joinedAt: 0 });
    return driver;
  };
  return { adapter, createUser, configured, enqueue, legacyDriver };
}

function bookingBody(route, seats = 2, extra = {}) {
  return { ...selection(route), pickup_location: at(route), seats, ...extra };
}
function bookingInput(passenger, route, seats = 2) {
  return { passengerId: passenger.user.id, passengerPhone: passenger.user.phoneNumber, pickupLocation: at(route), seats };
}
function code(errorCode) {
  return error => error?.code === errorCode;
}
async function once(adapter, passenger, route, key, seats = 2, overrides = {}) {
  return adapter.createRouteOrderOnce({ ...bookingInput(passenger, route, seats), ...overrides }, choiceInput(route), key, passenger.user.sessionVersion);
}

// Exercise the shared adapter contract, including the real PostgreSQL runtime.
for (const adapterName of ["PostgresStore", "MemoryStore"]) {
  test(`${adapterName}: retries preserve one reservation, isolate passengers and return defensive snapshots`, async t => {
    const adapter = adapterName === "PostgresStore" ? store : new production.MemoryStore();
    await adapter.initialize();
    const f = await fixture(t, adapter), route = await f.configured();
    const passenger = await f.createUser("passenger"), stranger = await f.createUser("passenger");
    const firstDriver = await f.enqueue(route, "a_to_b", 4, 1), secondDriver = await f.enqueue(route, "a_to_b", 4, 2);
    const key = randomUUID(), first = await once(adapter, passenger, route, key);
    assert.equal(first.created, true);
    const before = structuredClone(await adapter.getQueueEntry(firstDriver.user.id));
    const replay = await once(adapter, passenger, route, key.toUpperCase(), 2, {
      pickupLocation: { lat: 43.5, lng: 72, timestamp: Date.now() + 1_000 },
    });
    assert.equal(replay.created, false);
    assert.deepEqual(replay.order, first.order);
    assert.deepEqual(await adapter.getQueueEntry(firstDriver.user.id), before);
    assert.equal((await adapter.getQueueEntry(secondDriver.user.id)).pendingOfferOrderId, undefined);
    assert.equal((await adapter.listOrdersForUser(passenger.user.id)).length, 1);
    assert.equal(await adapter.getRouteOrderRequest(stranger.user.id, key, stranger.user.sessionVersion), undefined);
    const other = await once(adapter, stranger, route, key);
    assert.equal(other.created, true, "The same key is scoped to each authenticated passenger.");
    assert.notEqual(other.order.id, first.order.id);
    assert.equal(other.order.offeredDriverId, secondDriver.user.id);
    const receipt = await adapter.getRouteOrderRequest(passenger.user.id, key, passenger.user.sessionVersion);
    assert.match(receipt.requestHash, /^[0-9a-f]{64}$/);
    receipt.order.fare.totalKzt = -1;
    assert.equal((await adapter.getRouteOrderRequest(passenger.user.id, key)).order.fare.totalKzt, first.order.fare.totalKzt);
  });

  test(`${adapterName}: unavailable requests retain no receipt and may retry the same key after a driver joins`, async t => {
    const adapter = adapterName === "PostgresStore" ? store : new production.MemoryStore();
    await adapter.initialize(); const f = await fixture(t, adapter), route = await f.configured();
    const passenger = await f.createUser("passenger"), key = randomUUID();
    assert.equal(await once(adapter, passenger, route, key), undefined);
    assert.equal(await adapter.getRouteOrderRequest(passenger.user.id, key), undefined);
    assert.deepEqual(await adapter.listOrdersForUser(passenger.user.id), []);
    const driver = await f.enqueue(route);
    const result = await once(adapter, passenger, route, key);
    assert.equal(result.created, true);
    assert.equal(result.order.offeredDriverId, driver.user.id);
    assert.equal((await adapter.getQueueEntry(driver.user.id)).availableSeats, 2);
    assert.equal((await once(adapter, passenger, route, key)).created, false);
  });

  test(`${adapterName}: changed seats, direction, version or stops cannot reuse an existing booking key`, async t => {
    const adapter = adapterName === "PostgresStore" ? store : new production.MemoryStore();
    await adapter.initialize(); const f = await fixture(t, adapter), route = await f.configured();
    const passenger = await f.createUser("passenger"), driver = await f.enqueue(route), key = randomUUID();
    await once(adapter, passenger, route, key);
    const before = structuredClone(await adapter.getQueueEntry(driver.user.id));
    for (const [inputPatch, selectionPatch] of [
      [{ seats: 1 }, {}], [{}, { direction: "b_to_a" }],
      [{}, { expectedUpdatedAt: new Date(Date.parse(route.updatedAt) + 1_000).toISOString() }],
      [{}, { pickupStopId: route.stops[1].id }], [{}, { destinationStopId: route.stops[1].id }],
    ]) {
      await assert.rejects(Promise.resolve().then(() => adapter.createRouteOrderOnce(
        { ...bookingInput(passenger, route), ...inputPatch }, { ...choiceInput(route), ...selectionPatch }, key, passenger.user.sessionVersion,
      )), code("IDEMPOTENCY_CONFLICT"));
    }
    assert.deepEqual(await adapter.getQueueEntry(driver.user.id), before);
    assert.equal((await adapter.listOrdersForUser(passenger.user.id)).length, 1);
  });

  test(`${adapterName}: cancelled and completed orders replay their current terminal state without reserving again`, async t => {
    const adapter = adapterName === "PostgresStore" ? store : new production.MemoryStore();
    await adapter.initialize();
    for (const terminal of ["cancelled", "completed"]) {
      const f = await fixture(t, adapter), route = await f.configured();
      const passenger = await f.createUser("passenger"), driver = await f.enqueue(route), key = randomUUID();
      const first = await once(adapter, passenger, route, key);
      if (terminal === "completed") {
        assert.ok(await adapter.acceptOrderOffer(first.order.id, driver.user.id));
        assert.ok(await adapter.transitionOrder(first.order.id, driver.user.id, "arrived_at_c"));
        assert.ok(await adapter.transitionOrder(first.order.id, driver.user.id, "in_transit"));
      }
      const ended = await adapter.transitionOrder(first.order.id, terminal === "cancelled" ? passenger.user.id : driver.user.id, terminal);
      assert.equal(ended.status, terminal);
      const before = structuredClone(await adapter.getQueueEntry(driver.user.id));
      const replay = await once(adapter, passenger, route, key);
      assert.equal(replay.created, false); assert.equal(replay.order.status, terminal);
      assert.equal(replay.order.id, first.order.id);
      assert.deepEqual(await adapter.getQueueEntry(driver.user.id), before);
      assert.equal((await adapter.listOrdersForUser(passenger.user.id)).length, 1);
    }
  });

  test(`${adapterName}: recovery and replay recheck revoked sessions and active passenger role`, async t => {
    const adapter = adapterName === "PostgresStore" ? store : new production.MemoryStore();
    await adapter.initialize(); const f = await fixture(t, adapter), route = await f.configured();
    const passenger = await f.createUser("passenger"), driver = await f.enqueue(route), key = randomUUID();
    const first = await once(adapter, passenger, route, key);
    const refreshed = await adapter.invalidateSessions(passenger.user.id);
    await assert.rejects(Promise.resolve().then(() => once(adapter, passenger, route, key)), code("UNAUTHORIZED"));
    await assert.rejects(Promise.resolve().then(() => adapter.getRouteOrderRequest(passenger.user.id, key, passenger.user.sessionVersion)), code("UNAUTHORIZED"));
    assert.equal((await adapter.getRouteOrderRequest(passenger.user.id, key, refreshed.sessionVersion)).order.id, first.order.id);
    await adapter.transitionOrder(first.order.id, passenger.user.id, "cancelled");
    const switched = await adapter.activateUserRole(passenger.user.id, "driver", refreshed.sessionVersion);
    await assert.rejects(Promise.resolve().then(() => adapter.getRouteOrderRequest(passenger.user.id, key, switched.sessionVersion)), code("FORBIDDEN"));
    await assert.rejects(Promise.resolve().then(() => adapter.createRouteOrderOnce(bookingInput(passenger, route), choiceInput(route), key, switched.sessionVersion)), code("FORBIDDEN"));
    assert.equal((await adapter.getQueueEntry(driver.user.id)).availableSeats, 4);
  });
}

async function waitForBlockedTransactions(count) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await adminPool.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND wait_event_type = 'Lock'",
      [applicationName],
    );
    if (rows[0].count >= count) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${count} real PostgreSQL transactions waiting on locks.`);
}

test("PostgreSQL: two instances concurrently retrying the last seat commit one order and one receipt", { timeout: 10_000 }, async t => {
  const f = await fixture(t), route = await f.configured(), passenger = await f.createUser("passenger");
  const driver = await f.enqueue(route, "a_to_b", 1), key = randomUUID();
  const blocker = await adminPool.connect(), pending = [];
  const settled = action => Promise.resolve().then(action).then(value => ({ value }), error => ({ error }));
  let results;
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT driver_id FROM "${schema}".tezjet_driver_queue WHERE driver_id = $1 FOR UPDATE`, [driver.user.id]);
    pending.push(settled(() => once(store, passenger, route, key, 1)));
    await waitForBlockedTransactions(1);
    pending.push(settled(() => once(otherStore, passenger, route, key, 1)));
    await waitForBlockedTransactions(2);
    await blocker.query("COMMIT");
    results = await Promise.all(pending);
  } finally {
    await blocker.query("ROLLBACK"); blocker.release(); await Promise.all(pending);
  }
  assert.ok(results.every(result => !result.error), results.map(result => result.error?.stack).join("\n"));
  assert.equal(results.filter(result => result.value.created).length, 1);
  assert.equal(results[0].value.order.id, results[1].value.order.id);
  const entry = await store.getQueueEntry(driver.user.id);
  assert.equal(entry.availableSeats, 0); assert.equal(entry.pendingOfferOrderId, results[0].value.order.id);
  assert.equal((await store.listOrdersForUser(passenger.user.id)).length, 1);
  const { rows } = await database.query("SELECT count(*)::int AS count FROM tezjet_route_order_requests WHERE passenger_id = $1 AND request_key = $2", [passenger.user.id, key]);
  assert.equal(rows[0].count, 1);
});

test("PostgreSQL: a new adapter recovers committed orders and an orphan receipt fails closed", async t => {
  const f = await fixture(t), route = await f.configured(), passenger = await f.createUser("passenger");
  await f.enqueue(route); const key = randomUUID(), first = await once(store, passenger, route, key);
  const restarted = new production.PostgresStore(); await restarted.initialize();
  assert.equal((await restarted.getRouteOrderRequest(passenger.user.id, key, passenger.user.sessionVersion)).order.id, first.order.id);
  assert.equal((await once(restarted, passenger, route, key)).created, false);
  await database.query("DELETE FROM tezjet_orders WHERE id = $1", [first.order.id]);
  const before = await store.getQueue();
  await assert.rejects(restarted.getRouteOrderRequest(passenger.user.id, key), code("ORDER_RECOVERY_REQUIRED"));
  await assert.rejects(once(restarted, passenger, route, key), code("ORDER_RECOVERY_REQUIRED"));
  assert.deepEqual(await store.getQueue(), before);
  assert.deepEqual(await store.listOrdersForUser(passenger.user.id), []);
});

test("HTTP: a replay emits no duplicate offer, returns its current booking and never changes GPS", async t => {
  const f = await fixture(t), route = await f.configured(), passenger = await f.createUser("passenger");
  const driver = await f.enqueue(route), key = randomUUID(), body = bookingBody(route);
  const events = [], previousIo = production.app.locals.io;
  production.app.locals.io = { to: room => ({ emit: (event, payload) => events.push({ room, event, payload }) }) };
  t.after(() => { production.app.locals.io = previousIo; });
  const created = await request("/orders/route", { token: passenger.token, method: "POST", key, body });
  assert.equal(created.status, 201, JSON.stringify(created.body)); assert.equal(created.body.replayed, false);
  assert.equal(events.filter(event => event.event === "incoming_order").length, 1);
  const eventCount = events.length, before = structuredClone(await store.getQueueEntry(driver.user.id));
  const savedLocation = (await store.getUser(passenger.user.id)).lastLocation;
  const replay = await request("/orders/route", { token: passenger.token, method: "POST", key, body: {
    ...body, pickup_location: { lat: 43.5, lng: 72, timestamp: Date.now() + 1_000 },
  } });
  assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.order, created.body.order);
  assert.equal(events.length, eventCount);
  assert.deepEqual((await store.getUser(passenger.user.id)).lastLocation, savedLocation);
  assert.deepEqual(await store.getQueueEntry(driver.user.id), before);
  const restored = await request(`/orders/route/requests/${key}`, { token: passenger.token });
  assert.equal(restored.status, 200); assert.deepEqual(restored.body.order, created.body.order);
  assert.deepEqual(Object.keys(restored.body), ["order"], "Private request hashes must not be exposed by recovery.");
  const stranger = await f.createUser("passenger");
  assertError(await request(`/orders/route/requests/${key}`, { token: stranger.token }), 404, "ORDER_REQUEST_NOT_FOUND");
});

test("HTTP: accepted booking replays its saved fare after catalog edits while new keys retain GPS checks", async t => {
  const f = await fixture(t), route = await f.configured(), passenger = await f.createUser("passenger");
  const driver = await f.enqueue(route), key = randomUUID(), body = bookingBody(route);
  const created = await request("/orders/route", { token: passenger.token, method: "POST", key, body });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const accepted = await store.acceptOrderOffer(created.body.order.id, driver.user.id);
  assert.ok(accepted);
  await store.updateRoute(route.id, { active: false, pricePerStopKzt: 5_000 });
  const saved = (await store.getUser(passenger.user.id)).lastLocation;
  const replay = await request("/orders/route", { token: passenger.token, method: "POST", key, body: {
    ...body, pickup_location: { lat: 43.5, lng: 72, timestamp: Date.now() + 1_000 },
  } });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.order.id, accepted.id); assert.equal(replay.body.order.status, accepted.status);
  assert.deepEqual(replay.body.order.fare, created.body.order.fare);
  assert.deepEqual((await store.getUser(passenger.user.id)).lastLocation, saved);
  assertError(await request("/orders/route", { token: passenger.token, method: "POST", key: randomUUID(), body: {
    ...body, pickup_location: { ...at(route), isMocked: true },
  } }), 422, "MOCKED_GPS");
});

test("HTTP: malformed keys and conflicting intents fail before mutating GPS or orders", async t => {
  const f = await fixture(t), route = await f.configured(), passenger = await f.createUser("passenger");
  const driver = await f.enqueue(route), body = bookingBody(route), key = randomUUID();
  for (const invalid of ["", "not-a-uuid", "0".repeat(1_000), `${key}, ${randomUUID()}`]) {
    assertError(await request("/orders/route", { token: passenger.token, method: "POST", key: invalid, body }), 400, "INVALID_IDEMPOTENCY_KEY");
  }
  assert.equal((await store.getUser(passenger.user.id)).lastLocation, undefined);
  assert.deepEqual(await store.listOrdersForUser(passenger.user.id), []);
  const created = await request("/orders/route", { token: passenger.token, method: "POST", key, body });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const location = (await store.getUser(passenger.user.id)).lastLocation, queue = await store.getQueueEntry(driver.user.id);
  assertError(await request("/orders/route", { token: passenger.token, method: "POST", key, body: {
    ...body, seats: 1, pickup_location: { lat: 43.5, lng: 72, timestamp: Date.now() + 1_000 },
  } }), 409, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual((await store.getUser(passenger.user.id)).lastLocation, location);
  assert.deepEqual(await store.getQueueEntry(driver.user.id), queue);
  assertError(await request(`/orders/route/requests/${key}`, {}), 401, "UNAUTHORIZED");
  await store.invalidateSessions(passenger.user.id);
  assertError(await request(`/orders/route/requests/${key}`, { token: passenger.token }), 401, "UNAUTHORIZED");
  assertError(await request("/orders/route", { token: passenger.token, method: "POST", key, body }), 401, "UNAUTHORIZED");
});

test("HTTP: unavailable requests can retry the same key and old clients without a key keep their contract", async t => {
  const f = await fixture(t), route = await f.configured(), passenger = await f.createUser("passenger");
  const body = bookingBody(route), key = randomUUID();
  assertError(await request("/orders/route", { token: passenger.token, method: "POST", key, body }), 409, "NO_DRIVERS");
  assertError(await request(`/orders/route/requests/${key}`, { token: passenger.token }), 404, "ORDER_REQUEST_NOT_FOUND");
  await f.enqueue(route);
  const retried = await request("/orders/route", { token: passenger.token, method: "POST", key, body: {
    ...body, pickup_location: { ...body.pickup_location, timestamp: body.pickup_location.timestamp + 1_000 },
  } });
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  assert.equal(retried.body.replayed, false);
  const oldPassenger = await f.createUser("passenger"); await f.enqueue(route);
  const oldClient = await request("/orders/route", { token: oldPassenger.token, method: "POST", body: bookingBody(route) });
  assert.equal(oldClient.status, 201, JSON.stringify(oldClient.body));
  assert.equal(Object.hasOwn(oldClient.body, "replayed"), false);
});

test("HTTP: authenticated passengers mint independent request keys without creating bookings or reservations", async t => {
  const f = await fixture(t), passenger = await f.createUser("passenger"), driver = await f.createUser();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assertError(await request("/orders/route/request-key"), 401, "UNAUTHORIZED");
  assertError(await request("/orders/route/request-key", { token: driver.token }), 403, "FORBIDDEN");
  const first = await request("/orders/route/request-key", { token: passenger.token });
  const second = await request("/orders/route/request-key", { token: passenger.token });
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.match(first.body.request_key, uuid); assert.match(second.body.request_key, uuid);
  assert.notEqual(first.body.request_key, second.body.request_key);
  assert.deepEqual(Object.keys(first.body), ["request_key"]);
  assert.deepEqual(await store.listOrdersForUser(passenger.user.id), []);
  const { rows } = await database.query("SELECT count(*)::int AS count FROM tezjet_route_order_requests WHERE passenger_id = $1", [passenger.user.id]);
  assert.equal(rows[0].count, 0);
});
