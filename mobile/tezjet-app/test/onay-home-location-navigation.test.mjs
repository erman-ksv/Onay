import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

test("home location chip shows unconfirmed pickup instead of claiming GPS coordinates", () => {
  assert.match(home, /testID="onay-home-location"/);
  assert.match(home, /<Text style=\{h\.locationCaption\}>Точка отправления<\/Text>/);
  assert.match(home, /<Text style=\{h\.locationTitle\}>Выбрать остановку<\/Text>/);
  assert.doesNotMatch(home, /<Text style=\{h\.locationCaption\}>Я сейчас<\/Text>/);
  assert.match(home, /style=\{h\.location\} onPress=\{onChooseLocation\}/);
});

test("location action navigates to backend-backed route picker without changing direction", () => {
  const handler = app.split("function openPassengerRoutePicker() {")[1]?.split("\n  function openPassengerBooking(")[0];
  assert.ok(handler, "location navigation handler exists");
  assert.match(handler, /setPassengerTab\("home"\)/);
  assert.match(handler, /scrollTo\(\{ y: Math\.max\(0, routeSectionY - 24\), animated: true \}\)/);
  assert.doesNotMatch(handler, /setBookingDirectionIntent|onayPassengerHomeTarget|request\(/);
  assert.match(app, /onChooseLocation=\{openPassengerRoutePicker\}/);
  assert.doesNotMatch(app, /onChooseLocation=\{\(\) => openPassengerBooking\("city"\)\}/);
  assert.match(app, /<PassengerRouteOrder[^>]*bookingGate=\{bookingGate\}/);
});
