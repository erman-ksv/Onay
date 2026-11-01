import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDriverVehicleSnapshot } from "../lib/driver-vehicle.ts";

const source = readFileSync(new URL("../components/DriverVehicleForm.tsx", import.meta.url), "utf8");

test("driver vehicle card uses Onay Driver V2 contrast for inputs, buttons and messages", () => {
  assert.match(source, /import \{ onayDark \} from "\.\.\/lib\/onay-auth-ui"/);
  for (const token of ["card", "border", "cardRaised", "text", "muted", "accent", "accentInk", "danger", "warning"]) {
    assert.ok(source.includes("onayDark." + token), "Missing theme token " + token);
  }
  for (const surface of ["card", "heading", "note", "input", "status", "statusText", "button", "buttonText", "buttonSecondary", "buttonSecondaryText", "disabled", "error", "notice"]) {
    assert.ok(source.includes("  " + surface + ": {"), "Missing visual surface " + surface);
  }
  assert.equal((source.match(/placeholderTextColor=\{onayDark\.muted\}/g) ?? []).length, 3);
  for (const testId of ["driver-vehicle-make", "driver-vehicle-model", "driver-vehicle-plate", "driver-vehicle-seats", "driver-vehicle-save", "driver-vehicle-refresh"]) {
    assert.ok(source.includes('testID="' + testId + '"'), "Required field missing: " + testId);
  }
});

test("review badge displays only server-confirmed driver approval states", () => {
  assert.match(source, /testID="driver-vehicle-review-status" accessibilityLiveRegion="polite"/);
  assert.match(source, /snapshot\.approval_status === "approved" \? "Подтверждён"/);
  assert.match(source, /snapshot\.approval_status === "pending" \? "На проверке"/);
  assert.match(source, /snapshot\.approval_status === "rejected" \? "Отклонён"/);
  assert.match(source, /snapshot\.approval_status === "blocked" && s\.statusBlocked/);
  for (const state of ["approved", "pending", "rejected", "blocked"]) {
    assert.equal(parseDriverVehicleSnapshot({ driver_vehicle: null, approval_status: state }).approval_status, state);
  }
  assert.match(source, /testID="driver-blocked-status"/);
  assert.match(source, /testID="driver-vehicle-error" accessibilityRole="alert"/);
});

test("visual changes do not bypass vehicle server revision, busy gate, or admin review", () => {
  assert.match(source, /if \(blocked \|\| loading \|\| !snapshot \|\| savingRef\.current\) return;/);
  assert.match(source, /driverVehicleBody\(draft, snapshot\.driver_vehicle\)/);
  assert.match(source, /validateApiEndpoint\(endpoint\) \+ "\/api\/driver\/vehicle"/);
  assert.ok(source.includes('Authorization: ') && source.includes('Bearer '));
  assert.match(source, /if \(!value\.driver_vehicle \|\| \(value\.approval_status !== "pending" && value\.approval_status !== "blocked"\)\) throw/);
  assert.match(source, /testID="driver-vehicle-save" disabled=\{disabled \|\| !snapshot \|\| !dirty\} onPress=\{\(\) => \{ void save\(\); \}\}/);
  assert.match(source, /testID="driver-vehicle-refresh" disabled=\{saving \|\| loading\} onPress=\{\(\) => \{ void load\(\); \}\}/);
  assert.match(source, /onBusyChange\(true\)/);
  assert.match(source, /onBusyChange\(false\)/);
  assert.match(source, /onSaved\(value\)/);
  assert.match(source, /generation\.current !== ticket \|\| controller\.signal\.aborted/);
});
