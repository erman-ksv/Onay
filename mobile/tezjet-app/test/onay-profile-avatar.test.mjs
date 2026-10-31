import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onayProfileInitial } from "../lib/onay-profile-avatar.ts";

test("profile avatar uses the real account name without inventing a picture or identity", () => {
  assert.equal(onayProfileInitial("  Әлібек Сәрсен  "), "Ә");
  assert.equal(onayProfileInitial("мария"), "М");
  assert.equal(onayProfileInitial("  john doe "), "J");
  assert.equal(onayProfileInitial("  "), "?");
  assert.equal(onayProfileInitial(""), "?");
});

test("profile renders the derived letter in the round 78px avatar from the reference", () => {
  const profile = readFileSync(new URL("../components/OnayPassengerProfile.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
  assert.match(profile, /testID="onay-profile-avatar-initial"/);
  assert.match(profile, /onayProfileInitial\(fullName\)/);
  assert.match(profile, /avatar: \{ width: 78, height: 78, borderRadius: 39/);
  assert.doesNotMatch(profile, />◉<\/Text>/);
  assert.match(app, /fullName=\{profile\.full_name \|\| ""\}/);
  assert.match(profile, /row\("history", "История поездок", onHistory\)/);
});
