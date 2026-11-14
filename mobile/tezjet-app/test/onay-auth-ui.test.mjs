import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onayDark, ONAY_COUNTRY_CODE, uzPhoneDigits, toOnayApiPhone, isCompleteOnayPhone, onayPhoneFromInput, onayPhonePrefix, onayPhoneInput, onayEntryScreen } from "../lib/onay-auth-ui.ts";

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

test("editing a pasted international phone preserves its country and API recipient", () => {
  for (const [pasted, edited] of [
    ["+14155552671", "14155552672"],
    ["+442079460018", "442079460019"],
    ["+123456789012345", "123456789012346"],
  ]) {
    const phone = onayPhoneFromInput("", pasted);
    assert.equal(phone, pasted);
    assert.equal(onayPhonePrefix(phone), "+");
    assert.equal(onayPhoneInput(phone), pasted.slice(1));
    assert.equal(onayPhoneFromInput(phone, onayPhoneInput(phone)), pasted);
    const updated = onayPhoneFromInput(phone, edited);
    assert.equal(updated, "+" + edited);
    assert.equal(toOnayApiPhone(updated), "+" + edited);
    assert.equal(isCompleteOnayPhone(updated), true);
  }
});

test("Uzbek phone editing keeps the established separated country prefix", () => {
  const phone = onayPhoneFromInput("", "90 123 45 67");
  assert.equal(onayPhonePrefix(phone), "+998");
  assert.equal(onayPhoneInput(phone), "901234567");
  assert.equal(onayPhoneFromInput(phone, "901234568"), "+998901234568");
});

test("native phone field accepts a complete pasted E.164 number including its plus", () => {
  const screen = readFileSync(new URL("../components/OnayAuthScreen.tsx", import.meta.url), "utf8");
  const phoneField = screen.match(/testID="onay-auth-phone"[\s\S]*?\/>/)?.[0];
  assert.ok(phoneField, "auth phone input must exist");
  const maxLength = Number(phoneField.match(/maxLength=\{(\d+)\}/)?.[1]);
  assert.ok(maxLength >= "+123456789012345".length, "native paste must not truncate the OTP recipient");
});

test("auth stays hidden behind the branded loading screen until session restoration settles", () => {
  const base = { token: "", apiBase: "http://127.0.0.1:5000", showEndpointSettings: false };
  assert.equal(onayEntryScreen({ ...base, sessionLoading: true }), "loading");
  assert.equal(onayEntryScreen({ ...base, sessionLoading: true, apiBase: "" }), "loading");
  assert.equal(onayEntryScreen({ ...base, sessionLoading: false }), "auth");
  assert.equal(onayEntryScreen({ ...base, sessionLoading: false, showEndpointSettings: true }), "connection");
  assert.equal(onayEntryScreen({ ...base, sessionLoading: false, token: "session-token" }), "application");
});

test("unconfigured and restored APK startup use only V2 connection/auth/application states", () => {
  const base = { sessionLoading: false, token: "", apiBase: "", showEndpointSettings: true };
  assert.equal(onayEntryScreen(base), "connection");
  assert.equal(onayEntryScreen({ ...base, showEndpointSettings: false }), "auth");
  assert.equal(onayEntryScreen({ ...base, token: "saved", showEndpointSettings: false }), "application");
  assert.equal(onayEntryScreen({ ...base, sessionLoading: true }), "loading");
});
