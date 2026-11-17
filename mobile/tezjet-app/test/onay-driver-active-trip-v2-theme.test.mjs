import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const offerStart = app.indexOf('{incomingOrder ? <View');
const tripStart = app.indexOf('{activeDriverOrders.map(activeOrder =>', offerStart);
const emptyStart = app.indexOf('{!driverRouteGate.hasChoice', tripStart);
const offer = app.slice(offerStart, tripStart);
const trip = app.slice(tripStart, emptyStart);

test("Onay V2 styles incoming offer and active driver trip with readable colors", () => {
  assert.ok(offerStart > 0 && tripStart > offerStart && emptyStart > tripStart);
  for (const name of ["driverOfferCard", "driverOfferHeading", "driverOfferText", "driverOfferTimer"]) {
    assert.ok(offer.includes("s." + name), "Missing applied offer theme: " + name);
  }
  for (const name of ["driverCurrentCard", "driverCurrentHeading", "driverCurrentText"]) {
    assert.ok(trip.includes("s." + name), "Missing applied active trip theme: " + name);
  }
  for (const color of ["card", "border", "accent", "text", "muted", "warning", "cardRaised"]) {
    assert.ok(app.includes("onayDark." + color), "Missing Onay design token: " + color);
  }
  assert.ok(offer.includes('testID="driver-offer-countdown"'));
  assert.ok(offer.includes('testID="driver-incoming-order"'));
  assert.ok(trip.includes('testID={\`driver-trip-\${activeOrder.id}\`}'));
});

test("new driver styling keeps real offer countdown and acceptance checks", () => {
  assert.ok(offer.includes('Math.max(0, Math.ceil(((incomingOrder.offer_expires_at ?? now) - now) / 1_000))'));
  assert.ok(offer.includes('testID="driver-order-accept" onPress={acceptOrder}'));
  assert.ok(offer.includes('testID="driver-order-reject" onPress={rejectOrder}'));
  assert.equal(offer.split('disabled={busy || !isLiveOffer(incomingOrder, profile.id, now)}').length - 1, 2);
  assert.ok(offer.includes('ridePickupLabel(incomingOrder)'));
  assert.ok(offer.includes('rideDestinationLabel(incomingOrder)'));
});

test("new active trip styling keeps boarding and progression permissions", () => {
  assert.ok(trip.includes('canBoardLinePassenger(lineState, activeOrder)'));
  assert.ok(trip.includes('nextDriverTripStatus(lineState?.phase ?? null, activeOrder)'));
  assert.ok(trip.includes('onPress={() => { void boardLinePassenger(activeOrder); }}'));
  assert.ok(trip.includes('onPress={() => progressOrder(activeOrder)}'));
  assert.ok(trip.includes('statusLabels[activeOrder.status]'));
  assert.ok(trip.includes('testID="driver-line-board"'));
  assert.ok(trip.includes('testID={\`driver-trip-progress-\${activeOrder.id}\`}'));
});
