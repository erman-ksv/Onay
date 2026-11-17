import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

test("Home has no nested hamburger page to intercept Android Back", () => {
  assert.doesNotMatch(home, /BackHandler|menuOpen|aboutOpen/);
});
test("Android Back from history uses its recorded origin and profile retains nested Back", () => {
  assert.match(app, /if \(passengerTab === "trips" && tripsHistoryOpen\) \{ closePassengerHistory\(\); return true; \}/);
  assert.match(app, /setPassengerTab\(historyReturnTab.current\)/);
  assert.match(app, /historyReturnTab.current = passengerTab/);
  assert.match(app, /if \(passengerTab === "profile"\) return false/);
});
