import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const profile = readFileSync(new URL("../components/OnayPassengerProfile.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

test("passenger personal information opens a native full page with a working Back handler", () => {
  assert.match(profile, /testID="onay-profile-personal-data"/);
  assert.match(profile, /if \(personalOpen\) return <Modal visible/);
  assert.match(profile, /<OnayPersonalDetails theme=\{theme\}/);
  const personal = readFileSync(new URL("../components/OnayPersonalDetails.tsx", import.meta.url), "utf8");
  assert.match(personal, /title="Личные данные"/);
  assert.match(personal, /onBack=\{onBack\}/);
  assert.match(profile, /accessibilityState=\{\{ expanded: personalOpen \}\}/);
  assert.match(profile, /onPress=\{\(\) => setPersonalOpen\(previous => !previous\)\}/);
  assert.match(profile, /if \(personalOpen\) return <Modal visible/);
});

test("personal data is sourced from the authenticated account and never fabricated", () => {
  const details = readFileSync(new URL("../components/OnayPersonalDetails.tsx", import.meta.url), "utf8");
  assert.match(details, /fullName \|\| "Не указано"/);
  assert.match(details, /phoneNumber \|\| "Не указан"/);
  assert.match(app, /phone_number\?: string/);
  assert.match(app, /phoneNumber=\{profile\.phone_number\}/);
  assert.match(app, /fullName=\{profile\.full_name \|\| ""\}/);
  assert.doesNotMatch(profile, /Поиск водителя|Уведомления/);
});

test("profile actions and current trip navigation remain connected", () => {
  assert.match(profile, /row\("history", "История поездок", onHistory\)/);
  assert.match(profile, /row\("driver", "Режим водителя", \(\) => setDriverModeOpen\(true\)\)/);
  assert.match(profile, /testID="onay-profile-logout"/);
  assert.match(app, /<PassengerHistory /);
});
