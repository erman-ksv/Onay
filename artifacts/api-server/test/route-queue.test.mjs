import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { io as createSocket } from "socket.io-client";

// Use the production HTTP app and adapters. PostgreSQL is mandatory, and
// all six tables are cloned with their real columns/indexes into a private
// schema. No public data is changed and no SQL results are substituted.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `route_queue_${randomUUID().replaceAll("-", "")}`;
const applicationName = `route-queue-${randomUUID()}`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes", "tezjet_admin_audit_events"];
const envKeys = ["DATABASE_URL", "TEZJET_STORAGE_ADAPTER", "NODE_ENV", "SESSION_SECRET", "LOG_LEVEL", "REQUIRE_DRIVER_APPROVAL", "PYATAK_CENTER_LAT", "PYATAK_CENTER_LNG"];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let moduleDirectory, production, database, adminPool, store, otherStore, server, baseUrl;
let realtime;
const sockets = new Set();
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
        'export { createRealtimeServer } from "./src/socket";',
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
    for (const socket of sockets) socket.disconnect();
    if (realtime) await new Promise(resolve => realtime.close(resolve));
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
    const locationUpdate = await request("/queue/location", { token: driver.token, method: "PATCH", body: { location: at(config, direction) } });
    assert.equal(locationUpdate.status, 200, JSON.stringify(locationUpdate.body));
    assert.equal(locationUpdate.body.entry.routeContext.pitak, context.pitak);
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
    const joined = await adapter.joinQueue(enrollment(f, a.user, route), a.user.sessionVersion, choiceInput(route));
    const durable = structuredClone(await adapter.getQueueEntry(a.user.id));
    joined.routeContext.center.lat = 0;
    delete joined.routeContext;
    const fetched = await adapter.getQueueEntry(a.user.id);
    assert.deepEqual(fetched, durable, "Changing or deleting a returned context must not erase the stored lane or move its geofence.");
    fetched.routeContext.center.lng = 0;
    delete fetched.routeContext;
    assert.deepEqual(await adapter.getQueueEntry(a.user.id), durable, "A fetched configured entry must also be isolated from caller mutations.");
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

test("actual HTTP configured joins recheck live session, role and approval after a user row-lock wait", { timeout: 20_000 }, async t => {
  for (const mutation of ["session", "role", "approval"]) {
    await t.test(mutation, async child => {
      const f = await fixture(child), route = await f.configured(), driver = await planned(f, route);
      const blocker = await adminPool.connect();
      let pending;
      try {
        await blocker.query("BEGIN");
        await blocker.query(`SELECT id FROM "${schema}".tezjet_users WHERE id = $1 FOR UPDATE`, [driver.user.id]);
        pending = join(driver, route);
        await waitForBlockedTransactions(1);
        // HTTP has authenticated with the prior account state. Its GPS-account
        // write is now waiting for this real concurrent account transaction;
        // the eventual enrollment must recheck the committed live authority.
        if (mutation === "session") await blocker.query(`UPDATE "${schema}".tezjet_users SET session_version = session_version + 1 WHERE id = $1`, [driver.user.id]);
        if (mutation === "role") await blocker.query(`UPDATE "${schema}".tezjet_users SET role = 'passenger', roles = '["driver","passenger"]'::jsonb WHERE id = $1`, [driver.user.id]);
        if (mutation === "approval") await blocker.query(`UPDATE "${schema}".tezjet_users SET driver_approval_status = 'rejected' WHERE id = $1`, [driver.user.id]);
        await blocker.query("COMMIT");
        const [status, code] = mutation === "session" ? [401, "UNAUTHORIZED"] : mutation === "role" ? [403, "FORBIDDEN"] : [403, "DRIVER_NOT_APPROVED"];
        assertError(await pending, status, code);
        assert.equal(await otherStore.getQueueEntry(driver.user.id), undefined, "Failed live authority checks must leave no inserted queue row.");
        assert.deepEqual((await otherStore.getUser(driver.user.id)).driverRouteChoice, savedChoice(route));
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        if (pending) await pending;
      }
    });
  }
});

test("a real HTTP admin layout writer queued first makes an overlapping configured join stale and rolls back enrollment", { timeout: 20_000 }, async t => {
  const f = await fixture(t), route = await f.configured(), driver = await planned(f, route), admin = await f.createUser("admin");
  const blocker = await adminPool.connect();
  const pending = [];
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM "${schema}".tezjet_routes WHERE id = $1 FOR UPDATE`, [route.id]);
    pending.push(request(`/admin/routes/${route.id}/layout`, { token: admin.token, method: "PUT", body: {
      expected_updated_at: route.updatedAt,
      stops: editStops(route).map((stop, index) => ({ ...stop, name: index === 1 ? "Обновлённая промежуточная остановка" : stop.name })),
      pitaks: { a_stop_code: pitaks.aStopCode, b_stop_code: pitaks.bStopCode, radius_meters: pitaks.radiusMeters },
    } }));
    await waitForBlockedTransactions(1);
    pending.push(join(driver, route));
    await waitForBlockedTransactions(2);
    // Observed PostgreSQL lock waiters establish that the admin UPDATE is
    // ahead of the join's route SHARE lock. Simultaneous JS starts alone do
    // not establish this ordering or prove a stale version was read.
    await blocker.query("COMMIT");
    const [written, rejected] = await Promise.all(pending);
    assert.equal(written.status, 200, JSON.stringify(written.body));
    assert.ok(Date.parse(written.body.route.updatedAt) > Date.parse(route.updatedAt));
    assert.equal(written.body.route.stops[1].name, "Обновлённая промежуточная остановка");
    assertError(rejected, 409, "ROUTE_CHANGED");
    assert.equal(await otherStore.getQueueEntry(driver.user.id), undefined, "The losing join must roll back its newly inserted row.");
    assert.deepEqual(await otherStore.getRoute(route.id), written.body.route);
    assert.deepEqual((await otherStore.getUser(driver.user.id)).driverRouteChoice, savedChoice(route));
    const restored = await request("/driver/route", { token: driver.token });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.unavailable_reason, "ROUTE_CHANGED");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await Promise.allSettled(pending);
  }
});

function initialSocketSnapshot(t, token) {
  const socket = createSocket(new URL(baseUrl).origin, {
    path: "/api/socket.io", auth: { token }, transports: ["websocket"],
    autoConnect: false, reconnection: false,
  });
  sockets.add(socket);
  t.after(() => { socket.disconnect(); sockets.delete(socket); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Timed out waiting for the real initial queue:snapshot")), 5_000);
    function finish(error, snapshot) {
      clearTimeout(timer);
      socket.off("queue:snapshot", onSnapshot);
      socket.off("connect_error", onError);
      if (error) reject(error);
      else resolve(snapshot);
    }
    const onSnapshot = snapshot => finish(undefined, snapshot);
    const onError = error => finish(error);
    socket.once("queue:snapshot", onSnapshot);
    socket.once("connect_error", onError);
    socket.connect();
  });
}

test("actual Socket.IO initial snapshots expose only the caller's configured lane or legacy queue", { timeout: 20_000 }, async t => {
  const f = await fixture(t), route = await f.configured(), route2 = await f.configured();
  const a1 = await planned(f, route), a2 = await planned(f, route), b = await planned(f, route, "b_to_a");
  const other = await planned(f, route2), observer = await planned(f, route);
  const legacy = await f.createUser(), passenger = await f.createUser("passenger");
  const socketJoinedAt = Date.now();
  const enrollments = [[a1, route, "a_to_b"], [a2, route, "a_to_b"], [b, route, "b_to_a"], [other, route2, "a_to_b"]];
  for (const [index, [driver, config, direction]] of enrollments.entries()) {
    await store.joinQueue({ ...enrollment(f, driver.user, config, direction), joinedAt: socketJoinedAt + index }, driver.user.sessionVersion, choiceInput(config, direction));
  }
  await store.joinQueue(f.queueInput(legacy.user), legacy.user.sessionVersion);
  // Attach the production initializer to the very same real HTTP server and
  // PostgreSQL-backed runtime store used by the request tests, not a mocked
  // Socket.IO handler or an alternative queue projection.
  realtime = production.createRealtimeServer(server);
  production.app.locals.io = realtime;
  const cases = [
    [a2, [a1.user.id, a2.user.id], 2, `route:${route.id}:A`],
    [b, [b.user.id], 1, `route:${route.id}:B`],
    [other, [other.user.id], 1, `route:${route2.id}:A`],
    [observer, [a1.user.id, a2.user.id], null, `route:${route.id}:A`],
    [legacy, [legacy.user.id], 1, "pyatak"],
    [passenger, [legacy.user.id], null, "pyatak"],
  ];
  for (const [actor, ids, position, zoneId] of cases) {
    const snapshot = await initialSocketSnapshot(t, actor.token);
    assert.deepEqual(snapshot.queue.map(entry => entry.driverId), ids, "Initial snapshots must not leak another route, opposite pitak, or legacy lane.");
    assert.equal(snapshot.your_position, position);
    assert.equal(snapshot.zone.id, zoneId);
    assert.deepEqual(snapshot.queue.map(entry => entry.position), ids.map((_, index) => index + 1));
    const http = await request("/queue", { token: actor.token });
    assert.equal(http.status, 200);
    assert.deepEqual(snapshot.queue, http.body.queue, "Socket initialization and HTTP must use the same durable lane view.");
    assert.deepEqual(snapshot.zone, http.body.zone, "The initial zone must also identify the same pitak and geofence as HTTP.");
  }
});

test("administrator queue identifies each durable lane without changing FIFO or leaking GPS and locks", async t => {
  const f = await fixture(t), route = await f.configured(), route2 = await f.configured();
  const admin = await f.createUser("admin");
  const a1 = await planned(f, route), a2 = await planned(f, route);
  const b = await planned(f, route, "b_to_a"), other = await planned(f, route2);
  const legacy = await f.createUser();
  const enrollments = [[a1, route, "a_to_b"], [b, route, "b_to_a"], [other, route2, "a_to_b"], [a2, route, "a_to_b"]];
  const epoch = Date.now();
  for (const [index, [driver, config, direction]] of enrollments.entries()) {
    await store.joinQueue({ ...enrollment(f, driver.user, config, direction), joinedAt: epoch + index },
      driver.user.sessionVersion, choiceInput(config, direction));
  }
  await store.joinQueue({ ...f.queueInput(legacy.user), joinedAt: epoch + 4 }, legacy.user.sessionVersion);
  const before = await store.queueSnapshot();
  const result = await request("/admin/queue?include_lanes=true", { token: admin.token });
  assert.equal(result.status, 200);
  assert.equal(result.body.total_queued, 5);
  assert.deepEqual(result.body.queue.map(entry => entry.driver_id), [a1, b, other, a2, legacy].map(actor => actor.user.id));
  assert.deepEqual(result.body.queue.map(entry => entry.position), [1, 1, 1, 2, 1]);
  for (const entry of result.body.queue) {
    assert.deepEqual(Object.keys(entry).sort(), ["driver_id", "position", "joined_at", "status", "available_seats", "lane"].sort());
    const persisted = before.find(item => item.driverId === entry.driver_id);
    if (persisted.routeContext) {
      const context = persisted.routeContext;
      assert.deepEqual(entry.lane, {
        kind: "configured", route_id: context.routeId, route_name: context.routeName,
        direction: context.direction, pitak: context.pitak, stop_code: context.stopCode,
        stop_name: context.stopName, route_updated_at: context.routeUpdatedAt,
      });
      assert.equal("center" in entry.lane, false);
      assert.equal("radiusMeters" in entry.lane, false);
    } else assert.deepEqual(entry.lane, { kind: "legacy" });
  }
  assert.deepEqual(await store.queueSnapshot(), before, "Monitoring reads must not reserve seats, dispatch or reorder.");
  const restored = new production.PostgresStore();
  await restored.initialize();
  assert.deepEqual(await restored.queueSnapshot(), before, "The lane identity must come from durable enrollments.");
});

test("administrator lane details remain forbidden to anonymous, passenger and driver callers", async t => {
  const f = await fixture(t), passenger = await f.createUser("passenger"), driver = await f.createUser();
  for (const [token, status] of [[undefined, 401], [passenger.token, 403], [driver.token, 403]]) {
    const result = await request("/admin/queue?include_lanes=true", { token });
    assert.equal(result.status, status);
    assert.equal(result.body.queue, undefined);
    assert.equal(result.body.total_queued, undefined);
  }
});

test("admin lane opt-in preserves the exact legacy response and validates the boolean query", async t => {
  const f = await fixture(t), admin = await f.createUser("admin"), driver = await f.createUser();
  await store.joinQueue(f.queueInput(driver.user), driver.user.sessionVersion);
  const original = await request("/admin/queue", { token: admin.token });
  const explicitFalse = await request("/admin/queue?include_lanes=false", { token: admin.token });
  assert.equal(original.status, 200);
  assert.equal(explicitFalse.status, 200);
  assert.deepEqual(explicitFalse.body, original.body);
  assert.equal(original.body.queue.some(entry => "lane" in entry), false);
  const opted = await request("/admin/queue?include_lanes=true", { token: admin.token });
  assert.equal(opted.status, 200);
  assert.deepEqual(opted.body.queue.map(({ lane, ...entry }) => entry), original.body.queue);
  for (const query of ["1", "", "TRUE", "true&include_lanes=false"]) {
    const result = await request("/admin/queue?include_lanes=" + query, { token: admin.token });
    assertError(result, 400, "VALIDATION_ERROR");
  }
});
