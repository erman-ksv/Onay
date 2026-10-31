import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");
const profile = readFileSync(new URL("../components/OnayPassengerProfile.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

test("home menu has the requested cash payment, theme, about and actual app version", () => {
  assert.match(home, /testID="onay-home-menu-open"/);
  assert.match(home, /testID="onay-home-settings-menu"/);
  assert.match(home, /Способ оплаты/);
  assert.match(home, /Наличными/);
  assert.match(home, /Режим света/);
  assert.match(home, /О приложении/);
  assert.match(home, /Constants\.expoConfig\?\.version/);
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
