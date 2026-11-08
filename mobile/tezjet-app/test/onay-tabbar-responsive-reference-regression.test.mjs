import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const nav = readFileSync(new URL("../components/OnayPassengerTabBar.tsx", import.meta.url), "utf8");

test("reference width overrides the safe floating-pill base without clipping compact screens", () => {
  assert.match(nav, /pill: \{ flexDirection: "row", alignSelf: "center", width: "100%", maxWidth: 336, borderRadius: 40/);
  assert.match(nav, /referencePill: \{ width: 304, maxWidth: "100%" \}/);
  assert.match(nav, /style=\{\[styles\.pill, styles\.referencePill, light && styles\.pillLight\]\}/);
  assert.match(nav, /container: \{ backgroundColor: onayDark\.background, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20 \}/);
  assert.match(nav, /tab: \{ width: 48, height: 48, borderRadius: 24/);
  assert.match(nav, /activeTab: \{ width: 120, backgroundColor: onayDark\.accent \}/);
});

test("design repair retains source icon assets, tab actions, selection and light mode", () => {
  assert.ok(nav.includes('source={TAB_ICONS[tab.id]}'));
  assert.ok(nav.includes('onPress={() => onSelect(tab.id)}'));
  assert.ok(nav.includes('accessibilityState={{ selected }}'));
  assert.ok(nav.includes('accessibilityLabel={tab.label}'));
  assert.ok(nav.includes('light && styles.pillLight'));
  assert.ok(nav.includes('light && !selected && styles.inactiveTabLight'));
});
