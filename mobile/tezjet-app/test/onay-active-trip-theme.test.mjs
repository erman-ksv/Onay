import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const driver = readFileSync(new URL("../components/PassengerDriverCard.tsx", import.meta.url), "utf8");

test("Active trip uses real Onay V2 dark tokens, not light white-on-dark combinations", () => {
  const line = app.split("\n").find(value => value.includes("passengerOrders.filter(order => !isClosed(order)).map("));
  assert.ok(line, "Active passenger trip must be rendered from the existing server orders");
  const ride = readFileSync(new URL("../components/OnayPassengerRide.tsx", import.meta.url), "utf8");
  assert.match(line, /<OnayPassengerRide key=\{passengerOrder.id\} order=\{passengerOrder\} theme=\{passengerTheme\}/);
  assert.match(line, /cancelOrder\(passengerOrder\)/);
  assert.match(ride, /const c = onayPalette\(theme\)/);
  for (const token of ["card", "accent", "text", "muted"]) assert.ok(ride.includes("c." + token));
  assert.match(ride, /ridePickupLabel\(order\)/);
  assert.match(ride, /rideDestinationLabel\(order\)/);
  assert.match(ride, /<Modal visible=\{open\}/);
  assert.match(ride, /<OnayScreenFrame title=\{label\} theme=\{theme\}/);
  assert.match(ride, /parseServerFareMoney\(order.fare\)/);

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
