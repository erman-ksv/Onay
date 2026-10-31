import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("authenticated Onay mobile footer displays the chosen company and tagline, not the former app name", () => {
  const source = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
  assert.match(source, /© 2026 ONAY OST E\.K\.K Technologies · One Founder\. Intelligent Systems\./);
  assert.doesNotMatch(source, /TEZJET · ПАССАЖИР И ВОДИТЕЛЬ/);
});

test("company footer is display-only; existing passenger booking remains mounted", () => {
  const source = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
  assert.match(source, /<PassengerRouteOrder /);
  assert.match(source, /bookingGate=\{bookingGate\}/);
});
