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
const schema = `route_orders_${randomUUID().replaceAll("-", "")}`;
const applicationName = `route-orders-${randomUUID()}`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes", "tezjet_admin_audit_events"];
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
        'export { serializeOrder } from "./src/utils/serialize";',
        'export { withCanonicalKztFare } from "./src/utils/fareMoney";',
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
async function createHttp(passenger, route, direction = "a_to_b", seats = 2, extra = {}) {
  return request("/orders/route", { token: passenger.token, method: "POST", body: {
    ...selection(route, direction), pickup_location: at(route, direction), seats, ...extra,
  } });
}
async function availabilityHttp(passenger, route, direction = "a_to_b", seats = 2, extra = {}) {
  return request(`/orders/route/availability?${new URLSearchParams({ ...selection(route, direction), seats: String(seats), ...extra })}`, { token: passenger.token });
}
async function enrollHttp(f, route, direction, collecting = false) {
  const driver = await f.createUser();
  const planned = await request("/driver/route", {
    token: driver.token, method: "PUT", body: selection(route, direction),
  });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const joined = await request(collecting ? "/queue/line" : "/queue/join", {
    token: driver.token, method: "POST", body: {
      route_choice: selection(route, direction), location: at(route, direction), available_seats: 4,
    },
  });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  assert.equal(joined.body.entry.routeContext.direction, direction);
  assert.equal(Boolean(joined.body.entry.collectionState), collecting);
  return driver;
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
    assert.deepEqual(availabilityState(await adapter.getRouteOrderAvailability(choiceInput(route), 2)), { available: false, eligibleDriverCount: 0 });
    assert.equal(await createStored(f, passenger, route), undefined);
    assert.deepEqual(await adapter.listOrdersForUser(passenger.user.id), [], "Unavailable requests must not persist searching orders.");
    await assertIdle(adapter, small, 1);
    const correct = await f.enqueue(route, "a_to_b", 8, 100);
    assert.deepEqual(availabilityState(await adapter.getRouteOrderAvailability(choiceInput(route), 8)), { available: true, eligibleDriverCount: 1 });
    const order = await createStored(f, passenger, route, "a_to_b", 8);
    assert.equal(order.offeredDriverId, correct.user.id);
    await assertPending(adapter, correct, order, 8);
    assert.deepEqual(availabilityState(await adapter.getRouteOrderAvailability(choiceInput(route), 1)), { available: true, eligibleDriverCount: 1 },
      "The separate one-seat driver remains eligible after another driver reserves an eight-seat offer.");
    const smallOrder = await createStored(f, passenger, route, "a_to_b", 1);
    assert.equal(smallOrder.offeredDriverId, small.user.id);
    await assertPending(adapter, small, smallOrder, 1);
    await assertPending(adapter, correct, order, 8);
    assert.deepEqual(availabilityState(await adapter.getRouteOrderAvailability(choiceInput(route), 1)), { available: false, eligibleDriverCount: 0 },
      "Neither driver may own two simultaneous pending offers.");
  }
});

test("HTTP a driver waiting only at the opposite pitak never makes an unavailable lane bookable in either queue mode", async t => {
  for (const direction of ["a_to_b", "b_to_a"]) {
    for (const collecting of [false, true]) await t.test(`${direction}:${collecting ? "collecting" : "configured"}`, async child => {
      const f = await fixture(child), route = await f.configured();
      const oppositeDirection = direction === "a_to_b" ? "b_to_a" : "a_to_b";
      const driver = await enrollHttp(f, route, oppositeDirection, collecting);
      if (collecting) {
        // Model elapsed travel without a future device timestamp. Being
        // physically at the other endpoint must not change the saved lane.
        await store.updateUser(driver.user.id, { lastLocation: { ...at(route, oppositeDirection), timestamp: Date.now() - 3_600_000 } });
        const moved = await request("/queue/location", {
          token: driver.token, method: "PATCH", body: { location: at(route, direction) },
        });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        assert.equal(moved.body.entry.routeContext.direction, oppositeDirection);
        assert.equal(moved.body.entry.routeContext.pitak, oppositeDirection === "a_to_b" ? "A" : "B");
        assert.equal(moved.body.entry.lastLocation.lat, at(route, direction).lat);
        assert.equal(moved.body.entry.lastLocation.lng, at(route, direction).lng);
      }
      const before = await otherStore.getQueueEntry(driver.user.id), passenger = await f.createUser("passenger");
      const availability = await availabilityHttp(passenger, route, direction);
      assert.equal(availability.status, 200, JSON.stringify(availability.body));
      assert.equal(availability.body.available, false);
      assert.equal(availability.body.eligible_driver_count, 0);
      assertError(await createHttp(passenger, route, direction), 409, "NO_DRIVERS");
      assert.deepEqual(await otherStore.listOrdersForUser(passenger.user.id), [], "An opposite-pitak driver must not cause even a searching order to be inserted.");
      assert.deepEqual(await otherStore.getQueueEntry(driver.user.id), before, "An unavailable request must preserve the opposite driver's queue position, enrollment, manifest and seats.");

      // A separate passenger starts at the driver's own pitak; the production
      // GPS speed guard must not be bypassed by teleporting the first passenger.
      const ownPassenger = await f.createUser("passenger");
      const ownAvailability = await availabilityHttp(ownPassenger, route, oppositeDirection);
      assert.equal(ownAvailability.status, 200, JSON.stringify(ownAvailability.body));
      assert.equal(ownAvailability.body.available, true);
      assert.equal(ownAvailability.body.eligible_driver_count, 1);
      const created = await createHttp(ownPassenger, route, oppositeDirection);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.order.offered_driver_id, driver.user.id);
      assert.equal(created.body.order.route_context.direction, oppositeDirection);
      assert.equal(created.body.order.route_context.pitak, oppositeDirection === "a_to_b" ? "A" : "B");
      await assertPending(otherStore, driver, await otherStore.getOrder(created.body.order.id));
    });
  }
});

test("HTTP knowing another lane's order ID grants no visibility, offer control or passenger lifecycle authority", async t => {
  for (const direction of ["a_to_b", "b_to_a"]) await t.test(direction, async child => {
    const f = await fixture(child), route = await f.configured(), passenger = await f.createUser("passenger");
    const assigned = await enrollHttp(f, route, direction, true);
    const opposite = await enrollHttp(f, route, direction === "a_to_b" ? "b_to_a" : "a_to_b", true);
    const created = await createHttp(passenger, route, direction);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.order.id, beforeOrder = await otherStore.getOrder(id);
    assert.equal(beforeOrder.offeredDriverId, assigned.user.id);
    const beforeAssigned = await otherStore.getQueueEntry(assigned.user.id);
    const beforeOpposite = await otherStore.getQueueEntry(opposite.user.id);
    const unchanged = async () => {
      assert.deepEqual(await otherStore.getOrder(id), beforeOrder, "A wrong-lane request must not modify the order or transfer its offer.");
      assert.deepEqual(await otherStore.getQueueEntry(assigned.user.id), beforeAssigned, "The actual offer owner's reservation must remain intact.");
      assert.deepEqual(await otherStore.getQueueEntry(opposite.user.id), beforeOpposite, "The wrong-lane driver's seats, FIFO and manifest must remain intact.");
    };
    const listed = await request("/orders", { token: opposite.token });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.orders, []);
    for (const [suffix, method, body, status, code] of [
      ["", "GET", undefined, 404, "ORDER_NOT_FOUND"],
      ["/accept", "POST", undefined, 409, "ORDER_RESERVED"],
      // PostgreSQL finds no authenticated actor among the locked order-lane
      // candidates and rejects before any offer or seat mutation.
      ["/reject", "POST", undefined, 401, "UNAUTHORIZED"],
      ["/status", "PATCH", { status: "arrived_at_c" }, 404, "ORDER_NOT_FOUND"],
      ["/board", "POST", {}, 404, "ORDER_NOT_FOUND"],
      ["/cancel", "POST", undefined, 404, "ORDER_NOT_FOUND"],
      ["/offer-first-driver", "POST", undefined, 404, "ORDER_NOT_FOUND"],
    ]) {
      assertError(await request(`/orders/${id}${suffix}`, { token: opposite.token, method, ...(body === undefined ? {} : { body }) }), status, code);
      await unchanged();
    }
    const accepted = await request(`/orders/${id}/accept`, { token: assigned.token, method: "POST" });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.order.driver_id, assigned.user.id);
    assert.equal(accepted.body.order.status, "en_route_to_c");
    assert.equal((await otherStore.getQueueEntry(assigned.user.id)).availableSeats, 2, "The legitimate owner accepts the existing reservation without a second debit.");
    assert.deepEqual(await otherStore.getQueueEntry(opposite.user.id), beforeOpposite);
  });
});

test("HTTP exhausted offers remain searching until their own lane gains a new driver, without falling back to the opposite pitak", async t => {
  for (const [action, direction] of [["reject", "a_to_b"], ["timeout", "b_to_a"]]) await t.test(action, async child => {
    const f = await fixture(child), route = await f.configured(), passenger = await f.createUser("passenger");
    const first = await enrollHttp(f, route, direction, true);
    const opposite = await enrollHttp(f, route, direction === "a_to_b" ? "b_to_a" : "a_to_b", true);
    const beforeOpposite = await otherStore.getQueueEntry(opposite.user.id);
    const created = await createHttp(passenger, route, direction);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.order.id, offered = await otherStore.getOrder(id);
    assert.equal(offered.offeredDriverId, first.user.id);
    if (action === "reject") {
      const rejected = await request(`/orders/${id}/reject`, { token: first.token, method: "POST" });
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    } else {
      await store.processOrderOffers(offered.offerExpiresAt + 1);
    }
    const waiting = await otherStore.getOrder(id);
    assert.equal(waiting.status, "searching");
    assert.equal(waiting.driverId, undefined);
    assert.equal(waiting.offeredDriverId, undefined);
    assert.equal(waiting.offerExpiresAt, undefined);
    assert.deepEqual(waiting.attemptedDriverIds, [first.user.id]);
    await assertIdle(otherStore, first);
    assert.deepEqual(await otherStore.getQueueEntry(opposite.user.id), beforeOpposite, "A free opposite-lane car must never become an exhaustion fallback.");
    assert.equal(await store.dispatchOrderOffer(id), undefined);
    assert.deepEqual(await otherStore.getOrder(id), waiting, "Repeated dispatch with only the opposite lane available must be read-only.");

    // Joining invokes the real dispatcher after the new enrollment commits.
    const next = await enrollHttp(f, route, direction, true), advanced = await otherStore.getOrder(id);
    assert.equal(advanced.offeredDriverId, next.user.id);
    assert.equal(advanced.routeContext.direction, direction);
    assert.deepEqual(advanced.attemptedDriverIds, [first.user.id, next.user.id]);
    await assertPending(otherStore, next, advanced);
    await assertIdle(otherStore, first);
    assert.deepEqual(await otherStore.getQueueEntry(opposite.user.id), beforeOpposite);
  });
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
    assert.deepEqual(availabilityState(await adapter.getRouteOrderAvailability(choiceInput(changed), 2)), { available: false, eligibleDriverCount: 0 }, "An old queue snapshot cannot receive a current-version order.");
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
  assert.deepEqual(availabilityState(await otherStore.getRouteOrderAvailability(choiceInput(route), 1)), { available: false, eligibleDriverCount: 0 });
});

test("real HTTP positive availability cannot preserve a booking after the last driver leaves, and a winning booking prevents leaving", { timeout: 20_000 }, async t => {
  for (const [first, direction, collecting] of [["leave", "a_to_b", false], ["create", "b_to_a", true]]) {
    await t.test(`${first}:${direction}:${collecting ? "collecting" : "configured"}`, async child => {
      const f = await fixture(child), route = await f.configured(), passenger = await f.createUser("passenger");
      const driver = await enrollHttp(f, route, direction, collecting);
      const before = await otherStore.getQueueEntry(driver.user.id);
      const available = await availabilityHttp(passenger, route, direction);
      assert.equal(available.status, 200, JSON.stringify(available.body));
      assert.equal(available.body.available, true);
      assert.equal(available.body.eligible_driver_count, 1);
      assert.deepEqual(await otherStore.getQueueEntry(driver.user.id), before, "Availability must not reserve the last driver's offer slot.");
      const leave = () => request("/queue/leave", { token: driver.token, method: "DELETE" });
      const create = () => createHttp(passenger, route, direction);
      // The observed queue-row wait establishes each transaction's order.
      // Both HTTP requests started after the same positive advisory GET.
      const results = await overlapping("tezjet_driver_queue", "driver_id", driver.user.id,
        first === "leave" ? [leave, create] : [create, leave]);
      for (const result of results) if (result.error) throw result.error;
      const [left, created] = (first === "leave" ? results : [...results].reverse()).map(result => result.value);
      const orders = await otherStore.listOrdersForUser(passenger.user.id);
      if (first === "leave") {
        assert.equal(left.status, 204, JSON.stringify(left.body));
        assertError(created, 409, "NO_DRIVERS");
        assert.deepEqual(orders, [], "A cached positive availability must not leave a searching order after the final queue row is deleted.");
        assert.equal(await otherStore.getQueueEntry(driver.user.id), undefined, "Failed creation must not recreate the departed queue enrollment.");
      } else {
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assertError(left, 409, "ACTIVE_ORDER");
        assert.deepEqual(orders.map(order => order.id), [created.body.order.id]);
        const order = await otherStore.getOrder(created.body.order.id);
        const pending = await assertPending(otherStore, driver, order);
        assert.equal(pending.joinedAt, before.joinedAt);
        assert.deepEqual(pending.routeContext, before.routeContext);
        assert.deepEqual(pending.collectionState, before.collectionState);
        assert.equal(pending.inFifo, before.inFifo);
      }
    });
  }
});

test("real HTTP creation rechecks the last driver's approval after positive availability and an observed PostgreSQL user lock", { timeout: 20_000 }, async t => {
  for (const [direction, collecting] of [["a_to_b", false], ["b_to_a", true]]) {
    await t.test(`${direction}:${collecting ? "collecting" : "configured"}`, async child => {
      const f = await fixture(child), route = await f.configured(), passenger = await f.createUser("passenger");
      const driver = await enrollHttp(f, route, direction, collecting);
      const before = await otherStore.getQueueEntry(driver.user.id);
      const available = await availabilityHttp(passenger, route, direction);
      assert.equal(available.status, 200, JSON.stringify(available.body));
      assert.equal(available.body.available, true);
      assert.equal(available.body.eligible_driver_count, 1);
      const blocker = await adminPool.connect(); let pending;
      try {
        await blocker.query("BEGIN");
        await blocker.query(`SELECT id FROM "${schema}".tezjet_users WHERE id = $1 FOR UPDATE`, [driver.user.id]);
        pending = createHttp(passenger, route, direction);
        await waitForBlockedTransactions(1);
        await blocker.query(`UPDATE "${schema}".tezjet_users SET driver_approval_status = 'rejected' WHERE id = $1`, [driver.user.id]);
        await blocker.query("COMMIT");
        assertError(await pending, 409, "NO_DRIVERS");
      } finally {
        await blocker.query("ROLLBACK"); blocker.release();
        if (pending) await pending;
      }
      assert.deepEqual(await otherStore.listOrdersForUser(passenger.user.id), [], "The eligibility recheck must reject before persisting an order.");
      assert.deepEqual(await otherStore.getQueueEntry(driver.user.id), before, "Losing approval must not debit seats or change the queue, manifest or enrollment.");
      const unavailable = await availabilityHttp(passenger, route, direction);
      assert.equal(unavailable.status, 200, JSON.stringify(unavailable.body));
      assert.equal(unavailable.body.available, false);
      assert.equal(unavailable.body.eligible_driver_count, 0);
      await store.setDriverApproval(driver.user.id, "approved");
      const retried = await createHttp(passenger, route, direction);
      assert.equal(retried.status, 201, JSON.stringify(retried.body));
      assert.deepEqual((await otherStore.listOrdersForUser(passenger.user.id)).map(order => order.id), [retried.body.order.id]);
      await assertPending(otherStore, driver, await otherStore.getOrder(retried.body.order.id));
    });
  }
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

function intermediateStops() {
  return [
    { code: "A", name: "Админский питак A", location: { lat: 42.9, lng: 71.3 } },
    { code: "C", name: "Админская остановка C", location: { lat: 42.91, lng: 71.34 } },
    { code: "D", name: "Админская остановка D", location: { lat: 42.925, lng: 71.38 } },
    { code: "B", name: "Админский питак B", location: { lat: 42.94, lng: 71.43 } },
  ];
}

function stop(route, code) {
  const result = route.stops.find(value => value.code === code);
  assert.ok(result, `Fixture stop ${code} must exist`);
  return result;
}

function atStop(route, code) {
  return { ...stop(route, code).location, timestamp: Date.now() };
}

function segmentChoice(route, direction, pickup, destination) {
  return {
    ...choiceInput(route, direction),
    ...(pickup === undefined ? {} : { pickupStopId: stop(route, pickup).id }),
    ...(destination === undefined ? {} : { destinationStopId: stop(route, destination).id }),
  };
}

function segmentFields(route, pickup, destination) {
  return {
    ...(pickup === undefined ? {} : { pickup_stop_id: stop(route, pickup).id }),
    ...(destination === undefined ? {} : { destination_stop_id: stop(route, destination).id }),
  };
}

function segmentAvailability(passenger, route, direction, pickup, destination, extra = {}) {
  return availabilityHttp(passenger, route, direction, 2, { ...segmentFields(route, pickup, destination), ...extra });
}

function segmentCreate(passenger, route, direction, pickup, destination, extra = {}) {
  const pickupCode = pickup ?? (direction === "a_to_b" ? "A" : "B");
  return createHttp(passenger, route, direction, 2, {
    ...segmentFields(route, pickup, destination), pickup_location: atStop(route, pickupCode), ...extra,
  });
}

function segmentStored(f, passenger, route, direction, pickup, destination, adapter = f.adapter) {
  return adapter.createRouteOrderWithOffer({
    passengerId: passenger.user.id, passengerPhone: passenger.user.phoneNumber,
    pickupLocation: atStop(route, pickup ?? (direction === "a_to_b" ? "A" : "B")), seats: 2,
  }, segmentChoice(route, direction, pickup, destination), passenger.user.sessionVersion);
}

function assertSegment(fare, route, direction, pickupCode, destinationCode) {
  const pickup = stop(route, pickupCode), destination = stop(route, destinationCode);
  const ordered = direction === "a_to_b" ? route.stops : [...route.stops].reverse();
  const from = ordered.findIndex(value => value.id === pickup.id), to = ordered.findIndex(value => value.id === destination.id);
  assert.ok(from < to);
  assert.deepEqual(fare.pickupStop, pickup);
  assert.deepEqual(fare.destinationStop, destination);
  assert.deepEqual(fare.stops, ordered.slice(from, to + 1));
  assert.equal(fare.pickupPosition, pickup.position);
  assert.equal(fare.destinationPosition, destination.position);
  assert.equal(fare.distanceStops, Math.abs(destination.position - pickup.position));
  assert.equal(fare.pricePerStopKzt, route.pricePerStopKzt);
  assert.equal(fare.totalKzt, fare.distanceStops * route.pricePerStopKzt);
  assert.equal(fare.routeId, route.id);
  assert.equal(fare.currency, "KZT");
}

test("HTTP configured subsegments in both directions derive their stops and fare while reserving the origin lane", async t => {
  for (const [direction, pickup, destination] of [
    ["a_to_b", "A", "C"], ["a_to_b", "D", "B"], ["a_to_b", "C", "D"],
    ["b_to_a", "C", "A"], ["b_to_a", "B", "D"], ["b_to_a", "D", "C"],
  ]) {
    await t.test(`${pickup}→${destination}`, async child => {
      const f = await fixture(child), route = await f.configured({}, intermediateStops());
      const passenger = await f.createUser("passenger"), driver = await f.enqueue(route, direction);
      const availability = await segmentAvailability(passenger, route, direction, pickup, destination);
      assert.equal(availability.status, 200, JSON.stringify(availability.body));
      assert.equal(availability.body.available, true);
      assert.equal(availability.body.eligible_driver_count, 1);
      assertSegment(availability.body.fare, route, direction, pickup, destination);
      const result = await segmentCreate(passenger, route, direction, pickup, destination);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      const order = result.body.order;
      assertSegment(order.fare, route, direction, pickup, destination);
      assert.deepEqual(order.route_stops, order.fare.stops);
      assert.equal(order.destination, stop(route, destination).name);
      assert.equal(order.pickup_stop_id, stop(route, pickup).id);
      assert.equal(order.destination_stop_id, stop(route, destination).id);
      assert.equal(order.pickup_point, direction === "a_to_b" ? "A" : "B");
      assert.equal(order.route_context.pitak, order.pickup_point);
      assert.deepEqual(order.route_context.center, { ...at(route, direction), timestamp: 0 });
      assert.equal(order.offered_driver_id, driver.user.id);
      const durable = await otherStore.getOrder(order.id);
      assert.deepEqual(durable.fare, order.fare);
      await assertPending(otherStore, driver, durable);
      assert.deepEqual((await request(`/orders/${order.id}`, { token: passenger.token })).body.order, order);
    });
  }
});

test("HTTP omitted stop selectors default independently and unavailable subsegments still return the server fare", async t => {
  for (const [direction, pickup, destination, expectedPickup, expectedDestination] of [
    ["a_to_b", "C", undefined, "C", "B"], ["a_to_b", undefined, "D", "A", "D"],
    ["b_to_a", "D", undefined, "D", "A"], ["b_to_a", undefined, "C", "B", "C"],
  ]) {
    const f = await fixture(t), route = await f.configured({}, intermediateStops()), passenger = await f.createUser("passenger");
    const unavailable = await segmentAvailability(passenger, route, direction, pickup, destination);
    assert.equal(unavailable.status, 200, JSON.stringify(unavailable.body));
    assert.equal(unavailable.body.available, false);
    assert.equal(unavailable.body.eligible_driver_count, 0);
    assertSegment(unavailable.body.fare, route, direction, expectedPickup, expectedDestination);
    assertError(await segmentCreate(passenger, route, direction, pickup, destination), 409, "NO_DRIVERS");
    assert.deepEqual(await otherStore.listOrdersForUser(passenger.user.id), []);
    const driver = await f.enqueue(route, direction);
    const created = await segmentCreate(passenger, route, direction, pickup, destination);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assertSegment(created.body.order.fare, route, direction, expectedPickup, expectedDestination);
    await assertPending(otherStore, driver, await store.getOrder(created.body.order.id));
  }
});

test("HTTP availability and creation reject unknown, foreign, reversed, same, and malformed stop selectors without reservations", async t => {
  const f = await fixture(t), route = await f.configured({}, intermediateStops()), otherRoute = await f.configured({}, intermediateStops());
  const passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
  const valid = segmentFields(route, "C", "D");
  const cases = [
    [{ pickup_stop_id: `unknown-${randomUUID()}` }, 404, "ROUTE_STOP_NOT_FOUND"],
    [{ destination_stop_id: stop(otherRoute, "D").id }, 404, "ROUTE_STOP_NOT_FOUND"],
    [{ pickup_stop_id: stop(route, "D").id, destination_stop_id: stop(route, "C").id }, 422, "INVALID_ROUTE_SEGMENT"],
    [{ destination_stop_id: stop(route, "C").id }, 422, "INVALID_ROUTE_SEGMENT"],
    [{ pickup_stop_id: "" }, 400, "VALIDATION_ERROR"],
    [{ destination_stop_id: "   " }, 400, "VALIDATION_ERROR"],
  ];
  for (const [extra, status, code] of cases) {
    const fields = { ...valid, ...extra };
    assertError(await availabilityHttp(passenger, route, "a_to_b", 2, fields), status, code);
    assertError(await createHttp(passenger, route, "a_to_b", 2, { ...fields, pickup_location: atStop(route, "C") }), status, code);
  }
  for (const value of [null, 17, [], {}]) {
    assertError(await segmentCreate(passenger, route, "a_to_b", "C", "D", { pickup_stop_id: value }), 400, "VALIDATION_ERROR");
  }
  const query = new URLSearchParams({ ...selection(route), ...valid, seats: "2" });
  query.append("pickup_stop_id", stop(route, "A").id);
  assertError(await request(`/orders/route/availability?${query}`, { token: passenger.token }), 400, "VALIDATION_ERROR");
  assertError(await segmentAvailability(passenger, route, "b_to_a", "C", "D"), 422, "INVALID_ROUTE_SEGMENT");
  assertError(await segmentCreate(passenger, route, "b_to_a", "C", "D"), 422, "INVALID_ROUTE_SEGMENT");
  assert.deepEqual(await otherStore.listOrdersForUser(passenger.user.id), []);
  await assertIdle(otherStore, driver);
});

test("selected pickup and destination require configured coordinates while a pass-through stop may omit them", async t => {
  const f = await fixture(t), stops = intermediateStops();
  delete stops[1].location;
  const route = await f.configured({}, stops), passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
  for (const [pickup, destination] of [["C", "D"], ["A", "C"]]) {
    assertError(await segmentAvailability(passenger, route, "a_to_b", pickup, destination), 422, "ROUTE_STOP_NOT_CONFIGURED");
    assertError(await segmentCreate(passenger, route, "a_to_b", pickup, destination, { pickup_location: atStop(route, "A") }), 422, "ROUTE_STOP_NOT_CONFIGURED");
    await assertIdle(otherStore, driver);
  }
  const through = await segmentCreate(passenger, route, "a_to_b", "A", "D");
  assert.equal(through.status, 201, JSON.stringify(through.body));
  assert.deepEqual(through.body.order.route_stops.map(value => value.code), ["A", "C", "D"]);
  assertSegment(through.body.order.fare, route, "a_to_b", "A", "D");
});

test("both adapters share strict origin FIFO across different subsegments and exclude opposite, foreign, and legacy lanes", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize();
    const f = await fixture(t, adapter), route = await f.configured({}, intermediateStops()), otherRoute = await f.configured({}, intermediateStops());
    const passenger = await f.createUser("passenger");
    const first = await f.enqueue(route, "a_to_b", 4, 1), second = await f.enqueue(route, "a_to_b", 4, 2);
    await adapter.updateQueueEntry(second.user.id, { priorityLock: true });
    const opposite = await f.enqueue(route, "b_to_a", 4, 0), foreign = await f.enqueue(otherRoute, "a_to_b", 4, 0), legacy = await f.legacyDriver();
    const order = await segmentStored(f, passenger, route, "a_to_b", "C", "D");
    assert.equal(order.offeredDriverId, first.user.id);
    await assertPending(adapter, first, order);
    const nextSegment = await segmentStored(f, passenger, route, "a_to_b", "D", "B");
    assert.equal(nextSegment.offeredDriverId, second.user.id, "Disjoint segments still obey the one-offer-per-driver reservation.");
    await assertPending(adapter, second, nextSegment);
    const unavailable = await adapter.getRouteOrderAvailability(segmentChoice(route, "a_to_b", "A", "C"), 2);
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.eligibleDriverCount, 0);
    await assertIdle(adapter, opposite); await assertIdle(adapter, foreign); await assertIdle(adapter, legacy);
  }
});

test("HTTP passenger pickup GPS uses the selected stop while pending driver GPS remains at the origin pitak", async t => {
  const f = await fixture(t), route = await f.configured({}, intermediateStops());
  const passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
  for (const pickupLocation of [atStop(route, "A"), atStop(route, "D"), { ...atStop(route, "C"), isMocked: true }]) {
    const rejectedPassenger = await f.createUser("passenger");
    assertError(await segmentCreate(rejectedPassenger, route, "a_to_b", "C", "D", { pickup_location: pickupLocation }), 422);
    assert.deepEqual(await otherStore.listOrdersForUser(rejectedPassenger.user.id), []);
    await assertIdle(otherStore, driver);
  }
  const created = await segmentCreate(passenger, route, "a_to_b", "C", "D");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assertError(await request("/queue/location", { token: driver.token, method: "PATCH", body: { location: atStop(route, "C") } }), 422, "OUTSIDE_QUEUE_GEOFENCE");
  await assertPending(otherStore, driver, await store.getOrder(created.body.order.id));
});

test("configured intermediate D keeps the normal pickup lock and cancellation requires fresh origin enrollment", async t => {
  const f = await fixture(t), route = await f.configured({}, intermediateStops()), passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
  const created = await segmentCreate(passenger, route, "a_to_b", "D", "B");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.order.id, accepted = await request(`/orders/${id}/accept`, { token: driver.token, method: "POST" });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.order.status, "en_route_to_c", "Configured D is not the legacy in-transit Point D pooling lane.");
  assert.equal(accepted.body.order.pickup_point, "A");
  assert.equal(accepted.body.order.fare.pickupStop.code, "D");
  assert.equal(accepted.body.seat_lock_minutes, 7);
  assert.equal(accepted.body.order.seat_lock_expires_at - Date.parse(accepted.body.order.updated_at), 420_000);
  assert.equal((await otherStore.getQueueEntry(driver.user.id)).availableSeats, 2, "Acceptance consumes the existing reservation without a second debit.");
  const cancelled = await request(`/orders/${id}/cancel`, { token: passenger.token, method: "POST" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  await assertIdle(otherStore, driver, 4, false);
  await assertFreshEnrollmentRequired(store, driver);
  assert.equal((await segmentAvailability(passenger, route, "a_to_b", "A", "C")).body.available, false);
  assertError(await request(`/orders/${id}/cancel`, { token: passenger.token, method: "POST" }), 409);
  await assertIdle(otherStore, driver, 4, false);
});

test("both adapters advance subsegment rejection and timeout within the lane and release accepted seats exactly once", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize();
    for (const action of ["reject", "timeout"]) {
      const f = await fixture(t, adapter), route = await f.configured({}, intermediateStops()), passenger = await f.createUser("passenger");
      const first = await f.enqueue(route, "a_to_b", 4, 1), second = await f.enqueue(route, "a_to_b", 4, 2);
      const order = await segmentStored(f, passenger, route, "a_to_b", "C", "D");
      const moved = action === "reject"
        ? await adapter.rejectOrderOffer(order.id, first.user.id)
        : await adapter.dispatchOrderOffer(order.id, order.offerExpiresAt);
      assert.equal(moved.order.offeredDriverId, second.user.id);
      assertSegment(moved.order.fare, route, "a_to_b", "C", "D");
      await assertIdle(adapter, first); await assertPending(adapter, second, moved.order);
      assert.equal(await adapter.acceptOrderOffer(order.id, first.user.id), undefined);
      const accepted = await adapter.acceptOrderOffer(order.id, second.user.id);
      assert.equal(accepted.status, "en_route_to_c");
      assert.equal((await adapter.getQueueEntry(second.user.id)).availableSeats, 2);
      for (const status of ["arrived_at_c", "in_transit", "completed"]) assert.equal((await adapter.transitionOrder(order.id, second.user.id, status)).status, status);
      await assertIdle(adapter, second, 4, false);
      assert.equal(await adapter.transitionOrder(order.id, second.user.id, "completed"), undefined);
      await assertIdle(adapter, second, 4, false);
    }
  }
});

test("both adapters invalidate pending edited stop selections but accepted subsegments retain their immutable fare and stops", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize();
    const f = await fixture(t, adapter), route = await f.configured({}, intermediateStops()), passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
    const offered = await segmentStored(f, passenger, route, "a_to_b", "C", "D");
    const editedStops = editStops(route).map(value => value.code === "C" ? { ...value, name: "Новая остановка C", location: { lat: 42.912, lng: 71.342 } } : value);
    const changed = await adapter.updateRouteLayout(route.id, { expectedUpdatedAt: route.updatedAt, stops: editedStops, pitaks });
    await assert.rejects(async () => adapter.getRouteOrderAvailability(segmentChoice(route, "a_to_b", "C", "D"), 2), error => error.code === "ROUTE_CHANGED");
    assert.equal(await adapter.acceptOrderOffer(offered.id, driver.user.id), undefined);
    const released = await adapter.dispatchOrderOffer(offered.id);
    assert.equal(released.order.offeredDriverId, undefined); await assertIdle(adapter, driver);
    await adapter.leaveQueue(driver.user.id);
    const fresh = await f.enqueue(changed), newOffer = await segmentStored(f, passenger, changed, "a_to_b", "C", "D");
    const accepted = await adapter.acceptOrderOffer(newOffer.id, fresh.user.id), frozen = structuredClone(accepted);
    const deletedPickup = editStops(changed).filter(value => value.code !== "C");
    await adapter.updateRouteLayout(route.id, { expectedUpdatedAt: changed.updatedAt, stops: deletedPickup, pitaks });
    for (const status of ["arrived_at_c", "in_transit", "completed"]) {
      const progressed = await adapter.transitionOrder(accepted.id, fresh.user.id, status);
      assert.equal(progressed.status, status);
      assert.deepEqual(progressed.fare, frozen.fare);
      assert.deepEqual(progressed.routeStops, frozen.routeStops);
      assert.deepEqual(progressed.routeContext, frozen.routeContext);
    }
    await assertIdle(adapter, fresh, 4, false);
  }
});

test("both adapters expire an intermediate pickup lock once and require fresh origin enrollment before another offer", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize();
    const f = await fixture(t, adapter), route = await f.configured({}, intermediateStops()), passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
    const offered = await segmentStored(f, passenger, route, "a_to_b", "D", "B");
    const accepted = await adapter.acceptOrderOffer(offered.id, driver.user.id, Date.now() - 420_001);
    assert.equal(accepted.status, "en_route_to_c");
    assert.ok(accepted.seatLockExpiresAt < Date.now());
    await adapter.clearExpiredSeatLocks();
    const reopened = await adapter.getOrder(offered.id);
    assert.equal(reopened.status, "searching");
    assert.equal(reopened.driverId, undefined);
    assert.equal(reopened.offeredDriverId, undefined);
    assert.equal(reopened.seatLockExpiresAt, undefined);
    assertSegment(reopened.fare, route, "a_to_b", "D", "B");
    await assertIdle(adapter, driver, 4, false);
    await assertFreshEnrollmentRequired(adapter, driver);
    await adapter.clearExpiredSeatLocks();
    await assertIdle(adapter, driver, 4, false);
    const unavailable = await adapter.getRouteOrderAvailability(segmentChoice(route, "a_to_b", "A", "C"), 2);
    assert.equal(unavailable.available, false);
  }
});

test("real PostgreSQL concurrent disjoint subsegments share one driver offer slot without overselling or stranded orders", { timeout: 15_000 }, async t => {
  const f = await fixture(t), route = await f.configured({}, intermediateStops()), passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
  const results = await overlapping("tezjet_driver_queue", "driver_id", driver.user.id, [
    () => segmentStored(f, passenger, route, "a_to_b", "A", "C", otherStore),
    () => segmentStored(f, passenger, route, "a_to_b", "D", "B"),
  ]);
  for (const result of results) if (result.error) throw result.error;
  const winners = results.map(result => result.value).filter(Boolean);
  assert.equal(winners.length, 1);
  assert.deepEqual((await otherStore.listOrdersForUser(passenger.user.id)).map(value => value.id), [winners[0].id]);
  await assertPending(otherStore, driver, winners[0]);
});

test("real PostgreSQL stop removal ordered before HTTP subsegment creation rejects the stale selection without reserving seats", { timeout: 20_000 }, async t => {
  const f = await fixture(t), route = await f.configured({}, intermediateStops()), passenger = await f.createUser("passenger"), driver = await f.enqueue(route), admin = await f.createUser("admin");
  const results = await overlapping("tezjet_routes", "id", route.id, [
    () => request(`/admin/routes/${route.id}/layout`, { token: admin.token, method: "PUT", body: {
      expected_updated_at: route.updatedAt, stops: editStops(route).filter(value => value.code !== "C"),
      pitaks: { a_stop_code: pitaks.aStopCode, b_stop_code: pitaks.bStopCode, radius_meters: pitaks.radiusMeters },
    } }),
    () => segmentCreate(passenger, route, "a_to_b", "C", "D"),
  ]);
  for (const result of results) if (result.error) throw result.error;
  assert.equal(results[0].value.status, 200, JSON.stringify(results[0].value.body));
  assertError(results[1].value, 409, "ROUTE_CHANGED");
  assert.deepEqual(await otherStore.listOrdersForUser(passenger.user.id), []);
  await assertIdle(otherStore, driver);
});

test("real HTTP intermediate creation and acceptance recheck revoked sessions after observed PostgreSQL locks", { timeout: 20_000 }, async t => {
  const f = await fixture(t), route = await f.configured({}, intermediateStops()), passenger = await f.createUser("passenger"), driver = await f.enqueue(route);
  const blocker = await adminPool.connect(); let pending;
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM "${schema}".tezjet_users WHERE id = $1 FOR UPDATE`, [passenger.user.id]);
    pending = segmentCreate(passenger, route, "a_to_b", "C", "D");
    await waitForBlockedTransactions(1);
    await blocker.query(`UPDATE "${schema}".tezjet_users SET session_version = session_version + 1 WHERE id = $1`, [passenger.user.id]);
    await blocker.query("COMMIT");
    assertError(await pending, 401, "UNAUTHORIZED");
    assert.deepEqual(await otherStore.listOrdersForUser(passenger.user.id), []);
    await assertIdle(otherStore, driver);
    const livePassenger = await otherStore.getUser(passenger.user.id);
    const created = await segmentCreate({ ...passenger, user: livePassenger, token: freshToken(livePassenger) }, route, "a_to_b", "C", "D");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.order.id, canonical = await otherStore.getOrder(id), queue = await otherStore.getQueueEntry(driver.user.id);
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM "${schema}".tezjet_orders WHERE id = $1 FOR UPDATE`, [id]);
    pending = request(`/orders/${id}/accept`, { token: driver.token, method: "POST" });
    await waitForBlockedTransactions(1);
    const liveDriver = await otherStore.invalidateSessions(driver.user.id);
    await blocker.query("COMMIT");
    assertError(await pending, 401, "UNAUTHORIZED");
    assert.deepEqual(await otherStore.getOrder(id), canonical);
    assert.deepEqual(await otherStore.getQueueEntry(driver.user.id), queue);
    const accepted = await request(`/orders/${id}/accept`, { token: freshToken(liveDriver), method: "POST" });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assertSegment(accepted.body.order.fare, route, "a_to_b", "C", "D");
    assert.equal((await otherStore.getQueueEntry(driver.user.id)).availableSeats, 2);
  } finally {
    await blocker.query("ROLLBACK"); blocker.release();
    if (pending) await pending;
  }
});


function assertCanonicalKztFare(fare, total = 1470, pricePerStop = 735) {
  assert.equal(fare.currency, "KZT");
  assert.equal(fare.total, total);
  assert.equal(fare.totalKzt, total, "Legacy readers retain the identical KZT total.");
  assert.equal(fare.pricePerStop, pricePerStop);
  assert.equal(fare.pricePerStopKzt, pricePerStop, "Legacy tariff readers remain compatible.");
}

test("canonical KZT aliases reject contradictions and invalid amounts without changing a frozen fare", () => {
  const legacy = Object.freeze({ currency: "KZT", totalKzt: 1470, pricePerStopKzt: 735 });
  const enriched = production.withCanonicalKztFare(legacy);
  assertCanonicalKztFare(enriched);
  assert.notEqual(enriched, legacy);
  assert.deepEqual(legacy, { currency: "KZT", totalKzt: 1470, pricePerStopKzt: 735 });
  assert.deepEqual(production.withCanonicalKztFare(enriched), enriched);
  for (const patch of [
    { currency: "UZS" }, { currency: "USD" }, { total: 1471 }, { pricePerStop: 736 },
    { total: null }, { pricePerStop: "735" },
    ...[-1, 0.1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1470"].map(totalKzt => ({ totalKzt })),
    ...[-1, 0.1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "735"].map(pricePerStopKzt => ({ pricePerStopKzt })),
  ]) assert.throws(() => production.withCanonicalKztFare({ ...legacy, ...patch }), error => error.code === "INVALID_FARE");
  const zero = production.withCanonicalKztFare({ currency: "KZT", totalKzt: 0, pricePerStopKzt: 0 });
  assertCanonicalKztFare(zero, 0, 0);
});

test("canonical KZT totals agree across legacy estimate, configured availability and persisted orders", async t => {
  await t.test("HTTP legacy estimate", async child => {
    const f = await fixture(child), route = await f.configured(), passenger = await f.createUser("passenger");
    const result = await request("/fares/estimate", { token: passenger.token, method: "POST", body: {
      route_id: route.id, pickup_stop: "A", destination_stop: "B",
    } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assertCanonicalKztFare(result.body.fare);
    await f.enqueue(route);
    const available = await availabilityHttp(passenger, route);
    assert.equal(available.status, 200, JSON.stringify(available.body));
    assertCanonicalKztFare(available.body.fare);
    const created = await createHttp(passenger, route);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assertCanonicalKztFare(created.body.order.fare);
    assertCanonicalKztFare((await otherStore.getOrder(created.body.order.id)).fare);
  });
  for (const adapter of [store, new production.MemoryStore()]) await t.test(adapter.constructor.name, async child => {
    await adapter.initialize();
    const f = await fixture(child, adapter), route = await f.configured(), passenger = await f.createUser("passenger");
    await f.enqueue(route);
    const available = await adapter.getRouteOrderAvailability(choiceInput(route), 2);
    assert.equal(available.available, true);
    assertCanonicalKztFare(available.fare);
    const created = await createStored(f, passenger, route);
    assert.ok(created);
    assertCanonicalKztFare(created.fare);
    const observer = adapter instanceof production.PostgresStore ? otherStore : adapter;
    assert.deepEqual((await observer.getOrder(created.id)).fare, created.fare);
  });
});

test("historical KZT reads add neutral aliases from the frozen fare without rewriting data or repricing", async t => {
  for (const adapter of [store, new production.MemoryStore()]) await t.test(adapter.constructor.name, async child => {
    await adapter.initialize();
    const f = await fixture(child, adapter), route = await f.configured(), passenger = await f.createUser("passenger");
    const pickupStop = route.stops[0], destinationStop = route.stops.at(-1);
    const legacyFare = { currency: "KZT", routeId: route.id, pickupStop, destinationStop,
      pickupPosition: pickupStop.position, destinationPosition: destinationStop.position,
      distanceStops: 2, pricePerStopKzt: 735, minimumFareApplied: false,
      stops: [pickupStop, destinationStop], totalKzt: 1470, calculatedAt: "2026-01-01T00:00:00.000Z" };
    // Insert an actual legacy-shaped terminal row, as an older application did;
    // do not mock SQL or use the current fare calculator to manufacture aliases.
    const historical = await adapter.createOrder({ passengerId: passenger.user.id,
      passengerPhone: passenger.user.phoneNumber, pickupPoint: "C", pickupLocation: legacyLocation,
      routeStops: legacyFare.stops, fare: structuredClone(legacyFare), destination: destinationStop.name,
      seats: 1, status: "completed" }, passenger.user.sessionVersion);
    await adapter.updateRoute(route.id, { pricePerStopKzt: 9999 });
    assert.equal((await adapter.getRoute(route.id)).pricePerStopKzt, 9999);
    const observer = adapter instanceof production.PostgresStore ? otherStore : adapter;
    const before = structuredClone(await observer.getOrder(historical.id));
    const response = production.serializeOrder(before);
    assertCanonicalKztFare(response.fare);
    assert.equal(response.fare.calculatedAt, legacyFare.calculatedAt);
    assert.deepEqual(before.fare, legacyFare, "Serialization must not mutate even a MemoryStore reference.");
    assert.deepEqual((await observer.getOrder(historical.id)).fare, legacyFare);
    if (adapter instanceof production.PostgresStore) {
      const read = await request(`/orders/${historical.id}`, { token: passenger.token });
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assertCanonicalKztFare(read.body.order.fare);
      const listed = await request("/orders", { token: passenger.token });
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      assertCanonicalKztFare(listed.body.orders.find(order => order.id === historical.id).fare);
      const { rows } = await database.query("SELECT payload->'fare' AS fare FROM tezjet_orders WHERE id=$1", [historical.id]);
      assert.deepEqual(rows[0].fare, legacyFare, "HTTP reads must not silently migrate or reprice the stored JSON snapshot.");
    }
  });
});
