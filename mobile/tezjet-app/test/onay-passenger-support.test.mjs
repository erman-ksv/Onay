import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const profile = readFileSync(new URL("../components/OnayPassengerProfile.tsx", import.meta.url), "utf8");
const support = readFileSync(new URL("../components/OnayPassengerSupport.tsx", import.meta.url), "utf8");

test("support row opens a distinct support screen with an accessible back action", () => {
  assert.match(profile, /row\("support", "Поддержка", \(\) => setSupportOpen\(true\)\)/);
  assert.match(profile, /if \(supportOpen\)/);
  assert.match(profile, /<OnayPassengerSupport theme=\{theme\} onBack=\{\(\) => setSupportOpen\(false\)\}/);
  assert.match(support, /testID="onay-passenger-support-screen"/);
  assert.match(support, /testID="onay-support-back"/);
  assert.match(support, /onPress=\{onBack\}/);
});

test("support screen matches user HTML: email is actionable, fake support chat is not", () => {
  assert.match(support, /Поможем с заказом, оплатой или работой приложения/);
  assert.match(support, /testID="onay-support-email"/);
  assert.match(support, /Linking\.openURL\("mailto:" \+ SUPPORT_EMAIL\)/);
  assert.match(support, /SUPPORT_EMAIL = "onayost\.taxi@gmail\.com"/);
  assert.match(support, /testID="onay-support-chat-unavailable"/);
  assert.match(support, /Пока недоступен/);
  assert.doesNotMatch(support, /request\(|socket\.emit\(|TextInput/);
});

test("support keeps both themes, branded footer and existing profile actions", () => {
  assert.match(support, /light && styles\.rootLight/);
  assert.match(support, /light && styles\.listLight/);
  assert.match(support, /© 2026 ONAY OST E\.K\.K Technologies/);
  assert.match(profile, /row\("history", "История поездок", onHistory\)/);
  assert.match(profile, /testID="onay-profile-logout"/);
});
