import assert from "node:assert/strict";
import { test } from "node:test";
import { isLiveOffer, mergeOrder, mergeOrderSnapshot, nextTripStatus } from "../lib/orders.ts";

const offered = {
  id: "ride", status: "searching", pickup_point: "C", seats: 2,
  passenger_id: "passenger", offered_driver_id: "driver", offer_expires_at: 61_000,
  created_at: "2026-10-13T00:00:00.000Z", updated_at: "2026-10-13T00:00:01.000Z",
};

test("only the current recipient can see an unexpired, unaccepted offer", () => {
  assert.equal(isLiveOffer(offered, "driver", 60_999), true);
  assert.equal(isLiveOffer(offered, "driver", 61_000), false);
  assert.equal(isLiveOffer(offered, "another-driver", 60_999), false);
  assert.equal(isLiveOffer({ ...offered, offer_expires_at: undefined }, "driver", 1), false);
  assert.equal(isLiveOffer({ ...offered, status: "en_route_to_c", driver_id: "driver" }, "driver", 1), false);
});

test("a delayed searching snapshot cannot resurrect an accepted or cancelled order", () => {
  const accepted = { ...offered, status: "en_route_to_c", driver_id: "driver", offer_expires_at: undefined, updated_at: "2026-10-13T00:00:02.000Z" };
  const current = [accepted];
  assert.equal(mergeOrder(current, offered), current);
  const cancelled = { ...accepted, status: "cancelled", updated_at: "2026-10-13T00:00:03.000Z" };
  const closed = mergeOrder(current, cancelled);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].status, "cancelled");
  assert.equal(mergeOrder(closed, accepted), closed);
});

test("pending offers cannot advance trip status", () => {
  assert.equal(nextTripStatus(offered), null);
  assert.equal(nextTripStatus({ ...offered, status: "en_route_to_c" }), "arrived_at_c");
  assert.equal(nextTripStatus({ ...offered, status: "arrived_at_c" }), "in_transit");
  assert.equal(nextTripStatus({ ...offered, status: "in_transit" }), "completed");
  assert.equal(nextTripStatus({ ...offered, status: "completed" }), null);
});

test("an old empty snapshot cannot hide an offer received while the GET was in flight", () => {
  const merged = mergeOrderSnapshot([offered], [], new Set([offered.id]));
  assert.equal(merged.length, 1);
  assert.equal(isLiveOffer(merged[0], "driver", 60_999), true);
});

test("a snapshot cannot restore an offer withdrawn while the GET was in flight", () => {
  const withdrawn = { ...offered, offered_driver_id: undefined, offer_expires_at: undefined };
  const merged = mergeOrderSnapshot([withdrawn], [offered], new Set([offered.id]));
  assert.equal(isLiveOffer(merged[0], "driver", 60_999), false);
});

test("a current full snapshot removes offers that are no longer visible to this driver", () => {
  assert.deepEqual(mergeOrderSnapshot([offered], []), []);
});

test("a snapshot preserves newer accepted passenger trip status", () => {
  const accepted = { ...offered, status: "en_route_to_c", driver_id: "driver", updated_at: "2026-10-13T00:00:02.000Z" };
  const merged = mergeOrderSnapshot([accepted], [offered]);
  assert.equal(merged[0].status, "en_route_to_c");
});
