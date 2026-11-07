import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onayTabWidths } from "../lib/onay-tab-layout.ts";

const nav = readFileSync(new URL("../components/OnayPassengerTabBar.tsx", import.meta.url), "utf8");

test("four real nav buttons fit 280, 320, 360, 390, 430 and 768dp viewports without clipping", () => {
  for (const viewport of [280, 320, 360, 390, 430, 768]) {
    const { active, inactive, pill } = onayTabWidths(viewport);
    const occupied = active + inactive * 3 + 2 * (8 + 1) + 3 * 8;
    assert.ok(occupied <= pill, "Overflows " + viewport + "dp: " + occupied + " > " + pill);
    assert.ok(pill <= viewport - 40, "Pill intrudes on outer safe horizontal padding");
    assert.ok(active > inactive, "Selected tab must remain wider than others");
    assert.ok(active <= 120 && inactive <= 48, "Do not exceed the supplied V2 reference geometry");
  }
});

test("tab geometry retains familiar reference sizing at normal width and shrinks on 320dp screens", () => {
  const normal = onayTabWidths(390);
  const compact = onayTabWidths(320);
  assert.equal(normal.pill, 304);
  assert.equal(compact.pill, 280);
  assert.ok(normal.active >= 118 && normal.inactive >= 47);
  assert.ok(compact.active < normal.active && compact.inactive < normal.inactive);
  assert.deepEqual(onayTabWidths(NaN), normal);
  assert.deepEqual(onayTabWidths(0), normal);
});

test("live tab bar applies responsive geometry without losing accessibility, safe area, themes or navigation", () => {
  assert.ok(nav.includes("useWindowDimensions()"));
  assert.ok(nav.includes("onayTabWidths(viewportWidth)"));
  assert.ok(nav.includes("{ width: selected ? tabWidths.active : tabWidths.inactive }"));
  for (const marker of [
    'useSafeAreaInsets()', 'paddingBottom: Math.max(20, insets.bottom)',
    'light && styles.pillLight', 'light && !selected && styles.inactiveTabLight',
    'accessibilityRole="tab"', 'accessibilityState={{ selected }}',
    'onPress={() => onSelect(tab.id)}', 'source={TAB_ICONS[tab.id]}',
  ]) assert.ok(nav.includes(marker), "Missing UI behavior: " + marker);
});
