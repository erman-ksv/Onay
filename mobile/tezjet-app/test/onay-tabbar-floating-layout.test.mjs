import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../components/OnayPassengerTabBar.tsx", import.meta.url), "utf8");

test("passenger navigation is a centered floating pill with safe outer spacing, like the V2 HTML", () => {
  assert.match(source, /pill: \{ flexDirection: "row", alignSelf: "center", width: "100%", maxWidth: 336, borderRadius: 40/);
  assert.match(source, /container: \{ backgroundColor: onayDark\.background, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20 \}/);
  assert.match(source, /selected \? styles\.activeTab : styles\.inactiveTab/);
  assert.match(source, /backgroundColor: onayDark\.accent/);
});

test("floating layout preserves functional and accessible navigation in both themes", () => {
  assert.match(source, /accessibilityRole="tablist"/);
  assert.match(source, /accessibilityRole="tab"/);
  assert.match(source, /accessibilityLabel=\{tab\.label\}/);
  assert.match(source, /accessibilityState=\{\{ selected \}\}/);
  assert.match(source, /onPress=\{\(\) => onSelect\(tab\.id\)\}/);
  assert.match(source, /light && styles\.pillLight/);
  assert.match(source, /light && !selected && styles\.inactiveTabLight/);
});
