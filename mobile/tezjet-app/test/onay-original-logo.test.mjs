import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("screens use the newly confirmed logo while the earlier artifact remains preserved", () => {
  const home = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");
  const auth = readFileSync(new URL("../components/OnayAuthScreen.tsx", import.meta.url), "utf8");
  for (const screen of [home, auth]) {
    assert.match(screen, /source=\{require\("\.\.\/assets\/onay-confirmed-logo\.jpg"\)\}/);
    assert.match(screen, /accessibilityLabel="Onay"/);
  }
  assert.match(home, /testID="onay-home-original-logo"/);
  assert.match(auth, /testID="onay-auth-original-logo"/);
});

test("the earlier Onay V2 logo stays available as an unchanged 240px transparent PNG", () => {
  const png = readFileSync(new URL("../assets/onay-original-logo.png", import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  assert.equal(png.readUInt32BE(16), 240);
  assert.equal(png.readUInt32BE(20), 240);
  assert.equal(png[25], 6, "RGBA color type preserves transparency");
});
