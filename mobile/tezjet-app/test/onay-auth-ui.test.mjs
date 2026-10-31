import test from "node:test";
import assert from "node:assert/strict";
import { onayDark, ONAY_COUNTRY_CODE, uzPhoneDigits, toOnayApiPhone, isCompleteOnayPhone } from "../lib/onay-auth-ui.ts";

test("auth tokens match the ONAY V2 Claude design reference", () => {
  assert.equal(onayDark.background, "#0a1d15");
  assert.equal(onayDark.accent, "#5bd62f");
  assert.equal(onayDark.card, "#12291f");
  assert.equal(ONAY_COUNTRY_CODE, "+998");
});

test("phone input preserves the existing API's international number shape", () => {
  assert.equal(toOnayApiPhone("90 123 45 67"), "+998901234567");
  assert.equal(toOnayApiPhone("+998 90 123 45 67"), "+998901234567");
  assert.equal(uzPhoneDigits("+998901234567"), "901234567");
  assert.equal(toOnayApiPhone(""), "");
});

test("request button accepts complete Uzbek phone numbers only", () => {
  assert.equal(isCompleteOnayPhone("+998901234567"), true);
  assert.equal(isCompleteOnayPhone("+99890123456"), false);
  assert.equal(isCompleteOnayPhone("+9989012345678"), false);
  assert.equal(isCompleteOnayPhone("901234567"), false);
});
