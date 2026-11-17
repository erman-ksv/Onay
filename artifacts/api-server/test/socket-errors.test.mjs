import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { io as createSocket } from "socket.io-client";
import jwt from "jsonwebtoken";

// Promise rejection handling belongs to the Socket.IO boundary, independent
// of a database connection. Use the real server with an isolated MemoryStore
// and make its actual lookup methods reject as the PostgreSQL adapter can.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envKeys = ["NODE_ENV", "TEZJET_STORAGE_ADAPTER", "SESSION_SECRET", "LOG_LEVEL", "REQUIRE_DRIVER_APPROVAL"];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const sockets = new Set();
let moduleDirectory;
let store;
let createAccessToken;
let switchRole;
let logout;
let verifyOtp;
let authenticate;
let httpServer;
let realtime;
let serverUrl;

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.TEZJET_STORAGE_ADAPTER = "memory";
  process.env.SESSION_SECRET = "socket-error-regression-session-secret";
  process.env.LOG_LEVEL = "silent";
  process.env.REQUIRE_DRIVER_APPROVAL = "true";
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".socket-error-test-"));
  const entry = path.join(moduleDirectory, "production.mjs");
  await build({
    stdin: {
      contents: [
        'export { createRealtimeServer } from "./src/socket";',
        'export { store } from "./src/store";',
        'export { MemoryStore } from "./src/store/memoryStore";',
        'export { authenticate } from "./src/middleware/auth";',
        'export { createAccessToken } from "./src/utils/token";',
        'export { switchRole, logout, verifyOtp } from "./src/controllers/authController";',
      ].join("\n"),
      resolveDir: apiRoot, loader: "ts",
    },
    outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["pg-native", "pino", "socket.io"],
    banner: { js: 'import { createRequire as testCreateRequire } from "node:module"; const require = testCreateRequire(import.meta.url);' },
  });
  const production = await import(pathToFileURL(entry).href);
  store = production.store;
  createAccessToken = production.createAccessToken;
  switchRole = production.switchRole;
  logout = production.logout;
  verifyOtp = production.verifyOtp;
  authenticate = production.authenticate;
  assert.ok(store instanceof production.MemoryStore, "Socket rejection regressions must be independent of PostgreSQL.");
  await store.initialize();
  httpServer = createServer((_request, response) => response.end("healthy"));
  realtime = production.createRealtimeServer(httpServer);
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  serverUrl = `http://127.0.0.1:${httpServer.address().port}`;
}, { timeout: 30_000 });

after(async () => {
  try {
    for (const socket of sockets) socket.disconnect();
    if (realtime) await new Promise(resolve => realtime.close(resolve));
  } finally {
    if (moduleDirectory) await rm(moduleDirectory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function waitForEvent(socket, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for Socket.IO event "${event}"`));
    }, 5_000);
    function onEvent(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timeout);
      socket.off(event, onEvent);
      resolve(payload);
    }
    socket.on(event, onEvent);
  });
}

async function client(t, role = "passenger", expiresIn) {
  const user = await store.createUser({
    role, fullName: "Socket regression user", phoneNumber: randomUUID(), locale: "ru",
  });
  if (role === "driver") await store.setDriverApproval(user.id, "approved");
  const claims = {
    sub: user.id, role: user.role, locale: user.locale,
    sessionVersion: user.sessionVersion, sessionId: randomUUID(),
  };
  const token = expiresIn === undefined ? createAccessToken(claims)
    : jwt.sign(claims, process.env.SESSION_SECRET, { expiresIn });
  const socket = createSocket(serverUrl, {
    path: "/api/socket.io", auth: { token }, transports: ["websocket"],
    autoConnect: false, reconnection: false,
  });
  sockets.add(socket);
  t.after(() => {
    socket.disconnect();
    sockets.delete(socket);
  });
  return { socket, user };
}

async function assignedRide(passenger, driver, status = "en_route_to_c") {
  const stops = [
    { id: "socket-c", code: "C", name: "C", sequence: 1, position: 1 },
    { id: "socket-d", code: "D", name: "D", sequence: 2, position: 2 },
  ];
  return store.createOrder({ passengerId: passenger.id, passengerPhone: passenger.phoneNumber,
    driverId: driver.id, pickupPoint: "C", pickupLocation: { lat: 41.3111, lng: 69.2797, timestamp: 1 },
    routeStops: stops, fare: { currency: "KZT", routeId: "pyatak", pickupStop: stops[0], destinationStop: stops[1],
      pickupPosition: 1, destinationPosition: 2, distanceStops: 1, pricePerStopKzt: 500,
      minimumFareApplied: false, stops, totalKzt: 500, calculatedAt: new Date(0).toISOString() },
    destination: "D", seats: 1, status });
}

async function connect(socket) {
  const snapshot = waitForEvent(socket, "queue:snapshot");
  socket.connect();
  await snapshot;
}

test("Socket authentication lookup rejection returns connect_error and permits recovery", { timeout: 15_000 }, async t => {
  const { socket } = await client(t);
  t.mock.method(store, "getUser", async () => { throw new Error("private database error"); });
  const errorReceived = waitForEvent(socket, "connect_error");
  socket.connect();
  const error = await errorReceived;
  assert.equal(error.message, "Authentication unavailable");
  assert.equal(socket.connected, false);
  assert.equal((await fetch(serverUrl)).status, 200);
  t.mock.restoreAll();
  await connect(socket);
  assert.equal(socket.connected, true);
});

for (const method of ["queueSnapshot", "getQueuePosition"]) {
  test(`Socket initialization ${method} rejection disconnects and permits recovery`, { timeout: 15_000 }, async t => {
    const { socket } = await client(t);
    const snapshots = [];
    socket.on("queue:snapshot", snapshot => snapshots.push(snapshot));
    t.mock.method(store, method, async () => { throw new Error("private database error"); });
    const disconnected = waitForEvent(socket, "disconnect");
    socket.connect();
    assert.equal(await disconnected, "io server disconnect");
    assert.equal(socket.connected, false);
    assert.deepEqual(snapshots, []);
    assert.equal((await fetch(serverUrl)).status, 200);
    t.mock.restoreAll();
    await connect(socket);
    assert.equal(snapshots.length, 1);
  });
}

test("Socket driver lookup rejection drops its location and later valid locations still broadcast", { timeout: 15_000 }, async t => {
  const { socket: observer, user: passenger } = await client(t);
  const { socket: driver, user } = await client(t, "driver");
  await assignedRide(passenger, user);
  await Promise.all([connect(observer), connect(driver)]);
  const locations = [];
  observer.on("driver:location", payload => locations.push(payload));
  const getUser = store.getUser.bind(store);
  let failedLookup;
  const rejectedLookup = new Promise(resolve => { failedLookup = resolve; });
  let failNextLookup = true;
  t.mock.method(store, "getUser", async userId => {
    if (userId === user.id && failNextLookup) {
      failNextLookup = false;
      failedLookup();
      throw new Error("private database error");
    }
    return getUser(userId);
  });
  driver.emit("driver:location", { lat: 1, lng: 1, timestamp: 1 });
  await rejectedLookup;
  const validLocation = { lat: 41.3111, lng: 69.2797, timestamp: 2 };
  const broadcast = waitForEvent(observer, "driver:location", payload => payload.location.timestamp === 2);
  driver.emit("driver:location", validLocation);
  await broadcast;
  assert.deepEqual(locations, [{ driver_id: user.id, location: validLocation }]);
  assert.equal(driver.connected, true);
  assert.equal((await fetch(serverUrl)).status, 200);
});

test("Socket drops malformed driver telemetry, strips untrusted fields, and keeps valid delivery working", { timeout: 15_000 }, async t => {
  const { socket: observer, user: passenger } = await client(t);
  const { socket: driver, user } = await client(t, "driver");
  await assignedRide(passenger, user);
  await Promise.all([connect(observer), connect(driver)]);
  const locations = [];
  observer.on("driver:location", payload => locations.push(payload));
  for (const location of [null, [], "point", {}, { lat: "41", lng: 69 },
    { lat: 91, lng: 0 }, { lat: 0, lng: -181 }, { lat: 0, lng: 0, timestamp: "123" },
    { lat: 0, lng: 0, timestamp: 0 }, { lat: 0, lng: 0, isMocked: "false" }]) {
    driver.emit("driver:location", location);
  }
  const valid = { lat: 41.3111, lng: 69.2797, timestamp: 314159 };
  const delivered = waitForEvent(observer, "driver:location", payload => payload.location?.timestamp === valid.timestamp);
  driver.emit("driver:location", { ...valid, private_note: "must not be relayed", driver_id: "spoof" });
  await delivered;
  assert.deepEqual(locations, [{ driver_id: user.id, location: valid }]);
  assert.equal(driver.connected, true);
  assert.equal((await fetch(serverUrl)).status, 200);
});

test("Socket drops driver telemetry when a blocked account read resumes after session revocation", { timeout: 15_000 }, async t => {
  const { socket: observer } = await client(t);
  const { socket: driver, user } = await client(t, "driver");
  await Promise.all([connect(observer), connect(driver)]);
  const locations = [];
  observer.on("driver:location", payload => locations.push(payload));
  const getUser = store.getUser.bind(store);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { started = resolve; });
  t.mock.method(store, "getUser", async id => {
    if (id === user.id) { started(); await gate; }
    return getUser(id);
  });
  const disconnected = waitForEvent(driver, "disconnect");
  driver.emit("driver:location", { lat: 41.3111, lng: 69.2797, timestamp: 1 });
  try {
    await pending;
    await store.invalidateSessions(user.id);
  } finally { release(); }
  assert.equal(await disconnected, "io server disconnect");
  assert.deepEqual(locations, []);
  assert.equal(observer.connected, true);
});

test("Driver telemetry authorization lookup failure drops one event and permits recovery", { timeout: 15_000 }, async t => {
  const { socket: observer, user: passenger } = await client(t);
  const { socket: driver, user } = await client(t, "driver");
  await assignedRide(passenger, user);
  await Promise.all([connect(observer), connect(driver)]);
  const locations = [];
  observer.on("driver:location", payload => locations.push(payload));
  const authorize = store.canReceiveDriverLocation.bind(store);
  let failed, failNext = true;
  const rejected = new Promise(resolve => { failed = resolve; });
  t.mock.method(store, "canReceiveDriverLocation", async (...args) => {
    if (failNext) { failNext = false; failed(); throw new Error("private database error"); }
    return authorize(...args);
  });
  driver.emit("driver:location", { lat: 41.3111, lng: 69.2797, timestamp: 1 });
  await rejected;
  const location = { lat: 41.3111, lng: 69.2797, timestamp: 2 };
  const delivered = waitForEvent(observer, "driver:location", payload => payload.location.timestamp === 2);
  driver.emit("driver:location", location);
  await delivered;
  assert.deepEqual(locations, [{ driver_id: user.id, location }]);
  assert.equal(driver.connected, true);
});

async function fence(socket) {
  const delivered = waitForEvent(socket, "test:telemetry-fence");
  realtime.to(socket.id).emit("test:telemetry-fence", {});
  await delivered;
}

test("Driver telemetry reaches only its active assigned passengers, once per passenger", { timeout: 15_000 }, async t => {
  const { socket: driver, user: driverUser } = await client(t, "driver");
  const allowed = [], denied = [];
  for (const status of ["en_route_to_c", "arrived_at_c", "boarded_waiting", "in_transit", "searching", "completed", "cancelled", "offered", "unrelated"]) {
    const recipient = await client(t);
    const events = [];
    recipient.socket.on("driver:location", payload => events.push(payload));
    if (status !== "unrelated") {
      const order = await assignedRide(recipient.user, driverUser, status === "offered" ? "searching" : status);
      if (status === "offered") await store.updateOrder(order.id, { driverId: undefined, offeredDriverId: driverUser.id, offerExpiresAt: Date.now() + 60_000 });
    }
    await connect(recipient.socket);
    (status === "en_route_to_c" || status === "arrived_at_c" || status === "boarded_waiting" || status === "in_transit" ? allowed : denied).push({ ...recipient, events });
  }
  // Two matching rides still yield one driver position, not duplicate events.
  await assignedRide(allowed[0].user, driverUser, "in_transit");
  for (const role of ["driver", "admin"]) {
    const recipient = await client(t, role);
    const events = [];
    recipient.socket.on("driver:location", payload => events.push(payload));
    await connect(recipient.socket);
    denied.push({ ...recipient, events });
  }
  await connect(driver);
  const location = { lat: 41.3111, lng: 69.2797, timestamp: 987654 };
  const received = Promise.all(allowed.map(({ socket }) => waitForEvent(socket, "driver:location", payload => payload.location.timestamp === location.timestamp)));
  driver.emit("driver:location", location);
  await received;
  for (const { socket, events } of allowed) { await fence(socket); assert.deepEqual(events, [{ driver_id: driverUser.id, location }]); }
  for (const { socket, events } of denied) { await fence(socket); assert.deepEqual(events, []); }
});

for (const action of ["cancel", "reassign", "revoke-passenger", "revoke-driver", "revoke-approval"]) {
  test(`Driver telemetry rechecks ${action} after a delayed recipient socket snapshot`, { timeout: 15_000 }, async t => {
    const { socket: observer, user: passenger } = await client(t);
    const { socket: driver, user: driverUser } = await client(t, "driver");
    const order = await assignedRide(passenger, driverUser);
    await Promise.all([connect(observer), connect(driver)]);
    const locations = [];
    observer.on("driver:location", payload => locations.push(payload));
    const getUser = store.getUser.bind(store);
    let release, started, finished;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { started = resolve; });
    const resumed = new Promise(resolve => { finished = resolve; });
    // Detached snapshots model SQL reads rather than MemoryStore's live objects.
    t.mock.method(store, "getUser", async id => structuredClone(await getUser(id)));
    const inRoom = realtime.in.bind(realtime);
    t.mock.method(realtime, "in", room => {
      const operator = inRoom(room);
      if (room !== `user:${passenger.id}`) return operator;
      const fetchSockets = operator.fetchSockets.bind(operator);
      operator.fetchSockets = async () => {
        const value = await fetchSockets();
        started();
        await gate;
        finished();
        return value;
      };
      return operator;
    });
    driver.emit("driver:location", { lat: 41.3111, lng: 69.2797, timestamp: 456 });
    try {
      await pending;
      if (action === "cancel") await store.updateOrder(order.id, { status: "cancelled" });
      if (action === "reassign") {
        const other = await store.createUser({ role: "driver", fullName: "Other driver", phoneNumber: randomUUID(), locale: "ru" });
        await store.updateOrder(order.id, { driverId: other.id });
      }
      if (action === "revoke-passenger") await store.invalidateSessions(passenger.id);
      if (action === "revoke-driver") await store.invalidateSessions(driverUser.id);
      if (action === "revoke-approval") await store.setDriverApproval(driverUser.id, "rejected");
    } finally { release(); }
    await resumed;
    await new Promise(resolve => setImmediate(resolve));
    await fence(observer);
    assert.deepEqual(locations, []);
  });
}

for (const action of ["invalidate", "switch", "logout"]) {
  test(`Socket ${action} revokes the previous driver's location access`, { timeout: 15_000 }, async t => {
    const { socket: observer } = await client(t);
    const { socket: driver, user } = await client(t, "driver");
    await Promise.all([connect(observer), connect(driver)]);
    const locations = [];
    observer.on("driver:location", payload => locations.push(payload));
    const disconnected = waitForEvent(driver, "disconnect");
    if (action === "invalidate") {
      await store.invalidateSessions(user.id);
      driver.emit("driver:location", { lat: 41.3111, lng: 69.2797, timestamp: Date.now() });
    } else {
      const request = {
        body: { role: "passenger" },
        auth: { userId: user.id, role: user.role, user: await store.getUser(user.id), locale: "ru" },
        app: { locals: { io: realtime } },
      };
      const response = { json() {}, status() { return this; }, send() {} };
      await (action === "switch" ? switchRole(request, response) : logout(request, response));
    }
    assert.equal(await disconnected, "io server disconnect");
    assert.equal(driver.connected, false);
    assert.deepEqual(locations, []);
    assert.equal(observer.connected, true);
    assert.equal((await fetch(serverUrl)).status, 200);
  });
}

for (const role of ["passenger", "driver"]) {
  test(`Socket ${role} expires without client traffic and rejects the old token on reconnect`, { timeout: 15_000 }, async t => {
    const { socket } = await client(t, role, 3);
    const { socket: observer } = await client(t);
    await Promise.all([connect(socket), connect(observer)]);
    const disconnected = waitForEvent(socket, "disconnect");
    assert.equal(await disconnected, "io server disconnect");
    assert.equal(socket.connected, false);
    assert.equal(observer.connected, true);
    const rejected = waitForEvent(socket, "connect_error");
    socket.connect();
    assert.equal((await rejected).message, "Unauthorized");
    assert.equal(socket.connected, false);
    const { socket: renewed } = await client(t, role);
    await connect(renewed);
    assert.equal(renewed.connected, true);
  });
}

test("Socket rejects an already expired JWT at handshake", async t => {
  const { socket } = await client(t, "passenger", -1);
  const rejected = waitForEvent(socket, "connect_error");
  socket.connect();
  assert.equal((await rejected).message, "Unauthorized");
  assert.equal(socket.connected, false);
});

test("Socket expiry drops a driver location whose account lookup finishes after expiry", { timeout: 15_000 }, async t => {
  const { socket: observer, user: passenger } = await client(t);
  const { socket: driver, user } = await client(t, "driver", 3);
  await Promise.all([connect(observer), connect(driver)]);
  const locations = [];
  observer.on("driver:location", payload => locations.push(payload));
  const getUser = store.getUser.bind(store);
  let releaseLookup, lookupStarted;
  const blocked = new Promise(resolve => { releaseLookup = resolve; });
  const started = new Promise(resolve => { lookupStarted = resolve; });
  let lookupFinished;
  const finished = new Promise(resolve => { lookupFinished = resolve; });
  t.mock.method(store, "getUser", async id => {
    if (id === user.id) {
      lookupStarted();
      await blocked;
      const value = await getUser(id);
      lookupFinished();
      return value;
    }
    return getUser(id);
  });
  const disconnected = waitForEvent(driver, "disconnect");
  driver.emit("driver:location", { lat: 41.3111, lng: 69.2797, timestamp: Date.now() });
  try {
    await started;
    assert.equal(await disconnected, "io server disconnect");
  } finally {
    releaseLookup();
  }
  await finished;
  // A subsequent valid broadcast fences the observer's event stream.
  const { socket: validDriver, user: validUser } = await client(t, "driver");
  await assignedRide(passenger, validUser);
  await connect(validDriver);
  const delivered = waitForEvent(observer, "driver:location", payload => payload.location.timestamp === 42);
  validDriver.emit("driver:location", { lat: 41.3111, lng: 69.2797, timestamp: 42 });
  await delivered;
  assert.equal(locations.length, 1);
  assert.equal(locations[0].location.timestamp, 42);
});

test("Logout socket cleanup delayed across a newer login disconnects only the revoked session", { timeout: 15_000 }, async t => {
  const { socket: oldSocket, user } = await client(t);
  await connect(oldSocket);
  let releaseCleanup, cleanupStarted;
  const gate = new Promise(resolve => { releaseCleanup = resolve; });
  const started = new Promise(resolve => { cleanupStarted = resolve; });
  const request = {
    auth: { userId: user.id, role: user.role, user: structuredClone(user), locale: "ru" },
    app: { locals: { io: { in(room) {
      return { async fetchSockets() {
        cleanupStarted();
        await gate;
        return realtime.in(room).fetchSockets();
      } };
    } } } },
  };
  const response = { status(value) { this.statusCode = value; return this; }, send() {} };
  const pending = logout(request, response);
  let renewed;
  try {
    await started;
    const current = await store.invalidateSessions(user.id);
    const token = createAccessToken({
      sub: current.id, role: current.role, locale: current.locale,
      sessionVersion: current.sessionVersion, sessionId: randomUUID(),
    });
    renewed = createSocket(serverUrl, {
      path: "/api/socket.io", auth: { token }, transports: ["websocket"],
      autoConnect: false, reconnection: false,
    });
    sockets.add(renewed);
    t.after(() => { renewed.disconnect(); sockets.delete(renewed); });
    await connect(renewed);
    const disconnected = waitForEvent(oldSocket, "disconnect");
    releaseCleanup();
    await pending;
    assert.equal(await disconnected, "io server disconnect");
    assert.equal(response.statusCode, 204);
    assert.equal(renewed.connected, true);
    const delivered = waitForEvent(renewed, "test:session");
    realtime.to(`user:${user.id}`).emit("test:session", { current: true });
    assert.deepEqual(await delivered, { current: true });
    assert.equal((await store.getUser(user.id)).sessionVersion, current.sessionVersion);
  } finally {
    releaseCleanup();
    await pending;
  }
});

for (const action of ["login", "switch-role"]) {
  test(`Delayed ${action} completion preserves the newer OTP login's socket and JWT`, { timeout: 15_000 }, async t => {
    const user = await store.createUser({
      role: "passenger", fullName: "Concurrent session regression",
      phoneNumber: action === "login" ? "+998901234561" : "+998901234562", locale: "ru",
    });
    function socketFor(token) {
      const socket = createSocket(serverUrl, {
        path: "/api/socket.io", auth: { token }, transports: ["websocket"],
        autoConnect: false, reconnection: false,
      });
      sockets.add(socket);
      t.after(() => { socket.disconnect(); sockets.delete(socket); });
      return socket;
    }
    const oldSocket = socketFor(createAccessToken({
      sub: user.id, role: user.role, locale: user.locale,
      sessionVersion: user.sessionVersion, sessionId: randomUUID(),
    }));
    await connect(oldSocket);
    let releaseRotation, rotationStarted;
    const gate = new Promise(resolve => { releaseRotation = resolve; });
    const started = new Promise(resolve => { rotationStarted = resolve; });
    const method = action === "login" ? "invalidateSessions" : "activateUserRole";
    const rotate = store[method].bind(store);
    let first = true;
    t.mock.method(store, method, async (...args) => {
      const rotated = await rotate(...args);
      if (first) {
        first = false;
        rotationStarted();
        // Model a durable commit whose result is delayed before controller cleanup.
        await gate;
      }
      return rotated;
    });
    const app = { locals: { io: realtime } };
    const response = () => ({ json(body) { this.body = body; } });
    async function otpRequest(code) {
      await store.saveOtp({
        phoneNumber: user.phoneNumber, code, role: "passenger",
        locale: "ru", expiresAt: Date.now() + 60_000,
      });
      return { body: { phone_number: user.phoneNumber, code }, app };
    }
    const previousResponse = response();
    const firstRequest = action === "login" ? await otpRequest("123456") : {
      body: { role: "driver" }, app,
      auth: { userId: user.id, role: user.role, locale: "ru", user: structuredClone(user) },
    };
    const pending = (action === "login" ? verifyOtp : switchRole)(firstRequest, previousResponse);
    try {
      await started;
      const disconnected = waitForEvent(oldSocket, "disconnect");
      const latestResponse = response();
      await verifyOtp(await otpRequest("654321"), latestResponse);
      assert.equal(await disconnected, "io server disconnect", "Superseded sockets must still be revoked");
      const current = await store.getUser(user.id);
      const latestSocket = socketFor(latestResponse.body.access_token);
      await connect(latestSocket);
      releaseRotation();
      await pending;
      // Successful delivery after the earlier controller completes proves survival.
      const delivered = waitForEvent(latestSocket, "test:latest-session");
      realtime.to(`user:${user.id}`).emit("test:latest-session", { current: true });
      assert.deepEqual(await delivered, { current: true });
      assert.equal(latestSocket.connected, true);
      const authRequest = token => ({ header: () => `Bearer ${token}` });
      await assert.rejects(() => authenticate(authRequest(previousResponse.body.access_token), {}, () => {}),
        error => error.statusCode === 401 && error.code === "UNAUTHORIZED");
      const currentRequest = authRequest(latestResponse.body.access_token);
      let passed = false;
      await authenticate(currentRequest, {}, () => { passed = true; });
      assert.equal(passed, true);
      assert.equal(currentRequest.auth.userId, user.id);
      assert.equal((await store.getUser(user.id)).sessionVersion, current.sessionVersion);
      assert.equal(current.sessionVersion, user.sessionVersion + 2);
      assert.equal(current.fullName, user.fullName);
    } finally {
      releaseRotation();
      await pending;
    }
  });
}
