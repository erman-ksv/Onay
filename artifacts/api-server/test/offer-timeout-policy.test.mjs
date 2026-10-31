import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Exercise the real HTTP application and durable adapters. Private copies of
// migrated tables retain their actual columns and uniqueness constraints.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `offer_policy_${randomUUID().replaceAll("-", "")}`;
const applicationName = `offer-policy-${randomUUID()}`;
const tables = ["tezjet_offer_policy", "tezjet_route_order_requests", "tezjet_closed_route_order_requests", "tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes", "tezjet_admin_audit_events"];
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
  process.env.SESSION_SECRET = "offer-policy-regression-secret-at-least-32-characters";
  process.env.LOG_LEVEL = "silent";
  process.env.REQUIRE_DRIVER_APPROVAL = "true";
  process.env.PYATAK_CENTER_LAT = "41.3111";
  process.env.PYATAK_CENTER_LNG = "69.2797";
  delete process.env.TEZJET_OFFER_TIMEOUT_SECONDS;
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".offer-policy-test-"));
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
  return { status: response.status, headers: response.headers, text: content, body: content ? JSON.parse(content) : undefined };
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


const policyPath = "/admin/settings/offer-timeout";
beforeEach(async () => {
  // Reset only this file's private fixture policy. Audit receipts are never
  // deleted or weakened, and no public schema/state is changed.
  await database.query("UPDATE tezjet_offer_policy SET seconds=NULL,revision=NULL,updated_at=NULL WHERE id='offer-timeout'");
});
async function adminFixture(t) {
  const f = await fixture(t), admin = await f.createUser("admin");
  return { ...f, admin, actor: { adminId: admin.user.id, expectedSessionVersion: admin.user.sessionVersion } };
}
const eventsFor = async admin => (await store.listAdminAuditEvents(undefined, 100)).filter(event => event.actorId === admin.user.id && event.action === "settings.offer_timeout_changed");
const put = (actor, seconds, revision = null) => request(policyPath, { token: actor.token, method: "PUT", body: { seconds, expected_revision: revision } });

test("Offer policy GET/HEAD and writes are admin-only,private,and reject stale sessions", async t => {
  const f = await adminFixture(t), initial = await store.getOfferTimeout();
  assert.deepEqual(initial, { seconds: 60, revision: null, updatedAt: null });
  const read = await request(policyPath, { token: f.admin.token });
  assert.equal(read.status, 200); assert.deepEqual(read.body.offer_timeout, initial);
  assert.equal(read.headers.get("cache-control"), "no-store");
  const head = await request(policyPath, { token: f.admin.token, method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.text, ""); assert.equal(head.headers.get("cache-control"), "no-store");
  assertError(await request(policyPath), 401, "UNAUTHORIZED");
  for (const role of ["passenger", "driver"]) {
    const actor = await f.createUser(role);
    assertError(await request(policyPath, { token: actor.token }), 403, "FORBIDDEN");
    assertError(await put(actor, 90), 403, "FORBIDDEN");
  }
  await store.invalidateSessions(f.admin.user.id);
  assertError(await put(f.admin, 90), 401, "UNAUTHORIZED");
  assert.deepEqual(await store.getOfferTimeout(), initial); assert.equal((await eventsFor(f.admin)).length, 0);
});

test("Offer policy rejects invalid bodies without settings or audit mutations", async t => {
  const f = await adminFixture(t), initial = await store.getOfferTimeout();
  for (const body of [null, [], {}, { seconds: 90 }, { seconds: 90, expected_revision: {} },
    { seconds: 90, expected_revision: null, actor_id: "forged" },
    ...[0, -1, 3601, 1.5, "90", true, null].map(seconds => ({ seconds, expected_revision: null }))]) {
    const result = await request(policyPath, { token: f.admin.token, method: "PUT", body });
    assertError(result, 400, body === null ? "INVALID_JSON" : "VALIDATION_ERROR"); assert.equal(result.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(await store.getOfferTimeout(), initial); assert.equal((await eventsFor(f.admin)).length, 0);
});

test("Offer policy survives a fresh store,accepts bounds,and no-op/stale writes preserve one audit receipt", async t => {
  const f = await adminFixture(t), first = await put(f.admin, 60);
  assert.equal(first.status, 200); const one = first.body.offer_timeout;
  assert.ok(one.revision); assert.equal(one.seconds, 60);
  const again = await put(f.admin, 60, one.revision); assert.deepEqual(again.body.offer_timeout, one);
  assertError(await put(f.admin, 60, null), 409, "OFFER_TIMEOUT_CHANGED");
  assert.equal((await eventsFor(f.admin)).length, 1);
  const low = (await put(f.admin, 1, one.revision)).body.offer_timeout;
  const high = (await put(f.admin, 3600, low.revision)).body.offer_timeout;
  const fresh = new production.PostgresStore(); await fresh.initialize();
  assert.deepEqual(await fresh.getOfferTimeout(), high); assert.deepEqual(await otherStore.getOfferTimeout(), high);
  const audit = await eventsFor(f.admin); assert.equal(audit.length, 3);
  assert.ok(audit.every(event => event.settingKey === "offer-timeout" && Number.isInteger(event.previousValue) && Number.isInteger(event.nextValue) && event.nextVersion));
  assert.ok(!JSON.stringify(audit).includes(f.admin.token));
});

test("Concurrent administrators compare the same policy revision and exactly one wins", async t => {
  const f = await adminFixture(t), second = await f.createUser("admin");
  const results = await Promise.allSettled([
    store.setOfferTimeoutAsAdmin(75, null, f.actor),
    otherStore.setOfferTimeoutAsAdmin(90, null, { adminId: second.user.id, expectedSessionVersion: second.user.sessionVersion }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "OFFER_TIMEOUT_CHANGED");
  const saved = results.find(result => result.status === "fulfilled").value;
  assert.deepEqual(await store.getOfferTimeout(), saved);
  assert.equal((await eventsFor(f.admin)).length + (await eventsFor(second)).length, 1);
});

test("A settings writer waiting for its row rechecks administrator revocation before commit", { timeout: 10_000 }, async t => {
  const f = await adminFixture(t), blocker = await adminPool.connect();
  let pending;
  try {
    await blocker.query("BEGIN");
    await blocker.query('SELECT id FROM "' + schema + '".tezjet_offer_policy FOR UPDATE');
    pending = store.setOfferTimeoutAsAdmin(90, null, f.actor).then(value => ({ value }), error => ({ error }));
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < deadline) {
      const result = await adminPool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%tezjet_offer_policy%'", [applicationName]);
      if (result.rows[0].count > 0) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true, "The real settings transaction must actually overlap a held row lock");
    await otherStore.invalidateSessions(f.admin.user.id);
    await blocker.query("COMMIT");
    assert.equal((await pending).error.code, "UNAUTHORIZED");
    assert.deepEqual(await store.getOfferTimeout(), { seconds: 60, revision: null, updatedAt: null });
    assert.equal((await eventsFor(f.admin)).length, 0);
  } finally {
    await blocker.query("ROLLBACK"); blocker.release();
    if (pending) await pending;
  }
});

test("Audit insertion failure rolls the policy update back in the same PostgreSQL transaction", async t => {
  const f = await adminFixture(t), initial = await store.getOfferTimeout();
  await database.query("CREATE FUNCTION reject_offer_policy_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='settings.offer_timeout_changed' THEN RAISE EXCEPTION 'fixture audit rejection'; END IF; RETURN NEW; END $$");
  await database.query("CREATE TRIGGER reject_offer_policy_audit BEFORE INSERT ON tezjet_admin_audit_events FOR EACH ROW EXECUTE FUNCTION reject_offer_policy_audit()");
  try {
    await assert.rejects(store.setOfferTimeoutAsAdmin(90, null, f.actor));
    assert.deepEqual(await store.getOfferTimeout(), initial); assert.equal((await eventsFor(f.admin)).length, 0);
  } finally {
    await database.query("DROP TRIGGER reject_offer_policy_audit ON tezjet_admin_audit_events");
    await database.query("DROP FUNCTION reject_offer_policy_audit()");
  }
});

test("Configured offers freeze existing deadlines; replay,redispatch,expiry and accepted rides use the right policy", async t => {
  const f = await adminFixture(t), route = await f.configured(), passenger = await f.createUser("passenger");
  const drivers = [await f.planned(route), await f.planned(route), await f.planned(route)];
  for (const driver of drivers) await f.storedJoin(driver, route, 4);
  const initial = await store.setOfferTimeoutAsAdmin(71, null, f.actor);
  const key = randomUUID(), body = { passengerId: passenger.user.id, passengerPhone: passenger.user.phoneNumber, pickupLocation: at(route), seats: 1 };
  const first = await store.createRouteOrderOnce(body, choice(route), key, passenger.user.sessionVersion);
  assert.equal(first.order.offerExpiresAt - Date.parse(first.order.createdAt), 71000);
  const frozen = first.order.offerExpiresAt;
  const changed = await store.setOfferTimeoutAsAdmin(13, initial.revision, f.actor);
  assert.equal(await store.dispatchOrderOffer(first.order.id, frozen - 1), undefined);
  const replay = await otherStore.createRouteOrderOnce(body, choice(route), key, passenger.user.sessionVersion);
  assert.equal(replay.created, false); assert.equal(replay.order.offerExpiresAt, frozen);
  const moved = await store.rejectOrderOffer(first.order.id, first.order.offeredDriverId);
  assert.ok(moved.order.offeredDriverId); assert.notEqual(moved.order.offeredDriverId, first.order.offeredDriverId);
  assert.equal(moved.order.offerExpiresAt - Date.parse(moved.order.updatedAt), 13000);
  await store.setOfferTimeoutAsAdmin(19, changed.revision, f.actor);
  await store.processOrderOffers(moved.order.offerExpiresAt - 1);
  assert.equal((await store.getOrder(first.order.id)).offeredDriverId, moved.order.offeredDriverId);
  await store.processOrderOffers(moved.order.offerExpiresAt);
  const third = await store.getOrder(first.order.id);
  assert.equal(third.offerExpiresAt - Date.parse(third.updatedAt), 19000);
  const actor = drivers.find(driver => driver.user.id === third.offeredDriverId);
  const accepted = await store.acceptOrderOffer(third.id, actor.user.id, third.offerExpiresAt - 1, actor.user.sessionVersion);
  const current = await store.getOfferTimeout(); await store.setOfferTimeoutAsAdmin(3600, current.revision, f.actor);
  assert.deepEqual(await store.getOrder(third.id), accepted, "Policy changes do not retime accepted rides or seat leases");
  for (const driver of drivers) {
    const entry = await store.getQueueEntry(driver.user.id);
    assert.equal(entry.availableSeats, driver.user.id === accepted.driverId ? 3 : 4);
  }
});

test("Legacy offers and both availability endpoints expose the effective durable policy", async t => {
  const f = await adminFixture(t), driver = await f.createUser(), passenger = await f.createUser("passenger");
  await store.setOfferTimeoutAsAdmin(83, null, f.actor);
  await store.joinQueue({ driverId: driver.user.id, joinedAt: Date.now(), status: "searching", availableSeats: 3,
    lastLocation: { lat: 41.3111, lng: 69.2797, timestamp: Date.now() }, priorityLock: false, inFifo: true, activeOrderIds: [] }, driver.user.sessionVersion);
  const route = await store.getRoute("pyatak"), stops = route.stops;
  const order = await store.createOrderWithOffer({ passengerId: passenger.user.id, passengerPhone: passenger.user.phoneNumber,
    pickupPoint: "C", pickupLocation: { lat: 41.3111, lng: 69.2797, timestamp: Date.now() }, routeStops: stops,
    fare: { currency: "KZT", routeId: route.id, pickupStop: stops[0], destinationStop: stops[1], totalKzt: 500 },
    destination: "D", seats: 1, status: "searching" }, passenger.user.sessionVersion);
  assert.equal(order.offerExpiresAt - Date.parse(order.updatedAt), 83000);
  const legacy = await request("/orders/availability?pickup_point=C&seats=1", { token: passenger.token });
  assert.equal(legacy.status, 200); assert.equal(legacy.body.offer_timeout_seconds, 83);
  const configured = await f.configured();
  const query = new URLSearchParams({ route_id: configured.id, expected_updated_at: configured.updatedAt, direction: "a_to_b", seats: "1" });
  const current = await request("/orders/route/availability?" + query, { token: passenger.token });
  assert.equal(current.status, 200); assert.equal(current.body.offer_timeout_seconds, 83);
});
