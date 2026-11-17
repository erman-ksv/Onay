import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ONAY_PASSENGER_TABS } from "../lib/onay-passenger-tabs.ts";

test("native Onay bottom navigation matches the four tabs in the user's HTML artifact", () => {
  assert.deepEqual(ONAY_PASSENGER_TABS.map(tab => [tab.id, tab.label]), [
    ["home", "Главная"], ["trips", "Поездки"], ["chats", "Чаты"], ["profile", "Профиль"],
  ]);
});

test("four independent screens replace scroll-to-anchor navigation", () => {
  const shell=readFileSync(new URL("../components/OnayPassengerScreens.tsx", import.meta.url), "utf8");
  const app=readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
  assert.ok(shell.includes("pages.map(page =>"));
  assert.ok(shell.includes('scrollEnabled={selected}'));
  assert.ok(shell.includes('accessibilityElementsHidden={!selected}'));
  assert.ok(shell.includes("useSafeAreaInsets()"));
  assert.ok(app.includes("<OnayPassengerScreens"));
  assert.ok(!app.includes("onayPassengerTabScrollY(tab,"));
});

test("tab controls are accessible and are only shown to signed-in passengers", () => {
  const source = readFileSync(new URL("../components/OnayPassengerTabBar.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
  assert.match(source, /accessibilityRole="tab"/);
  assert.match(source, /accessibilityState=\{\{ selected \}\}/);
  assert.match(source, /onPress=\{\(\) => onSelect\(tab\.id\)\}/);
  assert.match(app, /if \(token && profile && activeRole === "passenger" && mode === "passenger"\)/);
  assert.match(app, /<OnayPassengerTabBar active=\{passengerTab\}/);
  assert.match(app, /<PassengerHistory /);
  assert.match(app, /<PassengerRouteOrder /);
});
