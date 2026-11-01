import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const start = app.indexOf('<View style={[s.card, s.driverShiftCard]} testID="onay-driver-shift">');
const end = app.indexOf("{!driverRouteGate.hasChoice && !driverQueueContext", start);
const controls = app.slice(start, end);

test("driver shift, offers and active trips apply dark theme to every action", () => {
  assert.ok(start > 0 && end > start, "Driver action section must exist");
  const buttons = controls.match(/<Button\b[\s\S]*?\/>/g) ?? [];
  assert.equal(buttons.length, 12, "Guard against silent removal or addition of driver actions");
  for (const button of buttons) {
    assert.match(button, /\sdark\s*\/>$/, "Driver action would render a light button on a dark card");
  }
  assert.ok(app.includes('dark && s.legacyButtonDark'));
  assert.ok(app.includes('dark && secondary && s.legacyButtonSecondaryDark'));
  assert.ok(app.includes('dark && secondary && s.legacyButtonSecondaryDarkText'));
});

test("driver action visual changes preserve all backend and safety guards", () => {
  for (const id of [
    "driver-free-seats-refresh", "driver-queue-join", "driver-queue-location",
    "driver-queue-leave", "driver-line-join", "driver-line-depart",
    "driver-line-depart-confirm", "driver-line-depart-cancel",
    "driver-order-accept", "driver-order-reject",
    "driver-line-board"
  ]) {
    assert.ok(controls.includes('testID="' + id + '"'), "Missing driver action: " + id);
  }
  assert.ok(controls.includes('testID={\`driver-trip-progress-\${activeOrder.id}\`}'));
  assert.ok(controls.includes('testID="driver-queue-join" onPress={joinQueue} disabled={busy || !!incomingOrder || !canJoinQueue} dark />'));
  assert.ok(controls.includes('testID="driver-line-depart" onPress={confirmLineDeparture} disabled={busy || !!incomingOrder || !canDepartLine(lineState)} dark />'));
  assert.ok(controls.includes('testID="driver-order-accept" onPress={acceptOrder} disabled={busy || !isLiveOffer(incomingOrder, profile.id, now)} dark />'));
  assert.ok(controls.includes('testID="driver-order-reject" onPress={rejectOrder} disabled={busy || !isLiveOffer(incomingOrder, profile.id, now)} secondary dark />'));
  assert.ok(controls.includes('onPress={() => { void departLine(departureConfirmation.enrollmentId); }} disabled={busy || !!incomingOrder} dark />'));
  assert.ok(controls.includes('onPress={() => progressOrder(activeOrder)} disabled={busy} dark />'));
  assert.ok(app.includes('<Button title={busy ? "Отменяем…" : "Отменить заказ"} onPress={() => cancelOrder(passengerOrder)} disabled={busy} secondary />'),
    "Passenger cancellation must remain unaffected");
});
