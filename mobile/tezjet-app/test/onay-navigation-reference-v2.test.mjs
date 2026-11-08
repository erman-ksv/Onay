import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ONAY_PASSENGER_TABS, onayPassengerTabScrollY } from "../lib/onay-passenger-tabs.ts";

const nav = readFileSync(new URL("../components/OnayPassengerTabBar.tsx", import.meta.url), "utf8");
test("native passenger tabs reproduce original Onay V2 pill geometry and palette", () => {
  assert.match(nav, /width: 304, maxWidth: "100%"/);
  assert.match(nav, /borderWidth: 1, padding: 8, gap: 8/);
  assert.match(nav, /tab: \{ width: 48, height: 48, borderRadius: 24/);
  assert.match(nav, /activeTab: \{ width: 120, backgroundColor: onayDark.accent \}/);
  assert.match(nav, /icon: \{ width: 22, height: 22, tintColor: "#cfe3d8" \}/);
  assert.match(nav, /selectedText: \{ tintColor: onayDark.accentInk \}/);
  assert.match(nav, /pillLight: \{ backgroundColor: "rgba\(255,255,255,0.95\)"/);
});

test("four original vector outlines are rendered as local raster assets, not Unicode glyphs", () => {
  const names = ["home", "trips", "chat", "user"];
  for (const name of names) {
    const asset = new URL("../assets/onay-nav-" + name + ".png", import.meta.url);
    assert.ok(statSync(fileURLToPath(asset)).size > 100, "Missing original icon for " + name);
    assert.ok(nav.includes('require("../assets/onay-nav-' + name + '.png")'));
  }
  assert.ok(nav.includes("source={TAB_ICONS[tab.id]}"));
  assert.ok(nav.includes('accessible={false}'));
  assert.ok(!nav.includes("{tab.symbol}"), "Do not render font-dependent placeholder icons");
});

test("UI changes retain four backend-safe tab navigation handlers, selected state, and contrast", () => {
  assert.deepEqual(ONAY_PASSENGER_TABS.map(tab => tab.id), ["home", "trips", "chats", "profile"]);
  for (const term of [
    'accessibilityRole="tablist"',
    'accessibilityRole="tab"',
    'accessibilityLabel={tab.label}',
    'accessibilityState={{ selected }}',
    'onPress={() => onSelect(tab.id)}',
    'testID={"onay-tab-" + tab.id}',
    'light && !selected && styles.inactiveTabLight',
    'light && !selected && styles.iconLight',
    'selected && styles.selectedText',
  ]) assert.ok(nav.includes(term), "Missing existing selection / navigation guard: " + term);
  assert.equal(onayPassengerTabScrollY("home", { trips: 100, chats: 200, profile: 300 }), 0);
  assert.equal(onayPassengerTabScrollY("trips", { trips: 100, chats: 200, profile: 300 }), 88);
});
