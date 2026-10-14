import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Use the production HTTP app and adapters. PostgreSQL is mandatory, and
// all six tables are cloned with their real columns/indexes into a private
// schema. No public data is changed and no SQL results are substituted.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `route_queue_${randomUUID().replaceAll("-", "")}`;
const applicationName = `route-queue-${randomUUID()}`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes"];
const envKeys = ["DATABASE_URL", "TEZJET_STORAGE_ADAPTER", "NODE_ENV", "SESSION_SECRET", "LOG_LEVEL", "REQUIRE_DRIVER_APPROVAL", "PYATAK_CENTER_LAT", "PYATAK_CENTER_LNG"];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let moduleDirectory, production, database, adminPool, store, otherStore, server, baseUrl;
let schemaCreated = false;

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required: driver-route regressions must execute real PostgreSQL.");
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
  process.env.PYATAK_CENTER_LAT = "41.3111";
  process.env.PYATAK_CENTER_LNG = "69.2797";
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".route-queue-test-"));
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
    external: ["pg-native", "pino", "pino-http"],
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
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
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
const location = { lat: 41.3111, lng: 69.2797, timestamp: 1 };
const stopC = { id: "choice-c", code: "C", name: "Legacy C", sequence: 1, position: 1 };
const stopD = { id: "choice-d", code: "D", name: "Legacy D", sequence: 2, position: 2 };
const fare = {
  currency: "KZT", routeId: "pyatak", pickupStop: stopC, destinationStop: stopD,
  pickupPosition: 1, destinationPosition: 2, distanceStops: 1, pricePerStopKzt: 500,
  minimumFareApplied: false, stops: [stopC, stopD], totalKzt: 500, calculatedAt: new Date(0).toISOString(),
};
function draftStops() {
  return [
    { code: "A", name: "Настоящий питак A", location: { lat: 42.9, lng: 71.3 } },
    { code: "C", name: "Промежуточная остановка" },
    { code: "B", name: "Настоящий питак B", location: { lat: 42.94, lng: 71.43 } },
  ];
}
function editStops(route) {
  return route.stops.map(({ id, code, name, location }) => ({
    id, code, name, ...(location ? { location: { lat: location.lat, lng: location.lng } } : {}),
  }));
}
function option(route) {
  return { id: route.id, name: route.name, updatedAt: route.updatedAt, stops: route.stops, pitaks: route.pitaks };
}
function choiceInput(route, direction = "a_to_b") {
  return { routeId: route.id, direction, expectedUpdatedAt: route.updatedAt };
}
function choiceBody(route, direction = "a_to_b") {
  return { route_id: route.id, direction, expected_updated_at: route.updatedAt };
}
function savedChoice(route, direction = "a_to_b") {
  return { routeId: route.id, direction, routeUpdatedAt: route.updatedAt };
}
function assertError(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body?.error?.code, code, JSON.stringify(result.body));
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
    let user = await adapter.createUser({ role, fullName: "Driver route regression", phoneNumber: `choice-${randomUUID()}`, locale: "ru" });
    users.push(user.id);
    if (role === "driver" && approval) {
      await adapter.setDriverApproval(user.id, approval);
      user = await adapter.getUser(user.id);
    }
    const token = production.createAccessToken({ sub: user.id, role: user.role, locale: user.locale, sessionVersion: user.sessionVersion, sessionId: randomUUID() });
    return { user: structuredClone(user), token };
  };
  const createRoute = async (patch = {}) => {
    const id = `choice-${randomUUID()}`;
    routes.push(id);
    return adapter.createRoute({ id, name: "Маршрут с питаками", pricePerStopKzt: 735, active: true, ...patch });
  };
  const configured = async (patch = {}) => {
    const empty = await createRoute(patch);
    return adapter.updateRouteLayout(empty.id, { expectedUpdatedAt: empty.updatedAt, stops: draftStops(), pitaks });
  };
  const queueInput = driver => ({ driverId: driver.id, joinedAt: Date.now(), status: "searching", availableSeats: 4, lastLocation: location, priorityLock: false, inFifo: true, activeOrderIds: [] });
  const orderInput = (passenger, patch = {}) => ({
    passengerId: passenger.id, passengerPhone: passenger.phoneNumber, pickupPoint: "C", pickupLocation: location,
    routeStops: [stopC, stopD], fare, destination: "Legacy D", seats: 2, status: "searching", ...patch,
  });
  return { adapter, createUser, createRoute, configured, queueInput, orderInput };
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
// Real row locks and observed lock waiters establish overlap. The direct
// production joinQueue call reaches its queue -> user SHARE transaction;
// HTTP /queue/join has a prior GPS-account update which would be blocked
// earlier, before the absent queue-row insertion that this race exercises.
async function overlapUser(userId, actions) {
  const blocker = await adminPool.connect();
  const pending = [];
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM "${schema}".tezjet_users WHERE id = $1 FOR UPDATE`, [userId]);
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

function at(route, direction = "a_to_b") {
  const stop = direction === "a_to_b" ? route.stops[0] : route.stops.at(-1);
  return { ...stop.location, timestamp: Date.now() };
}
function enrollment(f, driver, route, direction = "a_to_b") {
  return { ...f.queueInput(driver), lastLocation: at(route, direction) };
}
async function planned(f, route, direction = "a_to_b") {
  const driver = await f.createUser();
  await f.adapter.setDriverRouteChoice(driver.user.id, choiceInput(route, direction), driver.user.sessionVersion);
  return driver;
}
async function join(driver, route, direction = "a_to_b", extra = {}) {
  return request("/queue/join", { token: driver.token, method: "POST", body: {
    location: at(route, direction), available_seats: 4, route_choice: choiceBody(route, direction), ...extra,
  } });
}

test("HTTP persists separate route A/B lanes and restores their own FIFO positions across stores", async t => {
  const f = await fixture(t), route = await f.configured(), route2 = await f.configured();
  const a1 = await planned(f, route), a2 = await planned(f, route), b = await planned(f, route, "b_to_a"), other = await planned(f, route2);
  for (const [driver, config, direction, position] of [[a1, route, "a_to_b", 1], [b, route, "b_to_a", 1], [other, route2, "a_to_b", 1], [a2, route, "a_to_b", 2]]) {
    const result = await join(driver, config, direction);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.position, position);
    const context = result.body.entry.routeContext;
    assert.equal(context.routeId, config.id); assert.equal(context.direction, direction);
    assert.equal(context.pitak, direction === "a_to_b" ? "A" : "B");
    assert.equal(context.routeUpdatedAt, config.updatedAt);
    assert.equal(context.radiusMeters, config.pitaks.radiusMeters);
    assert.deepEqual(await otherStore.getQueueEntry(driver.user.id), await store.getQueueEntry(driver.user.id));
  }
  const view = await request("/queue", { token: a2.token });
  assert.equal(view.status, 200); assert.equal(view.body.your_position, 2);
  assert.deepEqual(view.body.queue.map(entry => entry.driverId), [a1.user.id, a2.user.id]);
  assert.equal(view.body.zone.center.lat, route.stops[0].location.lat);
  const before = await store.getQueueEntry(a1.user.id);
  const repeat = await join(a1, route, "a_to_b", { available_seats: 8 });
  assert.equal(repeat.status, 201); assert.equal(repeat.body.entry.availableSeats, 4);
  assert.equal(repeat.body.entry.joinedAt, before.joinedAt); assert.equal(repeat.body.position, 1);
  assert.equal((await request("/queue/leave", { token: a1.token, method: "DELETE" })).status, 204);
  assert.equal(await otherStore.getQueuePosition(a2.user.id), 1);
  assert.equal(await otherStore.getQueuePosition(b.user.id), 1);
});

test("both adapters validate the selected endpoint and isolate configured queues from legacy availability and claims", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize(); const f = await fixture(t, adapter), route = await f.configured();
    const a = await planned(f, route), b = await planned(f, route, "b_to_a");
    await assert.rejects(async () => adapter.joinQueue({ ...enrollment(f, a.user, route), lastLocation: at(route, "b_to_a") }, a.user.sessionVersion, choiceInput(route)), e => e.code === "OUTSIDE_QUEUE_GEOFENCE");
    assert.equal(await adapter.getQueueEntry(a.user.id), undefined);
    await adapter.joinQueue(enrollment(f, a.user, route), a.user.sessionVersion, choiceInput(route));
    await adapter.joinQueue(enrollment(f, b.user, route, "b_to_a"), b.user.sessionVersion, choiceInput(route, "b_to_a"));
    assert.equal((await adapter.getOrderAvailability("C", 1)).available, false);
    assert.equal(await adapter.getFirstEligibleDriver(1), undefined);
    const passenger = await f.createUser("passenger"), order = await adapter.createOrder(f.orderInput(passenger.user));
    assert.equal(await adapter.dispatchOrderOffer(order.id), undefined);
    assert.equal(await adapter.claimOrderForDriver(order.id, a.user.id, {}, {}), undefined);
    await assert.rejects(async () => adapter.setDriverRouteChoice(a.user.id, null, a.user.sessionVersion), e => e.code === "DRIVER_ROUTE_BUSY");
    await assert.rejects(async () => adapter.updateQueueEntry(a.user.id, { routeContext: undefined }), e => e.code === "QUEUE_BUSY");
    const legacy = await f.createUser(); await adapter.joinQueue(f.queueInput(legacy.user), legacy.user.sessionVersion);
    assert.equal(await adapter.getQueuePosition(legacy.user.id), 1);
    const change = await adapter.dispatchOrderOffer(order.id);
    assert.equal(change?.order.offeredDriverId, legacy.user.id);
  }
});

test("HTTP rejects forged geometry, wrong direction, stale choice, revoked approval and manual configured-route status", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await planned(f, route);
  assertError(await join(driver, route, "a_to_b", { route_context: { pitak: "B", radiusMeters: 500000 } }), 400, "VALIDATION_ERROR");
  assertError(await join(driver, route, "a_to_b", { route_choice: choiceBody(route, "b_to_a") }), 409, "ROUTE_CHANGED");
  assertError(await join(driver, route, "a_to_b", { route_choice: { ...choiceBody(route), expected_updated_at: "stale" } }), 409, "ROUTE_CHANGED");
  assert.equal(await store.getQueueEntry(driver.user.id), undefined);
  assert.equal((await join(driver, route)).status, 201);
  assertError(await request("/queue/status", { token: driver.token, method: "PATCH", body: { status: "in_transit" } }), 409, "ROUTE_DISPATCH_NOT_AVAILABLE");
  assert.equal((await request("/queue/leave", { token: driver.token, method: "DELETE" })).status, 204);
  await store.setDriverApproval(driver.user.id, "rejected");
  assert.equal((await join(driver, route)).status, 403);
  assert.equal(await store.getQueueEntry(driver.user.id), undefined);
});

test("both adapters reject changed, disabled and deleted layouts without persisting queue rows", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    await adapter.initialize(); const f = await fixture(t, adapter);
    for (const mutation of ["changed", "inactive", "deleted"]) {
      const route = await f.configured(), driver = await planned(f, route);
      if (mutation === "changed") await adapter.updateRouteLayout(route.id, { expectedUpdatedAt: route.updatedAt, stops: editStops(route).map((stop, i) => ({ ...stop, name: stop.name + i })), pitaks });
      if (mutation === "inactive") await adapter.updateRoute(route.id, { active: false });
      if (mutation === "deleted") await adapter.deleteRoute(route.id);
      await assert.rejects(async () => adapter.joinQueue(enrollment(f, driver.user, route), driver.user.sessionVersion, choiceInput(route)), e => ["ROUTE_CHANGED", "ROUTE_INACTIVE", "ROUTE_NOT_FOUND"].includes(e.code));
      assert.equal(await adapter.getQueueEntry(driver.user.id), undefined);
    }
  }
});

test("real PostgreSQL choice-versus-configured-join barriers preserve one legal outcome in both schedules", { timeout: 20000 }, async t => {
  for (const winner of ["join", "choice"]) {
    const f = await fixture(t), route = await f.configured(), driver = await planned(f, route);
    const enroll = () => store.joinQueue(enrollment(f, driver.user, route), driver.user.sessionVersion, choiceInput(route));
    const change = () => otherStore.setDriverRouteChoice(driver.user.id, choiceInput(route, "b_to_a"), driver.user.sessionVersion);
    const results = await overlapUser(driver.user.id, winner === "join" ? [enroll, change] : [change, enroll]);
    assert.ok(results[0].value); assert.ok(results[1].error);
    if (winner === "join") {
      assert.equal(results[1].error.code, "DRIVER_ROUTE_BUSY");
      assert.equal((await otherStore.getQueueEntry(driver.user.id)).routeContext.pitak, "A");
    } else {
      assert.equal(results[1].error.code, "ROUTE_CHANGED");
      assert.equal(await otherStore.getQueueEntry(driver.user.id), undefined);
      assert.equal((await store.getUser(driver.user.id)).driverRouteChoice.direction, "b_to_a");
    }
  }
});

