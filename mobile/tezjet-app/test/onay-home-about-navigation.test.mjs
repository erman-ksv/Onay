import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");
const about = readFileSync(new URL("../components/OnayPassengerAbout.tsx", import.meta.url), "utf8");

test("the main home menu opens the same branded About page as passenger profile", () => {
  assert.match(home, /import OnayPassengerAbout from "\.\/OnayPassengerAbout"/);
  assert.match(home, /testID="onay-home-about" onPress=\{\(\) => setAboutOpen\(true\)\}/);
  assert.match(home, /if \(aboutOpen\) \{/);
  assert.match(home, /<OnayPassengerAbout theme=\{theme\} onBack=\{\(\) => \{ setAboutOpen\(false\); setMenuOpen\(false\); \}\} \/>/);
  assert.doesNotMatch(home, /testID="onay-home-about-details"/);
  assert.match(about, /testID="onay-about-real-version"/);
});

test("back returns to a closed menu without affecting the existing booking actions", () => {
  assert.match(home, /setAboutOpen\(false\); setMenuOpen\(false\)/);
  assert.match(home, /onPress=\{\(\) => onChoose\("city"\)\}/);
  assert.match(home, /onPress=\{\(\) => onChoose\("village"\)\}/);
  assert.match(home, /onPress=\{\(\) => onChoose\("address"\)\}/);
  assert.match(home, /onPress=\{onChooseLocation\}/);
});
