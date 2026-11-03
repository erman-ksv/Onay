import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const home = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");

test("native home approximates supplied V2 route diagram without inventing live driver markers", () => {
  assert.ok(home.includes('testID="onay-home-map-schematic"'));
  assert.ok(home.includes('Reference-based route artwork'));
  assert.ok(home.includes('[-135, -55, 25, 105, 185, 265, 345, 425].map('));
  assert.ok(home.includes('[-170, -90, -10, 70, 150, 230, 310].map('));
  assert.ok(home.includes('gridSlope: {'));
  assert.ok(home.includes('gridCross: {'));
  assert.ok(home.includes('rotate: "25deg"'));
  assert.ok(home.includes('backgroundColor: "#0d2a1f"'));
  assert.ok(home.includes('backgroundColor: "#244b39"'));
  for (const stop of ["Shaxsham", "Qoramazor", "Gazalkent"]) {
    assert.ok(home.includes(">" + stop + "</Text>"), "Missing reference stop: " + stop);
  }
  assert.ok(home.includes('Не GPS · данные и наличие водителей — в форме заказа'));
});

test("V2 card sizes, brand palette and real booking interactions remain aligned", () => {
  assert.ok(home.includes('primaryMode: { backgroundColor: onayDark.accent }'));
  assert.ok(home.includes('primaryIcon: { backgroundColor: "rgba(8,38,26,0.14)" }'));
  assert.ok(home.includes('secondaryMode: { flexDirection: "column", alignItems: "flex-start", backgroundColor: onayDark.card, minHeight: 154 }'));
  assert.ok(home.includes('modeTitle: { color: onayDark.text, fontWeight: "700", fontSize: 17 }'));
  for (const item of [
    'testID="onay-home-to-city"', 'testID="onay-home-to-village"', 'testID="onay-home-to-address"',
    'onPress={() => onChoose("city")}', 'onPress={() => onChoose("village")}',
    'onPress={() => onChoose("address")}', 'onPress={onChooseLocation}',
    'onPress={onViewActiveOrder}', 'accessibilityLabel={menuOpen ? "Закрыть настройки" : "Открыть настройки"}'
  ]) assert.ok(home.includes(item), "Existing handler must remain: " + item);
  assert.ok(home.includes('Уточнение подачи на маршруте C/D'));
});
