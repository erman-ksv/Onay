import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, request, setApiEndpoint } from "../lib/api.ts";
import { routeBookingRequestKey, routeBookingRecoveryKey, readRouteBookingRecovery,
  saveRouteBookingRecovery, discardUnsentRouteBooking, reconcileRouteBookingRequest, routeBookingDefinitivelyRejected,
  confirmedRouteBookingPresent } from "../lib/passenger-route-orders.ts";

const intent = "a3f7b2c1-4455-4677-8899-aabbccddeeff";
function memoryStorage() {
  const records = new Map();
  return { records, getItem: async key => records.get(key) ?? null,
    setItem: async (key, value) => { records.set(key, value); }, removeItem: async key => { records.delete(key); } };
}

test("lost booking response recovers the exact request after restart without another POST", async t => {
  setApiEndpoint("https://onay.example");
  const storage = memoryStorage(), key = routeBookingRecoveryKey("https://onay.example", "passenger-1");
  await saveRouteBookingRecovery(storage, key, { status: "in_flight", orderId: null, requestKey: intent });
  const restored = await readRouteBookingRecovery(storage, key), calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ order: { id: "order-committed", status: "searching" } }), { status: 200 });
  });
  const recovered = await reconcileRouteBookingRequest(restored, path => request(path, "passenger-session"));
  await saveRouteBookingRecovery(storage, key, recovered);
  assert.deepEqual(await readRouteBookingRecovery(storage, key), {
    status: "confirmed", orderId: "order-committed", requestKey: intent,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://onay.example/api/orders/route/requests/" + intent);
  assert.equal(calls[0].init.method ?? "GET", "GET");
  assert.equal(calls[0].init.headers.Authorization, "Bearer passenger-session");
  assert.equal(confirmedRouteBookingPresent(recovered, [{ id: "another-order" }]), false);
  assert.equal(confirmedRouteBookingPresent(recovered, [{ id: "order-committed" }]), true);
});

test("missing, offline or malformed recovery never erases an uncertain booking or resubmits it", async () => {
  const storage = memoryStorage();
  await saveRouteBookingRecovery(storage, "receipt", { status: "uncertain", orderId: null, requestKey: intent });
  const original = storage.records.get("receipt");
  const restored = await readRouteBookingRecovery(storage, "receipt");
  for (const failure of [new ApiError("not found", 404, "ORDER_REQUEST_NOT_FOUND"),
    new ApiError("offline", undefined, "NETWORK_ERROR"), new ApiError("expired", 401, "UNAUTHORIZED")]) {
    let lookups = 0;
    await assert.rejects(reconcileRouteBookingRequest(restored, async () => { lookups++; throw failure; }));
    assert.equal(lookups, 1);
    assert.equal(storage.records.get("receipt"), original);
  }
  for (const invalid of [null, {}, { order: null }, { order: { id: "" } }, { order: { id: 1 } }]) {
    await assert.rejects(reconcileRouteBookingRequest(restored, async () => invalid));
    assert.equal(storage.records.get("receipt"), original);
  }
});

test("legacy and corrupt receipts stay blocked without guessing a request key", async () => {
  const storage = memoryStorage();
  for (const serialized of ['{"status":"uncertain","orderId":null}', '{broken',
    JSON.stringify({ status: "in_flight", orderId: null, requestKey: "malformed" })]) {
    storage.records.set("receipt", serialized);
    const record = await readRouteBookingRecovery(storage, "receipt");
    assert.deepEqual(record, { status: "uncertain", orderId: null });
    let calls = 0;
    assert.deepEqual(await reconcileRouteBookingRequest(record, async () => { calls++; }), record);
    assert.equal(calls, 0);
  }
});

test("persistent recovery scopes the key to endpoint/user and writes no token or GPS", async () => {
  const storage = memoryStorage();
  const key = routeBookingRecoveryKey("https://onay.example", "passenger-1");
  assert.notEqual(key, routeBookingRecoveryKey("https://another.example", "passenger-1"));
  assert.notEqual(key, routeBookingRecoveryKey("https://onay.example", "passenger-2"));
  await saveRouteBookingRecovery(storage, key, { status: "in_flight", orderId: null,
    requestKey: intent.toUpperCase(), token: "private-session", pickup_location: { lat: 42, lng: 71 } });
  assert.deepEqual(JSON.parse(storage.records.get(key)), { status: "in_flight", orderId: null, requestKey: intent });
  for (const invalid of [undefined, "", "not-a-uuid", [intent], intent + "," + intent]) {
    assert.throws(() => routeBookingRequestKey(invalid));
  }
});

test("only explicit pre-commit rejection can unlock a fresh booking", () => {
  assert.equal(routeBookingDefinitivelyRejected({ status: 409, code: "NO_DRIVERS" }), true);
  assert.equal(routeBookingDefinitivelyRejected({ status: 422, code: "MOCKED_GPS" }), true);
  for (const error of [{ status: 409, code: "IDEMPOTENCY_CONFLICT" }, { status: 409, code: "ORDER_RECOVERY_REQUIRED" },
    { status: 409, code: "REQUEST_CONFLICT" }, { status: 429 }, { status: 500, code: "NO_DRIVERS" },
    { status: 503 }, { code: "NETWORK_ERROR" }, { code: "REQUEST_TIMEOUT" }]) {
    assert.equal(routeBookingDefinitivelyRejected(error), false);
  }
});

test("known pre-POST cancellation clears only its own unsent intent", async () => {
  const storage = memoryStorage();
  await saveRouteBookingRecovery(storage, "receipt", { status: "in_flight", orderId: null, requestKey: intent });
  await discardUnsentRouteBooking(storage, "receipt", intent);
  assert.equal(await readRouteBookingRecovery(storage, "receipt"), null);
  for (const record of [{ status: "uncertain", orderId: null, requestKey: intent },
    { status: "confirmed", orderId: "order-created", requestKey: intent },
    { status: "in_flight", orderId: null, requestKey: "00000000-0000-4000-8000-000000000000" }]) {
    await saveRouteBookingRecovery(storage, "receipt", record);
    await discardUnsentRouteBooking(storage, "receipt", intent);
    assert.deepEqual(await readRouteBookingRecovery(storage, "receipt"), record);
  }
});

test("API forwards the idempotency header while keeping the authenticated session", async t => {
  setApiEndpoint("https://onay.example");
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("idempotency-key"), intent);
    assert.equal(headers.get("authorization"), "Bearer current-session");
    assert.equal(headers.get("content-type"), "application/json");
    return new Response(JSON.stringify({ order: { id: "booked-once" } }), { status: 201 });
  });
  assert.deepEqual(await request("/api/orders/route", "current-session", { method: "POST",
    headers: new Headers({ "Idempotency-Key": intent, Authorization: "Bearer wrong-session" }), body: "{}" }),
  { order: { id: "booked-once" } });
});
