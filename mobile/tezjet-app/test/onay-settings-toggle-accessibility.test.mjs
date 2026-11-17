import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");

const profile = readFileSync(new URL("../components/OnayPassengerProfile.tsx", import.meta.url), "utf8");
const language = readFileSync(new URL("../components/OnayLanguageSettings.tsx", import.meta.url), "utf8");
test("removed Home hamburger is not focusable; language options expose radio selection", () => {
  assert.doesNotMatch(home, /onay-home-menu-open|onay-home-settings-menu/);
  assert.match(profile, /testID="onay-profile-language"/);
  assert.match(language, /accessibilityRole="radiogroup"/);
  assert.match(language, /accessibilityRole="radio"/);
  assert.match(language, /accessibilityState=\{\{ checked: language === item.code \}\}/);
  assert.match(language, /onPress=\{\(\) => changeLanguage\(item.code\)\}/);
});
