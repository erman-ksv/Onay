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
const schema = `driver_vehicle_${randomUUID().replaceAll("-", "")}`;
const applicationName = `driver-vehicle-${randomUUID()}`;
const tables = ["tezjet_offer_policy", "tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes", "tezjet_admin_audit_events"];
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
  process.env.SESSION_SECRET = "driver-vehicle-regression-secret-at-least-32-characters";
  process.env.LOG_LEVEL = "silent";
  process.env.REQUIRE_DRIVER_APPROVAL = "true";
  process.env.PYATAK_CENTER_LAT = "41.3111";
  process.env.PYATAK_CENTER_LNG = "69.2797";
  delete process.env.TEZJET_OFFER_TIMEOUT_SECONDS;
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".driver-vehicle-test-"));
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
        'export { readDriverVehicleInput } from "./src/utils/driverVehicle";',
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

const car = { make: "Chevrolet", model: "Cobalt", plate_number: "01 A123 BC", seat_capacity: 3, expected_revision: null };
const input = (value = car) => production.readDriverVehicleInput(value);
const savedVehicle = async driver => {
  const result = await request("/driver/vehicle", { token: driver.token, method: "PUT", body: car });
  assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.driver_vehicle;
};

test("vehicle migration is nullable and profile survives a new PostgreSQL store", async t => {
  const f = await fixture(t), driver = await f.createUser("driver", "pending");
  assert.equal((await request("/driver/vehicle", { token: driver.token })).body.driver_vehicle, null);
  const vehicle = await savedVehicle(driver), fresh = new production.PostgresStore(); await fresh.initialize();
  const user = await fresh.getUser(driver.user.id);
  assert.equal(user.driverVehicle.revision, vehicle.revision);
  assert.equal(user.driverVehicle.plateNumber, car.plate_number); assert.equal(user.driverApprovalStatus, "pending");
  const column = await database.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='tezjet_users' AND column_name='driver_vehicle'", [schema]);
  assert.equal(column.rows[0].is_nullable, "YES");
});

test("only current driver owns the profile; forged fields and revoked sessions fail", async t => {
  const f = await fixture(t), driver = await f.createUser("driver", "pending");
  assertError(await request("/driver/vehicle"), 401, "UNAUTHORIZED");
  for (const role of ["passenger", "admin"]) {
    const actor = await f.createUser(role);
    assertError(await request("/driver/vehicle", { token: actor.token }), 403, "FORBIDDEN");
    assertError(await request("/driver/vehicle", { token: actor.token, method: "PUT", body: car }), 403, "FORBIDDEN");
  }
  for (const field of ["driver_id", "driver_approval_status", "revision", "version", "updated_at"])
    assertError(await request("/driver/vehicle", { token: driver.token, method: "PUT", body: { ...car, [field]: "forged" } }), 400, "VALIDATION_ERROR");
  await store.invalidateSessions(driver.user.id);
  assertError(await request("/driver/vehicle", { token: driver.token, method: "PUT", body: car }), 401, "UNAUTHORIZED");
});

test("invalid vehicle fields do not mutate an approved account", async t => {
  const f = await fixture(t), driver = await f.createUser();
  for (const body of [{ ...car, make: "" }, { ...car, model: "x".repeat(61) }, { ...car, plate_number: "bad<script>" },
    ...[0, 9, 1.5, "3", null].map(seat_capacity => ({ ...car, seat_capacity })), { ...car, expected_revision: undefined }])
    assertError(await request("/driver/vehicle", { token: driver.token, method: "PUT", body }), 400, "VALIDATION_ERROR");
  const user = await store.getUser(driver.user.id);
  assert.equal(user.driverVehicle, undefined); assert.equal(user.driverApprovalStatus, "approved");
});

test("saving resets approval; administrator must review the exact current revision", async t => {
  const f = await fixture(t), driver = await f.createUser(), admin = await f.createUser("admin"), first = await savedVehicle(driver);
  const approve = revision => request(`/admin/drivers/${driver.user.id}/approval`, { token: admin.token, method: "PATCH", body: { status: "approved", expected_vehicle_revision: revision } });
  assert.equal((await store.getUser(driver.user.id)).driverApprovalStatus, "pending");
  assertError(await approve(undefined), 409, "VEHICLE_REVIEW_CHANGED");
  assert.equal((await approve(first.revision)).status, 200);
  const edited = await request("/driver/vehicle", { token: driver.token, method: "PUT", body: { ...car, model: "Nexia", expected_revision: first.revision } });
  assert.equal(edited.status, 200); assert.equal(edited.body.approval_status, "pending"); assert.notEqual(edited.body.driver_vehicle.revision, first.revision);
  assertError(await approve(first.revision), 409, "VEHICLE_REVIEW_CHANGED");
  assertError(await request("/driver/vehicle", { token: driver.token, method: "PUT", body: { ...car, expected_revision: first.revision } }), 409, "VEHICLE_CHANGED");
  assert.equal((await approve(edited.body.driver_vehicle.revision)).status, 200);
});

test("reviewed capacity bounds queue join; enrollment prevents vehicle edits", async t => {
  const f = await fixture(t), driver = await f.createUser(), vehicle = await savedVehicle(driver);
  const entry = seats => ({ driverId: driver.user.id, joinedAt: Date.now(), status: "searching", availableSeats: seats, lastLocation: { lat: 41.3111, lng: 69.2797, timestamp: Date.now() }, priorityLock: false, inFifo: true, activeOrderIds: [] });
  await assert.rejects(store.joinQueue(entry(3), driver.user.sessionVersion), error => error.code === "VEHICLE_REVIEW_REQUIRED");
  await store.setDriverApproval(driver.user.id, "approved", vehicle.revision);
  await assert.rejects(store.joinQueue(entry(4), driver.user.sessionVersion), error => error.code === "VEHICLE_CAPACITY_EXCEEDED");
  assert.equal(await store.getQueueEntry(driver.user.id), undefined, "Invalid capacity rolls back the inserted entry");
  await store.joinQueue(entry(3), driver.user.sessionVersion);
  assertError(await request("/driver/vehicle", { token: driver.token, method: "PUT", body: { ...car, expected_revision: vehicle.revision } }), 409, "DRIVER_VEHICLE_BUSY");
  assert.equal((await store.getUser(driver.user.id)).driverApprovalStatus, "approved");
});

test("assigned passenger reads reviewed car without private revision; active ride prevents editing", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await f.planned(route), passenger = await f.createUser("passenger"), vehicle = await savedVehicle(driver);
  await store.setDriverApproval(driver.user.id, "approved", vehicle.revision); await f.storedJoin(driver, route, 3);
  const order = await f.storedOrder(passenger, route); await store.acceptOrderOffer(order.id, driver.user.id, Date.now(), driver.user.sessionVersion);
  const result = await request(`/orders/${order.id}/driver`, { token: passenger.token });
  assert.equal(result.status, 200); assert.deepEqual(result.body.driver.vehicle, { make: car.make, model: car.model, plate_number: car.plate_number, seat_capacity: 3 });
  assert.equal(JSON.stringify(result.body).includes(vehicle.revision), false);
  assertError(await request("/driver/vehicle", { token: driver.token, method: "PUT", body: { ...car, expected_revision: vehicle.revision } }), 409, "DRIVER_VEHICLE_BUSY");
});

test("concurrent review and edit cannot approve an unseen vehicle revision", { timeout: 10_000 }, async t => {
  const f = await fixture(t), driver = await f.createUser(), first = await savedVehicle(driver);
  const [review, edit] = await Promise.allSettled([store.setDriverApproval(driver.user.id, "approved", first.revision), otherStore.setDriverVehicle(driver.user.id, input({ ...car, model: "Nexia", expected_revision: first.revision }), driver.user.sessionVersion)]);
  assert.equal(edit.status, "fulfilled"); if (review.status === "rejected") assert.equal(review.reason.code, "VEHICLE_REVIEW_CHANGED");
  const user = await store.getUser(driver.user.id);
  assert.equal(user.driverApprovalStatus, "pending"); assert.equal(user.driverVehicle.model, "Nexia"); assert.notEqual(user.driverVehicle.revision, first.revision);
});

test("concurrent join and vehicle save preserve queue-before-user lock order and approval", { timeout: 10_000 }, async t => {
  const f = await fixture(t), driver = await f.createUser();
  const entry = { driverId: driver.user.id, joinedAt: Date.now(), status: "searching", availableSeats: 3, lastLocation: { lat: 41.3111, lng: 69.2797, timestamp: Date.now() }, priorityLock: false, inFifo: true, activeOrderIds: [] };
  const [save, join] = await Promise.allSettled([store.setDriverVehicle(driver.user.id, input(), driver.user.sessionVersion), otherStore.joinQueue(entry, driver.user.sessionVersion)]);
  const user = await store.getUser(driver.user.id), queued = await store.getQueueEntry(driver.user.id);
  if (save.status === "fulfilled") { assert.equal(user.driverApprovalStatus, "pending"); assert.equal(queued, undefined); assert.equal(join.status, "rejected"); }
  else { assert.equal(save.reason.code, "DRIVER_VEHICLE_BUSY"); assert.equal(join.status, "fulfilled"); assert.equal(user.driverApprovalStatus, "approved"); assert.equal(user.driverVehicle, undefined); assert.ok(queued); }
});

test("MemoryStore enforces the same vehicle revision, approval, capacity and busy rules", async () => {
  const adapter = new production.MemoryStore(); await adapter.initialize();
  const user = await adapter.createUser({ role: "driver", fullName: "Memory car", phoneNumber: "+77770009991", locale: "ru" });
  const saved = adapter.setDriverVehicle(user.id, input(), user.sessionVersion);
  assert.equal(saved.driverApprovalStatus, "pending");
  assert.throws(() => adapter.setDriverApproval(user.id, "approved"), error => error.code === "VEHICLE_REVIEW_CHANGED");
  adapter.setDriverApproval(user.id, "approved", saved.driverVehicle.revision);
  const entry = { driverId: user.id, joinedAt: Date.now(), status: "searching", availableSeats: 4, lastLocation: { lat: 41.3111, lng: 69.2797, timestamp: Date.now() }, priorityLock: false, inFifo: true, activeOrderIds: [] };
  assert.throws(() => adapter.joinQueue(entry, user.sessionVersion), error => error.code === "VEHICLE_CAPACITY_EXCEEDED");
  adapter.joinQueue({ ...entry, availableSeats: 3 }, user.sessionVersion);
  assert.throws(() => adapter.setDriverVehicle(user.id, input({ ...car, expected_revision: saved.driverVehicle.revision }), user.sessionVersion), error => error.code === "DRIVER_VEHICLE_BUSY");
});

async function storesWithLegacyApprovalBypass(t) {
  const outfile = path.join(moduleDirectory, `legacy-approval-${randomUUID()}.mjs`);
  await build({
    stdin: { contents: [
      'export { default as app } from "./src/app";',
      'export { createRealtimeServer } from "./src/socket";',
      'export { store as runtimeStore } from "./src/store";',
      'export { PostgresStore } from "./src/store/postgresStore";',
      'export { MemoryStore } from "./src/store/memoryStore";',
      'export { pool } from "../../lib/db/src/index";',
    ].join("\n"), resolveDir: apiRoot, loader: "ts" },
    outfile, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["pg-native", "pino", "pino-http", "socket.io"],
    banner: { js: 'import { createRequire as testCreateRequire } from "node:module"; const require = testCreateRequire(import.meta.url);' },
  });
  const prior = process.env.REQUIRE_DRIVER_APPROVAL;
  try {
    process.env.REQUIRE_DRIVER_APPROVAL = "false";
    const module = await import(pathToFileURL(outfile).href);
    t.after(() => module.pool.end());
    return module;
  } finally {
    if (prior === undefined) delete process.env.REQUIRE_DRIVER_APPROVAL;
    else process.env.REQUIRE_DRIVER_APPROVAL = prior;
  }
}

test("development approval bypass never authorizes a pending or revoked submitted vehicle over HTTP", async t => {
  const module = await storesWithLegacyApprovalBypass(t);
  await module.runtimeStore.initialize();
  const listener = await new Promise(resolve => { const server = module.app.listen(0, "127.0.0.1", () => resolve(server)); });
  const endpoint = `http://127.0.0.1:${listener.address().port}/api/driver/routes`;
  const f = await fixture(t), driver = await f.createUser(), legacy = await f.createUser("driver", "pending");
  const saved = await store.setDriverVehicle(driver.user.id, input(), driver.user.sessionVersion);
  const get = async actor => { const response = await fetch(endpoint, { headers: { authorization: `Bearer ${actor.token}` } }); return { status: response.status, body: await response.json() }; };
  const previous = process.env.REQUIRE_DRIVER_APPROVAL;
  process.env.REQUIRE_DRIVER_APPROVAL = "false";
  try {
    assert.equal((await get(legacy)).status, 200, "Legacy account compatibility stays available");
    assertError(await get(driver), 403, "DRIVER_APPROVAL_REQUIRED");
    await store.setDriverApproval(driver.user.id, "approved", saved.driverVehicle.revision);
    assert.equal((await get(driver)).status, 200);
    await store.setDriverApproval(driver.user.id, "rejected", saved.driverVehicle.revision);
    assertError(await get(driver), 403, "DRIVER_APPROVAL_REQUIRED");
  } finally {
    if (previous === undefined) delete process.env.REQUIRE_DRIVER_APPROVAL;
    else process.env.REQUIRE_DRIVER_APPROVAL = previous;
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
});

test("revoked vehicles disappear from configured availability and dispatch despite the legacy bypass", async t => {
  const module = await storesWithLegacyApprovalBypass(t);
  for (const [name, adapter] of [["PostgreSQL", new module.PostgresStore()], ["MemoryStore", new module.MemoryStore()]]) await t.test(name, async context => {
    const f = await fixture(context, adapter), route = await f.configured(), driver = await f.planned(route);
    const saved = await adapter.setDriverVehicle(driver.user.id, input(), driver.user.sessionVersion);
    await adapter.setDriverApproval(driver.user.id, "approved", saved.driverVehicle.revision);
    await f.storedJoin(driver, route, 3);
    assert.equal((await adapter.getRouteOrderAvailability(choice(route), 1)).available, true);
    await adapter.setDriverApproval(driver.user.id, "rejected", saved.driverVehicle.revision);
    assert.equal((await adapter.getRouteOrderAvailability(choice(route), 1)).available, false);
    const passenger = await f.createUser("passenger");
    assert.equal(await f.storedOrder(passenger, route), undefined, "Rejected car cannot reserve a new order");
    const legacy = await f.planned(route);
    await adapter.setDriverApproval(legacy.user.id, "pending");
    await f.storedJoin(legacy, route, 2);
    assert.equal((await adapter.getRouteOrderAvailability(choice(route), 1)).available, true);
    const order = await f.storedOrder(passenger, route);
    assert.equal(order.offeredDriverId, legacy.user.id, "Dispatch preserves legacy compatibility and skips the revoked car");
    const revokedEntry = await adapter.getQueueEntry(driver.user.id);
    assert.equal(revokedEntry.availableSeats, 3); assert.equal(revokedEntry.pendingOfferOrderId, undefined);
  });
});

test("revocation invalidates an existing offer and releases its seats exactly once with the bypass enabled", async t => {
  const module = await storesWithLegacyApprovalBypass(t);
  for (const [name, adapter] of [["PostgreSQL", new module.PostgresStore()], ["MemoryStore", new module.MemoryStore()]]) await t.test(name, async context => {
    const f = await fixture(context, adapter), route = await f.configured(), driver = await f.planned(route);
    const saved = await adapter.setDriverVehicle(driver.user.id, input(), driver.user.sessionVersion);
    await adapter.setDriverApproval(driver.user.id, "approved", saved.driverVehicle.revision);
    await f.storedJoin(driver, route, 3);
    const passenger = await f.createUser("passenger"), order = await f.storedOrder(passenger, route, 2);
    assert.equal(order.offeredDriverId, driver.user.id);
    assert.equal((await adapter.getQueueEntry(driver.user.id)).availableSeats, 1);
    await adapter.setDriverApproval(driver.user.id, "rejected", saved.driverVehicle.revision);
    assert.equal(await adapter.acceptOrderOffer(order.id, driver.user.id, Date.now(), driver.user.sessionVersion), undefined);
    await adapter.processOrderOffers();
    const released = await adapter.getQueueEntry(driver.user.id), current = await adapter.getOrder(order.id);
    assert.equal(released.availableSeats, 3); assert.equal(released.pendingOfferOrderId, undefined);
    assert.equal(current.driverId, undefined); assert.equal(current.offeredDriverId, undefined);
    assert.equal(current.status, "searching");
    await adapter.processOrderOffers();
    assert.equal((await adapter.getQueueEntry(driver.user.id)).availableSeats, 3);
  });
});

test("socket authentication keeps submitted-car review mandatory while retaining legacy development access", async t => {
  const module = await storesWithLegacyApprovalBypass(t);
  const { createServer } = await import("node:http");
  const { io: connect } = await import("socket.io-client");
  await module.runtimeStore.initialize();
  const listener = createServer(), realtime = module.createRealtimeServer(listener);
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${listener.address().port}`;
  const f = await fixture(t), driver = await f.createUser(), legacy = await f.createUser("driver", "pending");
  const saved = await store.setDriverVehicle(driver.user.id, input(), driver.user.sessionVersion);
  const handshake = token => new Promise((resolve, reject) => {
    const client = connect(endpoint, { path: "/api/socket.io", auth: { token }, transports: ["websocket"], reconnection: false, autoConnect: false });
    const timer = setTimeout(() => { client.close(); reject(new Error("Socket authentication did not settle")); }, 3000);
    const finish = result => { clearTimeout(timer); client.close(); resolve(result); };
    client.once("connect", () => finish("connected"));
    client.once("connect_error", error => finish(error.message));
    client.connect();
  });
  try {
    assert.equal(await handshake(legacy.token), "connected");
    assert.equal(await handshake(driver.token), "Driver approval required");
    await store.setDriverApproval(driver.user.id, "approved", saved.driverVehicle.revision);
    assert.equal(await handshake(driver.token), "connected");
    await store.setDriverApproval(driver.user.id, "rejected", saved.driverVehicle.revision);
    assert.equal(await handshake(driver.token), "Driver approval required");
  } finally { await new Promise(resolve => realtime.close(resolve)); }
});

const blockBody = (blocked, revision = null) => ({ blocked, expected_vehicle_revision: revision });
const blockPath = driver => "/admin/drivers/" + driver.user.id + "/block";

test("Only a current administrator can explicitly block a driver; invalid bodies and targets do not mutate", async t => {
  const f = await fixture(t), driver = await f.createUser(), admin = await f.createUser("admin");
  const path = blockPath(driver);
  assertError(await request(path, { method: "PATCH", body: blockBody(true) }), 401, "UNAUTHORIZED");
  for (const role of ["passenger", "driver"]) {
    const actor = await f.createUser(role);
    assertError(await request(path, { token: actor.token, method: "PATCH", body: blockBody(true) }), 403, "FORBIDDEN");
  }
  for (const body of [{}, { blocked: true }, blockBody("true"), blockBody(1), blockBody(null),
    { ...blockBody(true), driver_id: "forged" }, { ...blockBody(true), expected_vehicle_revision: {} }]) {
    assertError(await request(path, { token: admin.token, method: "PATCH", body }), 400, "VALIDATION_ERROR");
  }
  assert.equal((await store.getUser(driver.user.id)).driverApprovalStatus, "approved");
  assert.equal((await store.listAdminAuditEvents(undefined, 100, driver.user.id)).length, 0);
  const passenger = await f.createUser("passenger");
  assertError(await request(blockPath(passenger), { token: admin.token, method: "PATCH", body: blockBody(true) }), 404, "DRIVER_NOT_FOUND");
  assertError(await request("/admin/drivers/missing/block", { token: admin.token, method: "PATCH", body: blockBody(true) }), 404, "DRIVER_NOT_FOUND");
  await store.invalidateSessions(admin.user.id);
  assertError(await request(path, { token: admin.token, method: "PATCH", body: blockBody(true) }), 401, "UNAUTHORIZED");
  assert.equal((await store.getUser(driver.user.id)).driverApprovalStatus, "approved");
});

test("Block persists after vehicle edits and restart; stale reviews cannot unblock; explicit unblock requires reapproval", async t => {
  const f = await fixture(t), driver = await f.createUser(), admin = await f.createUser("admin"), first = await savedVehicle(driver);
  const patch = body => request(blockPath(driver), { token: admin.token, method: "PATCH", body });
  assert.equal((await patch(blockBody(true, first.revision))).body.driver.driver_approval_status, "blocked");
  const audit = () => store.listAdminAuditEvents(undefined, 100, driver.user.id);
  assert.equal((await audit()).length, 1);
  assert.equal((await patch(blockBody(true, first.revision))).status, 200);
  assert.equal((await audit()).length, 1, "Repeated block is an audit no-op");
  const edited = await request("/driver/vehicle", { token: driver.token, method: "PUT", body: { ...car, model: "Blocked Nexia", expected_revision: first.revision } });
  assert.equal(edited.status, 200); assert.equal(edited.body.approval_status, "blocked");
  const current = edited.body.driver_vehicle;
  const fresh = new production.PostgresStore(); await fresh.initialize();
  assert.equal((await fresh.getUser(driver.user.id)).driverApprovalStatus, "blocked");
  assertError(await patch(blockBody(false, first.revision)), 409, "VEHICLE_REVIEW_CHANGED");
  for (const status of ["approved", "rejected", "pending"]) {
    assertError(await request("/admin/drivers/" + driver.user.id + "/approval", {
      token: admin.token, method: "PATCH", body: { status, expected_vehicle_revision: current.revision },
    }), 409, "DRIVER_BLOCKED");
  }
  assert.equal((await audit()).length, 1);
  assert.equal((await patch(blockBody(false, current.revision))).body.driver.driver_approval_status, "pending");
  assertError(await request("/driver/routes", { token: driver.token }), 403, "DRIVER_APPROVAL_REQUIRED");
  const approved = await request("/admin/drivers/" + driver.user.id + "/approval", {
    token: admin.token, method: "PATCH", body: { status: "approved", expected_vehicle_revision: current.revision },
  });
  assert.equal(approved.status, 200);
  assert.equal((await request("/driver/routes", { token: driver.token })).status, 200);
  assert.equal((await patch(blockBody(false, current.revision))).body.driver.driver_approval_status, "approved", "Repeated unblock must not reset approved to pending");
  const events = await audit();
  assert.equal(events.length, 3);
  assert.deepEqual(events.map(event => [event.fromStatus, event.toStatus]), [["pending", "approved"], ["blocked", "pending"], ["pending", "blocked"]]);
  assert.ok(events.every(event => event.actorId === admin.user.id && event.driverId === driver.user.id));
});

test("Driver block survives passenger/driver role switches and cannot be changed through profile fields", async t => {
  const f = await fixture(t), driver = await f.createUser(), admin = await f.createUser("admin");
  assert.equal((await request(blockPath(driver), { token: admin.token, method: "PATCH", body: blockBody(true) })).status, 200);
  const passenger = await request("/auth/switch-role", { token: driver.token, method: "POST", body: { role: "passenger" } });
  assert.equal(passenger.status, 200); assert.equal(passenger.body.user.driver_approval_status, "blocked");
  const restored = await request("/auth/switch-role", { token: passenger.body.access_token, method: "POST", body: { role: "driver" } });
  assert.equal(restored.status, 200); assert.equal(restored.body.user.driver_approval_status, "blocked");
  assertError(await request("/driver/routes", { token: restored.body.access_token }), 403, "DRIVER_APPROVAL_REQUIRED");
  await request("/auth/profile", { token: restored.body.access_token, method: "PATCH", body: { driver_approval_status: "approved" } });
  assert.equal((await store.getUser(driver.user.id)).driverApprovalStatus, "blocked");
});

test("Explicit blocking cannot be bypassed by the legacy approval development switch without a car", async t => {
  const module = await storesWithLegacyApprovalBypass(t);
  await module.runtimeStore.initialize();
  const f = await fixture(t), driver = await f.createUser(), admin = await f.createUser("admin");
  await store.setDriverBlockedAsAdmin(driver.user.id, true, null, admin.user.id, admin.user.sessionVersion);
  const listener = await new Promise(resolve => { const value = module.app.listen(0, "127.0.0.1", () => resolve(value)); });
  const previous = process.env.REQUIRE_DRIVER_APPROVAL; process.env.REQUIRE_DRIVER_APPROVAL = "false";
  try {
    const response = await fetch("http://127.0.0.1:" + listener.address().port + "/api/driver/routes", { headers: { authorization: "Bearer " + driver.token } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "DRIVER_APPROVAL_REQUIRED");
  } finally {
    if (previous === undefined) delete process.env.REQUIRE_DRIVER_APPROVAL; else process.env.REQUIRE_DRIVER_APPROVAL = previous;
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
});

test("Block versus concurrent vehicle edit either preserves the block or rejects a stale administrator receipt", { timeout: 10_000 }, async t => {
  const f = await fixture(t), driver = await f.createUser(), admin = await f.createUser("admin"), first = await savedVehicle(driver);
  const [block, edit] = await Promise.allSettled([
    store.setDriverBlockedAsAdmin(driver.user.id, true, first.revision, admin.user.id, admin.user.sessionVersion),
    otherStore.setDriverVehicle(driver.user.id, input({ ...car, model: "Concurrent Nexia", expected_revision: first.revision }), driver.user.sessionVersion),
  ]);
  assert.equal(edit.status, "fulfilled");
  const user = await store.getUser(driver.user.id);
  assert.equal(user.driverVehicle.model, "Concurrent Nexia");
  if (block.status === "fulfilled") {
    assert.equal(user.driverApprovalStatus, "blocked");
    assert.equal((await store.listAdminAuditEvents(undefined, 100, driver.user.id)).length, 1);
  } else {
    assert.equal(block.reason.code, "VEHICLE_REVIEW_CHANGED");
    assert.equal(user.driverApprovalStatus, "pending");
    assert.equal((await store.listAdminAuditEvents(undefined, 100, driver.user.id)).length, 0);
  }
});

test("Blocking releases a pending offer once and preserves an accepted trip until explicit administrator cancellation", async t => {
  const f = await fixture(t), route = await f.configured(), admin = await f.createUser("admin"), passenger = await f.createUser("passenger");
  const drivers = [await f.planned(route), await f.planned(route)];
  for (const driver of drivers) await f.storedJoin(driver, route, 3);
  const original = await f.storedOrder(passenger, route);
  const first = drivers.find(driver => driver.user.id === original.offeredDriverId);
  const second = drivers.find(driver => driver !== first);
  assert.ok(first && second);
  const block = driver => request(blockPath(driver), { token: admin.token, method: "PATCH", body: blockBody(true) });
  assert.equal((await block(first)).status, 200);
  const moved = await store.getOrder(original.id);
  assert.equal(moved.offeredDriverId, second.user.id);
  assert.equal((await store.getQueueEntry(first.user.id)).availableSeats, 3);
  assert.equal((await store.getQueueEntry(second.user.id)).availableSeats, 2);
  assert.equal((await block(first)).status, 200);
  assert.equal((await store.getOrder(original.id)).offerExpiresAt, moved.offerExpiresAt);
  const accepted = await store.acceptOrderOffer(original.id, second.user.id, Date.now(), second.user.sessionVersion);
  assert.ok(accepted.driverId);
  assert.equal((await block(second)).status, 200);
  assert.deepEqual(await store.getOrder(original.id), accepted, "Blocking never silently cancels or releases an assigned ride");
  const cancelled = await request("/admin/orders/" + original.id + "/cancel", {
    token: admin.token, method: "POST", body: { expected_status: accepted.status },
  });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.order.status, "cancelled");
  assert.equal((await store.getQueueEntry(second.user.id)).availableSeats, 3);
});

test("MemoryStore preserves explicit blocks, repeat receipts and stale-review protection", async () => {
  const adapter = new production.MemoryStore(); await adapter.initialize();
  const admin = await adapter.createUser({ role: "admin", fullName: "Block admin", phoneNumber: "+77770009981", locale: "ru" });
  const driver = await adapter.createUser({ role: "driver", fullName: "Block driver", phoneNumber: "+77770009982", locale: "ru" });
  adapter.setDriverBlockedAsAdmin(driver.id, true, null, admin.id, admin.sessionVersion);
  assert.throws(() => adapter.setDriverApprovalAsAdmin(driver.id, "approved", null, admin.id, admin.sessionVersion), error => error.code === "DRIVER_BLOCKED");
  const edited = adapter.setDriverVehicle(driver.id, input(), driver.sessionVersion);
  assert.equal(edited.driverApprovalStatus, "blocked");
  assert.equal(adapter.setDriverBlockedAsAdmin(driver.id, true, edited.driverVehicle.revision, admin.id, admin.sessionVersion).driverApprovalStatus, "blocked");
  assert.equal(adapter.listAdminAuditEvents(undefined, 100, driver.id).length, 1);
  const passenger = adapter.activateUserRole(driver.id, "passenger", driver.sessionVersion);
  const restored = adapter.activateUserRole(driver.id, "driver", passenger.sessionVersion);
  assert.equal(restored.driverApprovalStatus, "blocked");
  assert.throws(() => adapter.setDriverBlockedAsAdmin(driver.id, false, null, admin.id, admin.sessionVersion), error => error.code === "VEHICLE_REVIEW_CHANGED");
  assert.equal(adapter.setDriverBlockedAsAdmin(driver.id, false, edited.driverVehicle.revision, admin.id, admin.sessionVersion).driverApprovalStatus, "pending");
});
