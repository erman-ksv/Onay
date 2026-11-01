import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const driver = readFileSync(new URL("../components/PassengerDriverCard.tsx", import.meta.url), "utf8");

test("Active trip uses real Onay V2 dark tokens, not light white-on-dark combinations", () => {
  const line = app.split("\n").find(value => value.includes("passengerOrders.filter(order => !isClosed(order)).map("));
  assert.ok(line, "Active passenger trip must be rendered from the existing server orders");
  for (const style of ["darkPassengerTripCard", "darkPassengerTripTitle", "darkPassengerTripMuted", "darkPassengerTripNote"]) {
    assert.ok(line.includes('passengerTheme === "dark" && s.' + style));
  }
  for (const style of ["card", "border", "text", "muted", "cardRaised"]) assert.ok(app.includes("onayDark." + style));
  assert.match(line, /order=\{passengerOrder\} theme=\{passengerTheme\}/);
  assert.match(line, /cancelOrder\(passengerOrder\)/);
  assert.match(line, /ridePickupLabel\(passengerOrder\)/);
  assert.match(line, /rideDestinationLabel\(passengerOrder\)/);
});

test("Nested driver contact also follows theme without changing guarded contact loading", () => {
  assert.match(driver, /theme\?: "light" \| "dark"/);
  assert.match(driver, /theme = "light"/);
  assert.match(driver, /const dark = theme === "dark"/);
  for (const token of ["text", "muted", "accent"]) assert.ok(driver.includes("onayDark." + token));
  for (const style of ["darkHeading", "darkText", "darkPhone"]) assert.ok(driver.includes("dark && s." + style));
  assert.match(driver, /if \(!eligible\) return null/);
  assert.match(driver, /scope\.current\.isCurrent\(ticket\)/);
  assert.match(driver, /testID="passenger-driver-phone"/);
  assert.match(driver, /testID="passenger-driver-retry"/);
});
