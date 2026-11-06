import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

test("Android Back closes Home About before the settings menu and leaves normal Home to the OS", () => {
  assert.match(home, /BackHandler\.addEventListener\("hardwareBackPress"/);
  assert.match(home, /if \(aboutOpen\) \{\s*setAboutOpen\(false\);\s*setMenuOpen\(false\);\s*return true;\s*\}/);
  assert.match(home, /if \(menuOpen\) \{\s*setMenuOpen\(false\);\s*return true;\s*\}/);
  assert.match(home, /if \(menuOpen\)[\s\S]*?return false;/);
  assert.match(home, /return \(\) => subscription\.remove\(\)/);
  assert.match(home, /onBack=\{\(\) => \{ setAboutOpen\(false\); setMenuOpen\(false\); \}\}/);
});

test("hidden Home cannot steal Android Back from Trips or Profile", () => {
  assert.match(home, /active\?: boolean/);
  assert.match(home, /if \(!active \|\| Platform\.OS !== "android"\) return/);
  assert.match(home, /\[active, aboutOpen, menuOpen\]/);
  assert.match(app, /<OnayPassengerHome\s+active=\{passengerTab === "home"\}/);
  assert.match(app, /if \(passengerTab === "profile"\) return false/);
  assert.match(app, /if \(passengerTab === "trips" && tripsHistoryOpen\)/);
});
