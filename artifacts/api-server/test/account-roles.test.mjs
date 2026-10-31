import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { build } from "esbuild";

// Exercise the production adapters, routes, authentication middleware, and
// controllers against a private PostgreSQL schema. A missing database fails
// the suite; it never skips the durable adapter or substitutes SQL results.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `account_roles_${randomUUID().replaceAll("-", "")}`;
const applicationName = `account-roles-${randomUUID()}`;
const adminPhone = "+77779000099";
const tables = ["tezjet_offer_policy", "tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes", "tezjet_admin_audit_events"];
const envKeys = ["DATABASE_URL", "TEZJET_STORAGE_ADAPTER", "NODE_ENV", "SESSION_SECRET", "ADMIN_PHONE", "REQUIRE_DRIVER_APPROVAL", "PYATAK_CENTER_LAT", "PYATAK_CENTER_LNG"];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let moduleDirectory;
let database;
let adminPool;
let store;
let otherStore;
let runtimeStore;
let production;
let server;
let baseUrl;
let schemaCreated = false;

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required: account-role regressions must run against actual PostgreSQL.");
  const originalUrl = process.env.DATABASE_URL;
  const isolatedUrl = new URL(originalUrl);
  isolatedUrl.searchParams.set("options", `${isolatedUrl.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
  isolatedUrl.searchParams.set("application_name", applicationName);
  process.env.DATABASE_URL = isolatedUrl.href;
  process.env.TEZJET_STORAGE_ADAPTER = "postgres";
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "account-role-regression-secret-at-least-32-characters";
  process.env.ADMIN_PHONE = adminPhone;
  process.env.REQUIRE_DRIVER_APPROVAL = "true";
  process.env.PYATAK_CENTER_LAT = "41.3111";
  process.env.PYATAK_CENTER_LNG = "69.2797";
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".account-roles-test-"));
  const entry = path.join(moduleDirectory, "production.mjs");
  await build({
    stdin: {
      contents: [
        'export { PostgresStore } from "./src/store/postgresStore";',
        'export { MemoryStore } from "./src/store/memoryStore";',
        'export { pool } from "../../lib/db/src/index";',
        'export { store as runtimeStore } from "./src/store";',
        'export { default as router } from "./src/routes";',
        'export { errorHandler } from "./src/middleware/errorHandler";',
        'export { switchRole, logout } from "./src/controllers/authController";',
        'export { joinQueue } from "./src/controllers/queueController";',
        'export { createOrder } from "./src/controllers/orderController";',
      ].join("\n"),
      resolveDir: apiRoot, loader: "ts",
    },
    outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["pg-native", "pino"],
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
  runtimeStore = production.runtimeStore;
  assert.ok(runtimeStore instanceof production.PostgresStore, "HTTP requests must use the actual PostgreSQL adapter.");
  await Promise.all([store.initialize(), otherStore.initialize(), runtimeStore.initialize()]);
  const app = express();
  app.use(express.json());
  app.use("/api", production.router);
  app.use(production.errorHandler);
  server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
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

const location = { lat: 41.3111, lng: 69.2797, timestamp: 1 };
const stopC = { id: "role-c", code: "C", name: "Role C", sequence: 1, position: 1 };
const stopD = { id: "role-d", code: "D", name: "Role D", sequence: 2, position: 2 };
const fare = {
  currency: "KZT", routeId: "pyatak", pickupStop: stopC, destinationStop: stopD,
  pickupPosition: 1, destinationPosition: 2, distanceStops: 1, pricePerStopKzt: 500,
  minimumFareApplied: false, stops: [stopC, stopD], totalKzt: 500, calculatedAt: new Date(0).toISOString(),
};
let phoneSequence = 0;
function freshPhone() {
  return `+77${String(process.pid % 100_000).padStart(5, "0")}${String(++phoneSequence).padStart(5, "0")}`;
}

async function fixture(t, adapter = store) {
  const users = [];
  const phones = [];
  if (adapter instanceof production.PostgresStore) t.after(async () => {
    const ids = users.map(user => user.id);
    await database.query("DELETE FROM tezjet_orders WHERE passenger_id = ANY($1::text[]) OR driver_id = ANY($1::text[]) OR offered_driver_id = ANY($1::text[])", [ids]);
    await database.query("DELETE FROM tezjet_driver_queue WHERE driver_id = ANY($1::text[])", [ids]);
    await database.query("DELETE FROM tezjet_otp_challenges WHERE phone_number = ANY($1::text[])", [phones]);
    await database.query("DELETE FROM tezjet_users WHERE id = ANY($1::text[])", [ids]);
  });
  const ownUser = user => {
    users.push(user);
    phones.push(user.phoneNumber);
    return user;
  };
  const createUser = async (role = "passenger", phoneNumber = freshPhone()) => ownUser(await adapter.createUser({
    role, fullName: "Account role regression", phoneNumber, locale: "ru",
  }));
  const orderInput = (passenger, patch = {}) => ({
    passengerId: passenger.id, passengerPhone: passenger.phoneNumber,
    pickupPoint: "C", pickupLocation: location, routeStops: [stopC, stopD], fare,
    destination: "Role D", seats: 2, status: "searching", ...patch,
  });
  const queueInput = driver => ({
    driverId: driver.id, joinedAt: Date.now(), status: "searching", availableSeats: 4,
    lastLocation: location, priorityLock: false, inFifo: true, activeOrderIds: [],
  });
  const approvedDriver = async () => {
    const driver = await createUser("driver");
    await adapter.setDriverApproval(driver.id, "approved");
    return structuredClone(await adapter.getUser(driver.id));
  };
  return { adapter, createUser, approvedDriver, orderInput, queueInput, ownUser };
}

function snapshot(adapter, userId) {
  return Promise.resolve(adapter.getUser(userId)).then(user => structuredClone(user));
}

async function request(pathname, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function ageFixtureResendIntervals() {
  // These role tests model a user returning after the resend interval. Keep
  // the production limits enabled and the hourly send counts intact; the
  // dedicated OTP suite verifies cooldown instead of waiting a minute here.
  await database.query("UPDATE otp_rate_limits SET state = jsonb_set(state, '{nextAllowedAt}', '0'::jsonb) WHERE state ? 'nextAllowedAt'");
}

async function login(phoneNumber, role, fullName = "Registered role regression", endpoint = "/auth/verify-otp") {
  await ageFixtureResendIntervals();
  const challenge = await request("/auth/request-otp", {
    method: "POST", body: { phone_number: phoneNumber, role, full_name: fullName, locale: "ru" },
  });
  assert.equal(challenge.status, 202, JSON.stringify(challenge.body));
  assert.match(challenge.body.demo_code, /^\d{6}$/);
  return request(endpoint, { method: "POST", body: { phone_number: phoneNumber, code: challenge.body.demo_code } });
}

function controllerRequest(user, body = {}) {
  return {
    body, params: {}, query: {}, app: { locals: {} },
    auth: { userId: user.id, role: user.role, locale: user.locale, user: structuredClone(user) },
  };
}

function controllerResponse() {
  return { status() { return this; }, json(body) { this.body = body; }, send() {} };
}

function orderBody() {
  return { pickup_point: "C", pickup_location: { ...location, timestamp: Date.now() }, route_stops: ["C", "D"], destination: "Role D", seats: 2 };
}

function settlement(action) {
  return Promise.resolve().then(action).then(value => ({ value }), error => ({ error }));
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
  throw new Error(`Expected ${count} production PostgreSQL transactions blocked on the account row.`);
}

// Actual row locks force both transactions to overlap and establish which
// operation wins. Promise.all alone can accidentally execute sequentially.
async function overlappingAccount(userId, actions) {
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

test("PostgreSQL the actual account-role migration backfills legacy modes and preserves approval decisions", async () => {
  const migrationSchema = `role_backfill_${randomUUID().replaceAll("-", "")}`;
  const migrationSql = await readFile(path.resolve(apiRoot, "../../lib/db/drizzle/0002_account_roles.sql"), "utf8");
  const client = await adminPool.connect();
  let created = false;
  try {
    await client.query(`CREATE SCHEMA "${migrationSchema}"`);
    created = true;
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO "${migrationSchema}"`);
    // This is the legacy subset touched by the migration, with no roles
    // column. The committed production migration itself supplies all changes.
    await client.query("CREATE TABLE tezjet_users (id text PRIMARY KEY, role text NOT NULL, driver_approval_status text)");
    await client.query("INSERT INTO tezjet_users (id, role, driver_approval_status) VALUES ('passenger', 'passenger', NULL), ('driver-pending', 'driver', NULL), ('driver-approved', 'driver', 'approved'), ('driver-rejected', 'driver', 'rejected'), ('admin', 'admin', NULL)");
    await client.query(migrationSql);
    const { rows } = await client.query("SELECT id, role, roles, driver_approval_status FROM tezjet_users ORDER BY id");
    assert.deepEqual(rows, [
      { id: "admin", role: "admin", roles: ["admin"], driver_approval_status: null },
      { id: "driver-approved", role: "driver", roles: ["driver"], driver_approval_status: "approved" },
      { id: "driver-pending", role: "driver", roles: ["driver"], driver_approval_status: "pending" },
      { id: "driver-rejected", role: "driver", roles: ["driver"], driver_approval_status: "rejected" },
      { id: "passenger", role: "passenger", roles: ["passenger"], driver_approval_status: null },
    ]);
    const { rows: columns } = await client.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tezjet_users' AND column_name = 'roles'", [migrationSchema]);
    assert.equal(columns[0].is_nullable, "NO");
    const { rows: inserted } = await client.query("INSERT INTO tezjet_users (id, role) VALUES ('new-passenger', 'passenger') RETURNING roles");
    assert.deepEqual(inserted[0].roles, ["passenger"]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    if (created) await adminPool.query(`DROP SCHEMA "${migrationSchema}" CASCADE`);
  }
});

for (const adapterName of ["MemoryStore", "PostgresStore"]) {
  test(`${adapterName} grants driver capability while preserving identity, approval, and one session increment`, async t => {
    const adapter = adapterName === "MemoryStore" ? new production.MemoryStore() : store;
    const f = await fixture(t, adapter);
    const passenger = await f.createUser();
    const original = await snapshot(adapter, passenger.id);
    assert.deepEqual(original.roles, ["passenger"]);
    const driver = await adapter.activateUserRole(passenger.id, "driver");
    assert.equal(driver.id, original.id);
    assert.equal(driver.role, "driver");
    assert.deepEqual([...driver.roles].sort(), ["driver", "passenger"]);
    assert.equal(driver.driverApprovalStatus, "pending");
    assert.equal(driver.sessionVersion, original.sessionVersion + 1);
    for (const field of ["phoneNumber", "fullName", "locale", "profileLocked", "createdAt"]) assert.equal(driver[field], original[field]);
    await adapter.setDriverApproval(passenger.id, "approved");
    const activePassenger = await adapter.activateUserRole(passenger.id, "passenger");
    assert.equal(activePassenger.role, "passenger");
    assert.equal(activePassenger.driverApprovalStatus, "approved");
    assert.equal(activePassenger.sessionVersion, original.sessionVersion + 2);
    assert.equal((await adapter.listUsers("driver")).filter(user => user.id === passenger.id).length, 1, "Driver capability stays available to the admin approval list while passenger mode is active.");
    await adapter.setDriverApproval(passenger.id, "rejected");
    const returningDriver = await adapter.activateUserRole(passenger.id, "driver");
    assert.equal(returningDriver.driverApprovalStatus, "rejected", "Changing mode cannot reset an existing approval decision.");
    assert.equal(returningDriver.sessionVersion, original.sessionVersion + 3);
    const refreshedDriver = await adapter.activateUserRole(passenger.id, "driver");
    assert.equal(refreshedDriver.sessionVersion, original.sessionVersion + 4, "A successful same-mode request rotates sessions exactly once.");
    assert.equal(new Set(refreshedDriver.roles).size, 2);
    if (adapterName === "PostgresStore") {
      const { rows } = await database.query("SELECT role, roles, session_version FROM tezjet_users WHERE id = $1", [passenger.id]);
      assert.equal(rows[0].role, "driver");
      assert.deepEqual([...rows[0].roles].sort(), ["driver", "passenger"]);
      assert.equal(rows[0].session_version, original.sessionVersion + 4);
      assert.deepEqual(await snapshot(otherStore, passenger.id), await snapshot(adapter, passenger.id), "Another durable adapter reads the persisted active mode and capabilities.");
    }
  });

  test(`${adapterName} rejects administrator switching and invalid modes without account mutation`, async t => {
    const adapter = adapterName === "MemoryStore" ? new production.MemoryStore() : store;
    const f = await fixture(t, adapter);
    const admin = await f.createUser("admin");
    const passenger = await f.createUser();
    const adminBefore = await snapshot(adapter, admin.id);
    const passengerBefore = await snapshot(adapter, passenger.id);
    for (const role of ["passenger", "driver"]) {
      await assert.rejects(async () => adapter.activateUserRole(admin.id, role), { statusCode: 403, code: "ADMIN_ROLE_FORBIDDEN" });
    }
    await assert.rejects(async () => adapter.activateUserRole(passenger.id, "invalid-mode"), { statusCode: 400, code: "INVALID_ROLE" });
    assert.deepEqual(await snapshot(adapter, admin.id), adminBefore);
    assert.deepEqual(await snapshot(adapter, passenger.id), passengerBefore);
  });

  test(`${adapterName} blocks every queue record and all nonterminal participant relations`, async t => {
    for (const queueStatus of ["searching", "picking_up", "en_route_to_c", "arrived_at_c", "in_transit"]) {
      await t.test(`queue ${queueStatus}`, async child => {
        const adapter = adapterName === "MemoryStore" ? new production.MemoryStore() : store;
        const f = await fixture(child, adapter);
        const driver = await f.approvedDriver();
        await adapter.joinQueue(f.queueInput(driver));
        await adapter.updateQueueEntry(driver.id, { status: queueStatus, inFifo: queueStatus !== "in_transit" });
        const before = await snapshot(adapter, driver.id);
        const queueBefore = structuredClone(await adapter.getQueueEntry(driver.id));
        for (const nextRole of ["passenger", "driver"]) {
          await assert.rejects(async () => adapter.activateUserRole(driver.id, nextRole), { statusCode: 409, code: "ROLE_BUSY" });
        }
        assert.deepEqual(await snapshot(adapter, driver.id), before);
        assert.deepEqual(await adapter.getQueueEntry(driver.id), queueBefore);
      });
    }
    for (const status of ["searching", "en_route_to_c", "arrived_at_c", "in_transit"]) {
      for (const relation of ["passengerId", "driverId", "offeredDriverId"]) {
        await t.test(`${status} ${relation}`, async child => {
          const adapter = adapterName === "MemoryStore" ? new production.MemoryStore() : store;
          const f = await fixture(child, adapter);
          const actor = await f.createUser(relation === "passengerId" ? "passenger" : "driver");
          const passenger = relation === "passengerId" ? actor : await f.createUser();
          const order = await adapter.createOrder(f.orderInput(passenger, { status, [relation]: actor.id }));
          const before = await snapshot(adapter, actor.id);
          await assert.rejects(async () => adapter.activateUserRole(actor.id, actor.role === "driver" ? "passenger" : "driver"), { statusCode: 409, code: "ROLE_BUSY" });
          assert.deepEqual(await snapshot(adapter, actor.id), before);
          assert.deepEqual(await adapter.getOrder(order.id), order);
        });
      }
    }
  });

  test(`${adapterName} terminal trip history permits switching and remains intact`, async t => {
    for (const status of ["completed", "cancelled"]) {
      for (const relation of ["passengerId", "driverId", "offeredDriverId"]) {
        await t.test(`${status} ${relation}`, async child => {
          const adapter = adapterName === "MemoryStore" ? new production.MemoryStore() : store;
          const f = await fixture(child, adapter);
          const actor = await f.createUser(relation === "passengerId" ? "passenger" : "driver");
          const passenger = relation === "passengerId" ? actor : await f.createUser();
          const order = await adapter.createOrder(f.orderInput(passenger, { status, [relation]: actor.id }));
          const before = await snapshot(adapter, actor.id);
          const switched = await adapter.activateUserRole(actor.id, actor.role === "driver" ? "passenger" : "driver");
          assert.equal(switched.sessionVersion, before.sessionVersion + 1);
          assert.deepEqual(await adapter.getOrder(order.id), order);
        });
      }
    }
  });

  test(`${adapterName} refuses stale sessions and current-role violations in writes`, async t => {
    const adapter = adapterName === "MemoryStore" ? new production.MemoryStore() : store;
    const f = await fixture(t, adapter);
    const driver = await f.approvedDriver();
    await adapter.activateUserRole(driver.id, "passenger", driver.sessionVersion);
    await assert.rejects(async () => adapter.joinQueue(f.queueInput(driver), driver.sessionVersion), { statusCode: 401, code: "UNAUTHORIZED" });
    await assert.rejects(async () => adapter.joinQueue(f.queueInput(driver)), { statusCode: 403, code: "FORBIDDEN" });
    assert.equal(await adapter.getQueueEntry(driver.id), undefined);
    const passenger = await f.createUser();
    const oldVersion = passenger.sessionVersion;
    await adapter.activateUserRole(passenger.id, "driver", oldVersion);
    for (const operation of ["createOrder", "createOrderWithOffer"]) {
      await assert.rejects(async () => adapter[operation](f.orderInput(passenger), oldVersion), { statusCode: 401, code: "UNAUTHORIZED" });
      await assert.rejects(async () => adapter[operation](f.orderInput(passenger)), { statusCode: 403, code: "FORBIDDEN" });
    }
    await assert.rejects(async () => adapter.activateUserRole(passenger.id, "passenger", oldVersion), { statusCode: 401, code: "UNAUTHORIZED" });
    assert.deepEqual(await adapter.listOrdersForUser(passenger.id), []);
  });
}

test("HTTP switching authenticates, rotates one session, enforces active authority, and preserves approval", async t => {
  const f = await fixture(t);
  const unauthorized = await request("/auth/switch-role", { method: "POST", body: { role: "driver" } });
  assert.equal(unauthorized.status, 401);
  const registration = await login(freshPhone(), "passenger");
  assert.equal(registration.status, 200);
  const id = registration.body.user.id;
  f.ownUser(await store.getUser(id));
  assert.deepEqual(registration.body.user.roles, ["passenger"]);
  assert.equal(registration.body.user.active_role, "passenger");
  const before = await snapshot(store, id);
  const switched = await request("/auth/switch-role", { method: "POST", token: registration.body.access_token, body: { role: "driver" } });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(switched.body.user.id, id);
  assert.equal(switched.body.user.role, "driver");
  assert.equal(switched.body.user.active_role, "driver");
  assert.deepEqual([...switched.body.user.roles].sort(), ["driver", "passenger"]);
  assert.equal(switched.body.user.driver_approval_status, "pending");
  assert.equal((await store.getUser(id)).sessionVersion, before.sessionVersion + 1);
  assert.equal((await request("/auth/me", { token: registration.body.access_token })).status, 401);
  assert.equal((await request("/auth/me", { token: switched.body.access_token })).status, 200);
  assert.equal((await request("/orders", { method: "POST", token: switched.body.access_token, body: orderBody() })).status, 403);
  const deniedQueue = await request("/queue/join", { method: "POST", token: switched.body.access_token, body: { location: { ...location, timestamp: Date.now() }, available_seats: 4 } });
  assert.equal(deniedQueue.status, 403);
  assert.equal(deniedQueue.body.error.code, "DRIVER_APPROVAL_REQUIRED");
  await store.setDriverApproval(id, "approved");
  const joined = await request("/queue/join", { method: "POST", token: switched.body.access_token, body: { location: { ...location, timestamp: Date.now() }, available_seats: 4 } });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  const queuedVersion = (await store.getUser(id)).sessionVersion;
  const busy = await request("/auth/switch-role", { method: "POST", token: switched.body.access_token, body: { role: "passenger" } });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, "ROLE_BUSY");
  assert.equal((await store.getUser(id)).sessionVersion, queuedVersion);
  assert.equal((await request("/queue/leave", { method: "DELETE", token: switched.body.access_token })).status, 204);
  const passenger = await request("/auth/switch-role", { method: "POST", token: switched.body.access_token, body: { role: "passenger" } });
  assert.equal(passenger.status, 200);
  assert.equal(passenger.body.user.active_role, "passenger");
  assert.equal(passenger.body.user.driver_approval_status, "approved");
  assert.equal((await store.getUser(id)).sessionVersion, queuedVersion + 1);
  assert.equal((await request("/auth/me", { token: switched.body.access_token })).status, 401);
  assert.equal((await request("/queue/join", { method: "POST", token: passenger.body.access_token, body: { location: { ...location, timestamp: Date.now() }, available_seats: 4 } })).status, 403);
  assert.equal((await request("/orders/availability", { token: passenger.body.access_token })).status, 200);
});

test("HTTP admin route listing filters active and inactive routes without modifying them", async t => {
  const f = await fixture(t);
  const passenger = await f.createUser("passenger");
  const admin = await f.createUser("admin");
  const activeId = `active-${randomUUID()}`;
  const inactiveId = `inactive-${randomUUID()}`;
  await store.createRoute({ id: activeId, name: "Active test route", pricePerStopKzt: 500, active: true });
  await store.createRoute({ id: inactiveId, name: "Inactive test route", pricePerStopKzt: 500, active: false });
  t.after(async () => { await store.deleteRoute(activeId); await store.deleteRoute(inactiveId); });
  const activeBefore = await store.getRoute(activeId);
  const inactiveBefore = await store.getRoute(inactiveId);
  assert.equal((await request("/admin/routes?active=true")).status, 401);
  const passengerLogin = await login(passenger.phoneNumber, "passenger");
  assert.equal(passengerLogin.status, 200);
  assert.equal((await request("/admin/routes?active=false", { token: passengerLogin.body.access_token })).status, 403);
  await store.saveOtp({ phoneNumber: admin.phoneNumber, code: "627495", role: "admin", locale: "ru", expiresAt: Date.now() + 60_000 });
  const signedIn = await request("/auth/verify-otp", { method: "POST", body: { phone_number: admin.phoneNumber, code: "627495" } });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  const token = signedIn.body.access_token;
  const all = await request("/admin/routes", { token });
  assert.equal(all.status, 200);
  assert.ok(all.body.routes.some(route => route.id === activeId));
  assert.ok(all.body.routes.some(route => route.id === inactiveId));
  const enabled = await request("/admin/routes?active=true", { token });
  assert.equal(enabled.status, 200);
  assert.ok(enabled.body.routes.some(route => route.id === activeId));
  assert.ok(enabled.body.routes.every(route => route.active === true));
  const disabled = await request("/admin/routes?active=false", { token });
  assert.equal(disabled.status, 200);
  assert.ok(disabled.body.routes.some(route => route.id === inactiveId));
  assert.ok(disabled.body.routes.every(route => route.active === false));
  for (const invalid of ["", "yes", "1", "TRUE"]) {
    const response = await request(`/admin/routes?active=${encodeURIComponent(invalid)}`, { token });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "VALIDATION_ERROR");
  }
  assert.deepEqual(await store.getRoute(activeId), activeBefore);
  assert.deepEqual(await store.getRoute(inactiveId), inactiveBefore);
});

test("HTTP admin route detail protects access, returns stops, and handles missing routes", async t => {
  const f = await fixture(t);
  const passenger = await f.createUser("passenger");
  const admin = await f.createUser("admin");
  const routeId = `admin-route-${randomUUID()}`;
  const created = await store.createRoute({
    id: routeId, name: "Test admin route", pricePerStopKzt: 700, active: true,
  });
  t.after(async () => { await store.deleteRoute(routeId); });
  const stop = await store.addRouteStop(routeId, { code: "A", name: "Admin stop A", sequence: 1, position: 1 });

  const path = `/admin/routes/${routeId}`;
  assert.equal((await request(path)).status, 401);
  const passengerLogin = await login(passenger.phoneNumber, "passenger");
  assert.equal(passengerLogin.status, 200);
  assert.equal((await request(path, { token: passengerLogin.body.access_token })).status, 403);

  await store.saveOtp({ phoneNumber: admin.phoneNumber, code: "276583", role: "admin", locale: "ru", expiresAt: Date.now() + 60_000 });
  const adminLogin = await request("/auth/verify-otp", { method: "POST", body: { phone_number: admin.phoneNumber, code: "276583" } });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
  const token = adminLogin.body.access_token;
  const before = await store.getRoute(routeId);
  const response = await request(path, { token });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.route.id, routeId);
  assert.equal(response.body.route.name, created.name);
  assert.equal(response.body.route.pricePerStopKzt, 700);
  assert.ok(response.body.route.stops.some(item => item.id === stop.id && item.code === "A"));
  assert.deepEqual(await store.getRoute(routeId), before, "a read must not change the route or stops");

  const unknown = await request(`/admin/routes/admin-missing-${randomUUID()}`, { token });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "ROUTE_NOT_FOUND");
  const invalid = await request("/admin/routes/%20", { token });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "VALIDATION_ERROR");
});

test("HTTP admin FIFO queue is private, FIFO-ordered and hides location data", async t => {
  const f = await fixture(t);
  const one = await f.approvedDriver();
  const two = await f.approvedDriver();
  const admin = await f.createUser("admin");
  await store.joinQueue(f.queueInput(one));
  await store.joinQueue(f.queueInput(two));
  // Join normalizes its timestamp; set deterministic FIFO order using the
  // production store API, then snapshot the actual persisted row shape.
  await store.updateQueueEntry(one.id, { joinedAt: 100 });
  await store.updateQueueEntry(two.id, { joinedAt: 200 });
  const firstBefore = await store.getQueueEntry(one.id);
  const secondBefore = await store.getQueueEntry(two.id);
  assert.equal(firstBefore?.joinedAt, 100);
  assert.equal(secondBefore?.joinedAt, 200);

  assert.equal((await request("/admin/queue")).status, 401);
  const driverLogin = await login(one.phoneNumber, "driver");
  assert.equal(driverLogin.status, 200);
  assert.equal((await request("/admin/queue", { token: driverLogin.body.access_token })).status, 403);

  await store.saveOtp({ phoneNumber: admin.phoneNumber, code: "438216", role: "admin", locale: "ru", expiresAt: Date.now() + 60_000 });
  const signedIn = await request("/auth/verify-otp", { method: "POST", body: { phone_number: admin.phoneNumber, code: "438216" } });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  const response = await request("/admin/queue", { token: signedIn.body.access_token });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.total_queued, response.body.queue.length);
  const firstResult = response.body.queue.find(item => item.driver_id === one.id);
  const secondResult = response.body.queue.find(item => item.driver_id === two.id);
  assert.ok(firstResult);
  assert.ok(secondResult);
  assert.ok(firstResult.position < secondResult.position);
  assert.equal(firstResult.available_seats, 4);
  assert.equal(firstResult.status, "searching");
  assert.deepEqual(Object.keys(firstResult).sort(), ["available_seats", "driver_id", "joined_at", "position", "status"]);
  assert.ok(!JSON.stringify(response.body).includes(one.phoneNumber));
  assert.ok(!JSON.stringify(response.body).includes('"lastLocation"'));
  assert.ok(!JSON.stringify(response.body).includes('"lat"'));
  assert.deepEqual(await store.getQueueEntry(one.id), firstBefore);
  assert.deepEqual(await store.getQueueEntry(two.id), secondBefore);
});

test("HTTP admin trip statistics counts statuses without exposing personal data", async t => {
  const f = await fixture(t);
  const passenger = await f.createUser("passenger");
  const administrator = await f.createUser("admin");
  assert.equal((await request("/admin/statistics/trips")).status, 401);
  const passengerLogin = await login(passenger.phoneNumber, "passenger");
  assert.equal(passengerLogin.status, 200);
  assert.equal((await request("/admin/statistics/trips", { token: passengerLogin.body.access_token })).status, 403);
  await store.saveOtp({
    phoneNumber: administrator.phoneNumber, code: "584296", role: "admin",
    locale: "ru", expiresAt: Date.now() + 60_000,
  });
  const adminLogin = await request("/auth/verify-otp", {
    method: "POST", body: { phone_number: administrator.phoneNumber, code: "584296" },
  });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
  const token = adminLogin.body.access_token;
  const before = await request("/admin/statistics/trips", { token });
  assert.equal(before.status, 200);
  const a = await store.createOrder(f.orderInput(passenger, { status: "searching" }));
  const b = await store.createOrder(f.orderInput(passenger, { status: "completed" }));
  const c = await store.createOrder(f.orderInput(passenger, { status: "cancelled" }));
  const after = await request("/admin/statistics/trips", { token });
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body.statistics.total, before.body.statistics.total + 3);
  assert.equal(after.body.statistics.active, before.body.statistics.active + 1);
  assert.equal(after.body.statistics.completed, before.body.statistics.completed + 1);
  assert.equal(after.body.statistics.cancelled, before.body.statistics.cancelled + 1);
  for (const status of ["searching", "completed", "cancelled"]) {
    assert.equal(after.body.statistics.by_status[status], before.body.statistics.by_status[status] + 1);
  }
  assert.equal(Object.values(after.body.statistics.by_status).reduce((x, y) => x + y, 0), after.body.statistics.total);
  assert.equal(JSON.stringify(after.body).includes(passenger.phoneNumber), false);
  assert.equal(JSON.stringify(after.body).includes(passenger.id), false);
  assert.deepEqual(await store.getOrder(a.id), a);
  assert.deepEqual(await store.getOrder(b.id), b);
  assert.deepEqual(await store.getOrder(c.id), c);
});

test("HTTP admin order overview is read-only and rejects non-admin callers", async t => {
  const f = await fixture(t);
  const passenger = await f.createUser("passenger");
  const driver = await f.createUser("driver");
  const administrator = await f.createUser("admin");
  const order = await store.createOrder(f.orderInput(passenger));

  const anonymous = await request("/admin/orders");
  assert.equal(anonymous.status, 401);

  const passengerLogin = await login(passenger.phoneNumber, "passenger");
  assert.equal(passengerLogin.status, 200);
  const passengerDenied = await request("/admin/orders", { token: passengerLogin.body.access_token });
  assert.equal(passengerDenied.status, 403);
  assert.equal(passengerDenied.body.error.code, "FORBIDDEN");

  const driverLogin = await login(driver.phoneNumber, "driver");
  assert.equal(driverLogin.status, 200);
  assert.equal((await request("/admin/orders", { token: driverLogin.body.access_token })).status, 403);

  await store.saveOtp({
    phoneNumber: administrator.phoneNumber, code: "593821", role: "admin",
    locale: "ru", expiresAt: Date.now() + 60_000,
  });
  const adminLogin = await request("/auth/verify-otp", {
    method: "POST", body: { phone_number: administrator.phoneNumber, code: "593821" },
  });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
  const listing = await request("/admin/orders", { token: adminLogin.body.access_token });
  assert.equal(listing.status, 200, JSON.stringify(listing.body));
  assert.ok(Array.isArray(listing.body.orders));
  const listed = listing.body.orders.find(item => item.id === order.id);
  assert.ok(listed, "admin must see orders across user accounts");
  assert.equal(listed.passenger_id, passenger.id);
  assert.equal(listed.passenger_phone, passenger.phoneNumber);
  assert.equal(listed.status, "searching");
  assert.equal(listed.seats, 2);
  assert.equal(listed.sessionVersion, undefined);
  assert.deepEqual(await store.getOrder(order.id), order, "listing must not modify orders");
  const active = await request("/admin/orders?status=active", { token: adminLogin.body.access_token });
  assert.equal(active.status, 200);
  assert.ok(active.body.orders.some(item => item.id === order.id));
  const exact = await request("/admin/orders?status=searching", { token: adminLogin.body.access_token });
  assert.equal(exact.status, 200);
  assert.ok(exact.body.orders.some(item => item.id === order.id));
  for (const status of ["completed", "cancelled"]) {
    const filtered = await request(`/admin/orders?status=${status}`, { token: adminLogin.body.access_token });
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.orders.some(item => item.id === order.id), false);
  }
  const all = await request("/admin/orders?status=all", { token: adminLogin.body.access_token });
  assert.equal(all.status, 200);
  assert.ok(all.body.orders.some(item => item.id === order.id));
  for (const invalid of ["bogus", "", "ACTIVE"]) {
    const response = await request(`/admin/orders?status=${encodeURIComponent(invalid)}`, { token: adminLogin.body.access_token });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "VALIDATION_ERROR");
  }
  assert.equal((await request("/admin/orders?status=active", { token: passengerLogin.body.access_token })).status, 403);
  assert.deepEqual(await store.getOrder(order.id), order, "filtering must not mutate the order");
});

test("HTTP admin passenger directory is protected and includes passengers in driver mode", async t => {
  const f = await fixture(t);
  const passenger = await f.createUser("passenger");
  const switched = await f.createUser("passenger");
  const driver = await f.createUser("driver");
  const administrator = await f.createUser("admin");
  await store.activateUserRole(switched.id, "driver");

  const anonymous = await request("/admin/passengers");
  assert.equal(anonymous.status, 401);

  const passengerLogin = await login(passenger.phoneNumber, "passenger");
  assert.equal(passengerLogin.status, 200);
  const forbidden = await request("/admin/passengers", { token: passengerLogin.body.access_token });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, "FORBIDDEN");

  await store.saveOtp({
    phoneNumber: administrator.phoneNumber, code: "654321", role: "admin",
    locale: "ru", expiresAt: Date.now() + 60_000,
  });
  const adminLogin = await request("/auth/verify-otp", {
    method: "POST", body: { phone_number: administrator.phoneNumber, code: "654321" },
  });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
  const listing = await request("/admin/passengers", { token: adminLogin.body.access_token });
  assert.equal(listing.status, 200, JSON.stringify(listing.body));
  assert.ok(Array.isArray(listing.body.passengers));
  const byId = new Map(listing.body.passengers.map(user => [user.id, user]));
  assert.equal(byId.get(passenger.id)?.role, "passenger");
  assert.equal(byId.get(switched.id)?.role, "driver");
  assert.deepEqual([...byId.get(switched.id).roles].sort(), ["driver", "passenger"]);
  assert.equal(byId.has(driver.id), false);
  assert.equal(byId.has(administrator.id), false);
  assert.equal(byId.get(passenger.id).phone_number, passenger.phoneNumber);
  assert.equal(byId.get(passenger.id).sessionVersion, undefined);
});

test("HTTP verified OTP selects the requested mode, preserves the profile, and increments once on both login routes", async t => {
  const f = await fixture(t);
  const phone = freshPhone();
  const registered = await login(phone, "passenger", "Original full name");
  assert.equal(registered.status, 200);
  const id = registered.body.user.id;
  f.ownUser(await store.getUser(id));
  const before = await snapshot(store, id);
  const asDriver = await login(phone, "driver", "Replacement name", "/auth/login");
  assert.equal(asDriver.status, 200, JSON.stringify(asDriver.body));
  assert.equal(asDriver.body.user.id, id);
  assert.equal(asDriver.body.user.full_name, "Original full name");
  assert.equal(asDriver.body.user.role, "driver");
  assert.equal(asDriver.body.user.active_role, "driver");
  assert.equal(asDriver.body.user.driver_approval_status, "pending");
  assert.deepEqual([...asDriver.body.user.roles].sort(), ["driver", "passenger"]);
  assert.equal((await store.getUser(id)).sessionVersion, before.sessionVersion + 1, "OTP role activation must not invalidate sessions a second time.");
  assert.equal((await request("/auth/me", { token: registered.body.access_token })).status, 401);
  assert.equal((await request("/auth/me", { token: asDriver.body.access_token })).status, 200);
  const asPassenger = await login(phone, "passenger");
  assert.equal(asPassenger.status, 200);
  assert.equal(asPassenger.body.user.active_role, "passenger");
  assert.equal((await store.getUser(id)).sessionVersion, before.sessionVersion + 2);
  assert.equal((await request("/auth/me", { token: asDriver.body.access_token })).status, 401);
  assert.equal((await request("/auth/me", { token: asPassenger.body.access_token })).status, 200);
});

test("HTTP an OTP mode change cannot abandon the queue or revoke the still-valid driver session", async t => {
  const f = await fixture(t);
  const driver = await f.approvedDriver();
  const signedIn = await login(driver.phoneNumber, "driver");
  assert.equal(signedIn.status, 200);
  await store.joinQueue(f.queueInput(driver));
  const before = await snapshot(store, driver.id);
  const queueBefore = structuredClone(await store.getQueueEntry(driver.id));
  await ageFixtureResendIntervals();
  const challenge = await request("/auth/request-otp", {
    method: "POST", body: { phone_number: driver.phoneNumber, role: "passenger", locale: "ru" },
  });
  assert.equal(challenge.status, 202);
  const blocked = await request("/auth/verify-otp", {
    method: "POST", body: { phone_number: driver.phoneNumber, code: challenge.body.demo_code },
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "ROLE_BUSY");
  assert.deepEqual(await snapshot(store, driver.id), before);
  assert.deepEqual(await store.getQueueEntry(driver.id), queueBefore);
  assert.equal((await request("/auth/me", { token: signedIn.body.access_token })).status, 200);
});

test("HTTP refuses administrator escalation and administrator mode changes without rotating sessions", async t => {
  const f = await fixture(t);
  const passenger = await f.createUser("passenger", adminPhone);
  const signedIn = await login(adminPhone, "passenger");
  assert.equal(signedIn.status, 200);
  const before = await snapshot(store, passenger.id);
  const elevation = await login(adminPhone, "admin");
  assert.equal(elevation.status, 403);
  assert.equal(elevation.body.error.code, "ADMIN_ROLE_FORBIDDEN");
  const switchElevation = await request("/auth/switch-role", { method: "POST", token: signedIn.body.access_token, body: { role: "admin" } });
  assert.ok([400, 403].includes(switchElevation.status));
  assert.deepEqual(await snapshot(store, passenger.id), before);
  assert.equal((await request("/auth/me", { token: signedIn.body.access_token })).status, 200);
  const admin = await f.createUser("admin");
  // Existing admins can use an admin OTP issued by the store; the public OTP
  // request intentionally restricts admin phone numbers to ADMIN_PHONE.
  await store.saveOtp({ phoneNumber: admin.phoneNumber, code: "765432", role: "admin", locale: "ru", expiresAt: Date.now() + 60_000 });
  const adminLogin = await request("/auth/verify-otp", { method: "POST", body: { phone_number: admin.phoneNumber, code: "765432" } });
  assert.equal(adminLogin.status, 200);
  const adminBefore = await snapshot(store, admin.id);
  const demotion = await request("/auth/switch-role", { method: "POST", token: adminLogin.body.access_token, body: { role: "passenger" } });
  assert.equal(demotion.status, 403);
  assert.equal(demotion.body.error.code, "ADMIN_ROLE_FORBIDDEN");
  const otpDemotion = await login(admin.phoneNumber, "driver");
  assert.equal(otpDemotion.status, 403);
  assert.equal(otpDemotion.body.error.code, "ADMIN_ROLE_FORBIDDEN");
  assert.deepEqual(await snapshot(store, admin.id), adminBefore);
});

test("PostgreSQL simultaneous switches using one session permit one rotation", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const passenger = await f.createUser();
  const outcomes = await overlappingAccount(passenger.id, [
    () => store.activateUserRole(passenger.id, "driver", passenger.sessionVersion),
    () => otherStore.activateUserRole(passenger.id, "passenger", passenger.sessionVersion),
  ]);
  assert.equal(outcomes[0].value?.role, "driver");
  assert.equal(outcomes[1].error?.statusCode, 401);
  assert.equal(outcomes[1].error?.code, "UNAUTHORIZED");
  assert.equal((await store.getUser(passenger.id)).sessionVersion, passenger.sessionVersion + 1);
});

for (const winner of ["switch", "join"]) {
  test(`PostgreSQL real controllers serialize account switch versus queue join when ${winner} wins`, { timeout: 15_000 }, async t => {
    const f = await fixture(t);
    const driver = await f.approvedDriver();
    const switchAction = () => production.switchRole(controllerRequest(driver, { role: "passenger" }), controllerResponse());
    const joinAction = () => production.joinQueue(controllerRequest(driver, { location: { ...location, timestamp: Date.now() }, available_seats: 4 }), controllerResponse());
    const outcomes = await overlappingAccount(driver.id, winner === "switch" ? [switchAction, joinAction] : [joinAction, switchAction]);
    assert.equal(outcomes[0].error, undefined);
    const current = await store.getUser(driver.id);
    if (winner === "switch") {
      assert.equal(outcomes[1].error?.statusCode, 401);
      assert.equal(outcomes[1].error?.code, "UNAUTHORIZED");
      assert.equal(current.role, "passenger");
      assert.equal(current.sessionVersion, driver.sessionVersion + 1);
      assert.equal(await store.getQueueEntry(driver.id), undefined, "A stale driver controller must not recreate a queue record after switching to passenger.");
    } else {
      assert.equal(outcomes[1].error?.statusCode, 409);
      assert.equal(outcomes[1].error?.code, "ROLE_BUSY");
      assert.equal(current.role, "driver");
      assert.equal(current.sessionVersion, driver.sessionVersion);
      assert.equal((await store.getQueueEntry(driver.id)).availableSeats, 4);
    }
  });
}

for (const winner of ["switch", "create"]) {
  test(`PostgreSQL real controllers serialize account switch versus order creation when ${winner} wins`, { timeout: 15_000 }, async t => {
    const f = await fixture(t);
    const passenger = await f.createUser();
    const driver = await f.approvedDriver();
    await store.joinQueue(f.queueInput(driver));
    const createResponse = controllerResponse();
    const switchAction = () => production.switchRole(controllerRequest(passenger, { role: "driver" }), controllerResponse());
    const createAction = () => production.createOrder(controllerRequest(passenger, orderBody()), createResponse);
    const outcomes = await overlappingAccount(passenger.id, winner === "switch" ? [switchAction, createAction] : [createAction, switchAction]);
    assert.equal(outcomes[0].error, undefined);
    const current = await store.getUser(passenger.id);
    const orders = await store.listOrdersForUser(passenger.id);
    const queue = await store.getQueueEntry(driver.id);
    if (winner === "switch") {
      assert.equal(outcomes[1].error?.statusCode, 401);
      assert.equal(outcomes[1].error?.code, "UNAUTHORIZED");
      assert.equal(current.role, "driver");
      assert.equal(current.sessionVersion, passenger.sessionVersion + 1);
      assert.deepEqual(orders, []);
      assert.equal(queue.availableSeats, 4);
      assert.equal(queue.pendingOfferOrderId, undefined);
    } else {
      assert.equal(outcomes[1].error?.statusCode, 409);
      assert.equal(outcomes[1].error?.code, "ROLE_BUSY");
      assert.equal(current.role, "passenger");
      assert.equal(current.sessionVersion, passenger.sessionVersion);
      assert.equal(orders.length, 1);
      assert.equal(orders[0].id, createResponse.body.order.id);
      assert.equal(queue.pendingOfferOrderId, orders[0].id);
      assert.equal(queue.availableSeats, 2);
    }
  });
}

for (const adapterName of ["MemoryStore", "PostgresStore"]) {
  test(`${adapterName} conditional logout preserves a newer session and revokes the current one once`, async t => {
    const adapter = adapterName === "MemoryStore" ? new production.MemoryStore() : store;
    const f = await fixture(t, adapter);
    const user = await f.createUser();
    const current = await adapter.invalidateSessions(user.id);
    const before = await snapshot(adapter, user.id);
    await assert.rejects(async () => adapter.invalidateSessions(user.id, user.sessionVersion),
      error => error.statusCode === 401 && error.code === "UNAUTHORIZED");
    assert.deepEqual(await snapshot(adapter, user.id), before);
    const revoked = await adapter.invalidateSessions(user.id, current.sessionVersion);
    assert.equal(revoked.sessionVersion, current.sessionVersion + 1);
    await assert.rejects(async () => adapter.invalidateSessions(user.id, current.sessionVersion),
      error => error.statusCode === 401 && error.code === "UNAUTHORIZED");
    assert.equal((await adapter.getUser(user.id)).sessionVersion, revoked.sessionVersion);
  });
}

test("PostgreSQL delayed authenticated logout cannot revoke a newer login while waiting on its row lock", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const user = await f.createUser();
  let cleanupCalls = 0;
  const staleRequest = controllerRequest(user);
  staleRequest.app.locals.io = { in() { cleanupCalls++; throw new Error("Stale logout must not disconnect sockets"); } };
  const outcomes = await overlappingAccount(user.id, [
    () => otherStore.invalidateSessions(user.id),
    () => production.logout(staleRequest, controllerResponse()),
  ]);
  assert.equal(outcomes[0].error, undefined);
  assert.equal(outcomes[1].error?.statusCode, 401);
  assert.equal(outcomes[1].error?.code, "UNAUTHORIZED");
  assert.equal(cleanupCalls, 0);
  assert.equal((await store.getUser(user.id)).sessionVersion, user.sessionVersion + 1);
});

test("PostgreSQL duplicate authenticated logout requests increment the version only once", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const user = await f.createUser();
  const outcomes = await overlappingAccount(user.id, [
    () => production.logout(controllerRequest(user), controllerResponse()),
    () => production.logout(controllerRequest(user), controllerResponse()),
  ]);
  assert.equal(outcomes[0].error, undefined);
  assert.equal(outcomes[1].error?.statusCode, 401);
  assert.equal((await store.getUser(user.id)).sessionVersion, user.sessionVersion + 1);
});

test("HTTP logout revokes its current JWT while an old JWT cannot log out a newer login", async t => {
  const f = await fixture(t);
  const user = await f.createUser();
  const oldLogin = await login(user.phoneNumber, "passenger");
  assert.equal(oldLogin.status, 200);
  const newLogin = await login(user.phoneNumber, "passenger");
  assert.equal(newLogin.status, 200);
  const current = await snapshot(store, user.id);
  const stale = await request("/auth/logout", { method: "POST", token: oldLogin.body.access_token });
  assert.equal(stale.status, 401);
  assert.deepEqual(await snapshot(store, user.id), current);
  assert.equal((await request("/auth/me", { token: newLogin.body.access_token })).status, 200);
  assert.equal((await request("/auth/logout", { method: "POST", token: newLogin.body.access_token })).status, 204);
  assert.equal((await request("/auth/me", { token: newLogin.body.access_token })).status, 401);
  assert.equal((await store.getUser(user.id)).sessionVersion, current.sessionVersion + 1);
});
