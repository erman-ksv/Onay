import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Real HTTP middleware and PostgreSQL; private migrated tables, no SMS/provider.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = "gps_timestamp_" + randomUUID().replaceAll("-", "");
const tables = ["tezjet_offer_policy", "tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes", "tezjet_admin_audit_events"];
const keys = ["DATABASE_URL", "NODE_ENV", "TEZJET_STORAGE_ADAPTER", "SESSION_SECRET", "LOG_LEVEL", "REQUIRE_DRIVER_APPROVAL", "PYATAK_CENTER_LAT", "PYATAK_CENTER_LNG"];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let directory, production, database, adminPool, server, baseUrl, schemaCreated = false;
let sequence = 0;

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL required: GPS timestamp regressions must execute PostgreSQL");
  const originalUrl = process.env.DATABASE_URL;
  const url = new URL(originalUrl);
  url.searchParams.set("options", ((url.searchParams.get("options") ?? "") + " -c search_path=" + schema).trim());
  process.env.DATABASE_URL = url.href;
  process.env.NODE_ENV = "production";
  process.env.TEZJET_STORAGE_ADAPTER = "postgres";
  process.env.SESSION_SECRET = "gps-timestamp-regression-secret-at-least-32-characters";
  process.env.LOG_LEVEL = "silent";
  process.env.REQUIRE_DRIVER_APPROVAL = "true";
  process.env.PYATAK_CENTER_LAT = "41.3111";
  process.env.PYATAK_CENTER_LNG = "69.2797";
  directory = await mkdtemp(path.join(apiRoot, ".gps-timestamp-test-"));
  const entry = path.join(directory, "production.mjs");
  await build({
    stdin: { contents: [
      'export { default as app } from "./src/app";',
      'export { store } from "./src/store";',
      'export { pool } from "../../lib/db/src/index";',
      'export { createAccessToken } from "./src/utils/token";',
    ].join("\n"), resolveDir: apiRoot, loader: "ts" },
    outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["pg-native", "pino", "pino-http", "socket.io"],
    banner: { js: 'import { createRequire as testCreateRequire } from "node:module"; const require = testCreateRequire(import.meta.url);' },
  });
  production = await import(pathToFileURL(entry).href);
  database = production.pool;
  adminPool = new database.constructor({ connectionString: originalUrl, max: 2 });
  await adminPool.query('CREATE SCHEMA "' + schema + '"');
  schemaCreated = true;
  for (const table of tables) await adminPool.query('CREATE TABLE "' + schema + '"."' + table + '" (LIKE "public"."' + table + '" INCLUDING ALL)');
  await production.store.initialize();
  server = await new Promise(resolve => { const listener = production.app.listen(0, "127.0.0.1", () => resolve(listener)); });
  baseUrl = "http://127.0.0.1:" + server.address().port + "/api";
}, { timeout: 30_000 });

after(async () => {
  try {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (database) await database.end();
    if (schemaCreated && adminPool) await adminPool.query('DROP SCHEMA "' + schema + '" CASCADE');
  } finally {
    if (adminPool) await adminPool.end();
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

async function actor(role = "driver", previous) {
  let user = await production.store.createUser({
    role, fullName: "GPS timestamp regression", phoneNumber: "+99893" + String(++sequence).padStart(7, "0"), locale: "ru",
  });
  if (role === "driver") await production.store.setDriverApproval(user.id, "approved");
  if (previous) await production.store.updateUser(user.id, { lastLocation: previous });
  user = await production.store.getUser(user.id);
  return { user, token: production.createAccessToken({
    sub: user.id, role: user.role, locale: user.locale, sessionVersion: user.sessionVersion, sessionId: randomUUID(),
  }) };
}
async function request(actor, pathname, method, body) {
  const response = await fetch(baseUrl + pathname, {
    method, signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/json", authorization: "Bearer " + actor.token },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const center = () => ({ lat: 41.3111, lng: 69.2797 });
const invalidTimes = [null, false, true, 0, -1, "", " ", "NaN", "Infinity", "-Infinity", "not-a-time", "1e309", [], {}, { toString: null, valueOf: null }];
function invalid(result) {
  assert.equal(result.status, 422, JSON.stringify(result.body));
  assert.equal(result.body.error.code, "INVALID_COORDINATES");
}

test("Invalid first GPS timestamps cannot save a location or join a PostgreSQL queue", async () => {
  const driver = await actor();
  for (const timestamp of invalidTimes) {
    invalid(await request(driver, "/queue/join", "POST", { location: { ...center(), timestamp }, available_seats: 3 }));
    assert.equal((await production.store.getUser(driver.user.id)).lastLocation, undefined);
    assert.equal(await production.store.getQueueEntry(driver.user.id), undefined);
  }
});

test("Malformed timestamps cannot bypass speed checking or mutate an existing queue and user", async () => {
  const driver = await actor();
  const joined = await request(driver, "/queue/join", "POST", { location: { ...center(), timestamp: Date.now() }, available_seats: 3 });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  const userBefore = await production.store.getUser(driver.user.id);
  const queueBefore = await production.store.getQueueEntry(driver.user.id);
  for (const timestamp of invalidTimes) {
    // Original NaN comparison allowed this far jump to reach the controller;
    // configured/active lanes do not always have the legacy pitak geofence.
    invalid(await request(driver, "/queue/location", "PATCH", { location: { lat: 42, lng: 70, timestamp } }));
    assert.deepEqual((await production.store.getUser(driver.user.id)).lastLocation, userBefore.lastLocation);
    assert.deepEqual(await production.store.getQueueEntry(driver.user.id), queueBefore);
  }
  const tooFast = await request(driver, "/queue/location", "PATCH", {
    location: { lat: 42, lng: 70, timestamp: userBefore.lastLocation.timestamp + 1 },
  });
  assert.equal(tooFast.status, 422);
  assert.equal(tooFast.body.error.code, "GPS_SPEED_LIMIT");
});

test("Invalid passenger pickup timestamps preserve durable location, orders and all reservations", async () => {
  const passenger = await actor("passenger", { ...center(), timestamp: Date.now() - 1000 });
  const userBefore = await production.store.getUser(passenger.user.id);
  const ordersBefore = await production.store.listOrders();
  const queuesBefore = await production.store.getQueue();
  for (const timestamp of invalidTimes) {
    invalid(await request(passenger, "/orders", "POST", {
      pickup_point: "C", pickup_location: { ...center(), timestamp }, route_stops: ["C"], destination: "C", seats: 1,
    }));
    assert.deepEqual((await production.store.getUser(passenger.user.id)).lastLocation, userBefore.lastLocation);
    assert.deepEqual(await production.store.listOrders(), ordersBefore);
    assert.deepEqual(await production.store.getQueue(), queuesBefore);
  }
});

test("Numeric, legacy numeric-string and omitted GPS timestamps retain successful queue behavior", async () => {
  for (const timestamp of [Date.now(), String(Date.now()), undefined]) {
    const driver = await actor();
    const result = await request(driver, "/queue/join", "POST", { location: { ...center(), timestamp }, available_seats: 3 });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const user = await production.store.getUser(driver.user.id), queue = await production.store.getQueueEntry(driver.user.id);
    assert.ok(Number.isFinite(user.lastLocation.timestamp) && user.lastLocation.timestamp > 0);
    assert.ok(Number.isFinite(queue.lastLocation.timestamp) && queue.lastLocation.timestamp > 0);
    assert.equal(queue.availableSeats, 3);
  }
});
