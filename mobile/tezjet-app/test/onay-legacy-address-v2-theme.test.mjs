import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onayPassengerHomeTarget } from "../lib/onay-home-modes.ts";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const begin = app.indexOf('<View testID="onay-passenger-legacy-route"');
const end = app.indexOf('<View testID="onay-passenger-chats"', begin);
const legacy = app.slice(begin, end);

test("Onay address mode keeps the existing C/D route booking reachable", () => {
  assert.deepEqual(onayPassengerHomeTarget("address"), { section: "legacy", direction: null });
  assert.ok(begin > 0 && end > begin);
  assert.ok(legacy.includes("setLegacySectionY(event.nativeEvent.layout.y)"));
  assert.ok(legacy.includes('onPress={() => setA(v.code)}'));
  assert.ok(legacy.includes('onPress={() => setB(v.code)}'));
  assert.ok(legacy.includes('value={address} onChangeText={setAddress}'));
  assert.ok(legacy.includes('onChange={setSeats}'));
  assert.ok(legacy.includes("fareFresh && fare ? formatFareMoney(fare)"));
  assert.ok(legacy.includes("availabilityDisplay.label"));
});

test("legacy C/D route follows light/dark theme without losing accessibly named actions", () => {
  assert.ok(legacy.includes("По своему адресу · маршрут C/D"));
  for (const style of ["darkPassengerTripCard", "darkPassengerTripTitle", "darkPassengerTripMuted", "legacyStopDark", "legacyStopActiveDark", "legacyInputDark", "legacyFareDark", "legacyPriceDark", "legacySmallDark"]) {
    assert.ok(legacy.includes("s." + style), "Legacy route theme missing " + style);
  }
  assert.ok(legacy.includes('testID="onay-legacy-check-availability"'));
  assert.ok(legacy.includes('testID="onay-legacy-book-trip"'));
  assert.ok(legacy.includes('dark={passengerTheme === "dark"}'));
  for (const style of ["legacyButtonDark", "legacyButtonDarkText"]) {
    assert.ok(app.includes("dark && s." + style), "Shared primary button theme missing " + style);
  }
  for (const style of ["legacyButtonSecondaryDark", "legacyButtonSecondaryDarkText"]) {
    assert.ok(app.includes("dark && secondary && s." + style), "Shared secondary button must keep both dark and secondary guards: " + style);
  }
  assert.ok(legacy.includes('disabled={busy || checkingAvailability} secondary dark={passengerTheme === "dark"}'),
    "Availability remains disabled during checks while using the secondary theme");
  assert.ok(legacy.includes('disabled={busy || !fareFresh || !canOrder || passengerHasActiveOrder || !bookingGate.canSubmit()} dark={passengerTheme === "dark"}'),
    "Booking action keeps all safety conditions when themed");
  assert.ok(app.includes('disabled={disabled} style={[s.button, dark && s.legacyButtonDark'));
  assert.ok(app.includes('accessibilityRole="button" accessibilityState={{ disabled }}'));
});

test("original C/D booking safety and availability guards are preserved", () => {
  assert.ok(legacy.includes('onPress={order} disabled={busy || !fareFresh || !canOrder || passengerHasActiveOrder || !bookingGate.canSubmit()}'));
  assert.ok(legacy.includes('void refreshAvailability();'));
  assert.ok(legacy.includes('disabled={busy || checkingAvailability}'));
  assert.ok(legacy.includes('availabilityDisplay.state === "unavailable"'));
  assert.ok(legacy.includes('Геолокация запрашивается только при оформлении заказа.'));
  assert.ok(legacy.includes('Точка') === false || legacy.includes('ТОЧКА')); // labels remain distinct from navigation
});
