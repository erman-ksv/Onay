import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");

test("light menu keeps payment, about details and chevrons legible on white", () => {
  assert.match(source, /testID="onay-home-settings-menu"/);
  assert.match(source, /settingsMutedLight: \{ color: "#546b5e" \}/);
  assert.match(source, /style=\{\[h\.settingsMuted, light && h\.settingsMutedLight\]\}>Наличными/);
  assert.match(source, /testID="onay-home-about-details" style=\{\[h\.settingsMuted, light && h\.settingsMutedLight\]\}/);
  assert.match(source, /style=\{\[h\.settingsMuted, light && h\.settingsMutedLight\]\}>›/);
});

test("light and dark theme buttons retain selection, labels and callbacks", () => {
  assert.match(source, /accessibilityLabel=\{value === "light" \? "Светлая тема" : "Тёмная тема"\}/);
  assert.match(source, /accessibilityState=\{\{ selected: theme === value \}\}/);
  assert.match(source, /onPress=\{\(\) => onThemeChange\?\.\(value\)\}/);
  assert.match(source, /style=\{\[h\.themeToggle, light && h\.themeToggleLight, theme === value && h\.themeActive\]\}/);
  assert.match(source, /themeToggleLight: \{ backgroundColor: "#e6f0ea" \}/);
  assert.match(source, /theme === value \? onayDark\.accentInk : \(light \? "#0e1a14" : onayDark\.text\)/);
});
