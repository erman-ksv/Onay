import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const shiftStart = app.indexOf('<View style={[s.card, s.driverShiftCard]} testID="onay-driver-shift">');
const shiftEnd = app.indexOf("{incomingOrder ? ", shiftStart);
const shift = app.slice(shiftStart, shiftEnd);

test("driver shift shows dark Onay V2 colors for queue, free seats and seat selector", () => {
  assert.ok(shiftStart > 0 && shiftEnd > shiftStart);
  for (const name of ["driverShiftCard", "driverShiftHeading", "driverShiftText", "driverShiftLabel", "driverShiftNote"]) {
    assert.ok(shift.includes("s." + name), "Missing applied shift style: " + name);
  }
  for (const name of ["card", "border", "text", "muted", "cardRaised", "accent"]) {
    assert.ok(app.includes("onayDark." + name), "Missing Onay palette token: " + name);
  }
  for (const name of ["driverStepButton", "driverStepText", "driverStepValue"]) {
    assert.ok(app.includes("dark && s." + name), "Missing dark stepper style: " + name);
  }
  assert.ok(shift.includes('onChange={setDriverSeats}'));
  assert.ok(shift.includes('dark />'));
  assert.ok(app.includes('<Stepper value={seats} onChange={setSeats} dark={passengerTheme === "dark"} />'),
    "Passenger C/D stepper must preserve seat state and update handler while following the selected theme");
  assert.ok(app.includes('onPress={() => onChange(Math.max(min, value - 1))}'), "Stepper decrement retains minimum bound");
  assert.ok(app.includes('onPress={() => onChange(Math.min(max, value + 1))}'), "Stepper increment retains maximum bound");
});

test("driver shift remains server-backed with safe queue and departure controls", () => {
  for (const id of ["driver-queue-status","driver-free-seats","driver-free-seats-refresh","driver-queue-join","driver-queue-location","driver-queue-leave","driver-line-join","driver-line-depart","driver-line-depart-confirm","driver-line-depart-cancel"]) {
    assert.ok(shift.includes('testID="' + id + '"'), "Missing control: " + id);
  }
  for (const guard of ['queueMembership === "unknown"', 'driverSeatSnapshot.checkedAt', 'disabled={busy || !!incomingOrder || !canJoinQueue}', 'disabled={busy || !!incomingOrder || !canDepartLine(lineState)}', 'onPress={joinQueue}', 'onPress={leaveQueue}', 'onPress={() => { void departLine(departureConfirmation.enrollmentId); }}']) {
    assert.ok(shift.includes(guard), "Queue admission or departure guard changed: " + guard);
  }
});
