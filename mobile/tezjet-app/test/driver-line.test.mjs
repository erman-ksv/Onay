import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLineCollectionState, canBoardLinePassenger, canDepartLine, lineDepartBody, nextDriverTripStatus } from "../lib/driver-line.ts";

const receipt = { collectionState: { version: 1, enrollmentId: "enroll-1", phase: "collecting", capacity: 4 } };
const ride = { id: "r1", status: "arrived_at_c", driver_id: "driver-1", seats: 1 };

test("server enrollment receipt is required; old queue cannot depart as line", () => {
  assert.equal(parseLineCollectionState(null), null);
  assert.equal(parseLineCollectionState({}), null);
  const line = parseLineCollectionState(receipt);
  assert.equal(lineDepartBody(line).expected_enrollment_id, "enroll-1");
  assert.equal(canDepartLine(line), true);
  assert.equal(canDepartLine(null), false);
  assert.throws(() => lineDepartBody(null));
});
test("driver boarding only available for collecting line and arrived passenger", () => {
  const line = parseLineCollectionState(receipt);
  assert.equal(canBoardLinePassenger(line, ride), true);
  for (const status of ["searching", "en_route_to_c", "boarded_waiting", "in_transit", "completed", "cancelled"])
    assert.equal(canBoardLinePassenger(line, { ...ride, status }), false);
  assert.equal(canBoardLinePassenger(null, ride), false);
  assert.equal(canBoardLinePassenger({ ...line, phase: "departed" }, ride), false);
});
test("reject forged, missing, malformed or changed line enrollment receipts", () => {
  for (const value of [
    { ...receipt, collectionState: { ...receipt.collectionState, enrollmentId: "" } },
    { ...receipt, collectionState: { ...receipt.collectionState, version: 2 } },
    { ...receipt, collectionState: { ...receipt.collectionState, phase: "started" } },
    { ...receipt, collectionState: { ...receipt.collectionState, capacity: 9 } },
    { collectionState: [] },
  ]) assert.throws(() => parseLineCollectionState(value));
  const departed = parseLineCollectionState({ collectionState: { ...receipt.collectionState, phase: "departed" } });
  assert.equal(canDepartLine(departed), false);
});

test("collecting driver cannot use legacy start-trip button or handler", () => {
  const line = parseLineCollectionState(receipt);
  assert.equal(nextDriverTripStatus(line, ride), null);
  assert.equal(nextDriverTripStatus(line, { ...ride, status: "en_route_to_c" }), "arrived_at_c");
  assert.equal(nextDriverTripStatus(line, { ...ride, status: "boarded_waiting" }), null);
  assert.equal(nextDriverTripStatus(line, { ...ride, status: "in_transit" }), "completed");
  assert.equal(nextDriverTripStatus(null, ride), "in_transit");
  assert.equal(nextDriverTripStatus({ ...line, phase: "departed" }, ride), "in_transit");
});
