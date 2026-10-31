import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const profile = readFileSync(new URL("../components/OnayPassengerProfile.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

test("the passenger personal information section opens as an accessible expandable control", () => {
  assert.match(profile, /testID="onay-profile-personal-data"/);
  assert.match(profile, /accessibilityState=\{\{ expanded: personalOpen \}\}/);
  assert.match(profile, /onPress=\{\(\) => setPersonalOpen\(previous => !previous\)\}/);
  assert.match(profile, /\{personalOpen \? <View testID="onay-profile-personal-details"/);
});

test("personal data is sourced from the authenticated account and never fabricated", () => {
  assert.match(profile, /\{fullName \|\| "Не указано"\}/);
  assert.match(profile, /\{phoneNumber \? <>/);
  assert.match(profile, /\{phoneNumber\}<\/Text>/);
  assert.match(app, /phone_number\?: string/);
  assert.match(app, /phoneNumber=\{profile\.phone_number\}/);
  assert.match(app, /fullName=\{profile\.full_name \|\| ""\}/);
  assert.doesNotMatch(profile, /Поиск водителя|Уведомления/);
});

test("profile actions and current trip navigation remain connected", () => {
  assert.match(profile, /row\("history", "История поездок", onHistory\)/);
  assert.match(profile, /row\("driver", "Режим водителя", onDriver\)/);
  assert.match(profile, /testID="onay-profile-logout"/);
  assert.match(app, /<PassengerHistory /);
});
