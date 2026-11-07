import test from "node:test";
import assert from "node:assert/strict";
import { onayPassengerHomeTarget } from "../lib/onay-home-modes.ts";

test("Onay home city and village choices reuse configured route with correct direction", () => {
  assert.deepEqual(onayPassengerHomeTarget("city"), { section: "route", direction: "a_to_b" });
  assert.deepEqual(onayPassengerHomeTarget("village"), { section: "route", direction: "b_to_a" });
});

test("Onay home address choice opens existing legacy-address form without inventing a booking", () => {
  assert.deepEqual(onayPassengerHomeTarget("address"), { section: "legacy", direction: null });
});
