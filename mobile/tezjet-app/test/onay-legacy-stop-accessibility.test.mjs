import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const first = app.indexOf('<View testID="onay-passenger-legacy-route"');
const last = app.indexOf('<View testID="onay-passenger-chats"', first);
const legacy = app.slice(first, last);

test("C/D route pickup options expose accessible names and server-grounded selected states", () => {
  assert.ok(first > 0 && last > first, "Legacy address booking must remain available");
  assert.ok(legacy.includes('stops.filter(v => v.code === "C" || v.code === "D").map('));
  assert.ok(legacy.includes('testID={"onay-legacy-pickup-" + v.code}'));
  assert.ok(legacy.includes('accessibilityLabel={"Отправление: " + v.name + " (" + v.code + ")"}'));
  assert.ok(legacy.includes('accessibilityState={{ selected: a === v.code }}'));
  assert.ok(legacy.includes('onPress={() => setA(v.code)}'));
});

test("C/D destination options expose accessible names with the real chosen destination", () => {
  assert.ok(legacy.includes('stops.map(v => <Pressable key={"b"+v.id}'));
  assert.ok(legacy.includes('testID={"onay-legacy-destination-" + v.code}'));
  assert.ok(legacy.includes('accessibilityLabel={"Назначение: " + v.name + " (" + v.code + ")"}'));
  assert.ok(legacy.includes('accessibilityState={{ selected: b === v.code }}'));
  assert.ok(legacy.includes('onPress={() => setB(v.code)}'));
  const buttons = legacy.match(/accessibilityRole="button"/g) ?? [];
  assert.equal(buttons.length, 2, "Both stop-choice groups must remain independently accessible");
});

test("accessibility-only changes preserve C/D selections and protected real booking flow", () => {
  assert.ok(legacy.includes('passengerTheme === "dark" && a===v.code && s.legacyStopActiveDark'));
  assert.ok(legacy.includes('passengerTheme === "dark" && b===v.code && s.legacyStopActiveDark'));
  assert.ok(legacy.includes('onPress={order} disabled={busy || !fareFresh || !canOrder || passengerHasActiveOrder || !bookingGate.canSubmit()}'));
  assert.ok(legacy.includes('void refreshAvailability();'));
  assert.ok(legacy.includes('value={address} onChangeText={setAddress}'));
  assert.ok(legacy.includes('onChange={setSeats}'));
});
