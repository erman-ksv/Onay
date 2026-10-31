import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const booking = readFileSync(new URL("../components/PassengerRouteOrder.tsx", import.meta.url), "utf8");

test("native home choices pass direction to the backend-backed booking component", () => {
  assert.match(app, /setBookingDirectionIntent\(previous => \(\{/);
  assert.match(app, /direction: target\.direction!/);
  assert.match(app, /<PassengerRouteOrder[^>]*directionIntent=\{bookingDirectionIntent\}/);
});

test("home direction intent clears stale quote and route segment, preserving the existing submit gate", () => {
  assert.match(booking, /appliedDirectionIntent\.current = directionIntent\.revision/);
  assert.match(booking, /requestScope\.current\.cancelAvailability\(\)/);
  assert.match(booking, /setAvailability\(null\)/);
  assert.match(booking, /setSegmentDraft\(null\)/);
  assert.match(booking, /setDirection\(directionIntent\.direction\)/);
  assert.match(booking, /bookingGate\.canSubmit\(\)/);
  assert.match(booking, /saveRouteBookingRecovery\(AsyncStorage, recoveryKey/);
});
