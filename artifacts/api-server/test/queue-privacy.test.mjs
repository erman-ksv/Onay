import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { io as createSocket } from "socket.io-client";

// Real production HTTP/auth/Socket.IO and PostgreSQL. Gates delay real reads;
// they never replace SQL results or substitute a memory adapter. No database
// skips: setup failures are environment blockers, not privacy reproductions.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `queue_privacy_${randomUUID().replaceAll("-", "")}`;
const envKeys = ["DATABASE_URL", "TEZJET_STORAGE_ADAPTER", "NODE_ENV", "SESSION_SECRET", "LOG_LEVEL", "REQUIRE_DRIVER_APPROVAL", "PYATAK_CENTER_LAT", "PYATAK_CENTER_LNG"];
const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const sockets = new Set();
let directory, production, pool, adminPool, store, server, io, origin, schemaCreated;
const publicFields = ["availableSeats", "driverId", "position", "status"];

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL required: queue privacy tests need real PostgreSQL");
  const originalUrl = process.env.DATABASE_URL;
  const isolated = new URL(originalUrl);
  isolated.searchParams.set("options", `${isolated.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
  isolated.searchParams.set("application_name", "onay-queue-privacy-regression");
  process.env.DATABASE_URL = isolated.href;
  process.env.TEZJET_STORAGE_ADAPTER = "postgres";
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET = "queue-privacy-test-secret-not-a-production-credential";
  process.env.LOG_LEVEL = "silent";
  process.env.REQUIRE_DRIVER_APPROVAL = "true";
  process.env.PYATAK_CENTER_LAT = "41.3111";
  process.env.PYATAK_CENTER_LNG = "69.2797";
  directory = await mkdtemp(path.join(apiRoot, ".queue-privacy-test-"));
  const entry = path.join(directory, "production.mjs");
  await build({
    stdin: { contents: [
      'export { default as app } from "./src/app";',
      'export { store } from "./src/store";',
      'export { PostgresStore } from "./src/store/postgresStore";',
      'export { pool } from "../../lib/db/src/index";',
      'export { createAccessToken } from "./src/utils/token";',
      'export { createRealtimeServer } from "./src/socket";',
      'export { emitQueueUpdate } from "./src/utils/realtime";',
      'export { calculateFixedFare } from "./src/utils/fare";',
    ].join("\n"), resolveDir: apiRoot, loader: "ts" },
    outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["pg-native", "pino", "pino-http", "socket.io"],
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
  production = await import(pathToFileURL(entry).href);
  pool = production.pool;
  adminPool = new pool.constructor({ connectionString: originalUrl, max: 3 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  // Same isolated-schema pattern as route-queue.test.mjs: actual migrated
  // columns/indexes/checks, no copying customer rows or changing public data.
  const { rows } = await adminPool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND (tablename LIKE 'tezjet_%' OR tablename = 'otp_rate_limits')");
  assert.ok(rows.some(row => row.tablename === "tezjet_driver_queue"), "migrated queue table required");
  for (const { tablename } of rows) {
    assert.match(tablename, /^[a-z_]+$/);
    await adminPool.query(`CREATE TABLE "${schema}"."${tablename}" (LIKE "public"."${tablename}" INCLUDING ALL)`);
  }
  store = production.store;
  assert.ok(store instanceof production.PostgresStore, "actual app must use PostgreSQL, never MemoryStore");
  await store.initialize();
  server = await new Promise(resolve => {
    const listener = production.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  io = production.createRealtimeServer(server);
  production.app.locals.io = io;
  origin = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 30_000 });

after(async () => {
  try {
    for (const socket of sockets) socket.disconnect();
    if (io) await new Promise(resolve => io.close(resolve));
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (pool) await pool.end();
    if (schemaCreated) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    if (adminPool) await adminPool.end();
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

async function request(actor, pathname = "/queue", method = "GET") {
  const response = await fetch(origin + "/api" + pathname, {
    method, headers: actor ? { authorization: "Bearer " + actor.token } : {},
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function fixture(t) {
  const users = [], routes = [];
  t.after(async () => {
    await pool.query("DELETE FROM tezjet_orders WHERE passenger_id = ANY($1::text[]) OR driver_id = ANY($1::text[]) OR offered_driver_id = ANY($1::text[])", [users]);
    await pool.query("DELETE FROM tezjet_driver_queue WHERE driver_id = ANY($1::text[])", [users]);
    await pool.query("DELETE FROM tezjet_device_registrations WHERE user_id = ANY($1::text[])", [users]);
    await pool.query("DELETE FROM tezjet_users WHERE id = ANY($1::text[])", [users]);
    await pool.query("DELETE FROM tezjet_routes WHERE id = ANY($1::text[])", [routes]);
  });
  async function user(role = "driver") {
    let current = await store.createUser({ role, fullName: "Synthetic queue privacy fixture", phoneNumber: "privacy-" + randomUUID(), locale: "ru" });
    users.push(current.id);
    if (role === "driver") { await store.setDriverApproval(current.id, "approved"); current = await store.getUser(current.id); }
    const token = production.createAccessToken({ sub: current.id, role: current.role, locale: current.locale, sessionVersion: current.sessionVersion, sessionId: randomUUID() });
    return { user: structuredClone(current), token };
  }
  const passenger = await user("passenger"), admin = await user("admin");
  const legacyDriver = await user(), legacyPeer = await user();
  const configuredDriver = await user(), configuredPeer = await user(), reverseDriver = await user();
  const empty = await store.createRoute({ id: "privacy-" + randomUUID(), name: "Synthetic configured lane", active: true, pricePerStopKzt: 500 });
  routes.push(empty.id);
  const route = await store.updateRouteLayout(empty.id, {
    expectedUpdatedAt: empty.updatedAt,
    stops: [
      { code: "A", name: "Synthetic A", location: { lat: 41.32, lng: 69.29 } },
      { code: "C", name: "Synthetic intermediate" },
      { code: "B", name: "Synthetic B", location: { lat: 41.34, lng: 69.31 } },
    ], pitaks: { aStopCode: "A", bStopCode: "B", radiusMeters: 175 },
  });
  async function enroll(actor, configured = false, reverse = false, collection = false) {
    let location = { lat: 41.31111, lng: 69.27971, timestamp: Date.now(), isMocked: false };
    const selection = configured ? { routeId: route.id, direction: reverse ? "b_to_a" : "a_to_b", expectedUpdatedAt: route.updatedAt } : undefined;
    if (selection) {
      await store.setDriverRouteChoice(actor.user.id, selection, actor.user.sessionVersion);
      location = { ...(reverse ? route.stops.at(-1) : route.stops[0]).location, timestamp: Date.now(), isMocked: false };
    }
    await store.joinQueue({ driverId: actor.user.id, joinedAt: Date.now(), status: "searching", availableSeats: 4, lastLocation: location, priorityLock: false, inFifo: true, activeOrderIds: [] }, actor.user.sessionVersion, selection, collection);
  }
  await enroll(legacyDriver); await enroll(legacyPeer);
  await enroll(configuredDriver, true, false, true); await enroll(configuredPeer, true);
  await enroll(reverseDriver, true, true);
  // Genuine production reservation: private pending order ID/lock are not fake
  // DTO properties inserted by a mock. Allocation itself is not changed.
  const fare = await production.calculateFixedFare(["C"]);
  const offer = await store.createOrderWithOffer({
    passengerId: passenger.user.id, passengerPhone: passenger.user.phoneNumber,
    pickupPoint: "C", pickupLocation: { lat: 41.3111, lng: 69.2797, timestamp: Date.now() },
    routeStops: fare.stops, fare, destination: "Synthetic destination", seats: 1, status: "searching",
  }, passenger.user.sessionVersion);
  assert.ok(offer?.id && offer.offeredDriverId, "fixture must create a real durable reserved offer");
  assert.equal((await store.getOrder(offer.id)).id, offer.id);
  const legacy = [legacyDriver.user.id, legacyPeer.user.id];
  const forward = [configuredDriver.user.id, configuredPeer.user.id];
  const reverse = [reverseDriver.user.id];
  return { user, passenger, admin, legacyDriver, configuredDriver, reverseDriver, route, offer,
    visible: kind => kind === "admin" ? [...legacy, ...forward, ...reverse] : kind === "configuredDriver" ? forward : kind === "reverseDriver" ? reverse : legacy };
}

function publicQueue(payload, visible) {
  assert.ok(Array.isArray(payload.queue), "public queue array required");
  assert.deepEqual([...payload.queue.map(row => row.driverId)].sort(), [...visible].sort(), "only the authorized lane's driver IDs may be disclosed");
  for (const row of payload.queue) {
    assert.deepEqual(Object.keys(row).sort(), publicFields, "public queue must omit GPS, order IDs, enrollment IDs and internal locks");
    assert.ok(Number.isSafeInteger(row.position) && row.position >= 1);
    assert.ok(Number.isSafeInteger(row.availableSeats) && row.availableSeats >= 0 && row.availableSeats <= 8);
    assert.equal(typeof row.status, "string");
  }
}

function wait(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, received); reject(new Error("Timed out waiting for " + event)); }, 5_000);
    function received(value) { clearTimeout(timer); socket.off(event, received); resolve(value); }
    socket.on(event, received);
  });
}
function client(t, actor) {
  const socket = createSocket(origin, { path: "/api/socket.io", auth: { token: actor.token }, transports: ["websocket"], autoConnect: false, reconnection: false });
  sockets.add(socket);
  t.after(() => { socket.disconnect(); sockets.delete(socket); });
  return socket;
}
async function connect(socket) {
  const snapshot = wait(socket, "queue:snapshot");
  socket.connect();
  return snapshot;
}
async function fence(socket) {
  if (!socket.connected) return;
  await new Promise((resolve, reject) => {
    const event = "test:queue-privacy-fence:" + randomUUID();
    const cleanup = () => { clearTimeout(timer); socket.off(event, done); socket.off("disconnect", done); };
    const done = () => { cleanup(); resolve(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Socket fence unavailable")); }, 5_000);
    socket.once(event, done); socket.once("disconnect", done);
    io.to(socket.id).emit(event);
  });
}
function pauseRealSnapshot(t) {
  const read = store.queueSnapshot.bind(store);
  let release, entered, first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.mock.method(store, "queueSnapshot", async (...args) => {
    const snapshot = await read(...args);
    if (first) { first = false; entered(); await gate; }
    return snapshot;
  });
  return { started, release };
}
async function revoke(action, actor) {
  if (action === "logout") assert.equal((await request(actor, "/auth/logout", "POST")).status, 204);
  else if (action === "switch-role") await store.activateUserRole(actor.user.id, "passenger", actor.user.sessionVersion);
  else await store.invalidateSessions(actor.user.id, actor.user.sessionVersion);
}

for (const kind of ["passenger", "legacyDriver", "configuredDriver", "reverseDriver", "admin"]) {
  test(`HTTP generic queue projects the authorized ${kind} lane to public fields`, async t => {
    const f = await fixture(t), actor = f[kind];
    const before = await store.getQueue();
    const result = await request(actor);
    assert.equal(result.status, 200);
    publicQueue(result.body, f.visible(kind));
    assert.deepEqual(await store.getQueue(), before, "privacy reads must not mutate FIFO, reservation or available seats");
  });
}

test("own driver enrollment, admin monitoring DTO and authentication remain usable", async t => {
  const f = await fixture(t);
  const own = await request(f.configuredDriver);
  assert.equal(own.status, 200);
  assert.equal(own.body.your_entry.driverId, f.configuredDriver.user.id);
  assert.equal(own.body.your_entry.availableSeats, 4);
  assert.ok(Number.isSafeInteger(own.body.your_entry.joinedAt));
  assert.equal(own.body.your_entry.routeContext.routeId, f.route.id);
  assert.ok(own.body.your_entry.collectionState.enrollmentId);
  assert.equal(own.body.your_position, 1);
  assert.equal((await request(f.passenger)).body.your_entry, null);
  assert.equal((await request()).status, 401);
  const admin = await request(f.admin, "/admin/queue?include_lanes=true");
  assert.equal(admin.status, 200);
  assert.equal(admin.body.total_queued, 5);
  assert.ok(admin.body.queue.some(row => row.lane?.kind === "configured" && row.lane.route_id === f.route.id));
  assert.ok(admin.body.queue.some(row => row.lane?.kind === "legacy"));
  assert.equal((await request(f.passenger, "/admin/queue")).status, 403);
  assert.equal((await request(f.configuredDriver, "/admin/queue")).status, 403);
  await store.invalidateSessions(f.admin.user.id, f.admin.user.sessionVersion);
  assert.equal((await request(f.admin, "/admin/queue")).status, 401);
});

for (const kind of ["passenger", "configuredDriver", "admin"]) {
  test(`Socket initial snapshot projects the current ${kind} lane without raw queue data`, async t => {
    const f = await fixture(t), socket = client(t, f[kind]);
    publicQueue(await connect(socket), f.visible(kind));
  });
}

for (const kind of ["passenger", "configuredDriver", "reverseDriver", "admin"]) {
  test(`Socket queue events disclose only the current ${kind} view and authorized change IDs`, async t => {
    const f = await fixture(t), socket = client(t, f[kind]);
    await connect(socket);
    const received = [];
    socket.onAny((event, payload) => { if (event.startsWith("queue:")) received.push({ event, payload }); });
    await production.emitQueueUpdate(io, { type: "joined", driverId: f.legacyDriver.user.id });
    await fence(socket);
    assert.ok(received.some(item => item.event === "queue:update"), "existing update invalidation must remain available");
    for (const { event, payload } of received) {
      if (event === "queue:position") continue; // separately authenticated self-only channel
      publicQueue(payload, f.visible(kind));
      if (payload.changed_driver_id !== undefined) assert.ok(f.visible(kind).includes(payload.changed_driver_id), "cross-lane changed driver ID must be omitted");
    }
  });
}

for (const action of ["revoke", "logout", "switch-role"]) {
  test(`HTTP queue rejects ${action} committed during its real PostgreSQL snapshot read`, async t => {
    const f = await fixture(t);
    const actor = action === "revoke" ? f.admin : action === "logout" ? f.passenger : await f.user();
    const barrier = pauseRealSnapshot(t);
    const pending = request(actor);
    try { await barrier.started; await revoke(action, actor); }
    finally { barrier.release(); }
    assert.equal((await pending).status, 401, "a revoked snapshot must not return an earlier privileged queue view");
  });
}

for (const action of ["revoke", "logout", "switch-role"]) {
  test(`Socket initial snapshot rejects ${action} committed while the durable read is pending`, async t => {
    const f = await fixture(t);
    const actor = action === "revoke" ? f.admin : action === "logout" ? f.passenger : await f.user();
    const socket = client(t, actor), barrier = pauseRealSnapshot(t);
    const first = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Initial auth outcome unavailable")), 5_000);
      socket.once("queue:snapshot", () => { clearTimeout(timer); resolve("snapshot"); });
      socket.once("disconnect", () => { clearTimeout(timer); resolve("disconnect"); });
    });
    socket.connect();
    try { await barrier.started; await revoke(action, actor); }
    finally { barrier.release(); }
    assert.equal(await first, "disconnect", "initial delivery must not expose the stale role/session snapshot");
  });
}

for (const action of ["revoke", "logout", "switch-role"]) {
  test(`Socket events and own position reject ${action} during the durable broadcast read`, async t => {
    const f = await fixture(t);
    const actor = action === "switch-role" ? await f.user() : f.configuredDriver;
    const socket = client(t, actor);
    await connect(socket);
    const events = [];
    socket.onAny(event => { if (event.startsWith("queue:")) events.push(event); });
    const barrier = pauseRealSnapshot(t);
    const pending = production.emitQueueUpdate(io, { type: "location", driverId: f.legacyDriver.user.id });
    try { await barrier.started; await revoke(action, actor); }
    finally { barrier.release(); }
    await pending;
    await fence(socket);
    assert.deepEqual(events, [], "revoked recipients must receive neither queue payloads nor own-position metadata");
  });
}

async function observingDriver(f) {
  const actor = await f.user();
  await store.setDriverRouteChoice(actor.user.id, {
    routeId: f.route.id, direction: "a_to_b", expectedUpdatedAt: f.route.updatedAt,
  }, actor.user.sessionVersion);
  return actor;
}
async function changeObservedLane(f, actor) {
  await store.setDriverRouteChoice(actor.user.id, {
    routeId: f.route.id, direction: "b_to_a", expectedUpdatedAt: f.route.updatedAt,
  }, actor.user.sessionVersion);
  assert.equal((await store.getUser(actor.user.id)).sessionVersion, actor.user.sessionVersion,
    "a legitimate saved route change keeps the same authenticated session");
}

test("HTTP does not publish an earlier lane after a same-session route choice changes during the read", async t => {
  const f = await fixture(t), actor = await observingDriver(f);
  const barrier = pauseRealSnapshot(t), pending = request(actor);
  try { await barrier.started; await changeObservedLane(f, actor); }
  finally { barrier.release(); }
  const response = await pending;
  assert.equal(response.status, 409, "stale lane authority requires an explicit retry rather than the old lane payload");
  assert.equal(response.body?.error?.code, "ROUTE_CHANGED");
  assert.equal(response.body.queue, undefined);
});

test("initial socket snapshot rejects a same-session lane change while its durable read is pending", async t => {
  const f = await fixture(t), actor = await observingDriver(f);
  const socket = client(t, actor), barrier = pauseRealSnapshot(t);
  const first = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Initial lane outcome unavailable")), 5_000);
    socket.once("queue:snapshot", () => { clearTimeout(timer); resolve("snapshot"); });
    socket.once("disconnect", () => { clearTimeout(timer); resolve("disconnect"); });
  });
  socket.connect();
  try { await barrier.started; await changeObservedLane(f, actor); }
  finally { barrier.release(); }
  assert.equal(await first, "disconnect", "initial queue view must not retain old-lane visibility");
});

test("socket events after a same-session lane change expose only the current lane and remain usable", async t => {
  const f = await fixture(t), actor = await observingDriver(f), socket = client(t, actor);
  await connect(socket);
  const received = [];
  socket.onAny((event, payload) => { if (event.startsWith("queue:")) received.push({ event, payload }); });
  const barrier = pauseRealSnapshot(t);
  const pending = production.emitQueueUpdate(io, { type: "location", driverId: f.legacyDriver.user.id });
  try { await barrier.started; await changeObservedLane(f, actor); }
  finally { barrier.release(); }
  await pending;
  await fence(socket);
  // The recipient may be resolved after the shared read (current lane data is
  // safe), or a stale per-recipient read may be rejected. Neither may disclose
  // the earlier lane. Do not require a particular notification implementation.
  for (const { event, payload } of received) {
    if (event !== "queue:position") publicQueue(payload, f.visible("reverseDriver"));
  }
  assert.equal(socket.connected, true, "a retryable view change must not revoke this valid session");
  received.length = 0;
  await production.emitQueueUpdate(io, { type: "location", driverId: f.legacyDriver.user.id });
  await fence(socket);
  const current = received.find(item => item.event === "queue:update");
  assert.ok(current, "next notification must recover without reconnecting");
  publicQueue(current.payload, f.visible("reverseDriver"));
  assert.equal(current.payload.changed_driver_id, undefined);
});
