import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ONAY_PASSENGER_TABS, onayPassengerTabScrollY } from "../lib/onay-passenger-tabs.ts";

test("native Onay bottom navigation matches the four tabs in the user's HTML artifact", () => {
  assert.deepEqual(ONAY_PASSENGER_TABS.map(tab => [tab.id, tab.label]), [
    ["home", "Главная"], ["trips", "Поездки"], ["chats", "Чаты"], ["profile", "Профиль"],
  ]);
});

test("tabs only scroll to measured sections and never invent a booking", () => {
  const anchors = { trips: 450, chats: 980, profile: 1340 };
  assert.equal(onayPassengerTabScrollY("home", anchors), 0);
  assert.equal(onayPassengerTabScrollY("trips", anchors), 438);
  assert.equal(onayPassengerTabScrollY("chats", anchors), 968);
  assert.equal(onayPassengerTabScrollY("profile", anchors), 1328);
  assert.equal(onayPassengerTabScrollY("trips", { ...anchors, trips: 0 }), 0);
});

test("tab controls are accessible and are only shown to signed-in passengers", () => {
  const source = readFileSync(new URL("../components/OnayPassengerTabBar.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
  assert.match(source, /accessibilityRole="tab"/);
  assert.match(source, /accessibilityState=\{\{ selected \}\}/);
  assert.match(source, /onPress=\{\(\) => onSelect\(tab\.id\)\}/);
  assert.match(app, /token && profile && activeRole === "passenger" && mode === "passenger" \? <OnayPassengerTabBar/);
  assert.match(app, /<PassengerHistory /);
  assert.match(app, /<PassengerRouteOrder /);
});
