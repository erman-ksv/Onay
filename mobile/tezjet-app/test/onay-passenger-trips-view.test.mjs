import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const history = readFileSync(new URL("../components/PassengerHistory.tsx", import.meta.url), "utf8");

test("Trips tab shows active orders and API-backed history together before booking inputs", () => {
  const trips = app.indexOf('testID="onay-passenger-trips"');
  const active = app.indexOf("passengerOrders.filter(order => !isClosed(order)).map(", trips);
  const archived = app.indexOf("<PassengerHistory key=", active);
  const booking = app.indexOf("<PassengerRouteOrder key=", active);
  assert.ok(trips >= 0 && active > trips && archived > active && booking > archived);
  assert.match(app, /testID="onay-passenger-trips-title" accessibilityRole="header"/);
  assert.match(app, /<PassengerHistory[^\n]+theme=\{passengerTheme\}/);
  assert.match(app, /onHistory=\{\(\) => selectPassengerTab\("trips"\)\}/);
  assert.match(app, /onViewActiveOrder=\{\(\) => selectPassengerTab\("trips"\)\}/);
});

test("Trip history retains server-backed fetch, session guards and visible light/dark themes", () => {
  assert.match(history, /validateApiEndpoint\(endpoint\) \+ "\/api\/orders"/);
  assert.match(history, /Authorization: `Bearer \$\{token\}`/);
  assert.match(history, /generation\.current === ticket/);
  assert.match(history, /theme\?: "light" \| "dark"/);
  assert.match(history, /!light && s\.darkCard/);
  assert.match(history, /!light && s\.darkMuted/);
  assert.match(history, /!light && s\.darkHeading/);
  assert.match(history, /testID="passenger-history-empty"/);
});
