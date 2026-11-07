import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");
const about = readFileSync(new URL("../components/OnayPassengerAbout.tsx", import.meta.url), "utf8");

const profile = readFileSync(new URL("../components/OnayPassengerProfile.tsx", import.meta.url), "utf8");
test("About is available from profile after removing the Home hamburger", () => {
  assert.doesNotMatch(home, /onay-home-menu-open|onay-home-about|menuOpen|aboutOpen/);
  assert.match(profile, /row\("about", "О приложении", \(\) => setAboutOpen\(true\)\)/);
  assert.ok(profile.includes('<OnayPassengerAbout theme={theme} onBack={() => setAboutOpen(false)} />'));
  assert.ok(about.includes('backLabel = "Назад в профиль"'));
  assert.ok(about.includes('accessibilityLabel={backLabel}'));
  assert.match(about, /testID="onay-about-real-version"/);
});
test("removing menu retains all route and active-trip actions", () => {
  for (const choice of ["city", "village", "address"]) assert.ok(home.includes('onPress={() => onChoose("'+choice+'")}'));
  assert.ok(home.includes('onPress={onChooseLocation}'));
  assert.ok(home.includes('onPress={onViewActiveOrder}'));
});
