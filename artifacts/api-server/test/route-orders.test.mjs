import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Use the production HTTP app and adapters. PostgreSQL is mandatory, and
// all six tables are cloned with their real columns/indexes into a private
// schema. No public data is changed and no SQL results are substituted.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `route_orders_${randomUUID().replaceAll("-", "")}`;
const applicationName = `route-orders-${randomUUID()}`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes"];
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
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".route-orders-test-"));
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
async function request(pathname, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const content = await response.text();
  return { status: response.status, body: content ? JSON.parse(content) : undefined };
}
async function fixture(t, adapter = store) {
  const users = [], routes = [];
  if (adapter instanceof production.PostgresStore) t.after(async () => {
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
  const configured = async (patch = {}) => {
    const id = `route-order-${randomUUID()}`;
    routes.push(id);
    const empty = await adapter.createRoute({ id, name: "Админский маршрут A↔B", pricePerStopKzt: 735, active: true, ...patch });
    return adapter.updateRouteLayout(empty.id, { expectedUpdatedAt: empty.updatedAt, stops: draftStops(), pitaks });
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
async function createHttp(passenger, route, direction = "a_to_b", seats = 2, extra = {}) {
  return request("/orders/route", { token: passenger.token, method: "POST", body: {
    ...selection(route, direction), pickup_location: at(route, direction), seats, ...extra,
  } });
}
async function availabilityHttp(passenger, route, direction = "a_to_b", seats = 2, extra = {}) {
  return request(`/orders/route/availability?${new URLSearchParams({ ...selection(route, direction), seats: String(seats), ...extra })}`, { token: passenger.token });
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
  throw new Error(`Expected ${count} real PostgreSQL transactions waiting on row locks.`);
}
function settlement(action) {
  return Promise.resolve().then(action).then(value => ({ value }), error => ({ error }));
}
async function overlapping(table, idColumn, id, actions) {
  assert.ok(["tezjet_orders", "tezjet_driver_queue", "tezjet_routes", "tezjet_users"].includes(table));
  assert.ok(["id", "driver_id"].includes(idColumn));
  const blocker = await adminPool.connect(), pending = [];
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT "${idColumn}" FROM "${schema}"."${table}" WHERE "${idColumn}" = $1 FOR UPDATE`, [id]);
    for (const action of actions) {
      pending.push(settlement(action));
      await waitForBlockedTransactions(pending.length);
    }
    await blocker.query("COMMIT");
    return await Promise.all(pending);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await Promise.all(pending);
  }
}
async function createStored(f, passenger, route, direction = "a_to_b", seats = 2, creator = f.adapter) {
  return creator.createRouteOrderWithOffer({
    passengerId: passenger.user.id, passengerPhone: passenger.user.phoneNumber,
    pickupLocation: at(route, direction), seats,
  }, choiceInput(route, direction), passenger.user.sessionVersion);
}
async function assertIdle(adapter, driver, seats = 4, inFifo = true) {
  const entry = await adapter.getQueueEntry(driver.user.id);
  assert.equal(entry.pendingOfferOrderId, undefined);
  assert.equal(entry.availableSeats, seats, "Each reservation must return exactly once.");
  assert.deepEqual(entry.activeOrderIds, []);
  assert.equal(entry.currentOrderId, undefined);
  assert.equal(entry.inFifo, inFifo);
  return entry;
}
async function assertPending(adapter, driver, order, seats = 4) {
  const entry = await adapter.getQueueEntry(driver.user.id);
  assert.equal(entry.pendingOfferOrderId, order.id);
  assert.equal(entry.availableSeats, seats - order.seats, "The offer owns the seat debit.");
  assert.deepEqual(entry.activeOrderIds, []);
  assert.equal(entry.currentOrderId, undefined);
  assert.equal(order.status, "searching");
  assert.equal(order.driverId, undefined);
  assert.equal(order.offeredDriverId, driver.user.id);
  return entry;
}
async function assertFreshEnrollmentRequired(adapter, driver) {
  const detached = structuredClone(await adapter.getQueueEntry(driver.user.id));
  assert.equal(detached.inFifo, false);
  for (const restore of [
    () => adapter.returnDriverToFifo(driver.user.id),
    () => adapter.updateQueueEntry(driver.user.id, { inFifo: true }),
  ]) {
    await assert.rejects(async () => restore(), error => error.code === "QUEUE_BUSY");
    assert.deepEqual(await adapter.getQueueEntry(driver.user.id), detached,
      "A generic FIFO restore must preserve the completed or cancelled configured trip's queue snapshot.");
  }
}

test("HTTP A→B and B→A orders derive the admin endpoints and fare, reserve their own lane, and survive a second store", async t => {
  for (const direction of ["a_to_b", "b_to_a"]) {
    await t.test(direction, async child => {
      const f = await fixture(child), route = await f.configured();
      const passenger = await f.createUser("passenger"), driver = await f.enqueue(route, direction);
      const availability = await availabilityHttp(passenger, route, direction);
      assert.equal(availability.status, 200, JSON.stringify(availability.body));
      assert.equal(availability.body.available, true); assert.equal(availability.body.eligible_driver_count, 1);
      assert.equal(availability.body.offer_timeout_seconds, 60);
      const created = await createHttp(passenger, route, direction);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const order = created.body.order, pickup = direction === "a_to_b" ? route.stops[0] : route.stops.at(-1);
      const destination = direction === "a_to_b" ? route.stops.at(-1) : route.stops[0];
      assert.equal(order.pickup_point, direction === "a_to_b" ? "A" : "B");
      assert.equal(order.route_context.routeId, route.id); assert.equal(order.route_context.direction, direction);
      assert.equal(order.route_context.routeUpdatedAt, route.updatedAt);
      assert.equal(order.route_context.pitak, order.pickup_point);
      assert.equal(order.fare.routeId, route.id); assert.equal(order.fare.currency, "KZT");
      assert.equal(order.fare.pricePerStopKzt, 735); assert.equal(order.fare.totalKzt, 1470);
      assert.equal(order.fare.pickupStop.id, pickup.id); assert.equal(order.fare.destinationStop.id, destination.id);
      assert.equal(order.destination, destination.name);
      assert.deepEqual(order.route_stops.map(stop => stop.code), direction === "a_to_b" ? ["A", "C", "B"] : ["B", "C", "A"]);
      assert.deepEqual(order.fare.stops, order.route_stops);
      assert.equal(order.offered_driver_id, driver.user.id);
      assert.equal(created.body.offer.smart_pooling, false);
      const durable = await otherStore.getOrder(order.id);
      assert.equal(durable.routeContext.routeId, route.id); assert.equal(durable.routeContext.direction, direction);
      assert.deepEqual(durable.fare, order.fare);
      await assertPending(otherStore, driver, durable);
      const restored = await request(`/orders/${order.id}`, { token: passenger.token });
      assert.equal(restored.status, 200); assert.deepEqual(restored.body.order, order);
    });
  }
});

test("both adapters keep opposite directions, other routes, legacy queues and insufficient seats out of configured availability", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize(); const f = await fixture(t, adapter), route = await f.configured(), other = await f.configured();
    const passenger = await f.createUser("passenger");
    await f.enqueue(route, "b_to_a", 8, 0);
    await f.enqueue(other, "a_to_b", 8, 0);
    await f.legacyDriver(8);
    const small = await f.enqueue(route, "a_to_b", 1, 0);
    assert.deepEqual(await adapter.getRouteOrderAvailability(choiceInput(route), 2), { available: false, eligibleDriverCount: 0 });
    assert.equal(await createStored(f, passenger, route), undefined);
    assert.deepEqual(await adapter.listOrdersForUser(passenger.user.id), [], "Unavailable requests must not persist searching orders.");
    await assertIdle(adapter, small, 1);
    const correct = await f.enqueue(route, "a_to_b", 8, 100);
    assert.deepEqual(await adapter.getRouteOrderAvailability(choiceInput(route), 8), { available: true, eligibleDriverCount: 1 });
    const order = await createStored(f, passenger, route, "a_to_b", 8);
    assert.equal(order.offeredDriverId, correct.user.id);
    await assertPending(adapter, correct, order, 8);
    assert.deepEqual(await adapter.getRouteOrderAvailability(choiceInput(route), 1), { available: true, eligibleDriverCount: 1 },
      "The separate one-seat driver remains eligible after another driver reserves an eight-seat offer.");
    const smallOrder = await createStored(f, passenger, route, "a_to_b", 1);
    assert.equal(smallOrder.offeredDriverId, small.user.id);
    await assertPending(adapter, small, smallOrder, 1);
    await assertPending(adapter, correct, order, 8);
    assert.deepEqual(await adapter.getRouteOrderAvailability(choiceInput(route), 1), { available: false, eligibleDriverCount: 0 },
      "Neither driver may own two simultaneous pending offers.");
  }
});

test("both adapters use strict configured FIFO before location or priorityLock and advance rejection only within its own lane", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize(); const f = await fixture(t, adapter), route = await f.configured();
    const passenger = await f.createUser("passenger");
    const first = await f.enqueue(route, "a_to_b", 4, 1), later = await f.enqueue(route, "a_to_b", 4, 2);
    const opposite = await f.enqueue(route, "b_to_a", 8, 0);
    await adapter.updateQueueEntry(later.user.id, { priorityLock: true });
    assert.equal(await adapter.getQueuePosition(first.user.id), 1,
      "Configured queue position must use the same strict FIFO order as offer selection.");
    assert.equal(await adapter.getQueuePosition(later.user.id), 2,
      "A priority hint cannot make a later configured driver appear first in the queue.");
    const order = await createStored(f, passenger, route);
    assert.equal(order.offeredDriverId, first.user.id, "Priority hints and a different pitak cannot bypass configured FIFO.");
    const rejected = await adapter.rejectOrderOffer(order.id, first.user.id);
    assert.equal(rejected.previousDriverId, first.user.id);
    assert.equal(rejected.order.offeredDriverId, later.user.id);
    assert.deepEqual(rejected.order.attemptedDriverIds, [first.user.id, later.user.id]);
    await assertIdle(adapter, first); await assertIdle(adapter, opposite, 8);
    await assertPending(adapter, later, rejected.order);
    const ended = await adapter.rejectOrderOffer(order.id, later.user.id);
    assert.equal(ended.order.offeredDriverId, undefined); assert.equal(ended.order.offerExpiresAt, undefined);
    await assertIdle(adapter, later);
    assert.equal(await adapter.dispatchOrderOffer(order.id), undefined, "A rejected driver must not receive this same order again.");
  }
});

test("both adapters preserve the normal 60-second offer deadline and release expired seats before the next configured FIFO offer", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize(); const f = await fixture(t, adapter), route = await f.configured();
    const passenger = await f.createUser("passenger"), first = await f.enqueue(route), second = await f.enqueue(route, "a_to_b", 4, 2);
    const order = await createStored(f, passenger, route), expiry = order.offerExpiresAt;
    assert.equal(expiry - Date.parse(order.createdAt), 60_000);
    assert.equal(await adapter.dispatchOrderOffer(order.id, expiry - 1), undefined);
    await assertPending(adapter, first, order);
    assert.equal(await adapter.acceptOrderOffer(order.id, first.user.id, expiry), undefined, "The deadline itself is expired.");
    const advanced = await adapter.dispatchOrderOffer(order.id, expiry);
    assert.equal(advanced.previousDriverId, first.user.id); assert.equal(advanced.order.offeredDriverId, second.user.id);
    assert.equal(advanced.order.offerExpiresAt, expiry + 60_000);
    await assertIdle(adapter, first); await assertPending(adapter, second, advanced.order);
    assert.equal(await adapter.rejectOrderOffer(order.id, first.user.id, expiry + 1), undefined);
    assert.equal(await adapter.acceptOrderOffer(order.id, first.user.id, expiry + 1), undefined);
    assert.equal((await adapter.getQueueEntry(second.user.id)).availableSeats, 2);
  }
});

test("HTTP configured trips accept the existing pickup statuses, complete with one seat return, and require fresh enrollment before another offer", async t => {
  const f = await fixture(t), route = await f.configured(), passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
  const created = await createHttp(passenger, route), id = created.body.order?.id;
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const tripStart = Date.now() - 3_600_000;
  await store.updateUser(driver.user.id, { lastLocation: { ...at(route), timestamp: tripStart } });
  const accepted = await request(`/orders/${id}/accept`, { token: driver.token, method: "POST" });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body)); assert.equal(accepted.body.order.status, "en_route_to_c");
  assert.equal(accepted.body.seat_lock_minutes, 7);
  assert.equal((await store.getQueueEntry(driver.user.id)).availableSeats, 2, "Acceptance must not debit the offered seats again.");
  assertError(await request(`/orders/${id}/accept`, { token: driver.token, method: "POST" }), 409);
  for (const status of ["arrived_at_c", "in_transit", "completed"]) {
    const updated = await request(`/orders/${id}/status`, { token: driver.token, method: "PATCH", body: { status } });
    assert.equal(updated.status, 200, JSON.stringify(updated.body)); assert.equal(updated.body.order.status, status);
    assert.equal(updated.body.order.route_context.routeId, route.id);
    if (status === "in_transit") {
      const moved = await request("/queue/location", { token: driver.token, method: "PATCH", body: { location: at(route, "b_to_a") } });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.equal(moved.body.entry.lastLocation.lat, route.stops.at(-1).location.lat, "An accepted trip can send GPS after leaving its origin pitak.");
    }
  }
  await assertIdle(otherStore, driver, 4, false);
  assert.equal((await availabilityHttp(passenger, route)).body.available, false, "A finished driver is not silently teleported back to the origin pitak FIFO.");
  assertError(await request(`/orders/${id}/status`, { token: driver.token, method: "PATCH", body: { status: "completed" } }), 409);
  await assertIdle(store, driver, 4, false);
  await assertFreshEnrollmentRequired(store, driver);
  assert.equal((await request("/queue/leave", { token: driver.token, method: "DELETE" })).status, 204);
  const joined = await request("/queue/join", { token: driver.token, method: "POST", body: {
    route_choice: selection(route), location: { ...at(route), timestamp: Date.now() + 3_600_000 }, available_seats: 4,
  } });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  assert.equal((await availabilityHttp(passenger, route)).body.available, true);
});

test("both adapters release configured pending and accepted cancellations exactly once without crossing lanes", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize(); const f = await fixture(t, adapter), route = await f.configured();
    const passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
    let order = await createStored(f, passenger, route);
    const cancelledOffer = await adapter.transitionOrder(order.id, passenger.user.id, "cancelled", "searching");
    assert.equal(cancelledOffer.status, "cancelled"); await assertIdle(adapter, driver);
    assert.equal(await adapter.transitionOrder(order.id, passenger.user.id, "cancelled"), undefined);
    await assertIdle(adapter, driver);
    order = await createStored(f, passenger, route);
    const accepted = await adapter.acceptOrderOffer(order.id, driver.user.id);
    assert.equal(accepted.status, "en_route_to_c");
    assert.equal((await adapter.getQueueEntry(driver.user.id)).availableSeats, 2);
    const cancelledTrip = await adapter.transitionOrder(order.id, passenger.user.id, "cancelled", accepted.status);
    assert.equal(cancelledTrip.status, "cancelled"); await assertIdle(adapter, driver);
    assert.equal(await adapter.transitionOrder(order.id, driver.user.id, "cancelled"), undefined);
    await assertIdle(adapter, driver);
  }
});

test("both adapters recheck live admin versions and release a stale pending offer while an accepted trip keeps its snapshot", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize(); const f = await fixture(t, adapter), route = await f.configured();
    const passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
    const offered = await createStored(f, passenger, route);
    const changed = await adapter.updateRoute(route.id, { pricePerStopKzt: 900 });
    assert.notEqual(changed.updatedAt, route.updatedAt);
    await assert.rejects(async () => adapter.getRouteOrderAvailability(choiceInput(route), 2), error => error.code === "ROUTE_CHANGED");
    await assert.rejects(async () => createStored(f, passenger, route), error => error.code === "ROUTE_CHANGED");
    assert.equal(await adapter.acceptOrderOffer(offered.id, driver.user.id), undefined, "A price/layout/version edit invalidates a pending offer before acceptance.");
    const released = await adapter.dispatchOrderOffer(offered.id);
    assert.equal(released.previousDriverId, driver.user.id); assert.equal(released.order.offeredDriverId, undefined);
    assert.equal(released.order.status, "searching"); await assertIdle(adapter, driver);
    assert.deepEqual(await adapter.getRouteOrderAvailability(choiceInput(changed), 2), { available: false, eligibleDriverCount: 0 }, "An old queue snapshot cannot receive a current-version order.");
    await adapter.leaveQueue(driver.user.id);
    const fresh = await f.enqueue(changed);
    const acceptedOffer = await createStored(f, passenger, changed);
    const accepted = await adapter.acceptOrderOffer(acceptedOffer.id, fresh.user.id);
    assert.equal(accepted.fare.totalKzt, 1800);
    await adapter.updateRoute(route.id, { active: false });
    for (const status of ["arrived_at_c", "in_transit", "completed"]) {
      const result = await adapter.transitionOrder(accepted.id, fresh.user.id, status);
      assert.equal(result.status, status); assert.equal(result.fare.totalKzt, 1800);
      assert.equal(result.routeContext.routeUpdatedAt, changed.updatedAt, "Accepted trips retain the agreed route and fare snapshot.");
    }
    await assertIdle(adapter, fresh, 4, false);
  }
});

test("both adapters reject disabled/deleted routes and forged pickups without inserting configured orders", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize(); const f = await fixture(t, adapter);
    for (const mutation of ["inactive", "deleted", "outside", "mocked", "missing", "null"]) {
      const route = await f.configured(), passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
      if (mutation === "inactive") await adapter.updateRoute(route.id, { active: false });
      if (mutation === "deleted") await adapter.deleteRoute(route.id);
      let pickupLocation = at(route);
      if (mutation === "outside") pickupLocation = at(route, "b_to_a");
      if (mutation === "mocked") pickupLocation.isMocked = true;
      if (mutation === "missing") pickupLocation = undefined;
      if (mutation === "null") pickupLocation = null;
      await assert.rejects(async () => adapter.createRouteOrderWithOffer({
        passengerId: passenger.user.id, passengerPhone: passenger.user.phoneNumber, pickupLocation, seats: 2,
      }, choiceInput(route), passenger.user.sessionVersion));
      assert.deepEqual(await adapter.listOrdersForUser(passenger.user.id), []);
      await assertIdle(adapter, driver);
    }
  }
});

test("HTTP configured request validation rejects client fares, geometry, aliases, duplicate query selectors and invalid GPS without reserving seats", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await f.enqueue(route);
  const invalidBodies = [
    { fare: { totalKzt: 1 } }, { destination: "Forged endpoint" }, { pickup_point: "B" },
    { route_context: { routeId: route.id, pitak: "B", radiusMeters: 500000 } },
    { route_stops: ["A", "B"] }, { pickup_stop: "C" }, { destination_stop: "C" },
    { coordinates: at(route) }, { location: at(route) },
    { pickup_location: { ...at(route), lat: String(route.stops[0].location.lat) } },
    { pickup_location: { ...at(route), lng: null } },
    { pickup_location: [] }, { pickup_location: { ...at(route), timestamp: "yesterday" } },
    { pickup_location: { ...at(route), timestamp: -1 } },
    { pickup_location: { ...at(route), isMocked: "false" } },
    { direction: "north" }, { expected_updated_at: "" }, { route_id: [] },
    { seats: 0 }, { seats: 9 }, { seats: 1.5 }, { seats: "2" },
  ];
  for (const extra of invalidBodies) {
    const passenger = await f.createUser("passenger");
    const numericCoordinateError = extra.pickup_location && !Array.isArray(extra.pickup_location) &&
      (typeof extra.pickup_location.lat !== "number" || typeof extra.pickup_location.lng !== "number" ||
        (extra.pickup_location.timestamp !== undefined && (typeof extra.pickup_location.timestamp !== "number" || extra.pickup_location.timestamp <= 0)));
    assertError(await createHttp(passenger, route, "a_to_b", 2, extra), numericCoordinateError ? 422 : 400, numericCoordinateError ? "INVALID_COORDINATES" : "VALIDATION_ERROR");
    assert.deepEqual(await store.listOrdersForUser(passenger.user.id), []);
    assert.equal((await store.getUser(passenger.user.id)).lastLocation, undefined, "Strict validation must precede the GPS-account write.");
  }
  const passenger = await f.createUser("passenger");
  assertError(await createHttp(passenger, route, "a_to_b", 2, { pickup_location: { ...at(route), isMocked: true } }), 422, "MOCKED_GPS");
  const outside = await f.createUser("passenger");
  assertError(await createHttp(outside, route, "a_to_b", 2, { pickup_location: at(route, "b_to_a") }), 422, "OUTSIDE_PICKUP_GEOFENCE");
  assertError(await availabilityHttp(passenger, route, "a_to_b", 2, { route_context: "forged" }), 400, "VALIDATION_ERROR");
  assertError(await request(`/orders/route/availability?${new URLSearchParams(selection(route))}&seats=2&route_id=${route.id}`, { token: passenger.token }), 400, "VALIDATION_ERROR");
  await assertIdle(store, driver);
});

test("HTTP configured endpoints require an authenticated passenger and expose only active configured catalog entries", async t => {
  const f = await fixture(t), route = await f.configured(), disabled = await f.configured({ active: false });
  const passenger = await f.createUser("passenger"), driver = await f.createUser(), admin = await f.createUser("admin");
  assertError(await request("/orders/routes"), 401);
  for (const actor of [driver, admin]) {
    assertError(await request("/orders/routes", { token: actor.token }), 403);
    assertError(await availabilityHttp(actor, route), 403);
    assertError(await createHttp(actor, route), 403);
  }
  const catalog = await request("/orders/routes", { token: passenger.token });
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  const configured = catalog.body.routes.find(candidate => candidate.id === route.id);
  assert.ok(configured); assert.equal(configured.updatedAt, route.updatedAt);
  assert.equal(configured.pricePerStopKzt, 735); assert.deepEqual(configured.pitaks, route.pitaks);
  assert.deepEqual(configured.stops, route.stops);
  assert.equal(catalog.body.routes.some(candidate => candidate.id === disabled.id), false);
  assert.equal(catalog.body.routes.some(candidate => candidate.id === "pyatak"), false, "Legacy route without configured pitaks is not a configured route catalog entry.");
  assertError(await createHttp(passenger, route), 409, "NO_DRIVERS");
  assert.deepEqual(await store.listOrdersForUser(passenger.user.id), []);
});

test("configured order snapshots and generic patch methods cannot alter the live route, fare, seats or assigned context", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize(); const f = await fixture(t, adapter), route = await f.configured();
    const passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
    const offered = await createStored(f, passenger, route), id = offered.id;
    const canonical = structuredClone(await adapter.getOrder(id));
    const snapshots = [offered, await adapter.getOrder(id), ...(await adapter.listOrdersForUser(passenger.user.id)), ...(await adapter.listOrders()).filter(order => order.id === id)];
    for (const snapshot of snapshots) {
      snapshot.routeContext.center.lat = 0; snapshot.routeContext.direction = "b_to_a";
      snapshot.fare.totalKzt = 1; snapshot.fare.pickupStop.name = "Forged stop";
      snapshot.routeStops[0].code = "X"; snapshot.seats = 99;
      assert.deepEqual(await adapter.getOrder(id), canonical, "Returned configured snapshots must not alias live order state.");
    }
    const accepted = await adapter.acceptOrderOffer(id, driver.user.id);
    assert.ok(accepted); const assigned = structuredClone(await adapter.getOrder(id));
    for (const patch of [
      { routeContext: undefined }, { routeContext: { ...assigned.routeContext, direction: "b_to_a" } },
      { fare: { ...assigned.fare, totalKzt: 1 } }, { seats: 8 }, { pickupPoint: "C" },
      { pickupLocation: at(route, "b_to_a") }, { routeStops: [] }, { destination: "Forged stop" },
      { status: "completed" }, { driverId: undefined }, { seatLockExpiresAt: 0 },
      { attemptedDriverIds: [] }, { offeredDriverId: undefined }, { offerExpiresAt: Date.now() + 60_000 },
    ]) {
      await assert.rejects(async () => adapter.updateOrder(id, patch));
      assert.deepEqual(await adapter.getOrder(id), assigned, "Generic patches must not rewrite the immutable configured trip contract after acceptance.");
    }
    const ownedQueue = structuredClone(await adapter.getQueueEntry(driver.user.id));
    for (const patch of [
      { availableSeats: 8 }, { currentOrderId: undefined }, { activeOrderIds: [] },
      { status: "searching" }, { inFifo: false }, { pendingOfferOrderId: "forged" },
      { seatLockExpiresAt: undefined }, { driverId: "forged" }, { joinedAt: 0 }, { priorityLock: false },
    ]) {
      await assert.rejects(async () => adapter.updateQueueEntry(driver.user.id, patch));
      assert.deepEqual(await adapter.getQueueEntry(driver.user.id), ownedQueue, "Generic queue patches cannot discard an assigned configured trip's seat ownership.");
    }
    assert.equal(await adapter.claimOrderForDriver(id, driver.user.id, {}, {}), undefined);
  }
});

test("both adapters forbid generic creation from bypassing configured order validation", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize(); const f = await fixture(t, adapter), route = await f.configured();
    const passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
    const configured = await createStored(f, passenger, route);
    const { id, createdAt, updatedAt, ...input } = configured;
    await adapter.transitionOrder(id, passenger.user.id, "cancelled");
    for (const creator of ["createOrder", "createOrderWithOffer"]) {
      await assert.rejects(async () => adapter[creator]({ ...input, offeredDriverId: undefined, offerExpiresAt: undefined }, passenger.user.sessionVersion));
      await assert.rejects(async () => adapter[creator]({ ...input, pickupPoint: "C", offeredDriverId: undefined, offerExpiresAt: undefined }, passenger.user.sessionVersion));
      await assert.rejects(async () => adapter[creator]({ ...input, routeContext: undefined, offeredDriverId: undefined, offerExpiresAt: undefined }, passenger.user.sessionVersion));
    }
    assert.equal((await adapter.listOrdersForUser(passenger.user.id)).length, 1, "Bypass attempts must insert no additional orders.");
    await assertIdle(adapter, driver);
  }
});

test("real PostgreSQL overlapping configured creations reserve one offer slot and persist only the winning order", { timeout: 15_000 }, async t => {
  const f = await fixture(t), route = await f.configured(), passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
  const results = await overlapping("tezjet_driver_queue", "driver_id", driver.user.id, [
    () => createStored(f, passenger, route, "a_to_b", 2, otherStore),
    () => createStored(f, passenger, route),
  ]);
  for (const result of results) if (result.error) throw result.error;
  const winners = results.map(result => result.value).filter(Boolean);
  assert.equal(winners.length, 1);
  const orders = await otherStore.listOrdersForUser(passenger.user.id);
  assert.deepEqual(orders.map(order => order.id), [winners[0].id], "The losing transaction must not insert a stranded waiting order.");
  await assertPending(otherStore, driver, winners[0]);
  assert.deepEqual(await otherStore.getRouteOrderAvailability(choiceInput(route), 1), { available: false, eligibleDriverCount: 0 });
});

test("real PostgreSQL admin update ordered before configured HTTP creation invalidates its cached route version without a seat debit", { timeout: 20_000 }, async t => {
  const f = await fixture(t), route = await f.configured(), passenger = await f.createUser("passenger"), driver = await f.enqueue(route), admin = await f.createUser("admin");
  const results = await overlapping("tezjet_routes", "id", route.id, [
    () => request(`/admin/routes/${route.id}/layout`, { token: admin.token, method: "PUT", body: {
      expected_updated_at: route.updatedAt,
      stops: editStops(route).map((stop, i) => ({ ...stop, name: i === 1 ? "Остановка после административной правки" : stop.name })),
      pitaks: { a_stop_code: pitaks.aStopCode, b_stop_code: pitaks.bStopCode, radius_meters: pitaks.radiusMeters },
    } }),
    () => createHttp(passenger, route),
  ]);
  for (const result of results) if (result.error) throw result.error;
  assert.equal(results[0].value.status, 200, JSON.stringify(results[0].value.body));
  assertError(results[1].value, 409, "ROUTE_CHANGED");
  assert.deepEqual(await otherStore.listOrdersForUser(passenger.user.id), []);
  await assertIdle(otherStore, driver);
  assert.notEqual((await otherStore.getRoute(route.id)).updatedAt, route.updatedAt);
});

test("real HTTP configured creation rechecks the passenger session and active mode after an observed account row-lock wait", { timeout: 20_000 }, async t => {
  for (const mutation of ["session", "role"]) {
    await t.test(mutation, async child => {
      const f = await fixture(child), route = await f.configured(), passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
      const blocker = await adminPool.connect(); let pending;
      try {
        await blocker.query("BEGIN");
        await blocker.query(`SELECT id FROM "${schema}".tezjet_users WHERE id = $1 FOR UPDATE`, [passenger.user.id]);
        pending = createHttp(passenger, route);
        await waitForBlockedTransactions(1);
        if (mutation === "session") await blocker.query(`UPDATE "${schema}".tezjet_users SET session_version = session_version + 1 WHERE id = $1`, [passenger.user.id]);
        if (mutation === "role") await blocker.query(`UPDATE "${schema}".tezjet_users SET role = 'driver', roles = '["driver","passenger"]'::jsonb WHERE id = $1`, [passenger.user.id]);
        await blocker.query("COMMIT");
        assertError(await pending, mutation === "session" ? 401 : 403, mutation === "session" ? "UNAUTHORIZED" : "FORBIDDEN");
        assert.deepEqual(await otherStore.listOrdersForUser(passenger.user.id), []);
        await assertIdle(otherStore, driver);
      } finally {
        await blocker.query("ROLLBACK"); blocker.release();
        if (pending) await pending;
      }
    });
  }
});

function freshToken(user) {
  return production.createAccessToken({ sub: user.id, role: user.role, locale: user.locale, sessionVersion: user.sessionVersion, sessionId: randomUUID() });
}
test("real HTTP configured acceptance, rejection and pickup status cannot commit after the authenticated driver session is revoked during an order lock wait", { timeout: 20_000 }, async t => {
  for (const operation of ["accept", "reject", "status"]) {
    await t.test(operation, async child => {
      const f = await fixture(child), route = await f.configured(), passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
      const offered = await createStored(f, passenger, route), id = offered.id;
      if (operation === "status") assert.ok(await store.acceptOrderOffer(id, driver.user.id));
      const canonicalOrder = structuredClone(await store.getOrder(id)), canonicalQueue = structuredClone(await store.getQueueEntry(driver.user.id));
      const blocker = await adminPool.connect(); let pending;
      try {
        await blocker.query("BEGIN");
        await blocker.query(`SELECT id FROM "${schema}".tezjet_orders WHERE id = $1 FOR UPDATE`, [id]);
        pending = request(`/orders/${id}/${operation}`, { token: driver.token, method: operation === "status" ? "PATCH" : "POST", body: operation === "status" ? { status: "arrived_at_c" } : undefined });
        await waitForBlockedTransactions(1);
        const live = await otherStore.invalidateSessions(driver.user.id);
        assert.equal(live.sessionVersion, driver.user.sessionVersion + 1);
        await blocker.query("COMMIT");
        assertError(await pending, 401, "UNAUTHORIZED");
        assert.deepEqual(await otherStore.getOrder(id), canonicalOrder);
        assert.deepEqual(await otherStore.getQueueEntry(driver.user.id), canonicalQueue, "Revocation must preserve pending and accepted seat ownership.");
        const retried = await request(`/orders/${id}/${operation}`, { token: freshToken(live), method: operation === "status" ? "PATCH" : "POST", body: operation === "status" ? { status: "arrived_at_c" } : undefined });
        assert.equal(retried.status, 200, JSON.stringify(retried.body));
        assert.equal(retried.body.order.status, operation === "accept" ? "en_route_to_c" : operation === "reject" ? "searching" : "arrived_at_c");
        if (operation === "reject") {
          assert.equal(retried.body.order.offered_driver_id, undefined);
          await assertIdle(otherStore, driver);
        }
      } finally {
        await blocker.query("ROLLBACK"); blocker.release();
        if (pending) await pending;
      }
    });
  }
});

test("real PostgreSQL configured accept-versus-cancel races in both lock schedules restore seats once", { timeout: 20_000 }, async t => {
  for (const first of ["accept", "cancel"]) {
    await t.test(first, async child => {
      const f = await fixture(child), route = await f.configured(), passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
      const offered = await createStored(f, passenger, route);
      const accept = () => otherStore.acceptOrderOffer(offered.id, driver.user.id);
      const cancel = () => store.transitionOrder(offered.id, passenger.user.id, "cancelled");
      const results = await overlapping("tezjet_orders", "id", offered.id, first === "accept" ? [accept, cancel] : [cancel, accept]);
      for (const result of results) if (result.error) throw result.error;
      assert.ok(results[0].value);
      if (first === "accept") assert.equal(results[1].value.status, "cancelled");
      else assert.equal(results[1].value, undefined);
      assert.equal((await otherStore.getOrder(offered.id)).status, "cancelled");
      await assertIdle(otherStore, driver);
      assert.equal(await store.transitionOrder(offered.id, passenger.user.id, "cancelled"), undefined);
      await assertIdle(store, driver);
    });
  }
});

test("both adapters require fresh enrollment for completed and cancelled boarded configured trips, including generic FIFO restore attempts", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize();
    for (const terminal of ["completed", "cancelled"]) {
      const f = await fixture(t, adapter), route = await f.configured();
      const passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
      const offered = await createStored(f, passenger, route);
      assert.ok(await adapter.acceptOrderOffer(offered.id, driver.user.id));
      assert.ok(await adapter.transitionOrder(offered.id, driver.user.id, "arrived_at_c"));
      assert.ok(await adapter.transitionOrder(offered.id, driver.user.id, "in_transit"));
      const ended = await adapter.transitionOrder(offered.id, terminal === "cancelled" ? passenger.user.id : driver.user.id, terminal);
      assert.equal(ended.status, terminal);
      await assertIdle(adapter, driver, 4, false);
      assert.equal((await adapter.getRouteOrderAvailability(choiceInput(route), 1)).available, false);
      await assertFreshEnrollmentRequired(adapter, driver);
      assert.equal((await adapter.getRouteOrderAvailability(choiceInput(route), 1)).available, false,
        "Blocked generic restores must not make the driver eligible again.");
      await adapter.leaveQueue(driver.user.id);
      assert.equal(await adapter.getQueueEntry(driver.user.id), undefined);
      await adapter.joinQueue({
        driverId: driver.user.id, joinedAt: Date.now(), status: "searching", availableSeats: 4,
        lastLocation: at(route), priorityLock: false, inFifo: true, activeOrderIds: [],
      }, driver.user.sessionVersion, choiceInput(route));
      const reenrolled = await assertIdle(adapter, driver);
      assert.ok(reenrolled.joinedAt > 1, "Fresh enrollment must acquire a new FIFO position.");
      assert.equal(reenrolled.routeContext.routeId, route.id);
      assert.equal((await adapter.getRouteOrderAvailability(choiceInput(route), 1)).available, true);
    }
  }
});

test("HTTP pending configured offers keep the pickup geofence, and both adapters support an administrator's zero tariff", async t => {
  const f = await fixture(t), route = await f.configured(), passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
  const offered = await createStored(f, passenger, route), canonical = await store.getQueueEntry(driver.user.id);
  assertError(await request("/queue/location", { token: driver.token, method: "PATCH", body: { location: at(route, "b_to_a") } }), 422, "OUTSIDE_QUEUE_GEOFENCE");
  assert.deepEqual(await otherStore.getQueueEntry(driver.user.id), canonical, "A pending reservation cannot move into another pitak by a location update.");
  await assertPending(otherStore, driver, offered);
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize(); const zero = await fixture(t, adapter), freeRoute = await zero.configured({ pricePerStopKzt: 0 });
    const rider = await zero.createUser("passenger"), available = await zero.enqueue(freeRoute);
    const free = await createStored(zero, rider, freeRoute);
    assert.equal(free.fare.pricePerStopKzt, 0); assert.equal(free.fare.totalKzt, 0);
    await assertPending(adapter, available, free);
  }
});
