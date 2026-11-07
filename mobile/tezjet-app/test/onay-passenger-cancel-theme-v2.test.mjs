import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const from = app.indexOf("passengerOrders.filter(order => !isClosed(order)).map(");
const to = app.indexOf('testID="onay-passenger-history-anchor"', from);
const activeTrips = app.slice(from, to);
const cancelButton = '<Button title={busy ? "Отменяем…" : "Отменить заказ"} onPress={() => cancelOrder(passengerOrder)} disabled={busy} secondary dark={passengerTheme === "dark"} />';

test("passenger active-trip cancellation uses contrast-appropriate secondary button on both themes", () => {
  assert.ok(from >= 0 && to > from, "Server-backed active-trip section must exist");
  assert.ok(activeTrips.includes('<OnayPassengerRide key={passengerOrder.id} order={passengerOrder} theme={passengerTheme}>'));
  assert.ok(activeTrips.includes(cancelButton));
  assert.ok(app.includes("dark && secondary && s.legacyButtonSecondaryDark"));
  assert.ok(app.includes("dark && secondary && s.legacyButtonSecondaryDarkText"));
  assert.ok(app.includes("legacyButtonSecondaryDark:{backgroundColor:onayDark.cardRaised,borderColor:onayDark.border}"));
  assert.ok(app.includes("legacyButtonSecondaryDarkText:{color:onayDark.text}"));
});

test("themed cancel button preserves real order identity and in-flight disabled guard", () => {
  assert.ok(activeTrips.includes('passengerOrders.filter(order => !isClosed(order))'));
  assert.ok(activeTrips.includes('key={passengerOrder.id}'));
  assert.ok(activeTrips.includes('onPress={() => cancelOrder(passengerOrder)} disabled={busy}'));
  assert.ok(activeTrips.includes('title={busy ? "Отменяем…" : "Отменить заказ"}'));
  assert.ok(activeTrips.includes('order={passengerOrder} theme={passengerTheme}'));
  const ride = readFileSync(new URL("../components/OnayPassengerRide.tsx", import.meta.url), "utf8");
  assert.ok(ride.includes('statusLabels[order.status]'));
  assert.ok(ride.includes('{children}'));
  assert.ok(app.includes('testID="driver-order-reject" onPress={rejectOrder} disabled={busy || !isLiveOffer(incomingOrder, profile.id, now)} secondary dark />'));
});
