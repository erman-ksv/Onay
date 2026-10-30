import assert from "node:assert/strict";
import { test } from "node:test";
import { DRIVER_SEATS_MAX_AGE_MS, driverSeatView, parseDriverSeatSnapshot } from "../lib/driver-free-seats.ts";

const scope = { sessionKey: "endpoint-and-token", driverId: "driver-one", revision: 2 };
const entry = extra => ({ driverId: scope.driverId, joinedAt: 100, availableSeats: 3, ...extra });
const response = own => ({ your_entry: own, your_position: own ? 1 : null });
const parse = (own, revision = 2) => parseDriverSeatSnapshot(response(own), { ...scope, revision }, 1000);
const view = (snapshot, extra = {}, now = 1001, membership = "enrolled") => driverSeatView(snapshot, { ...scope, ...extra }, now, membership);

test("own authoritative zero and full capacity are numbers, never a truthiness fallback", () => {
  for (const availableSeats of [0, 1, 3, 8]) assert.deepEqual(view(parse(entry({ availableSeats }))), { status: "known", availableSeats });
});
test("confirmed absence is not zero; retained departed enrollment does not require FIFO position", () => {
  assert.deepEqual(view(parse(null), {}, 1001, "absent"), { status: "absent" });
  const snapshot = parseDriverSeatSnapshot({ your_entry: entry({ availableSeats: 2 }), your_position: null }, scope, 1000);
  assert.deepEqual(view(snapshot), { status: "known", availableSeats: 2 });
});
test("missing malformed fractional negative and oversized seats cannot become a usable snapshot", () => {
  for (const availableSeats of [undefined, null, "3", -1, 9, 0.5, NaN, Infinity]) assert.throws(() => parse(entry({ availableSeats })));
  for (const driverId of [undefined, "", "another-driver"]) assert.throws(() => parse(entry({ driverId })));
  for (const joinedAt of [undefined, null, -1, 0.5, "100"]) assert.throws(() => parse(entry({ joinedAt })));
});
test("an old endpoint token account or revision cannot display private seats", () => {
  const snapshot = parse(entry({}));
  for (const extra of [{ sessionKey: "another-endpoint-or-token" }, { driverId: "another-driver" }, { revision: 3 }]) assert.deepEqual(view(snapshot, extra), { status: "unknown" });
});
test("events and leave/rejoin fence an old in-flight receipt before accepting the new enrollment", () => {
  const old = parse(entry({ availableSeats: 3 }), 2);
  assert.deepEqual(view(old, { revision: 4 }), { status: "unknown" });
  const next = parse(entry({ joinedAt: 200, availableSeats: 2 }), 4);
  assert.equal(next.joinedAt, 200); assert.deepEqual(view(next, { revision: 4 }), { status: "known", availableSeats: 2 });
});
test("freshness starts when the queue response arrived, not when its slower sibling finished", () => {
  const snapshot = parse(entry({ availableSeats: 0 }));
  assert.deepEqual(view(snapshot, {}, 1000 + DRIVER_SEATS_MAX_AGE_MS - 1), { status: "known", availableSeats: 0 });
  assert.deepEqual(view(snapshot, {}, 1000 + DRIVER_SEATS_MAX_AGE_MS), { status: "unknown" });
  assert.deepEqual(view(snapshot, {}, 999), { status: "unknown" });
});
test("line capacity never replaces its actual availableSeats and the opaque receipt is retained", () => {
  const snapshot = parse(entry({ availableSeats: 2, collectionState: { version: 1, enrollmentId: "actual-receipt", phase: "departed", capacity: 8 } }));
  assert.equal(snapshot.enrollmentId, "actual-receipt"); assert.deepEqual(view(snapshot), { status: "known", availableSeats: 2 });
  assert.throws(() => parse(entry({ collectionState: { version: 1, enrollmentId: "", phase: "collecting", capacity: 8 } })));
});
test("unknown or contradictory membership cannot reuse an otherwise valid number", () => {
  for (const membership of ["unknown", "absent"]) assert.deepEqual(view(parse(entry({})), {}, 1001, membership), { status: "unknown" });
  assert.deepEqual(view(parse(null)), { status: "unknown" });
  assert.deepEqual(view(null), { status: "unknown" });
  assert.throws(() => parseDriverSeatSnapshot({ your_entry: null, your_position: 1 }, scope, 1000));
});
test("invalid scope clock or incomplete response never establishes absence or zero", () => {
  for (const input of [null, {}, { your_position: null }, { your_entry: null }]) assert.throws(() => parseDriverSeatSnapshot(input, scope, 1000));
  for (const extra of [{ sessionKey: "" }, { driverId: "" }, { revision: -1 }, { revision: 0.5 }]) assert.throws(() => parseDriverSeatSnapshot(response(null), { ...scope, ...extra }, 1000));
  for (const now of [-1, 0.5, NaN]) assert.throws(() => parseDriverSeatSnapshot(response(null), scope, now));
});
