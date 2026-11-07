import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const trips = readFileSync(new URL("../components/OnayPassengerTrips.tsx", import.meta.url), "utf8");

test("Trips V2 shows only actual active orders or a truthful empty state", () => {
  assert.ok(app.includes('activeCount={passengerOrders.filter(order => !isClosed(order)).length}'));
  assert.ok(trips.includes('activeCount > 0 ? activeContent'));
  assert.ok(trips.includes('testID="onay-trips-empty"'));
  assert.ok(trips.includes('Активных поездок нет'));
  assert.ok(trips.includes('onPress={onBook}'));
  assert.ok(app.includes('onBook={openPassengerRoutePicker}'));
  assert.ok(app.includes('<PassengerDriverCard '));
  assert.ok(app.includes('onPress={() => cancelOrder(passengerOrder)}'));
});

test("Trips and history are separate states, real history loads explicitly", () => {
  assert.ok(app.includes('const [tripsHistoryOpen, setTripsHistoryOpen] = useState(false);'));
  assert.ok(app.includes('if (tab === "trips") setTripsHistoryOpen(false);'));
  assert.ok(app.includes('setTripsHistoryOpen(true);'));
  assert.ok(app.includes('setHistoryOpenRequest(revision => revision + 1);'));
  assert.ok(app.includes('historyOpen={tripsHistoryOpen}'));
  assert.ok(trips.includes('historyOpen ? historyContent : activeCount > 0 ? activeContent'));
  assert.ok(app.includes('<PassengerHistory '));
  assert.ok(app.includes('openRequest={historyOpenRequest}'));
  assert.ok(!trips.includes('testID="onay-trips-open-history"'));
  assert.ok(trips.includes('testID="onay-trips-back-to-active"'));
  assert.ok(app.includes('onHistory={openPassengerHistory}'));
  assert.ok(trips.includes('onPress={onShowActive}'));
});

test("Native Trips V2 matches reference structure and preserves theme/navigation controls", () => {
  assert.ok(trips.includes('fontSize: 30, fontWeight: "700"'));
  assert.ok(trips.includes('backgroundColor: onayDark.accent'));
  assert.ok(trips.includes('light && s.lightPage'));
  assert.ok(trips.includes('light && s.lightText'));
  assert.ok(trips.includes('light && s.lightMuted'));
  assert.ok(trips.includes('accessibilityRole="header"'));
  assert.ok(trips.includes('accessibilityRole="button"'));
  assert.ok(app.includes('onViewActiveOrder={() => selectPassengerTab("trips")}'));
  assert.ok(app.includes('onHistory={openPassengerHistory}'));
});
