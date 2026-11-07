import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");
const profile = readFileSync(new URL("../components/OnayPassengerProfile.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

test("home has no hamburger; profile retains theme, about, version and language", () => {
  assert.doesNotMatch(home, /onay-home-menu-open|onay-home-settings-menu/);
  assert.match(profile, /onay-profile-theme-/);
  assert.match(profile, /row\("about", "О приложении"/);
  assert.match(profile, /testID="onay-profile-language"/);
  assert.match(profile, /Constants\.expoConfig\?\.version/);
});

test("passenger profile uses real user data, current version and existing actions", () => {
  assert.match(profile, /fullName \|\| "Пассажир Onay"/);
  assert.match(profile, /Constants\.expoConfig\?\.version/);
  assert.match(profile, /row\("history", "История поездок"/);
  assert.match(profile, /onDriver/);
  assert.match(profile, /onLogout/);
  assert.doesNotMatch(profile, /Поиск водителя|Уведомления/);
  assert.match(app, /<OnayPassengerProfile/);
  assert.match(app, /onDriver=\{\(\) => \{ void switchMode\("driver"\); \}\}/);
});

test("theme setting is persisted independently of authentication tokens", () => {
  assert.match(app, /AsyncStorage\.getItem\("onay_passenger_theme_v1"\)/);
  assert.match(app, /AsyncStorage\.setItem\("onay_passenger_theme_v1", value\)/);
  assert.match(app, /theme=\{passengerTheme\}/);
});

test("profile header uses the real authenticated phone and has a safe fallback", () => {
  assert.match(profile, /testID="onay-profile-header-phone"/);
  assert.match(profile, /phoneNumber \|\| "Аккаунт пассажира"/);
  assert.match(app, /phoneNumber=\{profile\.phone_number\}/);
  assert.match(app, /fullName=\{profile\.full_name \|\| ""\}/);
  assert.doesNotMatch(profile, /\+998 90 123 45 67/);
});
