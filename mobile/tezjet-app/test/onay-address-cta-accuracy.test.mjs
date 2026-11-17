import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onayPassengerHomeTarget } from "../lib/onay-home-modes.ts";

const home = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

test("address card describes the available C/D service rather than promising door-to-door pickup", () => {
  assert.ok(home.includes('<TripCard testID="onay-home-to-address" title="По своему адресу" description="Уточнение подачи на маршруте C/D"'));
  assert.ok(home.includes('onPress={() => onChoose("address")}'));
  assert.ok(!home.includes("Машина приедет за вами"), "Unverified door-to-door promise is misleading");
  assert.deepEqual(onayPassengerHomeTarget("address"), { section: "legacy", direction: null });
});

test("address CTA still opens the real configured C/D form and does not bypass booking protections", () => {
  assert.ok(app.includes('const offset = target.section === "route" ? routeSectionY : legacySectionY;'));
  assert.ok(app.includes('onChoose={openPassengerBooking}'));
  assert.ok(app.includes('testID="onay-passenger-legacy-route"'));
  assert.ok(app.includes('Уточнение адреса подачи не меняет точки маршрута.'));
  assert.ok(app.includes('onPress={order} disabled={busy || !fareFresh || !canOrder || passengerHasActiveOrder || !bookingGate.canSubmit()}'));
  assert.ok(app.includes('void refreshAvailability();'));
});
