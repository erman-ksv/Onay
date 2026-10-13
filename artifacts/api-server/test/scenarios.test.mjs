import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { io } from "socket.io-client";

const port = 41_000 + (process.pid % 1_000);
const baseUrl = `http://127.0.0.1:${port}/api`;
const socketUrl = `http://127.0.0.1:${port}`;
const queueLocation = {
  lat: 41.3111,
  lng: 69.2797,
  timestamp: Date.now(),
};

let serverProcess;
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

async function connectSocket(token) {
  const socket = io(socketUrl, {
    auth: { token },
    path: "/api/socket.io",
    transports: ["websocket"],
  });
  sockets.push(socket);
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
  });
  return socket;
}

async function registerUser(phoneNumber, role, fullName) {
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

function startApiServer() {
  return spawn(process.execPath, ["--enable-source-maps", "./dist/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      SESSION_SECRET: "tezjet-test-session-secret",
      ADMIN_PHONE: "+77771000099",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

before(async () => {
  serverProcess = startApiServer();
  await waitForServer();
});

after(async () => {
  for (const socket of sockets) {
    socket.disconnect();
  }
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
  }
});

test("covers OTP auth, FIFO queue, Point C locks, Point D pooling, and realtime events", async () => {
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

  const driverOneMe = await request("/auth/me", { token: driverOneToken });
  assert.equal(driverOneMe.body.user.driver_approval_status, "pending");
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

  const firstOrderIncoming = waitForSocketEvent(
    driverOneSocket,
    "incoming_order",
    (payload) => payload.order?.pickup_point === "C",
  );
  const pointCOrder = await createOrder(passengerLoginToken, "C", 2);
  assert.equal(pointCOrder.status, "searching");
  assert.equal(pointCOrder.offered_driver_id, firstJoin.body.entry.driverId);
  assert.equal((await firstOrderIncoming).priority, "high");

  const reservedForFirstDriver = await request(`/orders/${pointCOrder.id}/accept`, {
    method: "POST",
    token: driverTwoToken,
  });
  assert.equal(reservedForFirstDriver.response.status, 409);
  assert.equal(reservedForFirstDriver.body.error.code, "ORDER_RESERVED");

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
  const previousProcess = serverProcess;
  await new Promise((resolve) => {
    previousProcess.once("exit", resolve);
    previousProcess.kill("SIGTERM");
  });
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
});