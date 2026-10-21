import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueueMutationGuard, driverQueueMembership, parseDriverQueueMembership } from "../lib/driver-queue.ts";

test("departed lines and ordinary completed-trip entries remain enrolled outside FIFO", () => {
  for (const entry of [
    { driverId: "driver", collectionState: { phase: "departed", enrollmentId: "line-1", capacity: 3 }, activeOrderIds: [], inFifo: false },
    { driverId: "driver", routeContext: { routeId: "line-1", direction: "a_to_b" }, activeOrderIds: [], inFifo: false },
  ]) {
    assert.equal(parseDriverQueueMembership({ your_entry: entry, your_position: null }), "enrolled");
  }
  assert.equal(parseDriverQueueMembership({ your_entry: { driverId: "driver" }, your_position: 1 }), "enrolled");
});

test("only an explicit null entry with a null position proves absence", () => {
  assert.equal(parseDriverQueueMembership({ your_entry: null, your_position: null, queue: [] }), "absent");
  for (const incomplete of [
    { your_position: null }, { your_entry: undefined, your_position: null }, { your_entry: null },
    { your_entry: null, your_position: 1 }, { your_entry: null, your_position: undefined },
  ]) assert.throws(() => parseDriverQueueMembership(incomplete));
});

test("malformed or inherited queue response fields cannot unlock enrollment", () => {
  for (const malformed of [null, undefined, [], "absent", {},
    { your_entry: [], your_position: null }, { your_entry: "driver", your_position: null },
    { your_entry: false, your_position: null }, { your_entry: 1, your_position: null },
    ...[0, -1, 1.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(position => ({ your_entry: {}, your_position: position })),
    Object.create({ your_entry: null, your_position: null }),
    Object.assign(Object.create({ your_entry: null }), { your_position: null }),
  ]) assert.throws(() => parseDriverQueueMembership(malformed));
});

test("queue knowledge is isolated by exact endpoint/account/session key", () => {
  const current = "https://onay.example/passenger-driver/session-2";
  assert.equal(driverQueueMembership(null, current), "unknown");
  assert.equal(driverQueueMembership({ sessionKey: current, membership: "enrolled" }, current), "enrolled");
  assert.equal(driverQueueMembership({ sessionKey: current, membership: "absent" }, current), "absent");
  for (const other of ["https://other.example/passenger-driver/session-2", "https://onay.example/other-driver/session-2", "https://onay.example/passenger-driver/session-1"]) {
    assert.equal(driverQueueMembership({ sessionKey: other, membership: "absent" }, current), "unknown");
  }
  assert.equal(driverQueueMembership({ sessionKey: "", membership: "absent" }, ""), "unknown");
  assert.equal(driverQueueMembership({ sessionKey: current, membership: "unknown" }, current), "unknown");
});

test("one pending deletion blocks another delete and a new join until acknowledgement", async () => {
  const guard = createQueueMutationGuard(), requests = [];
  let acknowledge;
  const response = new Promise(resolve => { acknowledge = resolve; });
  const mutate = async (name, work) => {
    if (!guard.tryStart()) return false;
    try { requests.push(name); await work(); return true; }
    finally { guard.finish(); }
  };
  const deletion = mutate("delete", () => response);
  assert.equal(guard.isPending(), true);
  assert.equal(await mutate("delete-again", async () => {}), false);
  assert.equal(await mutate("join", async () => {}), false);
  assert.deepEqual(requests, ["delete"]);
  acknowledge();
  assert.equal(await deletion, true);
  assert.equal(guard.isPending(), false);
  assert.equal(await mutate("join", async () => {}), true);
  assert.deepEqual(requests, ["delete", "join"]);
});

test("failed mutation remains exclusive until finally releases it for explicit retry", async () => {
  const guard = createQueueMutationGuard();
  let fail;
  const response = new Promise((_resolve, reject) => { fail = reject; });
  const deletion = (async () => {
    assert.equal(guard.tryStart(), true);
    try { await response; }
    finally { guard.finish(); }
  })();
  assert.equal(guard.tryStart(), false);
  const rejected = assert.rejects(deletion, /offline/);
  fail(new Error("offline"));
  await rejected;
  assert.equal(guard.isPending(), false);
  assert.equal(guard.tryStart(), true);
  guard.finish();
});
