import test from "node:test";
import assert from "node:assert/strict";
import { onayDark, ONAY_COUNTRY_CODE, uzPhoneDigits, toOnayApiPhone, isCompleteOnayPhone, onayPhoneFromInput, onayPhonePrefix, onayPhoneInput } from "../lib/onay-auth-ui.ts";

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

test("request button enforces complete Uzbek and E.164 phone numbers", () => {
  assert.equal(isCompleteOnayPhone("+998901234567"), true);
  assert.equal(isCompleteOnayPhone("+99890123456"), false);
  assert.equal(isCompleteOnayPhone("+9989012345678"), false);
  assert.equal(isCompleteOnayPhone("901234567"), false);
});

test("browser driver registration may use +7 without silently rewriting country code", () => {
  const pasted = onayPhoneFromInput("", "+77779001234");
  assert.equal(pasted, "+77779001234");
  assert.equal(onayPhonePrefix(pasted), "+7");
  assert.equal(onayPhoneInput(pasted), "7779001234");
  assert.equal(isCompleteOnayPhone(pasted), true);
  assert.equal(onayPhoneFromInput(pasted, "7779001234"), pasted);
  assert.equal(isCompleteOnayPhone("+77779"), false);
});
