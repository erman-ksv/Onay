import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("both passenger and driver buttons remain available regardless of selected mode", () => {
  const source = readFileSync(new URL("../components/OnayAuthScreen.tsx", import.meta.url), "utf8");
  assert.match(source, /accessibilityRole="button"\s+accessibilityState=\{\{ selected: props\.mode === "passenger"/);
  assert.match(source, /testID="onay-auth-role-passenger"/);
  assert.match(source, /onPress=\{\(\) => props\.onMode\("passenger"\)\}/);
  assert.match(source, /testID="onay-auth-role-switch"/);
  assert.match(source, /onPress=\{\(\) => props\.onMode\("driver"\)\}/);
  assert.match(source, />Пассажир<\/Text>/);
  assert.match(source, />Водитель<\/Text>/);
});
