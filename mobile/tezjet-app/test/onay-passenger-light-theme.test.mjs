import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");
const nav = readFileSync(new URL("../components/OnayPassengerTabBar.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

test("light theme covers passenger location, active trip, heading, and secondary booking cards", () => {
  assert.match(home, /light && h\.locationLight/);
  assert.match(home, /light && h\.activeBannerLight/);
  assert.match(home, /light && h\.lightText/);
  assert.match(home, /light && !primary && h\.secondaryModeLight/);
  assert.match(home, /light && !primary && h\.modeTitleLight/);
  assert.match(home, /light && !primary && h\.modeDescriptionLight/);
  assert.equal((home.match(/light=\{light\}/g) ?? []).length, 3);
  assert.match(home, /primary \? h\.primaryMode : h\.secondaryMode/);
  assert.match(home, /Не GPS/);
});

test("bottom tabs keep accessible selection while applying readable light colors", () => {
  assert.match(nav, /light && styles\.pillLight/);
  assert.match(nav, /light && !selected && styles\.inactiveTabLight/);
  assert.match(nav, /light && !selected && styles\.iconLight/);
  assert.match(nav, /accessibilityRole="tab"/);
  assert.match(nav, /accessibilityState=\{\{ selected \}\}/);
  assert.match(nav, /onPress=\{\(\) => onSelect\(tab\.id\)\}/);
});

test("passenger scroll background follows chosen theme without altering API booking", () => {
  assert.match(app, /passengerTheme === "light" \? "#f4f6f4" : onayDark\.background/);
  assert.match(app, /<PassengerRouteOrder /);
  assert.match(app, /bookingGate=\{bookingGate\}/);
  assert.match(app, /AsyncStorage\.setItem\("onay_passenger_theme_v1", value\)/);
});
