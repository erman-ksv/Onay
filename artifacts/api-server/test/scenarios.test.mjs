import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { io } from "socket.io-client";

const port = 41_000 + (process.pid % 1_000);
const baseUrl = `http://127.0.0.1:${port}/api`;
const socketUrl = `http://127.0.0.1:${port}`;
const schema = `api_scenarios_${randomUUID().replaceAll("-", "")}`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes"];
const { Pool } = createRequire(new URL("../../../lib/db/package.json", import.meta.url))("pg");
const queueLocation = {
  lat: 41.3111,
  lng: 69.2797,
  timestamp: Date.now(),
};

let serverProcess;
let adminPool;
let isolatedDatabaseUrl;
let schemaCreated = false;
const sockets = [];

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    method: options.method ?? "GET",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { response, body };
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const { response } = await request("/healthz");
      if (response.ok) {
        return;
      }
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("API server did not become healthy");
}

function waitForSocketEvent(socket, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for Socket.io event "${event}"`));
    }, 5_000);

    function onEvent(payload) {
      if (!predicate(payload)) {
        return;
      }
      clearTimeout(timeout);
      socket.off(event, onEvent);
      resolve(payload);
    }

    socket.on(event, onEvent);
  });
}

async function connectSocket(token, prepare = () => {}) {
  const socket = io(socketUrl, {
    auth: { token },
    path: "/api/socket.io",
    transports: ["websocket"],
    autoConnect: false,
    reconnection: false,
  });
  sockets.push(socket);
  prepare(socket);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Socket.io connection timed out")), 5_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.connect();
  });
  return socket;
}

async function ageFixtureResendIntervals() {
  // Only this suite's private schema is changed. This models returning after
  // cooldown while preserving the actual request budget and failure blocks.
  await adminPool.query(`UPDATE "${schema}".otp_rate_limits SET state = jsonb_set(state, '{nextAllowedAt}', '0'::jsonb) WHERE state ? 'nextAllowedAt'`);
}

async function registerUser(phoneNumber, role, fullName) {
  await ageFixtureResendIntervals();
  const otpRequest = await request("/auth/request-otp", {
    method: "POST",
    body: {
      phone_number: phoneNumber,
      full_name: fullName,
      role,
      locale: "ru",
    },
  });
  assert.equal(otpRequest.response.status, 202);
  assert.match(otpRequest.body.demo_code, /^\d{6}$/);

  const verification = await request("/auth/verify-otp", {
    method: "POST",
    body: {
      phone_number: phoneNumber,
      code: otpRequest.body.demo_code,
    },
  });
  assert.equal(verification.response.status, 200);
  assert.equal(verification.body.user.role, role);
  return verification.body.access_token;
}

async function loginUser(phoneNumber) {
  await ageFixtureResendIntervals();
  const otpRequest = await request("/auth/request-otp", {
    method: "POST",
    body: { phone_number: phoneNumber, role: "passenger", locale: "ru" },
  });
  assert.equal(otpRequest.response.status, 202);
  const login = await request("/auth/login", {
    method: "POST",
    body: { phone_number: phoneNumber, code: otpRequest.body.demo_code },
  });
  assert.equal(login.response.status, 200);
  return login.body.access_token;
}

async function createOrder(token, pickupPoint, seats = 1) {
  const pickupLocation = {
    ...queueLocation,
    timestamp: Date.now(),
  };
  const result = await request("/orders", {
    method: "POST",
    token,
    body: {
      pickup_point: pickupPoint,
      pickup_location: pickupLocation,
      route_stops: ["C", "D"],
      destination: `${pickupPoint} test destination`,
      seats,
    },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.order;
}

function startApiServer(overrides = {}) {
  return spawn(process.execPath, ["--enable-source-maps", "./dist/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: isolatedDatabaseUrl,
      TEZJET_STORAGE_ADAPTER: "postgres",
      TEZJET_OFFER_TIMEOUT_SECONDS: "60",
      NODE_ENV: "test",
      PORT: String(port),
      SESSION_SECRET: "tezjet-test-session-secret",
      ADMIN_PHONE: "+77771000099",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function stopApiServer() {
  if (!serverProcess || serverProcess.exitCode !== null || serverProcess.signalCode !== null) return;
  await new Promise(resolve => {
    serverProcess.once("exit", resolve);
    serverProcess.kill("SIGTERM");
  });
}

async function resetOwnedState(passengerToken, driverTokens) {
  const existing = await request("/orders", { token: passengerToken });
  assert.equal(existing.response.status, 200);
  for (const order of existing.body.orders) {
    if (["completed", "cancelled"].includes(order.status)) continue;
    const cancellation = await request(`/orders/${order.id}/cancel`, { method: "POST", token: passengerToken });
    assert.equal(cancellation.response.status, 200, JSON.stringify(cancellation.body));
  }
  for (const token of driverTokens) {
    const leave = await request("/queue/leave", { method: "DELETE", token });
    assert.equal(leave.response.status, 204, JSON.stringify(leave.body));
  }
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, "HTTP scenarios require real PostgreSQL, including restart and pending-offer recovery.");
  adminPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  for (const table of tables) {
    await adminPool.query(`CREATE TABLE "${schema}"."${table}" (LIKE "public"."${table}" INCLUDING ALL)`);
  }
  const isolatedUrl = new URL(process.env.DATABASE_URL);
  isolatedUrl.searchParams.set("options", `${isolatedUrl.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
  isolatedDatabaseUrl = isolatedUrl.href;
  serverProcess = startApiServer();
  await waitForServer();
});

after(async () => {
  for (const socket of sockets) {
    socket.disconnect();
  }
  await stopApiServer();
  if (schemaCreated && adminPool) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  if (adminPool) await adminPool.end();
});

test("covers OTP auth, FIFO offers, Point C locks, Point D pooling, and realtime recovery", async t => {
  const passengerPhone = "+7 777 100 00 01";
  const passengerToken = await registerUser(passengerPhone, "passenger", "Test Passenger");
  const passengerLoginToken = await loginUser(passengerPhone);

  const staleMe = await request("/auth/me", { token: passengerToken });
  assert.equal(staleMe.response.status, 401, "a new login must invalidate the old token");
  const currentMe = await request("/auth/me", { token: passengerLoginToken });
  assert.equal(currentMe.response.status, 200);
  assert.equal(currentMe.body.user.phone_number, "+77771000001");

  const adminToken = await registerUser("+7 777 100 00 99", "admin", "Test Admin");
  const driverOneToken = await registerUser("+7 777 100 00 02", "driver", "Driver One");
  const driverTwoToken = await registerUser("+7 777 100 00 03", "driver", "Driver Two");

  // Repeated runs clean up only this passenger's unfinished orders and these
  // drivers' queue records through the real API, preserving durable users.
  for (const driverToken of [driverOneToken, driverTwoToken]) {
    const me = await request("/auth/me", { token: driverToken });
    await request(`/admin/drivers/${me.body.user.id}/approval`, { method: "PATCH", token: adminToken, body: { status: "approved" } });
  }
  await resetOwnedState(passengerLoginToken, [driverOneToken, driverTwoToken]);
  t.after(() => resetOwnedState(passengerLoginToken, [driverOneToken, driverTwoToken]));
  const driverOneMe = await request("/auth/me", { token: driverOneToken });
  await request(`/admin/drivers/${driverOneMe.body.user.id}/approval`, { method: "PATCH", token: adminToken, body: { status: "pending" } });
  const blockedBeforeApproval = await request("/queue/join", {
    method: "POST",
    token: driverOneToken,
    body: { location: queueLocation, available_seats: 3 },
  });
  assert.equal(blockedBeforeApproval.response.status, 403);
  assert.equal(blockedBeforeApproval.body.error.code, "DRIVER_APPROVAL_REQUIRED");

  for (const driverToken of [driverOneToken, driverTwoToken]) {
    const me = await request("/auth/me", { token: driverToken });
    const approval = await request(`/admin/drivers/${me.body.user.id}/approval`, {
      method: "PATCH",
      token: adminToken,
      body: { status: "approved" },
    });
    assert.equal(approval.response.status, 200);
    assert.equal(approval.body.driver.driver_approval_status, "approved");
  }

  const driverOneSocket = await connectSocket(driverOneToken);
  const driverTwoSocket = await connectSocket(driverTwoToken);
  const passengerSocket = await connectSocket(passengerLoginToken);

  const unavailable = await request("/orders/availability?pickup_point=C&seats=2", { token: passengerLoginToken });
  assert.equal(unavailable.response.status, 200);
  assert.equal(unavailable.body.available, false);
  assert.equal(unavailable.body.eligible_driver_count, 0);
  const beforeUnavailableCreate = await request("/orders", { token: passengerLoginToken });
  const cannotCreate = await request("/orders", {
    method: "POST", token: passengerLoginToken,
    body: { pickup_point: "C", pickup_location: queueLocation, route_stops: ["C", "D"], destination: "Unavailable destination", seats: 2 },
  });
  assert.equal(cannotCreate.response.status, 409);
  assert.equal(cannotCreate.body.error.code, "NO_DRIVERS");
  const afterUnavailableCreate = await request("/orders", { token: passengerLoginToken });
  assert.deepEqual(afterUnavailableCreate.body.orders, beforeUnavailableCreate.body.orders);

  const driverOneJoinEvent = waitForSocketEvent(
    driverOneSocket,
    "queue:joined",
    (payload) => payload.changed_driver_id,
  );
  const firstJoin = await request("/queue/join", {
    method: "POST",
    token: driverOneToken,
    body: { location: queueLocation, available_seats: 3 },
  });
  assert.equal(firstJoin.response.status, 201);
  assert.equal(firstJoin.body.position, 1);
  assert.equal((await driverOneJoinEvent).event, "joined");

  const secondJoin = await request("/queue/join", {
    method: "POST",
    token: driverTwoToken,
    body: { location: queueLocation, available_seats: 3 },
  });
  assert.equal(secondJoin.response.status, 201);
  assert.equal(secondJoin.body.position, 2);
  const available = await request("/orders/availability?pickup_point=C&seats=2", { token: passengerLoginToken });
  assert.equal(available.body.available, true);
  assert.equal(available.body.eligible_driver_count, 2);

  const declinedOrder = await createOrder(passengerLoginToken, "C", 1);
  assert.equal(declinedOrder.offered_driver_id, firstJoin.body.entry.driverId);
  const withdrawn = waitForSocketEvent(driverOneSocket, "order:offer_withdrawn", payload => payload.order_id === declinedOrder.id);
  const nextIncoming = waitForSocketEvent(driverTwoSocket, "incoming_order", payload => payload.order?.id === declinedOrder.id);
  const passengerReoffered = waitForSocketEvent(passengerSocket, "order:status", payload => payload.order?.id === declinedOrder.id && payload.order?.offered_driver_id === secondJoin.body.entry.driverId);
  const rejected = await request(`/orders/${declinedOrder.id}/reject`, { method: "POST", token: driverOneToken });
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.body.order.offered_driver_id, secondJoin.body.entry.driverId);
  assert.equal((await withdrawn).order_id, declinedOrder.id);
  assert.equal((await nextIncoming).order.id, declinedOrder.id);
  assert.equal((await passengerReoffered).order.offered_driver_id, secondJoin.body.entry.driverId);
  for (const action of ["accept", "reject"]) {
    const stale = await request(`/orders/${declinedOrder.id}/${action}`, { method: "POST", token: driverOneToken });
    assert.equal(stale.response.status, 409, "The previous recipient cannot act on the next driver's offer.");
  }
  const afterRejectQueue = await request("/queue", { token: driverOneToken });
  const releasedDriver = afterRejectQueue.body.queue.find(entry => entry.driverId === firstJoin.body.entry.driverId);
  assert.equal(releasedDriver.availableSeats, 3);
  assert.equal(releasedDriver.pendingOfferOrderId, undefined);
  const declinedCancelled = await request(`/orders/${declinedOrder.id}/cancel`, { method: "POST", token: passengerLoginToken });
  assert.equal(declinedCancelled.response.status, 200);

  const firstOrderIncoming = waitForSocketEvent(
    driverOneSocket,
    "incoming_order",
    (payload) => payload.order?.pickup_point === "C",
  );
  const pointCOrder = await createOrder(passengerLoginToken, "C", 2);
  assert.equal(pointCOrder.status, "searching");
  assert.equal(pointCOrder.offered_driver_id, firstJoin.body.entry.driverId);
  const incoming = await firstOrderIncoming;
  assert.equal(incoming.priority, "high");
  assert.equal(incoming.order.offer_expires_at, pointCOrder.offer_expires_at);
  assert.ok(pointCOrder.offer_expires_at > Date.now());
  assert.ok(pointCOrder.offer_expires_at <= Date.now() + 60_000);
  assert.notEqual(incoming.order.passenger_phone, currentMe.body.user.phone_number);
  const queueDuringOffer = await request("/queue", { token: driverOneToken });
  const offeredEntry = queueDuringOffer.body.queue.find(entry => entry.driverId === firstJoin.body.entry.driverId);
  assert.equal(offeredEntry.availableSeats, 1, "Seats are reserved when the offer is delivered.");
  assert.equal(offeredEntry.pendingOfferOrderId, pointCOrder.id);
  assert.ok(!offeredEntry.activeOrderIds.includes(pointCOrder.id));
  const driverPendingOrders = await request("/orders", { token: driverOneToken });
  assert.equal(driverPendingOrders.body.orders.find(order => order.id === pointCOrder.id)?.offer_expires_at, pointCOrder.offer_expires_at);
  for (const [path, method, body, code] of [
    ["/queue/leave", "DELETE", undefined, "ACTIVE_ORDER"],
    ["/queue/join", "POST", { location: { ...queueLocation, timestamp: Date.now() }, available_seats: 8 }, "QUEUE_BUSY"],
  ]) {
    const blocked = await request(path, { method, body, token: driverOneToken });
    assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, code);
  }

  const reservedForFirstDriver = await request(`/orders/${pointCOrder.id}/accept`, {
    method: "POST",
    token: driverTwoToken,
  });
  assert.equal(reservedForFirstDriver.response.status, 409);
  assert.equal(reservedForFirstDriver.body.error.code, "ORDER_RESERVED");
  const wrongRejection = await request(`/orders/${pointCOrder.id}/reject`, { method: "POST", token: driverTwoToken });
  assert.equal(wrongRejection.response.status, 409);

  const competingAccepts = await Promise.all([
    request(`/orders/${pointCOrder.id}/accept`, {
      method: "POST",
      token: driverOneToken,
    }),
    request(`/orders/${pointCOrder.id}/accept`, {
      method: "POST",
      token: driverOneToken,
    }),
  ]);
  assert.equal(
    competingAccepts.filter((result) => result.response.status === 200).length,
    1,
    "only one concurrent acceptance may claim an order",
  );
  assert.equal(
    competingAccepts.filter((result) => result.response.status === 409).length,
    1,
    "the duplicate acceptance must receive a conflict",
  );
  const pointCAccepted = competingAccepts.find((result) => result.response.status === 200);
  assert.equal(pointCAccepted.body.order.status, "en_route_to_c");
  assert.equal(pointCAccepted.body.order.seat_lock_expires_at > Date.now(), true);
  assert.equal(pointCAccepted.body.seat_lock_minutes, 7);

  const queueAfterLock = await request("/queue", { token: driverOneToken });
  const lockedEntry = queueAfterLock.body.queue.find(
    (entry) => entry.driverId === firstJoin.body.entry.driverId,
  );
  assert.equal(lockedEntry.availableSeats, 1, "Point C must reserve the requested seats");
  assert.equal(lockedEntry.currentOrderId, pointCOrder.id);
  assert.equal(lockedEntry.pendingOfferOrderId, undefined);
  assert.equal(pointCAccepted.body.order.offer_expires_at, undefined);

  const invalidJump = await request(`/orders/${pointCOrder.id}/status`, {
    method: "PATCH",
    token: driverOneToken,
    body: { status: "completed" },
  });
  assert.equal(invalidJump.response.status, 409);
  assert.equal(invalidJump.body.error.code, "INVALID_STATUS_TRANSITION");

  for (const [status, expectedQueueStatus] of [
    ["arrived_at_c", "arrived_at_c"],
    ["in_transit", "in_transit"],
    ["completed", "searching"],
  ]) {
    const statusEvent = waitForSocketEvent(
      driverOneSocket,
      "order:status",
      (payload) => payload.order?.id === pointCOrder.id && payload.order?.status === status,
    );
    const transition = await request(`/orders/${pointCOrder.id}/status`, {
      method: "PATCH",
      token: driverOneToken,
      body: { status },
    });
    assert.equal(transition.response.status, 200);
    assert.equal(transition.body.order.status, status);
    assert.equal((await statusEvent).order.status, status);
    const queue = await request("/queue", { token: driverOneToken });
    const entry = queue.body.queue.find(
      (candidate) => candidate.driverId === firstJoin.body.entry.driverId,
    );
    if (status === "in_transit") {
      assert.equal(
        entry,
        undefined,
        "a driver who started moving must leave the FIFO queue",
      );
    } else {
      assert.equal(entry.status, expectedQueueStatus);
    }
  }

  const transitOrder = await createOrder(passengerLoginToken, "C", 1);
  assert.equal(transitOrder.offered_driver_id, firstJoin.body.entry.driverId, "Completion preserves the existing FIFO timestamp.");
  const transitAccept = await request(`/orders/${transitOrder.id}/accept`, {
    method: "POST",
    token: driverOneToken,
  });
  assert.equal(transitAccept.body.order.status, "en_route_to_c");
  for (const status of ["arrived_at_c", "in_transit"]) {
    const transition = await request(`/orders/${transitOrder.id}/status`, {
      method: "PATCH",
      token: driverOneToken,
      body: { status },
    });
    assert.equal(transition.response.status, 200);
    assert.equal(transition.body.order.status, status);
  }

  const pointDIncoming = waitForSocketEvent(
    driverOneSocket,
    "incoming_order",
    (payload) => payload.order?.pickup_point === "D",
  );
  const pointDOrder = await createOrder(passengerLoginToken, "D", 2);
  assert.equal(pointDOrder.status, "searching");
  assert.equal(pointDOrder.offered_driver_id, firstJoin.body.entry.driverId);
  const pointDOffer = await pointDIncoming;
  assert.equal(pointDOffer.order.pickup_point, "D");

  const pooling = await request(`/orders/${pointDOrder.id}/offer-first-driver`, {
    method: "POST",
    token: driverOneToken,
  });
  assert.equal(pooling.response.status, 200);
  assert.equal(pooling.body.smart_pooling, true);
  assert.equal(pooling.body.order.offered_driver_id, firstJoin.body.entry.driverId);

  // The CI job provisions PostgreSQL and enables the durable adapter. Restart
  // the API process to prove that user sessions and orders survive process loss.
  for (const socket of sockets) socket.disconnect();
  await stopApiServer();
  serverProcess = startApiServer();
  await waitForServer();

  const userAfterRestart = await request("/auth/me", { token: passengerLoginToken });
  assert.equal(userAfterRestart.response.status, 200, "user and session version must persist after restart");
  const ordersAfterRestart = await request("/orders", { token: passengerLoginToken });
  assert.equal(ordersAfterRestart.response.status, 200);
  assert.ok(
    ordersAfterRestart.body.orders.some((order) => order.id === pointDOrder.id),
    "created orders must persist after the API process restarts",
  );
  const pendingAfterRestart = await request("/orders", { token: driverOneToken });
  const recoveredPending = pendingAfterRestart.body.orders.find(order => order.id === pointDOrder.id);
  assert.equal(recoveredPending.offer_expires_at, pointDOrder.offer_expires_at);
  assert.notEqual(recoveredPending.passenger_phone, currentMe.body.user.phone_number);
  let recoveredIncoming;
  await connectSocket(driverOneToken, socket => {
    recoveredIncoming = waitForSocketEvent(socket, "incoming_order", payload => payload.order?.id === pointDOrder.id);
  });
  const restoredOffer = await recoveredIncoming;
  assert.equal(restoredOffer.order.offer_expires_at, pointDOrder.offer_expires_at);
  const pooledAccept = await request(`/orders/${pointDOrder.id}/accept`, { method: "POST", token: driverOneToken });
  assert.equal(pooledAccept.response.status, 200);
  assert.equal(pooledAccept.body.order.status, "in_transit");
});

test("the real HTTP timer withdraws an expired offer, advances FIFO, and cancellation releases it once", { timeout: 20_000 }, async t => {
  // The normal 60-second setting is asserted in the PostgreSQL suite and the
  // scenario above. This supported runtime setting lets the actual timer run
  // here; no clock, Store method, controller, Socket server, or SQL is mocked.
  for (const socket of sockets) socket.disconnect();
  await stopApiServer();
  serverProcess = startApiServer({ TEZJET_OFFER_TIMEOUT_SECONDS: "1" });
  await waitForServer();
  const passenger = await registerUser("+77771000011", "passenger", "Timer Passenger");
  const firstDriver = await registerUser("+77771000012", "driver", "Timer Driver One");
  const nextDriver = await registerUser("+77771000013", "driver", "Timer Driver Two");
  const admin = await registerUser("+77771000099", "admin", "Timer Admin");
  const driverIds = [];
  for (const token of [firstDriver, nextDriver]) {
    const me = await request("/auth/me", { token });
    driverIds.push(me.body.user.id);
    const approved = await request(`/admin/drivers/${me.body.user.id}/approval`, { method: "PATCH", token: admin, body: { status: "approved" } });
    assert.equal(approved.response.status, 200);
  }
  await resetOwnedState(passenger, [firstDriver, nextDriver]);
  t.after(() => resetOwnedState(passenger, [firstDriver, nextDriver]));
  const firstSocket = await connectSocket(firstDriver);
  const nextSocket = await connectSocket(nextDriver);
  const passengerSocket = await connectSocket(passenger);
  for (const token of [firstDriver, nextDriver]) {
    const join = await request("/queue/join", { method: "POST", token, body: { location: queueLocation, available_seats: 4 } });
    assert.equal(join.response.status, 201);
  }
  const firstIncoming = waitForSocketEvent(firstSocket, "incoming_order", payload => payload.order?.pickup_point === "C");
  const order = await createOrder(passenger, "C", 2);
  assert.equal((await firstIncoming).order.id, order.id);
  assert.equal(order.offered_driver_id, driverIds[0]);
  assert.ok(order.offer_expires_at <= Date.now() + 1_000);
  const withdrawal = waitForSocketEvent(firstSocket, "order:offer_withdrawn", payload => payload.order_id === order.id);
  const reoffered = waitForSocketEvent(nextSocket, "incoming_order", payload => payload.order?.id === order.id);
  const passengerReoffered = waitForSocketEvent(passengerSocket, "order:status", payload => payload.order?.id === order.id && payload.order?.offered_driver_id === driverIds[1]);
  const nextOffer = await reoffered;
  assert.equal((await withdrawal).order_id, order.id);
  assert.equal((await passengerReoffered).order.offered_driver_id, driverIds[1]);
  assert.ok(nextOffer.order.offer_expires_at > order.offer_expires_at);
  const afterTimeout = await request("/queue", { token: firstDriver });
  const firstEntry = afterTimeout.body.queue.find(entry => entry.driverId === driverIds[0]);
  const nextEntry = afterTimeout.body.queue.find(entry => entry.driverId === driverIds[1]);
  assert.equal(firstEntry.availableSeats, 4);
  assert.equal(firstEntry.pendingOfferOrderId, undefined);
  assert.equal(nextEntry.availableSeats, 2);
  assert.equal(nextEntry.pendingOfferOrderId, order.id);
  for (const action of ["accept", "reject"]) {
    const stale = await request(`/orders/${order.id}/${action}`, { method: "POST", token: firstDriver });
    assert.equal(stale.response.status, 409);
  }
  const cancelledOffer = waitForSocketEvent(nextSocket, "order:offer_withdrawn", payload => payload.order_id === order.id);
  const cancelled = await request(`/orders/${order.id}/cancel`, { method: "POST", token: passenger });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.order.status, "cancelled");
  assert.equal((await cancelledOffer).order.status, "cancelled");
  await new Promise(resolve => setTimeout(resolve, 1_100));
  const afterCancellation = await request("/orders", { token: passenger });
  assert.equal(afterCancellation.body.orders.find(candidate => candidate.id === order.id).status, "cancelled");
  const finalQueue = await request("/queue", { token: firstDriver });
  for (const id of driverIds) {
    const entry = finalQueue.body.queue.find(candidate => candidate.driverId === id);
    assert.equal(entry.availableSeats, 4, "The scheduled sweep cannot double-credit cancellation.");
    assert.equal(entry.pendingOfferOrderId, undefined);
  }
});
