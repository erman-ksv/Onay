import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const booking = readFileSync(new URL("../components/PassengerRouteOrder.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

test("booking form receives Onay passenger theme and preserves original dark mode", () => {
  assert.ok(app.includes("onCreated={refreshOrders} theme={passengerTheme} />"));
  assert.ok(booking.includes('theme?: "light" | "dark"'));
  assert.ok(booking.includes('theme = "dark"'));
  assert.ok(booking.includes('theme === "light" ? { ...v, ...vLight } : v'));
  assert.ok(booking.includes('style={themeStyles.card}'));
  assert.ok(booking.includes('style={themeStyles.priceCard}'));
  assert.ok(booking.includes('primary ? themeStyles.buttonPrimary : themeStyles.buttonSecondary'));
});
test("light palette covers booking surfaces, buttons, disabled and fare states", () => {
  const lightBlock = booking.slice(booking.indexOf("const vLight = StyleSheet.create({"));
  for (const name of ["card","eyebrow","title","subtitle","hint","route","routeActive","indicator","indicatorActive","routeName","routeInfo","chevron","sectionHeading","direction","directionActive","directionText","directionTextActive","trip","originDot","tripLine","destinationDot","tripName","stopPicker","stopOption","stopOptionSelected","stopOptionName","tripCaption","seatsTitle","seatsDescription","step","stepText","count","buttonPrimary","buttonSecondary","primaryText","secondaryText","priceCard","price","availability","availabilityPositive","notice","error"]) {
    assert.ok(lightBlock.includes("  " + name + ": {"), name + " missing in light palette");
  }
  assert.ok(booking.includes("bookingGate.canSubmit()"));
  assert.ok(booking.includes("saveRouteBookingRecovery(AsyncStorage, recoveryKey"));
  assert.ok(booking.includes("isFreshPassengerRouteQuote(availability, key, now)"));
  assert.ok(booking.includes('style={[themeStyles.button, primary ? themeStyles.buttonPrimary : themeStyles.buttonSecondary, disabled && themeStyles.disabled]}'));
});

test("route actions forward stable test IDs through the real Pressable, without weakening booking admission", () => {
  assert.match(booking, /const button = \(title: string, onPress: \(\) => void, disabled = false, primary = false, testID\?: string\) =>\s*<Pressable testID=\{testID\} accessibilityRole="button" accessibilityState=\{\{ disabled \}\}\s*onPress=\{onPress\} disabled=\{disabled\}/);
  assert.match(booking, /button\(checking \? "Проверяем…" : "Проверить цену и водителей",\s*\(\) => \{ void check\(\); \}, checking \|\| submitting \|\| busy, false, "route-check-availability"\)/);
  assert.match(booking, /button\(submitting \? "Оформляем…" : "Заказать поездку",\s*\(\) => \{ void submit\(\); \}, !canOrder, true, "route-book-trip"\)/);
  assert.match(booking, /if \(!selection \|\| !canOrder \|\| !bookingGate\.tryStart\("configured"\)\) return;/);
  assert.match(booking, /isFreshPassengerRouteQuote\(availability, key, now\)/);
});
