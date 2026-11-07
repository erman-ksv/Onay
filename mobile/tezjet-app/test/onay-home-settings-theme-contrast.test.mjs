import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");
const about = readFileSync(new URL("../components/OnayPassengerAbout.tsx", import.meta.url), "utf8");

const profile = readFileSync(new URL("../components/OnayPassengerProfile.tsx", import.meta.url), "utf8");
test("theme and About remain legible in profile without a second Home settings menu", () => {
  assert.doesNotMatch(source, /onay-home-settings-menu|onay-home-menu-open/);
  assert.match(profile, /light \? "#6a7b72" : onayDark.muted/);
  assert.match(profile, /accessibilityLabel=\{value === "light" \? "Светлая тема" : "Тёмная тема"\}/);
  assert.match(profile, /accessibilityState=\{\{ selected: theme === value \}\}/);
  assert.match(profile, /onPress=\{\(\) => onThemeChange\(value\)\}/);
  assert.match(about, /light && styles\.rootLight/);
  assert.match(about, /testID="onay-about-real-version"/);
});
