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
const schema = `driver_route_${randomUUID().replaceAll("-", "")}`;
const applicationName = `driver-route-${randomUUID()}`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes", "tezjet_admin_audit_events"];
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
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".driver-route-test-"));
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

test("the actual choice migration adds nullable JSONB without changing existing account roles or approvals", async () => {
  const migrationSchema = `choice_migration_${randomUUID().replaceAll("-", "")}`;
  const sql = await readFile(path.resolve(apiRoot, "../../lib/db/drizzle/0003_driver_route_choice.sql"), "utf8");
  const client = await adminPool.connect();
  try {
    await client.query(`CREATE SCHEMA "${migrationSchema}"`);
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO "${migrationSchema}"`);
    await client.query("CREATE TABLE tezjet_users (id text PRIMARY KEY, role text NOT NULL, roles jsonb NOT NULL, driver_approval_status text)");
    await client.query("INSERT INTO tezjet_users VALUES ('legacy', 'driver', '[\"driver\",\"passenger\"]', 'approved')");
    await client.query(sql);
    const { rows } = await client.query("SELECT id, role, roles, driver_approval_status, driver_route_choice FROM tezjet_users");
    assert.deepEqual(rows, [{ id: "legacy", role: "driver", roles: ["driver", "passenger"], driver_approval_status: "approved", driver_route_choice: null }]);
    const { rows: columns } = await client.query("SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tezjet_users' AND column_name = 'driver_route_choice'", [migrationSchema]);
    assert.deepEqual(columns, [{ data_type: "jsonb", is_nullable: "YES" }]);
    const { rows: inserted } = await client.query("INSERT INTO tezjet_users (id, role, roles) VALUES ('new', 'passenger', '[\"passenger\"]') RETURNING driver_route_choice");
    assert.equal(inserted[0].driver_route_choice, null);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`);
  }
});

test("HTTP catalog exposes only active valid static configurations, including valid geometry and ordering boundaries", async t => {
  const f = await fixture(t);
  const driver = await f.createUser();
  const valid = await f.configured();
  const inactive = await f.configured({ active: false });
  const unconfigured = await f.createRoute();
  const corruptIds = [];
  const corruptions = [
    ["no stops", route => { route.stops = null; }],
    ["null stop", route => { route.stops[1] = null; }],
    ["missing endpoint location", route => { delete route.stops[0].location; }],
    ["latitude outside bounds", route => { route.stops[0].location.lat = 90.001; }],
    ["longitude outside bounds", route => { route.stops.at(-1).location.lng = -180.001; }],
    ["coerced latitude", route => { route.stops[0].location.lat = "42.9"; }],
    ["malformed middle geometry", route => { route.stops[1].location = { lat: 0, lng: null }; }],
    ["duplicate stop id", route => { route.stops[1].id = route.stops[0].id; }],
    ["duplicate stop code", route => { route.stops[1].code = "A"; }],
    ["empty stop name", route => { route.stops[1].name = " "; }],
    ["decreasing sequence", route => { route.stops[1].sequence = 1; }],
    ["noninteger position", route => { route.stops[1].position = 1.5; }],
    ["radius too small", route => { route.pitaks.radiusMeters = 9; }],
    ["radius too large", route => { route.pitaks.radiusMeters = 5001; }],
    ["coerced radius", route => { route.pitaks.radiusMeters = "175"; }],
    ["equal endpoints", route => { route.pitaks.bStopCode = "A"; }],
    ["misplaced endpoint", route => { route.pitaks.aStopCode = "C"; }],
    ["missing endpoint", route => { route.pitaks.bStopCode = "X"; }],
    ["truthy malformed active", route => { route.active = "true"; }],
  ];
  for (const [name, mutate] of corruptions) {
    const route = await f.configured({ name });
    mutate(route);
    corruptIds.push(route.id);
    await database.query("UPDATE tezjet_routes SET payload = $2::jsonb WHERE id = $1", [route.id, JSON.stringify(route)]);
  }
  const boundary = await f.configured({ name: "Boundary geometry" });
  boundary.pitaks.radiusMeters = 10;
  boundary.stops[0].location = { lat: -90, lng: -180 };
  boundary.stops.at(-1).location = { lat: 90, lng: 180 };
  boundary.stops.forEach((stop, index) => { stop.sequence = (index + 1) * 3; stop.position = (index + 1) * 4; });
  await database.query("UPDATE tezjet_routes SET payload = $2::jsonb WHERE id = $1", [boundary.id, JSON.stringify(boundary)]);
  const radiusMax = await f.configured({ name: "Maximum radius" });
  radiusMax.pitaks.radiusMeters = 5000;
  await database.query("UPDATE tezjet_routes SET payload = $2::jsonb WHERE id = $1", [radiusMax.id, JSON.stringify(radiusMax)]);
  const result = await request("/driver/routes", { token: driver.token });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.routes.map(route => route.id).sort(), [valid.id, boundary.id, radiusMax.id].sort());
  assert.deepEqual(result.body.routes.find(route => route.id === valid.id), option(valid));
  assert.ok(!result.body.routes.some(route => [inactive.id, unconfigured.id, "pyatak", ...corruptIds].includes(route.id)));
  for (const route of result.body.routes) assert.deepEqual(Object.keys(route).sort(), ["id", "name", "pitaks", "stops", "updatedAt"]);
});

test("HTTP saves A→B and B→A, restores from another Store, and clears durably without changing session or route", async t => {
  const f = await fixture(t);
  const driver = await f.createUser();
  const route = await f.configured();
  assert.deepEqual((await request("/driver/route", { token: driver.token })).body, { choice: null, route: null, unavailable_reason: null });
  for (const direction of ["a_to_b", "b_to_a"]) {
    const result = await request("/driver/route", { token: driver.token, method: "PUT", body: choiceBody(route, direction) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body, { choice: savedChoice(route, direction), route: option(route), unavailable_reason: null });
    const restarted = new production.PostgresStore();
    await restarted.initialize();
    assert.deepEqual((await restarted.getUser(driver.user.id)).driverRouteChoice, savedChoice(route, direction));
    assert.deepEqual((await request("/driver/route", { token: driver.token })).body, result.body);
    assert.equal((await store.getUser(driver.user.id)).sessionVersion, driver.user.sessionVersion);
    assert.deepEqual(await store.getRoute(route.id), route);
  }
  const me = await request("/auth/me", { token: driver.token });
  assert.equal(me.status, 200);
  assert.equal(Object.hasOwn(me.body.user, "driverRouteChoice"), false, "Choice is kept in the dedicated endpoint rather than public identity fields.");
  assert.equal(Object.hasOwn(me.body.user, "driver_route_choice"), false);
  assert.equal((await request("/driver/route", { token: driver.token, method: "DELETE" })).status, 204);
  assert.equal((await request("/driver/route", { token: driver.token, method: "DELETE" })).status, 204, "Clearing no choice is idempotent when idle.");
  assert.equal((await otherStore.getUser(driver.user.id)).driverRouteChoice, undefined);
  assert.deepEqual((await request("/driver/route", { token: driver.token })).body, { choice: null, route: null, unavailable_reason: null });
});

test("HTTP catalog, restore, save and clear require an authenticated approved driver in active driver mode", async t => {
  const f = await fixture(t);
  const route = await f.configured();
  const actors = [
    [undefined, 401, "UNAUTHORIZED"],
    [(await f.createUser("passenger")).token, 403, "FORBIDDEN"],
    [(await f.createUser("admin")).token, 403, "FORBIDDEN"],
    [(await f.createUser("driver", "pending")).token, 403, "DRIVER_APPROVAL_REQUIRED"],
    [(await f.createUser("driver", "rejected")).token, 403, "DRIVER_APPROVAL_REQUIRED"],
  ];
  for (const [token, status, code] of actors) {
    for (const [pathname, method] of [["/driver/routes", "GET"], ["/driver/route", "GET"], ["/driver/route", "PUT"], ["/driver/route", "DELETE"]]) {
      assertError(await request(pathname, { token, method, ...(method === "PUT" ? { body: choiceBody(route) } : {}) }), status, code);
    }
  }
});

test("HTTP rejects malformed choices without changing an existing saved direction", async t => {
  const f = await fixture(t);
  const driver = await f.createUser();
  const route = await f.configured();
  await store.setDriverRouteChoice(driver.user.id, choiceInput(route), driver.user.sessionVersion);
  const valid = choiceBody(route);
  for (const body of [[], {}, { ...valid, route_id: "" }, { ...valid, route_id: 1 }, { ...valid, route_id: "x".repeat(81) }, { ...valid, direction: "A_TO_B" }, { ...valid, direction: null }, { ...valid, expected_updated_at: "" }, { ...valid, expected_updated_at: 0 }, { ...valid, extra: true }]) {
    assertError(await request("/driver/route", { token: driver.token, method: "PUT", body }), 400, "VALIDATION_ERROR");
    assert.deepEqual((await otherStore.getUser(driver.user.id)).driverRouteChoice, savedChoice(route));
  }
});

test("HTTP rejected missing, inactive, stale and unconfigured route writes preserve the saved choice", async t => {
  const f = await fixture(t);
  const driver = await f.createUser();
  const route = await f.configured();
  await store.setDriverRouteChoice(driver.user.id, choiceInput(route), driver.user.sessionVersion);
  const inactive = await f.configured({ active: false });
  const draft = await f.createRoute();
  for (const [body, status, code] of [
    [{ ...choiceBody(route), route_id: `missing-${randomUUID()}` }, 404, "ROUTE_NOT_FOUND"],
    [choiceBody(inactive), 422, "ROUTE_INACTIVE"],
    [choiceBody(draft), 422, "ROUTE_NOT_CONFIGURED"],
    [{ ...choiceBody(route), expected_updated_at: new Date(0).toISOString() }, 409, "ROUTE_CHANGED"],
  ]) {
    assertError(await request("/driver/route", { token: driver.token, method: "PUT", body }), status, code);
    assert.deepEqual((await store.getUser(driver.user.id)).driverRouteChoice, savedChoice(route));
  }
});

test("HTTP restore reports missing, inactive, edited and no-longer-configured routes without silently clearing the saved choice", async t => {
  for (const reason of ["ROUTE_MISSING", "ROUTE_INACTIVE", "ROUTE_CHANGED", "ROUTE_NOT_CONFIGURED"]) {
    await t.test(reason, async child => {
      const f = await fixture(child);
      const driver = await f.createUser();
      const route = await f.configured();
      await store.setDriverRouteChoice(driver.user.id, choiceInput(route, "b_to_a"), driver.user.sessionVersion);
      if (reason === "ROUTE_MISSING") await store.deleteRoute(route.id);
      if (reason === "ROUTE_INACTIVE") await store.updateRoute(route.id, { active: false });
      if (reason === "ROUTE_CHANGED") await store.updateRoute(route.id, { name: "Изменённое имя" });
      if (reason === "ROUTE_NOT_CONFIGURED") await store.updateRouteLayout(route.id, { expectedUpdatedAt: route.updatedAt, stops: editStops(route) });
      const result = await request("/driver/route", { token: driver.token });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(result.body, { choice: savedChoice(route, "b_to_a"), route: null, unavailable_reason: reason });
      assert.deepEqual((await otherStore.getUser(driver.user.id)).driverRouteChoice, savedChoice(route, "b_to_a"));
      assertError(await request("/queue/join", { token: driver.token, method: "POST", body: { location: { ...location, timestamp: Date.now() }, available_seats: 4 } }), 409, "ROUTE_QUEUE_NOT_AVAILABLE");
      assert.equal(await store.getQueueEntry(driver.user.id), undefined, "An unavailable choice must still prevent a legacy queue insert.");
      assert.equal((await request("/driver/route", { token: driver.token, method: "DELETE" })).status, 204);
    });
  }
});

test("both adapters reject choice saves and clears for FIFO, active-trip and pending-offer queue records", async t => {
  for (const adapterName of ["MemoryStore", "PostgresStore"]) {
    for (const state of ["fifo", "active", "pending"]) {
      await t.test(`${adapterName} ${state}`, async child => {
        const adapter = adapterName === "MemoryStore" ? new production.MemoryStore() : store;
        const f = await fixture(child, adapter);
        const driver = await f.createUser();
        const route = await f.configured();
        await adapter.joinQueue(f.queueInput(driver.user), driver.user.sessionVersion);
        if (state === "active") await adapter.updateQueueEntry(driver.user.id, { status: "in_transit", inFifo: false });
        if (state === "pending") await adapter.updateQueueEntry(driver.user.id, { pendingOfferOrderId: `pending-${randomUUID()}` });
        const before = structuredClone(await adapter.getUser(driver.user.id));
        const queue = structuredClone(await adapter.getQueueEntry(driver.user.id));
        for (const input of [choiceInput(route), null]) {
          await assert.rejects(async () => adapter.setDriverRouteChoice(driver.user.id, input, driver.user.sessionVersion), { statusCode: 409, code: "DRIVER_ROUTE_BUSY" });
          assert.deepEqual(await adapter.getUser(driver.user.id), before);
          assert.deepEqual(await adapter.getQueueEntry(driver.user.id), queue);
        }
        if (adapterName === "PostgresStore") {
          for (const method of ["PUT", "DELETE"]) assertError(await request("/driver/route", { token: driver.token, method, ...(method === "PUT" ? { body: choiceBody(route) } : {}) }), 409, "DRIVER_ROUTE_BUSY");
        }
      });
    }
  }
});

test("both adapters block nonterminal order relations without a queue row and allow intact terminal history", async t => {
  for (const adapterName of ["MemoryStore", "PostgresStore"]) {
    for (const relation of ["passengerId", "driverId", "offeredDriverId"]) {
      await t.test(`${adapterName} ${relation}`, async child => {
        const adapter = adapterName === "MemoryStore" ? new production.MemoryStore() : store;
        const f = await fixture(child, adapter);
        const driver = await f.createUser(relation === "passengerId" ? "passenger" : "driver");
        const passenger = await f.createUser("passenger");
        const route = await f.configured();
        // A prior passenger relation can survive a switch to driver mode.
        // Create terminal history while that actor is a real passenger, then
        // make the saved relation live using the production snapshot writer.
        const history = [];
        for (const status of ["completed", "completed", "completed", "completed", "completed", "cancelled"]) {
          history.push(await adapter.createOrder(f.orderInput(passenger.user, { status, [relation]: driver.user.id })));
        }
        if (relation === "passengerId") {
          await adapter.activateUserRole(driver.user.id, "driver", driver.user.sessionVersion);
          await adapter.setDriverApproval(driver.user.id, "approved");
          driver.user = structuredClone(await adapter.getUser(driver.user.id));
        }
        const token = production.createAccessToken({ sub: driver.user.id, role: driver.user.role, locale: driver.user.locale, sessionVersion: driver.user.sessionVersion, sessionId: randomUUID() });
        for (const [index, status] of ["searching", "en_route_to_c", "arrived_at_c", "in_transit"].entries()) {
          const order = await adapter.updateOrder(history[index].id, { status });
          for (const input of [choiceInput(route), null]) await assert.rejects(async () => adapter.setDriverRouteChoice(driver.user.id, input, driver.user.sessionVersion), { statusCode: 409, code: "DRIVER_ROUTE_BUSY" });
          if (adapterName === "PostgresStore") {
            for (const method of ["PUT", "DELETE"]) assertError(await request("/driver/route", { token, method, ...(method === "PUT" ? { body: choiceBody(route) } : {}) }), 409, "DRIVER_ROUTE_BUSY");
          }
          assert.equal((await adapter.getUser(driver.user.id)).driverRouteChoice, undefined);
          assert.deepEqual(await adapter.getOrder(order.id), order);
          await adapter.updateOrder(order.id, { status: "completed" });
        }
        assert.deepEqual(await adapter.setDriverRouteChoice(driver.user.id, choiceInput(route), driver.user.sessionVersion), savedChoice(route));
        assert.equal(await adapter.setDriverRouteChoice(driver.user.id, null, driver.user.sessionVersion), null);
        const historyIds = new Set(history.map(order => order.id));
        const retained = (await adapter.listOrders()).filter(order => historyIds.has(order.id));
        assert.equal(retained.length, 6, "All terminal order snapshots remain intact, including historic offered-driver relations.");
        assert.ok(retained.every(order => ["completed", "cancelled"].includes(order.status)));
      });
    }
  }
});

test("HTTP legacy queue remains usable with no choice, while configured choices reject and roll back queue insertion until cleared", async t => {
  const f = await fixture(t);
  const driver = await f.createUser();
  const route = await f.configured();
  const join = () => request("/queue/join", { token: driver.token, method: "POST", body: { location: { ...location, timestamp: Date.now() }, available_seats: 4 } });
  assert.equal((await join()).status, 201);
  assertError(await request("/driver/route", { token: driver.token, method: "PUT", body: choiceBody(route) }), 409, "DRIVER_ROUTE_BUSY");
  assert.equal((await request("/queue/leave", { token: driver.token, method: "DELETE" })).status, 204);
  assert.equal((await request("/driver/route", { token: driver.token, method: "PUT", body: choiceBody(route) })).status, 200);
  assertError(await join(), 409, "ROUTE_QUEUE_NOT_AVAILABLE");
  assert.equal(await store.getQueueEntry(driver.user.id), undefined);
  assert.equal((await request("/driver/route", { token: driver.token, method: "DELETE" })).status, 204);
  assert.equal((await join()).status, 201);
  assert.equal((await request("/queue/leave", { token: driver.token, method: "DELETE" })).status, 204);
});

test("real PostgreSQL save-versus-join barriers produce one legal winner in both absent-row lock schedules", { timeout: 20_000 }, async t => {
  for (const first of ["save", "join"]) {
    await t.test(`${first} first`, async child => {
      const f = await fixture(child);
      const driver = await f.createUser();
      const route = await f.configured();
      assert.equal(await store.getQueueEntry(driver.user.id), undefined);
      const actions = {
        save: () => request("/driver/route", { token: driver.token, method: "PUT", body: choiceBody(route) }),
        join: () => otherStore.joinQueue(f.queueInput(driver.user), driver.user.sessionVersion),
      };
      const second = first === "save" ? "join" : "save";
      const settled = await overlapUser(driver.user.id, [actions[first], actions[second]]);
      const results = { [first]: settled[0], [second]: settled[1] };
      if (first === "save") {
        assert.equal(results.save.value?.status, 200, JSON.stringify(results.save));
        assert.equal(results.join.error?.statusCode, 409);
        assert.equal(results.join.error?.code, "ROUTE_QUEUE_NOT_AVAILABLE");
        assert.deepEqual((await store.getUser(driver.user.id)).driverRouteChoice, savedChoice(route));
        assert.equal(await store.getQueueEntry(driver.user.id), undefined, "The losing join must roll back its previously absent queue row.");
      } else {
        assert.ok(results.join.value, String(results.join.error));
        assertError(results.save.value, 409, "DRIVER_ROUTE_BUSY");
        assert.equal((await store.getUser(driver.user.id)).driverRouteChoice, undefined);
        assert.equal((await store.getQueueEntry(driver.user.id)).driverId, driver.user.id);
      }
    });
  }
});

test("HTTP writes recheck session, active role and approval after a real account row lock wait", { timeout: 30_000 }, async t => {
  for (const mutation of ["session", "role", "approval"]) {
    for (const method of ["PUT", "DELETE"]) {
      await t.test(`${mutation} during ${method}`, async child => {
        const f = await fixture(child);
        const driver = await f.createUser();
        const route = await f.configured();
        await store.setDriverRouteChoice(driver.user.id, choiceInput(route), driver.user.sessionVersion);
        const blocker = await adminPool.connect();
        let pending;
        try {
          await blocker.query("BEGIN");
          await blocker.query(`SELECT id FROM "${schema}".tezjet_users WHERE id = $1 FOR UPDATE`, [driver.user.id]);
          pending = request("/driver/route", { token: driver.token, method, ...(method === "PUT" ? { body: choiceBody(route, "b_to_a") } : {}) });
          await waitForBlockedTransactions(1);
          // This is a real committed concurrent account mutation. The HTTP
          // request has already authenticated and is waiting at its write.
          if (mutation === "session") await blocker.query(`UPDATE "${schema}".tezjet_users SET session_version = session_version + 1 WHERE id = $1`, [driver.user.id]);
          if (mutation === "role") await blocker.query(`UPDATE "${schema}".tezjet_users SET role = 'passenger', roles = '["driver","passenger"]'::jsonb WHERE id = $1`, [driver.user.id]);
          if (mutation === "approval") await blocker.query(`UPDATE "${schema}".tezjet_users SET driver_approval_status = 'rejected' WHERE id = $1`, [driver.user.id]);
          await blocker.query("COMMIT");
          const [status, code] = mutation === "session" ? [401, "UNAUTHORIZED"] : mutation === "role" ? [403, "FORBIDDEN"] : [403, "DRIVER_APPROVAL_REQUIRED"];
          assertError(await pending, status, code);
          assert.deepEqual((await otherStore.getUser(driver.user.id)).driverRouteChoice, savedChoice(route));
          assert.equal(await store.getQueueEntry(driver.user.id), undefined);
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
          if (pending) await pending;
        }
      });
    }
  }
});

test("MemoryStore isolates saved snapshots, retains choice through role switches, and rejects stale authority and configured joins", async t => {
  const memory = new production.MemoryStore();
  const f = await fixture(t, memory);
  const driver = await f.createUser();
  const route = await f.configured();
  const input = choiceInput(route, "b_to_a");
  const saved = await memory.setDriverRouteChoice(driver.user.id, input, driver.user.sessionVersion);
  saved.direction = "a_to_b";
  input.direction = "a_to_b";
  const user = memory.getUser(driver.user.id);
  user.driverRouteChoice.routeId = "caller mutation";
  assert.deepEqual(memory.getUser(driver.user.id).driverRouteChoice, savedChoice(route, "b_to_a"));
  assert.equal(memory.getUser(driver.user.id).sessionVersion, driver.user.sessionVersion);
  await assert.rejects(async () => memory.joinQueue(f.queueInput(driver.user), driver.user.sessionVersion), { statusCode: 409, code: "ROUTE_QUEUE_NOT_AVAILABLE" });
  assert.equal(memory.getQueueEntry(driver.user.id), undefined);
  const passenger = memory.activateUserRole(driver.user.id, "passenger", driver.user.sessionVersion);
  assert.deepEqual(passenger.driverRouteChoice, savedChoice(route, "b_to_a"));
  await assert.rejects(async () => memory.setDriverRouteChoice(driver.user.id, null, driver.user.sessionVersion), { statusCode: 401, code: "UNAUTHORIZED" });
  await assert.rejects(async () => memory.setDriverRouteChoice(driver.user.id, null, passenger.sessionVersion), { statusCode: 403, code: "FORBIDDEN" });
  const returned = memory.activateUserRole(driver.user.id, "driver", passenger.sessionVersion);
  memory.setDriverApproval(driver.user.id, "rejected");
  await assert.rejects(async () => memory.setDriverRouteChoice(driver.user.id, null, returned.sessionVersion), { statusCode: 403, code: "DRIVER_APPROVAL_REQUIRED" });
  memory.setDriverApproval(driver.user.id, "approved");
  assert.equal(memory.setDriverRouteChoice(driver.user.id, null, returned.sessionVersion), null);
});
