import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const from = app.indexOf("{!driverRouteGate.hasChoice && !driverQueueContext && !incomingOrder && !activeDriverOrders.length");
const to = app.indexOf("<DriverHistory ", from);
const noRoute = app.slice(from, to);

test("driver with no chosen route sees accurate actionable Onay V2 empty state", () => {
  assert.ok(from > 0 && to > from, "No-route state must stay in driver screen before driver history");
  assert.ok(noRoute.includes('testID="onay-driver-no-route"'));
  assert.ok(noRoute.includes('accessibilityRole="header"'));
  assert.ok(noRoute.includes("Маршрут не выбран"));
  assert.ok(noRoute.includes("Выбери маршрут и направление выше, затем встань в очередь."));
  assert.ok(noRoute.includes("До этого заказы не будут приходить."));
  assert.ok(!noRoute.includes("Ожидаем подходящий заказ."));
  for (const style of ["driverNoRouteCard", "driverNoRouteHeading", "driverNoRouteText"]) {
    assert.ok(noRoute.includes("s." + style), "Missing applied theme style: " + style);
  }
  assert.ok(app.includes("driverNoRouteCard:{backgroundColor:onayDark.card,borderColor:onayDark.border}"));
  assert.ok(app.includes("driverNoRouteHeading:{color:onayDark.text}"));
  assert.ok(app.includes("driverNoRouteText:{color:onayDark.muted}"));
});

test("empty-state presentation never hides a real queue, incoming offer or active trip", () => {
  assert.ok(noRoute.startsWith("{!driverRouteGate.hasChoice && !driverQueueContext && !incomingOrder && !activeDriverOrders.length"));
  assert.ok(noRoute.trimEnd().endsWith(": null}"));
  assert.ok(noRoute.includes("testID=\"onay-driver-no-route\""));
  assert.ok(!noRoute.includes("onPress={joinQueue}"));
  assert.ok(!noRoute.includes("onPress={acceptOrder}"));
  assert.ok(app.includes("testID=\"driver-queue-join\" onPress={joinQueue} disabled={busy || !!incomingOrder || !canJoinQueue}"));
  assert.ok(app.includes("testID=\"driver-order-accept\" onPress={acceptOrder} disabled={busy || !isLiveOffer(incomingOrder, profile.id, now)}"));
  assert.ok(app.includes("testID={\`driver-trip-\${activeOrder.id}\`}"));
});
