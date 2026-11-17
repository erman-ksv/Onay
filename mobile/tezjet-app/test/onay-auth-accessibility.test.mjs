import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Onay passenger/driver switch is exposed as a real button for keyboard and screen readers", () => {
  const source = readFileSync(new URL("../components/OnayAuthScreen.tsx", import.meta.url), "utf8");
  assert.match(
    source,
    /<Pressable\s+accessibilityRole="button"\s+testID="onay-auth-role-switch"/,
    "The mode switch must be discoverable by role=button, not only by testID"
  );
});
