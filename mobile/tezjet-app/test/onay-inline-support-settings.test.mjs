import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("profile languages use one persisted locale, KZ means kk, and driver phone stays API-derived", () => {
 const inline = read("../components/OnayInlineLanguage.tsx");
 assert.match(inline, /code: "kk", caption: "KZ"/);
 assert.match(inline, /changeLanguage\(item.code\)/);
 assert.match(inline, /accessibilityRole="radiogroup"/);
 assert.match(read("../components/OnayPassengerProfile.tsx"), /testID="onay-profile-language"/);
 assert.match(read("../components/OnayDriverProfile.tsx"), /testID="onay-driver-language"/);
 assert.match(read("../app/index.tsx"), /phoneNumber=\{profile.phone_number\}/);
 assert.match(read("../lib/onay-language-context.tsx"), /AsyncStorage.setItem\(LANGUAGE_KEY, value\)/);
});

test("support copies project email without sending messages in preview; legal links are not invented", () => {
 const support = read("../components/OnayPassengerSupport.tsx");
 assert.match(support, /SUPPORT_EMAIL = "onayost.taxi@gmail.com"/);
 assert.match(support, /Clipboard.setStringAsync\(SUPPORT_EMAIL\)/);
 assert.match(support, /testID="onay-support-copy-email"/);
 assert.match(support, /if \(previewOnly\) return/);
 assert.match(read("../components/OnayDemoApp.tsx"), /<OnayPassengerSupport theme=\{theme\} previewOnly/);
 const about = read("../components/OnayPassengerAbout.tsx");
 assert.match(about, /onay-legal-privacy-unavailable/);
 assert.match(about, /onay-legal-terms-unavailable/);
 assert.doesNotMatch(about, /https:\/\/.*privacy|https:\/\/.*terms/);
});

test("driver sound setting is marked unavailable rather than a fake toggle; actual queue methods stay connected", () => {
 const profile = read("../components/OnayDriverProfile.tsx");
 assert.match(profile, /onay-driver-sound-unavailable/);
 assert.match(profile, /approval === "pending" \? "На проверке" : "Статус недоступен"/);
 assert.doesNotMatch(profile, /onay-driver-sound-switch/);
 assert.match(read("../../../scripts/onay-demo-browser-qa.py"), /page.get_by_test_id\("onay-support-back"\)\.click\(\)/);
 const app = read("../app/index.tsx");
 assert.match(app, /onOnline=\{\(\) => \{ if \(queueMembership === "enrolled"\) void leaveQueue\(\); else if \(canJoinQueue\) void joinQueue\(\);/);
});
