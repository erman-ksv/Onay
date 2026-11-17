import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const start = app.indexOf('<View testID="onay-passenger-legacy-route"');
const end = app.indexOf('<View testID="onay-passenger-chats"', start);
const legacy = app.slice(start, end);

test("C/D pickup address is explicitly optional and explained to screen-reader users", () => {
  assert.ok(start >= 0 && end > start);
  assert.ok(legacy.includes('testID="onay-legacy-pickup-address"'));
  assert.ok(legacy.includes('accessibilityLabel="Уточнение адреса подачи (необязательно)"'));
  assert.ok(legacy.includes('accessibilityHint="Адрес служит уточнением подачи и не меняет выбранный маршрут C/D"'));
  assert.ok(legacy.includes('placeholder="Уточнение адреса подачи (необязательно)"'));
  assert.ok(legacy.includes('value={address} onChangeText={setAddress}'));
  assert.ok(legacy.includes('passengerTheme === "dark" && s.legacyInputDark'));
  assert.ok(legacy.includes('placeholderTextColor={passengerTheme === "dark" ? onayDark.muted : "#71837a"}'));
});

test("address accessibility annotation does not change route and booking admission controls", () => {
  assert.ok(legacy.includes('onPress={() => setA(v.code)}'));
  assert.ok(legacy.includes('onPress={() => setB(v.code)}'));
  assert.ok(legacy.includes('onPress={order} disabled={busy || !fareFresh || !canOrder || passengerHasActiveOrder || !bookingGate.canSubmit()}'));
  assert.ok(legacy.includes('void refreshAvailability();'));
  assert.ok(legacy.includes('Геолокация запрашивается только при оформлении заказа.'));
});
