import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

test("active trip banner is shown only for an actual active ride and is an accessible button", () => {
  assert.match(home, /\{activeOrder \? <Pressable/);
  assert.match(home, /testID="onay-home-active-trip"/);
  assert.match(home, /accessibilityRole="button"/);
  assert.match(home, /accessibilityLabel="Посмотреть активную поездку"/);
  assert.match(home, /onPress=\{onViewActiveOrder\}/);
  assert.doesNotMatch(home, /Подробности — ниже/);
});

test("active trip button navigates to existing API-backed trips without creating an order", () => {
  assert.match(app, /activeOrder=\{passengerHasActiveOrder\}/);
  assert.match(app, /onViewActiveOrder=\{\(\) => selectPassengerTab\("trips"\)\}/);
  assert.match(app, /<PassengerHistory /);
  assert.match(app, /onayPassengerTabScrollY\(tab,/);
});
