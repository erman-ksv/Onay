import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "app.json"), "utf8"));

test("Expo launcher icon references the exact user-approved Onay branding", () => {
  assert.equal(config.expo.name, "Onay");
  assert.equal(config.expo.icon, "./assets/onay-original-logo.png");
  const asset = readFileSync(join(root, config.expo.icon));
  assert.deepEqual([...asset.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  assert.equal(asset.readUInt32BE(16), 240);
  assert.equal(asset.readUInt32BE(20), 240);
});

test("on-screen branding and launcher configuration point at the same logo", () => {
  for (const file of ["components/OnayPassengerHome.tsx", "components/OnayAuthScreen.tsx"]) {
    const screen = readFileSync(join(root, file), "utf8");
    assert.ok(screen.includes('require("../assets/onay-original-logo.png")'), file);
  }
});
