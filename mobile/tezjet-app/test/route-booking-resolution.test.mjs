import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../lib/api.ts";
import { createPassengerBookingGate } from "../lib/passenger-booking-gate.ts";
import { resolveRouteBookingRequest, clearClosedRouteBookingRecovery, readRouteBookingRecovery,
  saveRouteBookingRecovery, confirmedRouteBookingPresent } from "../lib/passenger-route-orders.ts";

const requestKey = "a3f7b2c1-4455-4677-8899-aabbccddeeff";
const otherKey = "c3f7b2c1-4455-4677-8899-aabbccddeeff";
const uncertain = { status: "in_flight", orderId: null, requestKey };
const notFound = () => { throw new ApiError("Not found", 404, "ORDER_REQUEST_NOT_FOUND"); };
const receiptPath = "/api/orders/route/requests/" + requestKey;
function storage() {
  const records = new Map();
  return { getItem: async key => records.get(key) ?? null,
    setItem: async (key, value) => { records.set(key, value); },
    removeItem: async key => { records.delete(key); } };
}
function lockedGate() {
  const gate = createPassengerBookingGate();
  gate.setRecovery(true, true); gate.setActiveOrder(false, true);
  assert.equal(gate.tryStart("recovery"), true);
  return gate;
}

test("a committed receipt is recovered without closing it or posting another booking", async () => {
  const calls = [];
  const result = await resolveRouteBookingRequest(uncertain, async path => {
    calls.push(path); return { order: { id: "real-order" } };
  }, async path => { calls.push(path); throw new Error("A committed receipt must not be closed"); });
  assert.deepEqual(result, { state: "created", record: { status: "confirmed", orderId: "real-order", requestKey } });
  assert.deepEqual(calls, [receiptPath]);
});

test("an unknown missing request obtains an exact server closure proof rather than treating404 as proof", async () => {
  const calls = [];
  const result = await resolveRouteBookingRequest(uncertain, async path => {
    calls.push(path); return notFound();
  }, async path => { calls.push(path); return { state: "closed", request_key: requestKey }; });
  assert.deepEqual(result, { state: "closed", requestKey });
  assert.deepEqual(calls, [receiptPath, receiptPath + "/resolve"]);
  assert.equal(calls.includes("/api/orders/route"), false, "Recovery never automatically creates a new booking.");
});

test("closure racing an already committed request restores its order instead of releasing another booking", async () => {
  const result = await resolveRouteBookingRequest(uncertain, notFound, async () => ({
    state: "created", request_key: requestKey, order: { id: "late-order", status: "searching" },
  }));
  assert.equal(result.state, "created");
  assert.equal(result.record.orderId, "late-order");
  assert.equal(confirmedRouteBookingPresent(result.record, []), false);
  assert.equal(confirmedRouteBookingPresent(result.record, [{ id: "different-order" }]), false);
  assert.equal(confirmedRouteBookingPresent(result.record, [{ id: "late-order" }]), true);
});

test("a lost closure response survives restart and repeats resolution idempotently", async () => {
  const saved = storage(); await saveRouteBookingRecovery(saved, "receipt", uncertain);
  await assert.rejects(resolveRouteBookingRequest(uncertain, notFound, async () => {
    throw new ApiError("No response", 0, "NETWORK_ERROR");
  }));
  const restored = await readRouteBookingRecovery(saved, "receipt");
  assert.deepEqual(restored, uncertain);
  const result = await resolveRouteBookingRequest(restored, async () => {
    throw new ApiError("Closed", 409, "ORDER_REQUEST_CLOSED");
  }, async () => ({ state: "closed", request_key: requestKey }));
  assert.deepEqual(result, { state: "closed", requestKey });
  assert.deepEqual(await readRouteBookingRecovery(saved, "receipt"), uncertain, "Resolution alone cannot erase recovery state.");
});

test("bare404 empty lookup oldserver404 network auth and quota failures never clear storage", async () => {
  for (const error of [new ApiError("Old endpoint", 404), new ApiError("Old endpoint", 404, "NOT_FOUND"),
    new ApiError("Offline", 0, "NETWORK_ERROR"), new ApiError("Expired", 401, "UNAUTHORIZED"),
    new ApiError("Forbidden", 403, "FORBIDDEN"), new ApiError("Limited", 429, "ORDER_RECOVERY_LIMIT")]) {
    const saved = storage(); await saveRouteBookingRecovery(saved, "receipt", uncertain);
    let resolves = 0;
    await assert.rejects(resolveRouteBookingRequest(uncertain, async () => { throw error; }, async () => {
      resolves++; return { state: "closed", request_key: requestKey };
    }));
    assert.equal(resolves, 0);
    assert.deepEqual(await readRouteBookingRecovery(saved, "receipt"), uncertain);
  }
  let resolves = 0;
  await assert.rejects(resolveRouteBookingRequest(uncertain, async () => ({ orders: [] }), async () => { resolves++; }));
  assert.equal(resolves, 0);
  for (const error of [new ApiError("Old server", 404, "NOT_FOUND"), new ApiError("Limited", 429, "ORDER_RECOVERY_LIMIT")]) {
    await assert.rejects(resolveRouteBookingRequest(uncertain, notFound, async () => { throw error; }));
  }
});

test("malformed wrong-key and ambiguous closure replies cannot prove a request closed", async () => {
  for (const reply of [null, undefined, [], {}, { state: "closed" },
    { state: "closed", request_key: otherKey }, { state: "closed", request_key: requestKey.toUpperCase() },
    { state: "closed", request_key: requestKey, order: null },
    { state: "closed", request_key: requestKey, order: { id: "real-order" } },
    { state: "closed", request_key: requestKey, order_id: "real-order" },
    { state: "created", request_key: requestKey },
    { state: "created", request_key: otherKey, order: { id: "real-order" } },
    { state: "created", request_key: requestKey, order: { id: "bad/id" } },
    { state: "created", request_key: requestKey, order: [] }]) {
    await assert.rejects(resolveRouteBookingRequest(uncertain, notFound, async () => reply));
  }
});

test("legacy records without a request key stay blocked and confirmed records are not re-resolved", async () => {
  let calls = 0;
  const noCall = async () => { calls++; throw new Error("Must not call a transport"); };
  await assert.rejects(resolveRouteBookingRequest({ status: "uncertain", orderId: null }, noCall, noCall));
  const confirmed = { status: "confirmed", orderId: "already-created", requestKey };
  assert.deepEqual(await resolveRouteBookingRequest(confirmed, noCall, noCall), { state: "created", record: confirmed });
  assert.equal(calls, 0);
});

test("proof and current accepted orders snapshot release admission only after durable recovery removal", async () => {
  const saved = storage(); await saveRouteBookingRecovery(saved, "receipt", uncertain);
  const gate = lockedGate();
  const proof = await resolveRouteBookingRequest(uncertain, notFound, async () => ({ state: "closed", request_key: requestKey }));
  assert.equal(gate.tryStart("legacy"), false);
  const snapshot = gate.beginOrdersRead();
  assert.equal(gate.applyOrdersSnapshot(snapshot, false), true);
  assert.equal(gate.canSubmit(), false);
  assert.equal(await clearClosedRouteBookingRecovery(saved, "receipt", proof.requestKey), true);
  assert.equal(gate.tryStart("configured"), false, "The active recovery operation owns admission until completion.");
  gate.setRecovery(true, false); gate.finish("recovery");
  assert.equal(gate.tryStart("configured"), true);
  assert.equal(await readRouteBookingRecovery(saved, "receipt"), null);
});

test("a superseded orders snapshot cannot erase closure recovery or release either form", async () => {
  const saved = storage(); await saveRouteBookingRecovery(saved, "receipt", uncertain);
  const gate = lockedGate();
  const proof = await resolveRouteBookingRequest(uncertain, notFound, async () => ({ state: "closed", request_key: requestKey }));
  assert.equal(proof.state, "closed");
  const oldRead = gate.beginOrdersRead(); gate.setActiveOrder(true);
  const accepted = gate.applyOrdersSnapshot(oldRead, false);
  assert.equal(accepted, false);
  if (accepted) await clearClosedRouteBookingRecovery(saved, "receipt", proof.requestKey);
  gate.finish("recovery");
  assert.equal(gate.tryStart("legacy"), false); assert.equal(gate.tryStart("configured"), false);
  assert.deepEqual(await readRouteBookingRecovery(saved, "receipt"), uncertain);
});

test("storage failure changed key confirmed record or changed session never releases current intent", async () => {
  const saved = storage(); await saveRouteBookingRecovery(saved, "receipt", uncertain);
  const broken = { ...saved, removeItem: async () => { throw new Error("Storage unavailable"); } };
  await assert.rejects(clearClosedRouteBookingRecovery(broken, "receipt", requestKey));
  assert.deepEqual(await readRouteBookingRecovery(saved, "receipt"), uncertain);
  await saveRouteBookingRecovery(saved, "receipt", { ...uncertain, requestKey: otherKey });
  assert.equal(await clearClosedRouteBookingRecovery(saved, "receipt", requestKey), false);
  assert.equal((await readRouteBookingRecovery(saved, "receipt")).requestKey, otherKey);
  const confirmed = { status: "confirmed", orderId: "exists", requestKey };
  await saveRouteBookingRecovery(saved, "receipt", confirmed);
  assert.equal(await clearClosedRouteBookingRecovery(saved, "receipt", requestKey), false);
  assert.deepEqual(await readRouteBookingRecovery(saved, "receipt"), confirmed);
  await saveRouteBookingRecovery(saved, "receipt", uncertain);
  let current = true;
  const swappedSession = { ...saved, getItem: async key => { const value = await saved.getItem(key); current = false; return value; } };
  assert.equal(await clearClosedRouteBookingRecovery(swappedSession, "receipt", requestKey, () => current), false);
  assert.deepEqual(await readRouteBookingRecovery(saved, "receipt"), uncertain);
});
