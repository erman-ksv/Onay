import assert from "node:assert/strict";
import { test } from "node:test";
import { createPassengerBookingGate } from "../lib/passenger-booking-gate.ts";
import { ApiError } from "../lib/api.ts";
import { readRouteBookingRecovery, saveRouteBookingRecovery, clearRouteBookingRecovery,
  reconcileRouteBookingRequest } from "../lib/passenger-route-orders.ts";

const requestKey = "a3f7b2c1-4455-4677-8899-aabbccddeeff";
function storage() {
  const records = new Map();
  return { getItem: async key => records.get(key) ?? null,
    setItem: async (key, value) => { records.set(key, value); }, removeItem: async key => { records.delete(key); } };
}
async function hydrate(gate, saved) {
  const record = await readRouteBookingRecovery(saved, "receipt");
  gate.setRecovery(true, record !== null);
  return record;
}
function ready() {
  const gate = createPassengerBookingGate();
  gate.setRecovery(true, false); gate.setActiveOrder(false, true);
  return gate;
}

test("neither form can book before durable recovery and an authoritative orders snapshot finish", () => {
  for (const first of ["storage", "orders"]) {
    const gate = createPassengerBookingGate();
    assert.equal(gate.tryStart("legacy"), false);
    if (first === "storage") gate.setRecovery(true, false); else gate.setActiveOrder(false, true);
    assert.equal(gate.tryStart("configured"), false);
    if (first === "orders") gate.setRecovery(true, false); else gate.setActiveOrder(false, true);
    assert.equal(gate.canSubmit(), true);
  }
});

test("same-frame legacy/configured taps and GPS waits admit exactly one POST", async () => {
  for (const first of ["legacy", "configured"]) {
    const gate = ready(), saved = storage(), posts = [];
    let resume;
    const gps = new Promise(resolve => { resume = resolve; });
    async function submit(kind) {
      if (!gate.tryStart(kind)) return;
      try {
        await gps;
        await saveRouteBookingRecovery(saved, "receipt", { status: "in_flight", orderId: null,
          ...(kind === "configured" ? { requestKey } : {}) });
        gate.setRecovery(true, true);
        posts.push(kind);
      } finally { gate.finish(kind); }
    }
    const a = submit(first), b = submit(first === "legacy" ? "configured" : "legacy"), c = submit(first);
    resume(); await Promise.all([a, b, c]);
    assert.deepEqual(posts, [first]);
    assert.equal(gate.tryStart(first === "legacy" ? "configured" : "legacy"), false);
  }
});

test("lost configured response stays locked against legacy after restart and a404 receipt lookup", async () => {
  const saved = storage();
  await saveRouteBookingRecovery(saved, "receipt", { status: "in_flight", orderId: null, requestKey });
  const gate = createPassengerBookingGate();
  const record = await hydrate(gate, saved);
  gate.setActiveOrder(false, true); // A successful but stale/empty orders GET is insufficient.
  assert.equal(gate.tryStart("legacy"), false);
  assert.equal(gate.tryStart("configured"), false);
  assert.equal(gate.tryStart("recovery"), true);
  await assert.rejects(reconcileRouteBookingRequest(record, async () => {
    throw new ApiError("Not found", 404, "ORDER_REQUEST_NOT_FOUND");
  }));
  gate.finish("recovery");
  assert.deepEqual(await readRouteBookingRecovery(saved, "receipt"), record);
  assert.equal(gate.tryStart("legacy"), false);
});

test("legacy unknown outcome survives restart without inventing an idempotency receipt", async () => {
  const saved = storage();
  await saveRouteBookingRecovery(saved, "receipt", { status: "in_flight", orderId: null });
  const gate = createPassengerBookingGate(), record = await hydrate(gate, saved);
  gate.setActiveOrder(false, true);
  let calls = 0;
  assert.deepEqual(await reconcileRouteBookingRequest(record, async () => { calls++; }), record);
  assert.equal(calls, 0);
  assert.equal(gate.tryStart("configured"), false);
  assert.equal(gate.tryStart("legacy"), false);
});

test("reconciled receipt cannot reopen forms while the confirmed ride is still active", async () => {
  const gate = ready(), saved = storage();
  await saveRouteBookingRecovery(saved, "receipt", { status: "confirmed", orderId: "created", requestKey });
  await hydrate(gate, saved);
  assert.equal(gate.tryStart("recovery"), true);
  gate.setActiveOrder(true, true); // Exact recovery GET, even if the parent's GET was stale.
  await clearRouteBookingRecovery(saved, "receipt");
  gate.setRecovery(true, false); gate.finish("recovery");
  assert.equal(gate.canSubmit(), false);
  gate.setActiveOrder(false, true); // The authoritative terminal-order update releases admission.
  assert.equal(gate.tryStart("legacy"), true);
});

test("a pre-POST cancellation releases only its owner; new sessions hydrate independently", () => {
  const old = ready();
  assert.equal(old.tryStart("configured"), true);
  old.finish("legacy");
  assert.equal(old.tryStart("legacy"), false);
  old.finish("configured");
  assert.equal(old.canSubmit(), true);
  const current = createPassengerBookingGate();
  old.setRecovery(true, true);
  assert.equal(current.tryStart("legacy"), false);
  current.setActiveOrder(false, true); current.setRecovery(true, false);
  assert.equal(current.canSubmit(), true);
});

test("another form changing persistent state closes admission until the current revision is rehydrated", () => {
  let notifications = 0;
  const gate = createPassengerBookingGate(() => { notifications++; });
  gate.setRecovery(true, false); gate.setActiveOrder(false, true);
  const staleRevision = gate.recoveryRevision();
  gate.recoveryChanged();
  assert.notEqual(gate.recoveryRevision(), staleRevision);
  assert.equal(gate.canSubmit(), false);
  gate.setRecovery(true, true);
  assert.equal(gate.tryStart("legacy"), false);
  assert.equal(gate.tryStart("recovery"), true);
  assert.equal(gate.tryStart("configured"), false);
  const previous = notifications;
  gate.setRecovery(true, true); gate.setActiveOrder(false, true);
  assert.equal(notifications, previous, "Equal snapshots must not cause an effect/render loop.");
});

test("an older empty parent GET cannot erase a confirmed active recovery snapshot", () => {
  const gate = ready();
  gate.setRecovery(true, true);
  const parentRead = gate.beginOrdersRead();
  const recoveryRead = gate.beginOrdersRead();
  assert.equal(gate.applyOrdersSnapshot(recoveryRead, true), true);
  gate.setRecovery(true, false);
  assert.equal(gate.applyOrdersSnapshot(parentRead, false), false);
  assert.equal(gate.tryStart("legacy"), false);
  const nextRead = gate.beginOrdersRead();
  assert.equal(gate.applyOrdersSnapshot(nextRead, false), true);
  assert.equal(gate.canSubmit(), true);
});

test("POST and socket confirmations invalidate older snapshots; superseded recovery cannot clear its guard", () => {
  const gate = ready();
  const oldRead = gate.beginOrdersRead();
  gate.setActiveOrder(true);
  assert.equal(gate.applyOrdersSnapshot(oldRead, false), false);
  assert.equal(gate.canSubmit(), false);
  gate.setRecovery(true, true);
  const recoveryRead = gate.beginOrdersRead();
  gate.beginOrdersRead(); // Newer authoritative refresh has not resolved yet.
  assert.equal(gate.applyOrdersSnapshot(recoveryRead, false), false);
  assert.equal(gate.tryStart("legacy"), false);
});
