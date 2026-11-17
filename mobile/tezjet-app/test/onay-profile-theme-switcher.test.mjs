import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const profile = readFileSync(new URL("../components/OnayPassengerProfile.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

test("profile theme controls have readable light surfaces and labels for screen readers", () => {
  assert.ok(profile.includes("light && s.themeButtonsLight"));
  assert.ok(profile.includes("light && s.themeButtonLight"));
  assert.ok(profile.includes('themeButtonsLight: { backgroundColor: "#e6f0ea" }'));
  assert.ok(profile.includes('themeButtonLight: { backgroundColor: "#f8fbf9" }'));
  assert.ok(profile.includes('light ? "#194b34" : muted'));
  assert.ok(profile.includes('accessibilityLabel={value === "light" ? "Светлая тема" : "Тёмная тема"}'));
});

test("theme selection still invokes saved theme choice, and other profile actions remain", () => {
  assert.ok(profile.includes('testID={"onay-profile-theme-" + value}'));
  assert.ok(profile.includes("accessibilityState={{ selected: theme === value }}"));
  assert.ok(profile.includes("onPress={() => onThemeChange(value)}"));
  assert.ok(profile.includes("theme === value && s.themeSelected"));
  assert.ok(app.includes('AsyncStorage.setItem("onay_passenger_theme_v1", value)'));
  assert.ok(profile.includes('row("history", "История поездок", onHistory)'));
  assert.ok(profile.includes('row("support", "Поддержка", () => setSupportOpen(true))'));
});
