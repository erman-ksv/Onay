import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_REGISTRATION_FULL_NAME_LENGTH, normalizeRegistrationNamePart, registrationFullName } from "../lib/registration.ts";

test("joins the given and family name for the existing full_name API contract", () => {
  assert.equal(registrationFullName("Азамат", "Ергешов"), "Азамат Ергешов");
  assert.equal(registrationFullName("  Аза́мат \t", "  Ергешов  "), "Аза́мат Ергешов");
  assert.equal(registrationFullName("  Алия   М.", "Жумабаева   "), "Алия М. Жумабаева");
});

test("requires both given and family names", () => {
  assert.equal(registrationFullName("", "Иванов"), null);
  assert.equal(registrationFullName("Али", "  \t "), null);
  assert.equal(registrationFullName("  ", "  "), null);
  assert.equal(registrationFullName("Али", ""), null);
});

test("normalizes whitespace without changing text case", () => {
  assert.equal(normalizeRegistrationNamePart("\t A  B\n C  "), "A B C");
  assert.equal(registrationFullName("A\u00a0B", "C"), "A B C");
});

test("enforces the existing backend 120-character full_name limit", () => {
  assert.equal(MAX_REGISTRATION_FULL_NAME_LENGTH, 120);
  const valid = registrationFullName("A".repeat(58), "B".repeat(61));
  assert.equal(valid?.length, 120);
  assert.equal(registrationFullName("A".repeat(59), "B".repeat(61)), null);
});
