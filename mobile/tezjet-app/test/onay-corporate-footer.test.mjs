import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("About displays the company and tagline without duplicating the legacy profile footer", () => {
  const source = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
  const about = readFileSync(new URL("../components/OnayPassengerAbout.tsx", import.meta.url), "utf8");
  assert.match(about, /ONAY OST E\.K\.K Technologies/);
  assert.match(about, /One Founder\. Intelligent Systems\./);
  assert.doesNotMatch(source, /<Text style=\{s.footer\}>© 2026/);
  assert.doesNotMatch(source, /TEZJET · ПАССАЖИР И ВОДИТЕЛЬ/);
});

test("company footer is display-only; existing passenger booking remains mounted", () => {
  const source = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
  assert.match(source, /<PassengerRouteOrder /);
  assert.match(source, /bookingGate=\{bookingGate\}/);
});
