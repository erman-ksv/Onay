import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Exercise the real HTTP application and durable adapters. Private copies of
// migrated tables retain their actual columns and uniqueness constraints.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `external_pickup_${randomUUID().replaceAll("-", "")}`;
const applicationName = `external-pickup-${randomUUID()}`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes"];
const envKeys = ["DATABASE_URL", "TEZJET_STORAGE_ADAPTER", "NODE_ENV", "SESSION_SECRET", "LOG_LEVEL", "REQUIRE_DRIVER_APPROVAL", "PYATAK_CENTER_LAT", "PYATAK_CENTER_LNG", "TEZJET_OFFER_TIMEOUT_SECONDS", "TEZJET_OSRM_URL"];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let moduleDirectory, production, database, adminPool, store, otherStore, server, baseUrl;
let schemaCreated = false;
let routingServer;
const roadSamples = new Map();
let routerMode = "ok";
const routerRequests = [];
const keyFor = location => `${Number(location.lat).toFixed(6)},${Number(location.lng).toFixed(6)}`;
function resetRouter() { routerMode = "ok"; roadSamples.clear(); routerRequests.length = 0; }
function roadFor(location, distance, duration = distance / 5) { roadSamples.set(keyFor(location), { distance, duration }); }
async function startRouter() {
  routingServer = createServer((incoming, response) => {
    const url = new URL(incoming.url, "http://127.0.0.1");
    routerRequests.push(url);
    response.setHeader("content-type", "application/json");
    if (routerMode === "failure") { response.writeHead(503); response.end(JSON.stringify({ code: "Unavailable" })); return; }
    const raw = decodeURIComponent(url.pathname.split("/driving/")[1] ?? "");
    const coordinates = raw.split(";").filter(Boolean).map(pair => { const [lng, lat] = pair.split(",").map(Number); return { lat, lng }; });
    const indices = name => (url.searchParams.get(name) ?? coordinates.map((_, index) => index).join(";")).split(";").map(Number);
    const sources = indices("sources"), destinations = indices("destinations");
    const matrix = field => sources.map(index => destinations.map(() => {
      if (routerMode === "unreachable") return null;
      if (routerMode === "negative") return -5;
      const sample = roadSamples.get(keyFor(coordinates[index]));
      return sample?.[field] ?? (field === "distance" ? 2500 : 500);
    }));
    if (!url.pathname.startsWith("/table/v1/driving/")) { response.writeHead(404); response.end(JSON.stringify({ code: "NotFound" })); return; }
    response.end(JSON.stringify(routerMode === "malformed" ? { code: "Ok", distances: [[1]], durations: [] } : { code: "Ok", distances: matrix("distance"), durations: matrix("duration") }));
  });
  await new Promise(resolve => routingServer.listen(0, "127.0.0.1", resolve));
  process.env.TEZJET_OSRM_URL = `http://127.0.0.1:${routingServer.address().port}`;
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required: external pickup regressions must execute real PostgreSQL.");
  const originalUrl = process.env.DATABASE_URL;
  const isolatedUrl = new URL(originalUrl);
  isolatedUrl.searchParams.set("options", `${isolatedUrl.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
  isolatedUrl.searchParams.set("application_name", applicationName);
  process.env.DATABASE_URL = isolatedUrl.href;
  process.env.TEZJET_STORAGE_ADAPTER = "postgres";
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET = "external-pickup-regression-secret-at-least-32-characters";
  process.env.LOG_LEVEL = "silent";
  process.env.REQUIRE_DRIVER_APPROVAL = "true";
  process.env.PYATAK_CENTER_LAT = "41.3111";
  process.env.PYATAK_CENTER_LNG = "69.2797";
  delete process.env.TEZJET_OFFER_TIMEOUT_SECONDS;
  await startRouter();
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".external-pickup-test-"));
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
        'import jwt from "jsonwebtoken"; export const signJwt = jwt.sign;',
        'export { routePickupCandidates } from "./src/services/externalPickupRouting";',
        'export { driverLocationFingerprint as externalPickupLocationFingerprint } from "./src/store/externalPickup";',
        'export { createExternalPickupQuoteToken, verifyExternalPickupQuoteToken } from "./src/services/externalPickupQuoteToken";',
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
    if (routingServer?.listening) await new Promise(resolve => routingServer.close(resolve));
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
  resetRouter();
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
    let user = await adapter.createUser({ role, fullName: "External pickup regression", phoneNumber: `external-${randomUUID()}`, locale: "ru" });
    users.push(user.id);
    if (role === "driver" && approval) { await adapter.setDriverApproval(user.id, approval); user = await adapter.getUser(user.id); }
    return { user: structuredClone(user), token: production.createAccessToken({ sub: user.id, role: user.role, locale: user.locale, sessionVersion: user.sessionVersion, sessionId: randomUUID() }) };
  };
  const configured = async () => {
    const id = `external-${randomUUID()}`; routes.push(id);
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

const policy = {
  enabled: true, service_radius_meters: 5000, price_per_km_kzt: 100,
  gps_max_age_seconds: 120, quote_ttl_seconds: 120, pickup_grace_seconds: 120,
  max_pickup_seconds: 3600, fare_rounding: "ceil_kzt",
};
const externalTarget = { lat: 42.905, lng: 71.31 };
async function configure(f, route, overrides = {}) {
  const admin = await f.createUser("admin");
  const result = await request(`/admin/routes/${route.id}/external-pickup`, {
    token: admin.token, method: "PUT", body: { expected_updated_at: route.updatedAt, settings: { ...policy, ...overrides } },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return { route: await f.adapter.getRoute(route.id), admin };
}
function quoteBody(route, extra = {}) { return { ...selection(route), pickup_location: externalTarget, seats: 1, ...extra }; }
async function quote(passenger, route, extra = {}) {
  const result = await request("/orders/external/quote", { token: passenger.token, method: "POST", body: quoteBody(route, extra) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(typeof result.body.quote_token, "string");
  assert.ok(result.body.quote.quote_id);
  return result.body;
}
function confirm(passenger, quoted) {
  return request("/orders/external/confirm", { token: passenger.token, method: "POST", body: { quote_token: quoted.quote_token } });
}
async function setup(t, { seats = 4, settings = {} } = {}) {
  const f = await fixture(t), initial = await f.configured();
  const configured = await configure(f, initial, settings), route = configured.route;
  const driver = await enroll(f, route, seats), passenger = await f.createUser("passenger");
  return { f, route, driver, passenger, admin: configured.admin };
}
async function move(driver, location) {
  driver.sampleTimestamp = (driver.sampleTimestamp ?? driver.joined.lastLocation.timestamp) + 10 * 60_000;
  const result = await request("/queue/location", { token: driver.token, method: "PATCH", body: {
    location: { ...location, timestamp: driver.sampleTimestamp },
  } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.entry;
}
async function externalOrder(passenger, route, extra = {}) {
  const quoted = await quote(passenger, route, extra);
  const result = await confirm(passenger, quoted);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return { quoted, order: result.body.order };
}
async function assertNoPassengerOrders(passenger) {
  assert.deepEqual(await store.listOrdersForUser(passenger.user.id), []);
}

function originFor(route, direction = "a_to_b") { return at(route, direction === "a_to_b" ? "A" : "B"); }
function collectionPickup(route, direction = "a_to_b", fraction = 1) {
  const origin = originFor(route, direction), sign = direction === "a_to_b" ? 1 : -1;
  return { lat: origin.lat + sign * 0.005 * fraction, lng: origin.lng + sign * 0.01 * fraction };
}
function distanceMeters(left, right) {
  const radians = degrees => degrees * Math.PI / 180;
  const lat = radians(right.lat - left.lat), lng = radians(right.lng - left.lng);
  const haversine = Math.sin(lat / 2) ** 2 + Math.cos(radians(left.lat)) * Math.cos(radians(right.lat)) * Math.sin(lng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}
async function lineAvailability(passenger, route, seats = 1, direction = "a_to_b") {
  const result = await request(`/orders/route/availability?${new URLSearchParams({ ...selection(route, direction), seats: String(seats) })}`, { token: passenger.token });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
function requestLineOrder(passenger, route, seats = 1, direction = "a_to_b") {
  return request("/orders/route", { token: passenger.token, method: "POST", body: {
    ...selection(route, direction), pickup_location: originFor(route, direction), seats,
  } });
}
async function boardedExternalPassenger(driver, passenger, route, seats = 2, direction = "a_to_b") {
  const target = collectionPickup(route, direction);
  const { order } = await externalOrder(passenger, route, { seats, direction, pickup_location: target });
  assert.equal(order.offered_driver_id, driver.user.id);
  await accept(driver, order); await move(driver, target); await arrive(driver, order); await board(driver, order);
  return await otherStore.getOrder(order.id);
}
async function approachCurrentPitak(driver, route, direction = "a_to_b") {
  const origin = originFor(route, direction);
  let previousDistance = distanceMeters((await otherStore.getQueueEntry(driver.user.id)).lastLocation, origin);
  for (const fraction of [0.75, 0.5]) {
    const location = collectionPickup(route, direction, fraction), distance = distanceMeters(location, origin);
    assert.ok(distance < previousDistance, "The fixture must physically approach its enrolled origin pitak.");
    assert.ok(distance > pitaks.radiusMeters, "The additional offer must be received before returning inside the origin geofence.");
    const entry = await move(driver, location);
    assert.equal(entry.collectionState.enrollmentId, driver.enrollment.enrollmentId);
    assert.equal(entry.collectionState.phase, "collecting");
    assert.equal(entry.inFifo, true); assert.equal(entry.joinedAt, driver.joined.joinedAt);
    previousDistance = distance;
  }
}

// These are application regressions: real HTTP, real signed quotes, and the same
// migrated PostgreSQL row locks used in production. Geometry is supplied by a
// genuine HTTP routing fixture, never by replacing the production implementation.
test("external endpoints require passenger authentication and reject fabricated price/driver fields", async t => {
  const { route, driver, passenger } = await setup(t);
  assertError(await request("/orders/external/quote", { method: "POST", body: quoteBody(route) }), 401);
  assertError(await request("/orders/external/quote", { token: driver.token, method: "POST", body: quoteBody(route) }), 403);
  assertError(await request("/orders/external/confirm", { method: "POST", body: { quote_token: "bad" } }), 401);
  for (const extra of [{ price_kzt: 1 }, { driver_id: driver.user.id }, { pickup_surcharge_kzt: 0 }, { unexpected: true }]) {
    assertError(await request("/orders/external/quote", { token: passenger.token, method: "POST", body: quoteBody(route, extra) }), 400, "VALIDATION_ERROR");
  }
  assertError(await request("/orders/external/confirm", { token: passenger.token, method: "POST", body: { quote_token: "bad", driver_id: driver.user.id } }), 400, "VALIDATION_ERROR");
  await assertNoPassengerOrders(passenger);
});

test("administrator policy is explicit, versioned, durable and cannot be altered by passengers or drivers", async t => {
  const f = await fixture(t), initial = await f.configured(), passenger = await f.createUser("passenger"), driver = await f.createUser();
  const body = { expected_updated_at: initial.updatedAt, settings: policy };
  for (const token of [undefined, passenger.token, driver.token]) {
    const result = await request(`/admin/routes/${initial.id}/external-pickup`, { token, method: "PUT", body });
    assertError(result, token ? 403 : 401);
  }
  const { route, admin } = await configure(f, initial);
  assert.notEqual(route.updatedAt, initial.updatedAt);
  assert.deepEqual((await otherStore.getRoute(route.id)).externalPickup, route.externalPickup);
  assertError(await request(`/admin/routes/${route.id}/external-pickup`, { token: admin.token, method: "PUT", body }), 409);
  const invalid = [
    { ...policy, price_per_km_kzt: -1 }, { ...policy, service_radius_meters: 0 },
    { ...policy, gps_max_age_seconds: 0 }, { ...policy, quote_ttl_seconds: 0 },
    { ...policy, fare_rounding: "round-whatever" }, { ...policy, enabled: "true" },
    { enabled: true }, { ...policy, unexpected: true },
  ];
  for (const settings of invalid) assertError(await request(`/admin/routes/${route.id}/external-pickup`, {
    token: admin.token, method: "PUT", body: { expected_updated_at: route.updatedAt, settings },
  }), 400, "VALIDATION_ERROR");
  assert.deepEqual(await otherStore.getRoute(route.id), route);
});

test("unconfigured and disabled routes cannot create external offers or reserve seats", async t => {
  const f = await fixture(t), route = await f.configured(), driver = await enroll(f, route), passenger = await f.createUser("passenger");
  const before = await store.getQueueEntry(driver.user.id);
  const missing = await request("/orders/external/quote", { token: passenger.token, method: "POST", body: quoteBody(route) });
  assert.ok([409, 422].includes(missing.status), JSON.stringify(missing));
  assert.deepEqual(await store.getQueueEntry(driver.user.id), before);
  const disabled = (await configure(f, route, { enabled: false })).route;
  const result = await request("/orders/external/quote", { token: passenger.token, method: "POST", body: quoteBody(disabled) });
  assert.ok([409, 422].includes(result.status), JSON.stringify(result));
  await assertNoPassengerOrders(passenger);
});

test("quote uses road-nearest collecting driver and computes one-way pickup surcharge without exposing driver GPS", async t => {
  const { f, route, driver, passenger } = await setup(t);
  const later = await enroll(f, route), closerLocation = { lat: 42.904, lng: 71.309 };
  await move(later, closerLocation);
  // The second car is geometrically closer but the first car has the shorter
  // road. A straight-line fallback would silently choose the wrong driver.
  roadFor(at(route), 1251, 261); roadFor(closerLocation, 9000, 1800);
  const before = await store.getQueueEntry(driver.user.id);
  const quoted = await quote(passenger, route);
  assert.equal(quoted.quote.driver_id, driver.user.id);
  assert.equal(quoted.quote.road_distance_meters, 1251);
  assert.equal(quoted.quote.road_duration_seconds, 261);
  assert.equal(quoted.quote.base_fare_kzt, 1500);
  assert.equal(quoted.quote.pickup_surcharge_kzt, 126);
  assert.equal(quoted.quote.total_kzt, 1626);
  assert.equal(quoted.quote.currency, "KZT");
  assert.ok(quoted.quote.expires_at > Date.now());
  const publicText = JSON.stringify(quoted.quote);
  for (const key of ["lastLocation", "driver_location", "driver_origin", "phone_number", "sessionVersion", "enrollmentId"]) assert.equal(publicText.includes(key), false, `Public quote leaked ${key}`);
  assert.deepEqual(await store.getQueueEntry(driver.user.id), before, "A price quote does not reserve seats.");
  await assertNoPassengerOrders(passenger);
  assert.ok(routerRequests.length > 0);
});

test("external target is independent of passenger telemetry, and reverse route fare ends at the chosen stop", async t => {
  const { f, route, passenger } = await setup(t);
  const reverse = await enroll(f, route, 4, "b_to_a");
  const telemetry = { lat: 43.5, lng: 72.5, timestamp: Date.now() };
  await store.updateUser(passenger.user.id, { lastLocation: telemetry });
  const external = { lat: 42.939, lng: 71.422 };
  const quoted = await quote(passenger, route, { direction: "b_to_a", pickup_location: external, destination_stop_id: route.stops.find(stop => stop.code === "D").id, seats: 2 });
  assert.equal(quoted.quote.driver_id, reverse.user.id);
  assert.equal(quoted.quote.base_fare_kzt, 500);
  const confirmed = await confirm(passenger, quoted);
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
  const stored = await otherStore.getOrder(confirmed.body.order.id);
  assert.deepEqual(stored.pickupLocation.lat, external.lat);
  assert.deepEqual(stored.pickupLocation.lng, external.lng);
  assert.equal(stored.routeContext.direction, "b_to_a");
  assert.deepEqual((await otherStore.getUser(passenger.user.id)).lastLocation, telemetry);
});

test("external pickup validates service area, direction, destination, seats and live route version", async t => {
  const { route, passenger } = await setup(t);
  for (const pickup_location of [{ lat: 90.1, lng: 71 }, { lat: 42.9, lng: -181 }, { lat: "42.9", lng: 71 }]) {
    assertError(await request("/orders/external/quote", { token: passenger.token, method: "POST", body: quoteBody(route, { pickup_location }) }), 422, "INVALID_COORDINATES");
  }
  const invalid = [
    { seats: 0 }, { seats: 9 },
    { seats: 1.5 }, { direction: "sideways" },
  ];
  for (const extra of invalid) assertError(await request("/orders/external/quote", { token: passenger.token, method: "POST", body: quoteBody(route, extra) }), 400, "VALIDATION_ERROR");
  const outside = await request("/orders/external/quote", { token: passenger.token, method: "POST", body: quoteBody(route, { pickup_location: { lat: 44, lng: 73 } }) });
  assert.equal(outside.status, 422, JSON.stringify(outside));
  const wrongDestination = await request("/orders/external/quote", { token: passenger.token, method: "POST", body: quoteBody(route, { destination_stop_id: route.stops.find(stop => stop.code === "A").id }) });
  assert.ok([400, 422].includes(wrongDestination.status), JSON.stringify(wrongDestination));
  const unknownDestination = await request("/orders/external/quote", { token: passenger.token, method: "POST", body: quoteBody(route, { destination_stop_id: randomUUID() }) });
  assert.equal(unknownDestination.status, 404, JSON.stringify(unknownDestination));
  const stale = await request("/orders/external/quote", { token: passenger.token, method: "POST", body: quoteBody({ ...route, updatedAt: new Date(0).toISOString() }) });
  assert.equal(stale.status, 409, JSON.stringify(stale));
  await assertNoPassengerOrders(passenger);
});

test("external quotes fail safely when routing fails, returns invalid matrices or cannot reach a pickup", async t => {
  const { route, driver, passenger } = await setup(t);
  const before = await otherStore.getQueueEntry(driver.user.id);
  for (const mode of ["failure", "malformed", "negative", "unreachable"]) {
    routerMode = mode;
    const result = await request("/orders/external/quote", { token: passenger.token, method: "POST", body: quoteBody(route) });
    assert.ok([409, 503].includes(result.status), JSON.stringify({ mode, result }));
    assert.deepEqual(await otherStore.getQueueEntry(driver.user.id), before);
    await assertNoPassengerOrders(passenger);
  }
});

test("confirmation atomically reserves seats once and a duplicate quote returns the existing durable order", async t => {
  const { route, driver, passenger } = await setup(t);
  const quoted = await quote(passenger, route, { seats: 3 });
  const first = await confirm(passenger, quoted);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.order.offered_driver_id, driver.user.id);
  const entry = await capacityInvariant(otherStore, driver, 4);
  assert.equal(entry.availableSeats, 1); assert.equal(entry.pendingOfferOrderId, first.body.order.id);
  assert.equal(entry.inFifo, true); assert.equal(entry.joinedAt, driver.joined.joinedAt);
  const retry = await confirm(passenger, quoted);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.order.id, first.body.order.id);
  assert.equal((await store.listOrdersForUser(passenger.user.id)).length, 1);
  assert.deepEqual(await otherStore.getQueueEntry(driver.user.id), entry);
});

test("signed quote cannot be used as access token, tampered with, or confirmed by another passenger", async t => {
  const { f, route, driver, passenger } = await setup(t), stranger = await f.createUser("passenger");
  const quoted = await quote(passenger, route);
  const segments = quoted.quote_token.split(".");
  const tampered = [segments[0], Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(segments[1], "base64url").toString()), sub: stranger.user.id })).toString("base64url"), segments[2]].join(".");
  const badSignature = await confirm(passenger, { quote_token: tampered });
  assert.ok([400, 401].includes(badSignature.status), JSON.stringify(badSignature));
  assertError(await request("/orders", { token: quoted.quote_token }), 401);
  const accessAsQuote = await confirm(passenger, { quote_token: passenger.token });
  assert.ok([400, 401].includes(accessAsQuote.status), JSON.stringify(accessAsQuote));
  const wrongOwner = await confirm(stranger, quoted);
  assert.ok([403, 404, 409].includes(wrongOwner.status), JSON.stringify(wrongOwner));
  await assertNoPassengerOrders(passenger); await assertNoPassengerOrders(stranger);
  assert.equal((await store.getQueueEntry(driver.user.id)).availableSeats, 4);
});

test("confirmation revalidates live driver approval, passenger session, route policy and driver telemetry", async t => {
  for (const change of ["approval", "passenger_session", "policy", "location"]) await t.test(change, async child => {
    const { f, route, driver, passenger } = await setup(child), quoted = await quote(passenger, route);
    if (change === "approval") await store.setDriverApproval(driver.user.id, "rejected");
    if (change === "passenger_session") await store.invalidateSessions(passenger.user.id);
    if (change === "policy") await configure(f, route, { price_per_km_kzt: 200 });
    if (change === "location") await move(driver, { lat: 42.901, lng: 71.301 });
    const result = await confirm(passenger, quoted);
    assert.ok([401, 403, 409, 422].includes(result.status), JSON.stringify({ change, result }));
    await assertNoPassengerOrders(passenger);
    assert.equal((await store.getQueueEntry(driver.user.id)).availableSeats, 4);
  });
});

test("GPS freshness uses the server receipt time, so future client timestamps cannot prolong a quote candidate", async t => {
  const { route, driver, passenger } = await setup(t);
  // The persisted sample has a far-future client timestamp but an expired server
  // receipt. Eligibility must use the latter for this production row.
  await database.query("UPDATE tezjet_driver_queue SET last_location = jsonb_set(last_location, '{timestamp}', to_jsonb($2::bigint)), collection_state = jsonb_set(collection_state, '{locationUpdatedAt}', to_jsonb($3::bigint)) WHERE driver_id = $1", [driver.user.id, Date.now() + 86400_000, Date.now() - 121_000]);
  const result = await request("/orders/external/quote", { token: passenger.token, method: "POST", body: quoteBody(route) });
  assert.equal(result.status, 409, JSON.stringify(result));
  await assertNoPassengerOrders(passenger);
  assert.equal((await store.getQueueEntry(driver.user.id)).availableSeats, 4);
});

test("rejection releases only its reservation and awaits new passenger price consent instead of hidden reassignment", async t => {
  const { f, route, driver, passenger } = await setup(t), secondDriver = await enroll(f, route);
  roadFor(at(route), 2500, 500);
  const { quoted, order } = await externalOrder(passenger, route, { seats: 2 });
  assert.equal(order.offered_driver_id, driver.user.id);
  const rejected = await request(`/orders/${order.id}/reject`, { token: driver.token, method: "POST" });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  await store.processOrderOffers();
  const waiting = await otherStore.getOrder(order.id);
  assert.equal(waiting.status, "searching"); assert.equal(waiting.offeredDriverId, undefined);
  assert.equal((await otherStore.getQueueEntry(driver.user.id)).availableSeats, 4);
  assert.equal((await otherStore.getQueueEntry(secondDriver.user.id)).availableSeats, 4);
  const reprice = await request("/orders/external/quote", { token: passenger.token, method: "POST", body: { order_id: order.id } });
  assert.equal(reprice.status, 200, JSON.stringify(reprice.body));
  assert.equal(reprice.body.quote.driver_id, secondDriver.user.id);
  assert.equal((await store.getQueueEntry(secondDriver.user.id)).availableSeats, 4, "Repricing still requires passenger consent.");
  const acceptedNewPrice = await confirm(passenger, reprice.body);
  assert.equal(acceptedNewPrice.status, 200, JSON.stringify(acceptedNewPrice.body));
  assert.equal(acceptedNewPrice.body.order.id, order.id);
  assert.equal(acceptedNewPrice.body.order.offered_driver_id, secondDriver.user.id);
  assert.equal((await store.listOrdersForUser(passenger.user.id)).length, 1);
  assert.notEqual(reprice.body.quote.quote_id, quoted.quote.quote_id);
  const beforeOldReplay = await otherStore.getQueueEntry(secondDriver.user.id);
  const oldReplay = await confirm(passenger, quoted);
  assert.equal(oldReplay.status, 200, JSON.stringify(oldReplay.body));
  assert.equal(oldReplay.body.order.offered_driver_id, secondDriver.user.id);
  assert.deepEqual(await otherStore.getQueueEntry(secondDriver.user.id), beforeOldReplay);
  await capacityInvariant(otherStore, driver, 4); await capacityInvariant(otherStore, secondDriver, 4);
});

test("an elapsed 60-second external offer releases seats and never auto-offers a different fare", async t => {
  const { f, route, driver, passenger } = await setup(t), second = await enroll(f, route);
  const { order } = await externalOrder(passenger, route);
  const durable = await store.getOrder(order.id);
  await store.processOrderOffers(durable.offerExpiresAt + 1);
  await otherStore.processOrderOffers(durable.offerExpiresAt + 2);
  const current = await otherStore.getOrder(order.id);
  assert.equal(current.status, "searching"); assert.equal(current.offeredDriverId, undefined);
  assert.equal((await store.getQueueEntry(driver.user.id)).availableSeats, 4);
  assert.equal((await store.getQueueEntry(second.user.id)).availableSeats, 4);
  assert.equal((await store.listOrdersForUser(passenger.user.id)).length, 1);
});

test("requote binds the original passenger, route, target and seats and rejects client replacement fields", async t => {
  const { f, route, driver, passenger } = await setup(t), stranger = await f.createUser("passenger");
  const { order } = await externalOrder(passenger, route, { seats: 2, pickup_address: "Подъезд у внешней точки" });
  await request(`/orders/${order.id}/reject`, { token: driver.token, method: "POST" });
  for (const extra of [{ seats: 1 }, { pickup_location: at(route) }, { route_id: randomUUID() }, { expected_updated_at: route.updatedAt }]) {
    assertError(await request("/orders/external/quote", { token: passenger.token, method: "POST", body: { order_id: order.id, ...extra } }), 400, "VALIDATION_ERROR");
  }
  const outsider = await request("/orders/external/quote", { token: stranger.token, method: "POST", body: { order_id: order.id } });
  assert.ok([403, 404].includes(outsider.status), JSON.stringify(outsider));
  const durable = await otherStore.getOrder(order.id);
  assert.equal(durable.seats, 2); assert.equal(durable.pickupLocation.lat, externalTarget.lat); assert.equal(durable.pickupLocation.lng, externalTarget.lng);
});

test("external acceptance gives road travel plus administrator grace, boarding preserves FIFO and manual departure owns the phase", async t => {
  const { route, driver, passenger } = await setup(t);
  roadFor(at(route), 6000, 1200);
  const beforeAccept = Date.now(), { order } = await externalOrder(passenger, route, { seats: 2 });
  await accept(driver, order);
  const held = await otherStore.getOrder(order.id);
  assert.ok(held.seatLockExpiresAt >= beforeAccept + (1200 + policy.pickup_grace_seconds) * 1000);
  assert.ok(held.seatLockExpiresAt <= Date.now() + (1200 + policy.pickup_grace_seconds) * 1000);
  assertError(await depart(driver), 409, "PASSENGERS_NOT_BOARDED");
  await move(driver, externalTarget); await arrive(driver, order); await board(driver, order);
  const waiting = await otherStore.getOrder(order.id);
  assert.equal(waiting.seatLockExpiresAt, undefined); assert.equal(waiting.status, "boarded_waiting");
  await store.processOrderOffers(Date.now() + 86400_000); await store.clearExpiredSeatLocks();
  assert.equal((await otherStore.getOrder(order.id)).status, "boarded_waiting");
  let entry = await capacityInvariant(otherStore, driver, 4);
  assert.equal(entry.inFifo, true); assert.equal(entry.joinedAt, driver.joined.joinedAt);
  await move(driver, at(route));
  const left = await depart(driver); assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal((await otherStore.getOrder(order.id)).status, "in_transit");
  const completed = await request(`/orders/${order.id}/status`, { token: driver.token, method: "PATCH", body: { status: "completed" } });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  entry = await capacityInvariant(otherStore, driver, 4); assert.equal(entry.availableSeats, 4); assert.equal(entry.inFifo, false);
});

test("multiple external passengers fill the same collecting car without losing FIFO or double-debiting seats", async t => {
  const { f, route, driver, passenger } = await setup(t), otherPassenger = await f.createUser("passenger");
  const first = (await externalOrder(passenger, route, { seats: 2 })).order; await accept(driver, first);
  const second = (await externalOrder(otherPassenger, route, { seats: 2 })).order; await accept(driver, second);
  let entry = await capacityInvariant(otherStore, driver, 4);
  assert.equal(entry.availableSeats, 0); assert.equal(entry.inFifo, true); assert.equal(entry.collectionState.phase, "collecting");
  for (const order of [first, second]) { await arrive(driver, order); await board(driver, order); }
  entry = await capacityInvariant(otherStore, driver, 4); assert.equal(entry.availableSeats, 0); assert.equal(entry.inFifo, true);
  const cancelled = await request(`/orders/${first.id}/cancel`, { token: passenger.token, method: "POST" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assertError(await request(`/orders/${first.id}/cancel`, { token: passenger.token, method: "POST" }), 409);
  entry = await capacityInvariant(otherStore, driver, 4);
  assert.equal(entry.availableSeats, 2); assert.equal(entry.inFifo, true);
  assert.equal((await otherStore.getOrder(second.id)).status, "boarded_waiting");
});

test("returning collecting driver receives and accepts another ordinary line order outside the origin in either direction", async t => {
  for (const direction of ["a_to_b", "b_to_a"]) await t.test(direction, async child => {
    const f = await fixture(child), { route } = await configure(f, await f.configured());
    const driver = await enroll(f, route, 4, direction), externalPassenger = await f.createUser("passenger");
    const external = await boardedExternalPassenger(driver, externalPassenger, route, 2, direction);
    await approachCurrentPitak(driver, route, direction);
    const later = await enroll(f, route, 4, direction), passenger = await f.createUser("passenger");
    assert.ok(driver.joined.joinedAt < later.joined.joinedAt);
    assert.equal(await otherStore.getQueuePosition(driver.user.id), 1);
    assert.equal(await otherStore.getQueuePosition(later.user.id), 2);
    const availability = await lineAvailability(passenger, route, 2, direction);
    assert.equal(availability.available, true); assert.equal(availability.eligible_driver_count, 2);
    const created = await requestLineOrder(passenger, route, 2, direction);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const order = created.body.order;
    assert.equal(order.offered_driver_id, driver.user.id, "Origin proximity cannot let the later driver bypass the returning driver.");
    assert.equal(order.route_context.direction, direction);
    assert.equal(order.external_pickup, undefined, "An ordinary line order has no second external-pickup surcharge.");
    assert.equal(order.fare.totalKzt, 1500); assert.equal(order.fare.totalKzt, availability.fare.totalKzt);
    let entry = await capacityInvariant(otherStore, driver, 4);
    assert.equal(entry.availableSeats, 0); assert.equal(entry.pendingOfferOrderId, order.id);
    assert.deepEqual(entry.activeOrderIds, [external.id]);
    assertError(await depart(driver), 409, "QUEUE_BUSY");
    await accept(driver, order);
    assertError(await depart(driver), 409, "PASSENGERS_NOT_BOARDED");
    entry = await capacityInvariant(otherStore, driver, 4);
    assert.equal(entry.availableSeats, 0, "Accepting the new order cannot debit the reserved seats twice.");
    assert.equal(entry.pendingOfferOrderId, undefined);
    assert.deepEqual([...entry.activeOrderIds].sort(), [external.id, order.id].sort());
    assert.equal(entry.collectionState.enrollmentId, driver.enrollment.enrollmentId);
    assert.equal(entry.collectionState.phase, "collecting"); assert.equal(entry.inFifo, true);
    assert.equal(entry.joinedAt, driver.joined.joinedAt); assert.equal(await otherStore.getQueuePosition(driver.user.id), 1);
    assert.deepEqual(await otherStore.getOrder(external.id), external, "The seated external passenger's fare and lifecycle must remain unchanged.");
    const durable = new production.PostgresStore(); await durable.initialize();
    assert.deepEqual(await durable.getQueueEntry(driver.user.id), entry, "A separate durable adapter must recover the same collecting enrollment and manifest.");
    assert.deepEqual(await durable.getOrder(order.id), await store.getOrder(order.id));
  });
});

test("returning collector cannot bypass an earlier same-direction driver waiting at the pitak", async t => {
  const f = await fixture(t), { route } = await configure(f, await f.configured());
  const earlier = await enroll(f, route), origin = originFor(route);
  const earlierLocation = { lat: origin.lat + 0.0005, lng: origin.lng };
  await move(earlier, earlierLocation); roadFor(earlierLocation, 6000, 1200); roadFor(origin, 1000, 200);
  const returning = await enroll(f, route), externalPassenger = await f.createUser("passenger");
  assert.ok(earlier.joined.joinedAt < returning.joined.joinedAt);
  await boardedExternalPassenger(returning, externalPassenger, route);
  await approachCurrentPitak(returning, route);
  const passenger = await f.createUser("passenger"), created = await requestLineOrder(passenger, route, 2);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.order.offered_driver_id, earlier.user.id);
  assert.equal(await otherStore.getQueuePosition(earlier.user.id), 1);
  assert.equal(await otherStore.getQueuePosition(returning.user.id), 2);
  assert.equal((await capacityInvariant(otherStore, returning, 4)).availableSeats, 2);
  await capacityInvariant(otherStore, earlier, 4);
});

test("returning collector respects insufficient seats, one pending offer, and a completely full manifest", async t => {
  const { f, route, driver, passenger: externalPassenger } = await setup(t);
  const external = await boardedExternalPassenger(driver, externalPassenger, route);
  await approachCurrentPitak(driver, route);
  const passenger = await f.createUser("passenger"), nextPassenger = await f.createUser("passenger");
  assert.equal((await lineAvailability(passenger, route, 3)).available, false);
  assertError(await requestLineOrder(passenger, route, 3), 409, "NO_DRIVERS");
  await assertNoPassengerOrders(passenger);
  const created = await requestLineOrder(passenger, route, 1);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  let entry = await capacityInvariant(otherStore, driver, 4);
  assert.equal(entry.availableSeats, 1);
  assert.equal((await lineAvailability(nextPassenger, route)).available, false, "A free seat cannot allow a second simultaneous pending offer.");
  assertError(await requestLineOrder(nextPassenger, route), 409, "NO_DRIVERS");
  await assertNoPassengerOrders(nextPassenger);
  await accept(driver, created.body.order);
  const lastSeat = await requestLineOrder(nextPassenger, route);
  assert.equal(lastSeat.status, 201, JSON.stringify(lastSeat.body));
  await accept(driver, lastSeat.body.order);
  entry = await capacityInvariant(otherStore, driver, 4); assert.equal(entry.availableSeats, 0);
  assert.equal(entry.collectionState.phase, "collecting"); assert.equal(entry.inFifo, true);
  assert.equal((await lineAvailability(passenger, route)).available, false);
  assertError(await requestLineOrder(passenger, route), 409, "NO_DRIVERS");
  assert.deepEqual(await otherStore.getOrder(external.id), external);
});

test("refusal or timeout of a returning collector's ordinary offer advances only its lane and preserves seated external passengers", async t => {
  for (const action of ["reject", "timeout"]) await t.test(action, async child => {
    const { f, route, driver, passenger: externalPassenger } = await setup(child);
    const external = await boardedExternalPassenger(driver, externalPassenger, route);
    await approachCurrentPitak(driver, route);
    const next = await enroll(f, route), opposite = await enroll(f, route, 4, "b_to_a");
    const passenger = await f.createUser("passenger"), created = await requestLineOrder(passenger, route);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.order.offered_driver_id, driver.user.id);
    if (action === "reject") {
      const rejected = await request(`/orders/${created.body.order.id}/reject`, { token: driver.token, method: "POST" });
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    } else {
      const offered = await otherStore.getOrder(created.body.order.id);
      await store.processOrderOffers(offered.offerExpiresAt + 1);
    }
    const advanced = await otherStore.getOrder(created.body.order.id);
    assert.equal(advanced.offeredDriverId, next.user.id); assert.equal(advanced.status, "searching");
    assert.deepEqual(advanced.attemptedDriverIds, [driver.user.id, next.user.id]);
    const entry = await capacityInvariant(otherStore, driver, 4);
    assert.equal(entry.availableSeats, 2); assert.equal(entry.pendingOfferOrderId, undefined);
    assert.deepEqual(entry.activeOrderIds, [external.id]); assert.equal(entry.inFifo, true);
    assert.equal(entry.collectionState.phase, "collecting"); assert.equal(entry.collectionState.enrollmentId, driver.enrollment.enrollmentId);
    assert.equal(entry.joinedAt, driver.joined.joinedAt); assert.equal(await otherStore.getQueuePosition(driver.user.id), 1);
    assert.deepEqual(await otherStore.getOrder(external.id), external);
    assert.equal((await capacityInvariant(otherStore, next, 4)).availableSeats, 3);
    assert.equal((await capacityInvariant(otherStore, opposite, 4)).availableSeats, 4);
  });
});

test("a reverse returning collector and departed enrollments cannot receive an order from the opposite pitak", async t => {
  const f = await fixture(t), { route } = await configure(f, await f.configured());
  const departed = await enroll(f, route); assert.equal((await depart(departed)).status, 200);
  const reverse = await enroll(f, route, 4, "b_to_a"), externalPassenger = await f.createUser("passenger");
  const external = await boardedExternalPassenger(reverse, externalPassenger, route, 2, "b_to_a");
  await approachCurrentPitak(reverse, route, "b_to_a");
  const passenger = await f.createUser("passenger");
  assert.equal((await lineAvailability(passenger, route)).available, false);
  assertError(await requestLineOrder(passenger, route), 409, "NO_DRIVERS");
  await assertNoPassengerOrders(passenger);
  // A different passenger is physically at B; reusing the passenger at A
  // would correctly trigger the production GPS speed guard on creation.
  const reversePassenger = await f.createUser("passenger");
  assert.equal((await lineAvailability(reversePassenger, route, 1, "b_to_a")).available, true);
  assert.equal((await depart(reverse)).status, 200);
  assert.equal((await lineAvailability(reversePassenger, route, 1, "b_to_a")).available, false);
  assertError(await requestLineOrder(reversePassenger, route, 1, "b_to_a"), 409, "NO_DRIVERS");
  await assertNoPassengerOrders(reversePassenger);
  const entry = await capacityInvariant(otherStore, reverse, 4);
  assert.equal(entry.availableSeats, 2); assert.equal(entry.inFifo, false); assert.equal(entry.collectionState.phase, "departed");
  const travelling = await otherStore.getOrder(external.id);
  assert.equal(travelling.status, "in_transit"); assert.deepEqual(travelling.fare, external.fare);
});

test("real PostgreSQL simultaneous ordinary orders cannot oversell the returning collector's remaining seats", { timeout: 15_000 }, async t => {
  const { f, route, driver, passenger: externalPassenger } = await setup(t);
  const external = await boardedExternalPassenger(driver, externalPassenger, route);
  await approachCurrentPitak(driver, route);
  const passengers = [await f.createUser("passenger"), await f.createUser("passenger")];
  const results = await overlapping("tezjet_driver_queue", "driver_id", driver.user.id,
    passengers.map(passenger => () => requestLineOrder(passenger, route, 2)));
  assert.ok(results.every(result => !result.error), JSON.stringify(results));
  const values = results.map(result => result.value);
  assert.deepEqual(values.map(result => result.status).sort(), [201, 409], JSON.stringify(values));
  let entry = await capacityInvariant(otherStore, driver, 4);
  assert.equal(entry.availableSeats, 0); assert.deepEqual(entry.activeOrderIds, [external.id]);
  const winner = values.find(result => result.status === 201).body.order;
  assert.equal(entry.pendingOfferOrderId, winner.id); assert.equal(winner.offered_driver_id, driver.user.id);
  assert.equal((await Promise.all(passengers.map(passenger => store.listOrdersForUser(passenger.user.id)))).flat().length, 1);
  await accept(driver, winner);
  entry = await capacityInvariant(otherStore, driver, 4); assert.equal(entry.availableSeats, 0);
  assert.deepEqual(await otherStore.getOrder(external.id), external);
});

test("real PostgreSQL a new ordinary offer racing departure cannot alter a departed returning enrollment", { timeout: 20_000 }, async t => {
  for (const first of ["offer", "depart"]) await t.test(first, async child => {
    const { f, route, driver, passenger: externalPassenger } = await setup(child);
    const external = await boardedExternalPassenger(driver, externalPassenger, route);
    await approachCurrentPitak(driver, route);
    const passenger = await f.createUser("passenger");
    const offer = () => requestLineOrder(passenger, route), departure = () => depart(driver);
    const results = await overlapping("tezjet_driver_queue", "driver_id", driver.user.id,
      first === "offer" ? [offer, departure] : [departure, offer]);
    assert.ok(results.every(result => !result.error), JSON.stringify(results));
    const [offered, departed] = (first === "offer" ? results : [...results].reverse()).map(result => result.value);
    const entry = await capacityInvariant(otherStore, driver, 4), seated = await otherStore.getOrder(external.id);
    assert.equal(entry.collectionState.enrollmentId, driver.enrollment.enrollmentId);
    assert.equal(entry.joinedAt, driver.joined.joinedAt); assert.deepEqual(seated.fare, external.fare);
    if (entry.collectionState.phase === "departed") {
      assert.equal(departed.status, 200, JSON.stringify(departed)); assertError(offered, 409, "NO_DRIVERS");
      assert.equal(entry.availableSeats, 2); assert.equal(entry.inFifo, false);
      assert.equal(entry.pendingOfferOrderId, undefined); assert.equal(seated.status, "in_transit");
      await assertNoPassengerOrders(passenger);
    } else {
      assert.equal(offered.status, 201, JSON.stringify(offered)); assertError(departed, 409, "QUEUE_BUSY");
      assert.equal(entry.availableSeats, 1); assert.equal(entry.inFifo, true);
      assert.equal(entry.pendingOfferOrderId, offered.body.order.id); assert.equal(seated.status, "boarded_waiting");
      assert.deepEqual(entry.activeOrderIds, [external.id]); assert.deepEqual(seated, external);
    }
  });
});

test("real PostgreSQL simultaneous confirmation of the same quote creates only one order and reservation", { timeout: 15_000 }, async t => {
  const { route, driver, passenger } = await setup(t), quoted = await quote(passenger, route, { seats: 3 });
  const results = await overlapping("tezjet_driver_queue", "driver_id", driver.user.id, [() => confirm(passenger, quoted), () => confirm(passenger, quoted)]);
  assert.ok(results.every(result => !result.error), JSON.stringify(results));
  const values = results.map(result => result.value);
  assert.deepEqual(values.map(result => result.status).sort(), [200, 201], JSON.stringify(values));
  assert.equal(values[0].body.order.id, values[1].body.order.id);
  assert.equal((await store.listOrdersForUser(passenger.user.id)).length, 1);
  assert.equal((await capacityInvariant(otherStore, driver, 4)).availableSeats, 1);
});

test("real PostgreSQL two quoted passengers cannot both reserve the last seats", { timeout: 15_000 }, async t => {
  const { f, route, driver, passenger } = await setup(t), second = await f.createUser("passenger");
  const firstQuote = await quote(passenger, route, { seats: 3 }), secondQuote = await quote(second, route, { seats: 3 });
  const results = await overlapping("tezjet_driver_queue", "driver_id", driver.user.id, [() => confirm(passenger, firstQuote), () => confirm(second, secondQuote)]);
  assert.ok(results.every(result => !result.error), JSON.stringify(results));
  const values = results.map(result => result.value);
  assert.equal(values.filter(result => result.status === 201).length, 1, JSON.stringify(values));
  assert.equal(values.filter(result => result.status === 409).length, 1, JSON.stringify(values));
  assert.equal((await capacityInvariant(otherStore, driver, 4)).availableSeats, 1);
  assert.equal((await store.listOrdersForUser(passenger.user.id)).length + (await store.listOrdersForUser(second.user.id)).length, 1);
});

test("real PostgreSQL confirmation racing empty departure cannot reserve a departed enrollment", { timeout: 20_000 }, async t => {
  for (const first of ["confirm", "depart"]) await t.test(first, async child => {
    const { route, driver, passenger } = await setup(child), quoted = await quote(passenger, route);
    const confirmation = () => confirm(passenger, quoted), departure = () => depart(driver);
    const results = await overlapping("tezjet_driver_queue", "driver_id", driver.user.id, first === "confirm" ? [confirmation, departure] : [departure, confirmation]);
    assert.ok(results.every(result => !result.error), JSON.stringify(results));
    const entry = await capacityInvariant(otherStore, driver, 4), orders = await store.listOrdersForUser(passenger.user.id);
    if (entry.collectionState.phase === "departed") { assert.equal(entry.availableSeats, 4); assert.equal(orders.length, 0); }
    else { assert.equal(entry.pendingOfferOrderId, orders[0].id); assert.equal(entry.availableSeats, 3); assert.equal(entry.inFifo, true); }
  });
});

test("expired quotes cannot create reservations, but the exact confirmed quote remains an idempotent receipt", async t => {
  const { f, route, driver, passenger } = await setup(t, { settings: { quote_ttl_seconds: 1 } });
  const second = await f.createUser("passenger");
  const unused = await quote(passenger, route), committed = await quote(second, route);
  const first = await confirm(second, committed);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const expiresAt = Math.max(unused.quote.expires_at, committed.quote.expires_at);
  await new Promise(resolve => setTimeout(resolve, Math.max(1, expiresAt - Date.now() + 20)));
  assertError(await confirm(passenger, unused), 409, "PICKUP_QUOTE_EXPIRED");
  const replay = await confirm(second, committed);
  assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.order.id, first.body.order.id);
  assert.equal((await capacityInvariant(otherStore, driver, 4)).availableSeats, 3);
  await assertNoPassengerOrders(passenger);
});

test("production quote signatures enforce purpose and derived signing key independently of access credentials", async t => {
  const { route, passenger } = await setup(t), quoted = await quote(passenger, route);
  const claims = JSON.parse(Buffer.from(quoted.quote_token.split(".")[1], "base64url").toString());
  assert.deepEqual(production.verifyExternalPickupQuoteToken(quoted.quote_token), claims.quote);
  const accessKeyForgery = production.signJwt(claims, process.env.SESSION_SECRET, { algorithm: "HS256" });
  assert.throws(() => production.verifyExternalPickupQuoteToken(accessKeyForgery), error => error.code === "INVALID_PICKUP_QUOTE");
  assert.throws(() => production.verifyExternalPickupQuoteToken(passenger.token), error => error.code === "INVALID_PICKUP_QUOTE");
  assert.throws(() => production.createExternalPickupQuoteToken({ ...claims.quote, totalKzt: 1 }), error => error.code === "INVALID_PICKUP_QUOTE");
  const publicToken = JSON.stringify(claims);
  for (const field of ["driverLocation", "lastLocation", "phoneNumber", "driver_origin"]) assert.equal(publicToken.includes(`"${field}":`), false, `Signed readable payload leaked ${field}`);
});

test("production Table routing evaluates every candidate across 50-source chunks and ranks raw road distances", async () => {
  resetRouter();
  const candidates = Array.from({ length: 103 }, (_, index) => ({
    driverId: `road-${index}`, joinedAt: 1000 + index,
    lastLocation: { lat: 42.9 + index / 100000, lng: 71.3 },
  }));
  for (const [index, candidate] of candidates.entries()) roadFor(candidate.lastLocation, 10000 + index, 1000 + index);
  roadFor(candidates[99].lastLocation, 1000.9, 200.9);
  roadFor(candidates[102].lastLocation, 1000.1, 200.1);
  const result = await production.routePickupCandidates(candidates, externalTarget);
  assert.equal(result.length, 103);
  assert.equal(result[0].driverId, candidates[102].driverId);
  assert.equal(result[0].distanceMeters, 1000.1);
  assert.equal(result[1].driverId, candidates[99].driverId);
  assert.equal(routerRequests.length, 3);
  for (const url of routerRequests) {
    assert.ok(url.searchParams.get("sources").split(";").length <= 50);
    assert.equal(url.searchParams.get("annotations"), "distance,duration");
    assert.equal(url.searchParams.get("destinations").split(";").length, 1);
  }
});

test("production routing fails the entire selection for malformed data and never truncates excessive candidates", async () => {
  const candidates = [{ driverId: "routing-failure", joinedAt: 1, lastLocation: { lat: 42.9, lng: 71.3 } }];
  for (const mode of ["failure", "malformed", "negative"]) {
    resetRouter(); routerMode = mode;
    await assert.rejects(() => production.routePickupCandidates(candidates, externalTarget), error => error.statusCode === 503 && error.code === "ROUTING_UNAVAILABLE");
  }
  resetRouter(); routerMode = "unreachable";
  assert.deepEqual(await production.routePickupCandidates(candidates, externalTarget), []);
  resetRouter();
  await assert.rejects(() => production.routePickupCandidates(Array.from({ length: 501 }, (_, index) => ({ ...candidates[0], driverId: `too-many-${index}` })), externalTarget), error => error.statusCode === 503 && error.code === "ROUTING_UNAVAILABLE");
  assert.equal(routerRequests.length, 0, "An unsupported fleet size must fail explicitly, never rank a truncated subset.");
});

async function signedStoreQuote(adapter, driver, passenger, route, options = {}) {
  const live = await adapter.getQueueEntry(driver.user.id), now = Date.now();
  const settings = route.externalPickup, distance = options.distance ?? 2500, duration = options.duration ?? 500;
  const direction = options.direction ?? "a_to_b", pickupLocation = options.pickupLocation ?? externalTarget;
  // Build a server command with the actual fingerprint and signing helpers;
  // adapter parity below does not bypass quote validation or reservation logic.
  const selected = await adapter.getExternalPickupCandidates({ routeId: route.id, direction, expectedUpdatedAt: route.updatedAt }, options.seats ?? 1);
  assert.equal(selected.candidates[0].driverId, driver.user.id);
  const quoted = {
    version: 1, quoteId: randomUUID(), passengerId: passenger.user.id, sessionVersion: passenger.user.sessionVersion,
    selection: { routeId: route.id, direction, expectedUpdatedAt: route.updatedAt },
    pickupLocation: { ...pickupLocation, timestamp: now }, seats: options.seats ?? 1,
    driverId: driver.user.id, driverEnrollmentId: live.collectionState.enrollmentId,
    driverLocationFingerprint: production.externalPickupLocationFingerprint(live),
    roadDistanceMeters: distance, roadDurationSeconds: duration, baseFareKzt: 1500,
    pickupSurchargeKzt: Math.ceil(distance * settings.pricePerKmKzt / 1000),
    totalKzt: 1500 + Math.ceil(distance * settings.pricePerKmKzt / 1000), settings,
    quotedAt: now, expiresAt: now + settings.quoteTtlSeconds * 1000,
  };
  return production.verifyExternalPickupQuoteToken(production.createExternalPickupQuoteToken(quoted));
}

test("durable and memory adapters preserve the returning collector's manifest and seats for both directions", async t => {
  for (const adapter of [store, new production.MemoryStore()]) {
    for (const direction of ["a_to_b", "b_to_a"]) await t.test(`${adapter.constructor.name}:${direction}`, async child => {
      const f = await fixture(child, adapter), initial = await f.configured();
      const settings = {
        enabled: true, serviceRadiusMeters: policy.service_radius_meters, pricePerKmKzt: policy.price_per_km_kzt,
        gpsMaxAgeSeconds: policy.gps_max_age_seconds, quoteTtlSeconds: policy.quote_ttl_seconds,
        pickupGraceSeconds: policy.pickup_grace_seconds, maxPickupSeconds: policy.max_pickup_seconds, fareRounding: policy.fare_rounding,
      };
      const route = await adapter.updateExternalPickupSettings(initial.id, { expectedUpdatedAt: initial.updatedAt, settings });
      const driver = await f.planned(route, direction), externalPassenger = await f.createUser("passenger");
      const joined = await f.storedJoin(driver, route, 4, direction), target = collectionPickup(route, direction);
      const quoted = await signedStoreQuote(adapter, driver, externalPassenger, route, { seats: 2, direction, pickupLocation: target });
      const confirmed = await adapter.confirmExternalPickupQuote(quoted, externalPassenger.user.id, externalPassenger.user.sessionVersion);
      assert.equal(confirmed.order.offeredDriverId, driver.user.id);
      assert.ok(await adapter.acceptOrderOffer(confirmed.order.id, driver.user.id));
      assert.ok(await adapter.updateQueueEntry(driver.user.id, { lastLocation: { ...target, timestamp: joined.lastLocation.timestamp + 600_000 } }));
      assert.ok(await adapter.transitionOrder(confirmed.order.id, driver.user.id, "arrived_at_c"));
      assert.ok(await adapter.transitionOrder(confirmed.order.id, driver.user.id, "boarded_waiting"));
      const seated = structuredClone(await adapter.getOrder(confirmed.order.id));
      let previousDistance = distanceMeters(target, originFor(route, direction));
      for (const [index, fraction] of [0.75, 0.5].entries()) {
        const location = collectionPickup(route, direction, fraction), distance = distanceMeters(location, originFor(route, direction));
        assert.ok(distance < previousDistance && distance > pitaks.radiusMeters);
        assert.ok(await adapter.updateQueueEntry(driver.user.id, { lastLocation: { ...location, timestamp: joined.lastLocation.timestamp + (index + 2) * 600_000 } }));
        previousDistance = distance;
      }
      const observer = adapter instanceof production.PostgresStore ? new production.PostgresStore() : adapter;
      await observer.initialize();
      assert.deepEqual(await observer.getQueueEntry(driver.user.id), await adapter.getQueueEntry(driver.user.id));
      const passenger = await f.createUser("passenger"), selected = choice(route, direction);
      const availability = await observer.getRouteOrderAvailability(selected, 2);
      assert.equal(availability.available, true); assert.equal(availability.eligibleDriverCount, 1);
      const order = await adapter.createRouteOrderWithOffer({
        passengerId: passenger.user.id, passengerPhone: passenger.user.phoneNumber,
        pickupLocation: originFor(route, direction), seats: 2,
      }, selected, passenger.user.sessionVersion);
      assert.equal(order.offeredDriverId, driver.user.id); assert.equal(order.externalPickup, undefined);
      assert.equal((await capacityInvariant(observer, driver, 4)).availableSeats, 0);
      assert.ok(await adapter.acceptOrderOffer(order.id, driver.user.id));
      let entry = await capacityInvariant(observer, driver, 4);
      assert.equal(entry.availableSeats, 0); assert.equal(entry.joinedAt, joined.joinedAt);
      assert.equal(entry.collectionState.enrollmentId, joined.collectionState.enrollmentId);
      assert.equal(entry.collectionState.phase, "collecting"); assert.equal(entry.inFifo, true);
      assert.deepEqual([...entry.activeOrderIds].sort(), [seated.id, order.id].sort());
      assert.deepEqual(await observer.getOrder(seated.id), seated);
      assert.ok(await adapter.transitionOrder(order.id, passenger.user.id, "cancelled"));
      assert.equal((await capacityInvariant(observer, driver, 4)).availableSeats, 2);
      assert.deepEqual(await observer.getOrder(seated.id), seated);
      await adapter.departQueue(driver.user.id, joined.collectionState.enrollmentId, driver.user.sessionVersion);
      assert.equal((await observer.getRouteOrderAvailability(selected, 1)).available, false);
      assert.ok(await adapter.transitionOrder(seated.id, driver.user.id, "completed"));
      entry = await capacityInvariant(observer, driver, 4); assert.equal(entry.availableSeats, 4); assert.equal(entry.inFifo, false);
    });
  }
});

test("both durable and memory adapters retain external price/target snapshots and enforce seat conservation through collection", async t => {
  for (const adapter of [store, new production.MemoryStore()]) await t.test(adapter.constructor.name, async child => {
    const f = await fixture(child, adapter), initial = await f.configured();
    const settings = {
      enabled: true, serviceRadiusMeters: policy.service_radius_meters, pricePerKmKzt: policy.price_per_km_kzt,
      gpsMaxAgeSeconds: policy.gps_max_age_seconds, quoteTtlSeconds: policy.quote_ttl_seconds,
      pickupGraceSeconds: policy.pickup_grace_seconds, maxPickupSeconds: policy.max_pickup_seconds, fareRounding: policy.fare_rounding,
    };
    const route = await adapter.updateExternalPickupSettings(initial.id, { expectedUpdatedAt: initial.updatedAt, settings });
    const driver = await f.planned(route), passenger = await f.createUser("passenger");
    const joined = await f.storedJoin(driver, route), quoted = await signedStoreQuote(adapter, driver, passenger, route, { seats: 2 });
    const first = await adapter.confirmExternalPickupQuote(quoted, passenger.user.id, passenger.user.sessionVersion);
    assert.equal(first.created, true); assert.equal(first.changed, true);
    assert.equal(first.order.offeredDriverId, driver.user.id);
    assert.equal(first.order.externalPickup.baseFareKzt, 1500); assert.equal(first.order.externalPickup.pickupSurchargeKzt, 250);
    assert.equal(first.order.fare.totalKzt, 1750);
    const duplicate = await adapter.confirmExternalPickupQuote(quoted, passenger.user.id, passenger.user.sessionVersion);
    assert.equal(duplicate.created, false); assert.equal(duplicate.changed, false); assert.equal(duplicate.order.id, first.order.id);
    assert.ok(await adapter.acceptOrderOffer(first.order.id, driver.user.id));
    assert.equal((await capacityInvariant(adapter, driver, 4)).availableSeats, 2);
    assert.ok(await adapter.transitionOrder(first.order.id, driver.user.id, "arrived_at_c"));
    assert.ok(await adapter.transitionOrder(first.order.id, driver.user.id, "boarded_waiting"));
    assert.equal((await adapter.getOrder(first.order.id)).seatLockExpiresAt, undefined);
    const nextQuote = await signedStoreQuote(adapter, driver, passenger, route, { seats: 2 });
    const next = await adapter.confirmExternalPickupQuote(nextQuote, passenger.user.id, passenger.user.sessionVersion);
    assert.ok(await adapter.acceptOrderOffer(next.order.id, driver.user.id));
    let entry = await capacityInvariant(adapter, driver, 4);
    assert.equal(entry.availableSeats, 0); assert.equal(entry.inFifo, true); assert.equal(entry.joinedAt, joined.joinedAt);
    assert.ok(await adapter.transitionOrder(next.order.id, passenger.user.id, "cancelled"));
    assert.equal(await adapter.transitionOrder(next.order.id, passenger.user.id, "cancelled"), undefined);
    entry = await capacityInvariant(adapter, driver, 4); assert.equal(entry.availableSeats, 2); assert.equal(entry.inFifo, true);
    assert.equal((await adapter.getOrder(first.order.id)).status, "boarded_waiting");
    await adapter.departQueue(driver.user.id, joined.collectionState.enrollmentId, driver.user.sessionVersion);
    assert.equal((await adapter.getOrder(first.order.id)).status, "in_transit");
    assert.ok(await adapter.transitionOrder(first.order.id, driver.user.id, "completed"));
    entry = await capacityInvariant(adapter, driver, 4); assert.equal(entry.availableSeats, 4); assert.equal(entry.inFifo, false);
  });
});

test("already accepted external trip keeps its agreed price and can finish after route policy changes", async t => {
  const { f, route, driver, passenger } = await setup(t), { quoted, order } = await externalOrder(passenger, route, { seats: 2 });
  await accept(driver, order);
  const accepted = await otherStore.getOrder(order.id);
  await configure(f, route, { price_per_km_kzt: 900, enabled: false });
  await move(driver, externalTarget);
  const beforeReplay = await otherStore.getQueueEntry(driver.user.id);
  const retry = await confirm(passenger, quoted);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.order.id, order.id); assert.equal(retry.body.order.price_kzt ?? retry.body.order.fare?.totalKzt ?? quoted.quote.total_kzt, quoted.quote.total_kzt);
  assert.deepEqual(await otherStore.getQueueEntry(driver.user.id), beforeReplay);
  assert.deepEqual((await otherStore.getOrder(order.id)).fare, accepted.fare);
  await arrive(driver, order); await board(driver, order);
  assert.equal((await depart(driver)).status, 200);
  const result = await request(`/orders/${order.id}/status`, { token: driver.token, method: "PATCH", body: { status: "completed" } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await capacityInvariant(otherStore, driver, 4)).availableSeats, 4);
});

test("real PostgreSQL confirmation and passenger session revocation serialize without unauthorized reservations", { timeout: 20_000 }, async t => {
  for (const first of ["confirm", "revoke"]) await t.test(first, async child => {
    const { route, driver, passenger } = await setup(child), quoted = await quote(passenger, route, { seats: 2 });
    const confirmation = () => confirm(passenger, quoted), revocation = () => store.invalidateSessions(passenger.user.id);
    const results = await overlapping("tezjet_users", "id", passenger.user.id, first === "confirm" ? [confirmation, revocation] : [revocation, confirmation]);
    assert.ok(results.every(result => !result.error), JSON.stringify(results));
    const confirmationResult = results.map(result => result.value).find(value => typeof value.status === "number");
    const orders = await store.listOrdersForUser(passenger.user.id), entry = await capacityInvariant(otherStore, driver, 4);
    assert.ok([201, 401].includes(confirmationResult.status), JSON.stringify(confirmationResult));
    if (confirmationResult.status === 201) { assert.equal(orders.length, 1); assert.equal(entry.availableSeats, 2); }
    else { assert.equal(orders.length, 0); assert.equal(entry.availableSeats, 4); }
  });
});

test("administrator rounding and zero pickup tariff are honored without inventing a minimum surcharge", async t => {
  for (const [settings, surcharge] of [[{ fare_rounding: "nearest_kzt" }, 125], [{ price_per_km_kzt: 0 }, 0]]) await t.test(JSON.stringify(settings), async child => {
    const { route, driver, passenger } = await setup(child, { settings });
    roadFor(at(route), 1251, 200);
    const quoted = await quote(passenger, route);
    assert.equal(quoted.quote.pickup_surcharge_kzt, surcharge);
    assert.equal(quoted.quote.total_kzt, 1500 + surcharge);
    const confirmed = await confirm(passenger, quoted);
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
    assert.equal((await capacityInvariant(otherStore, driver, 4)).availableSeats, 3);
  });
});

test("external selection requires an active collecting enrollment in the correct direction and ignores legacy queues", async t => {
  const f = await fixture(t), initial = await f.configured(), { route } = await configure(f, initial);
  const legacy = await f.planned(route); await f.storedJoin(legacy, route, 4, "a_to_b", false);
  const reverse = await enroll(f, route, 4, "b_to_a");
  const departed = await enroll(f, route); assert.equal((await depart(departed)).status, 200);
  const approved = await enroll(f, route), passenger = await f.createUser("passenger");
  const quoted = await quote(passenger, route);
  assert.equal(quoted.quote.driver_id, approved.user.id);
  assert.notEqual(quoted.quote.driver_id, legacy.user.id); assert.notEqual(quoted.quote.driver_id, reverse.user.id);
  assert.notEqual(quoted.quote.driver_id, departed.user.id);
  await store.setDriverApproval(approved.user.id, "rejected");
  assertError(await request("/orders/external/quote", { token: passenger.token, method: "POST", body: quoteBody(route) }), 409, "NO_DRIVERS");
});

test("missing or unsafe routing configuration fails closed and never leaks the configured URL", async t => {
  const { route, passenger } = await setup(t), configured = process.env.TEZJET_OSRM_URL;
  try {
    for (const value of [undefined, "http://user:secret@127.0.0.1/private?token=secret"]) {
      if (value === undefined) delete process.env.TEZJET_OSRM_URL; else process.env.TEZJET_OSRM_URL = value;
      const result = await request("/orders/external/quote", { token: passenger.token, method: "POST", body: quoteBody(route) });
      assertError(result, 503, "ROUTING_UNAVAILABLE");
      assert.equal(JSON.stringify(result.body).includes("secret"), false);
      await assertNoPassengerOrders(passenger);
    }
  } finally { process.env.TEZJET_OSRM_URL = configured; }
});
