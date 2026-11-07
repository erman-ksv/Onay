import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const profile = readFileSync(new URL("../components/OnayPassengerProfile.tsx", import.meta.url), "utf8");
const about = readFileSync(new URL("../components/OnayPassengerAbout.tsx", import.meta.url), "utf8");

test("about opens a dedicated V2 page and returns to the existing passenger profile", () => {
  assert.match(profile, /row\("about", "О приложении", \(\) => setAboutOpen\(true\)\)/);
  assert.match(profile, /if \(aboutOpen\)/);
  assert.match(profile, /<OnayPassengerAbout theme=\{theme\} onBack=\{\(\) => setAboutOpen\(false\)\}/);
  assert.match(about, /testID="onay-passenger-about-screen"/);
  assert.match(about, /testID="onay-about-back"/);
  assert.match(about, /onPress=\{onBack\}/);
  assert.doesNotMatch(profile, /\{aboutOpen \? <View/);
});

test("about page uses the confirmed Onay logo, actual app version and company attribution", () => {
  assert.match(about, /onay-original-logo\.png/);
  assert.match(about, /Constants\.expoConfig\?\.version/);
  assert.match(about, /testID="onay-about-real-version"/);
  assert.match(about, /ONAY OST E\.K\.K Technologies/);
  assert.match(about, /One Founder\. Intelligent Systems\./);
  assert.doesNotMatch(about, /2\.0\.0/);
  assert.match(about, /Политика конфиденциальности/);
  assert.match(about, /Условия использования/);
  assert.match(about, /Документ не опубликован/);
});

test("both themes work while profile history, support, driver mode and logout stay connected", () => {
  assert.match(about, /light && styles\.rootLight/);
  assert.match(about, /light && styles\.companyCardLight/);
  assert.match(profile, /row\("history", "История поездок", onHistory\)/);
  assert.match(profile, /row\("driver", "Режим водителя", onDriver\)/);
  assert.match(profile, /row\("support", "Поддержка", \(\) => setSupportOpen\(true\)\)/);
  assert.match(profile, /testID="onay-profile-logout"/);
});
