import assert from "node:assert/strict";
import { test } from "node:test";
import { createPassengerRouteRequestScope, createPassengerRouteSubmissionGuard, routeBookingRecoveryKey, readRouteBookingRecovery, saveRouteBookingRecovery, clearRouteBookingRecovery, confirmedRouteBookingPresent, passengerRouteCatalogStatus, isFreshPassengerRouteQuote, routeBookingOutcomeUncertain, syncConfirmedRouteBooking, passengerRouteSelection, passengerRouteSelectionKey,
  passengerRouteAvailabilityPath, parsePassengerRouteAvailability, passengerRouteOrderBody } from "../lib/passenger-route-orders.ts";
const route = { id: "route1", name: "Село — город", updatedAt: "2026-10-19T01:00:00Z",
  stops: [{id:"a",name:"Село"}, {id:"b",name:"Город"}] };
test("route request binds direction, version and seats", () => {
  const a = passengerRouteSelection(route, "a_to_b", 2);
  const b = passengerRouteSelection(route, "b_to_a", 2);
  assert.notEqual(passengerRouteSelectionKey(a), passengerRouteSelectionKey(b));
  const url = new URL(passengerRouteAvailabilityPath(a), "https://example.invalid");
  assert.equal(url.searchParams.get("route_id"), "route1");
  assert.equal(url.searchParams.get("direction"), "a_to_b");
  assert.equal(url.searchParams.get("expected_updated_at"), route.updatedAt);
  assert.equal(url.searchParams.get("seats"), "2");
});
test("server-authoritative quote does not treat malformed fare as valid", () => {
  const quote = { available:true, eligible_driver_count:2, fare:{totalKzt:4000,currency:"KZT"} };
  assert.equal(parsePassengerRouteAvailability(quote).priceKzt, 4000);
  for (const bad of [{...quote,eligible_driver_count:-1},{...quote,fare:null},
    {...quote,available:"true"},{...quote,fare:{totalKzt:NaN,currency:"KZT"}},
    {...quote,available:true,eligible_driver_count:0}])
    assert.throws(()=>parsePassengerRouteAvailability(bad));
});
test("order uses exact selected route without locally invented fare",()=>{
  const selection = passengerRouteSelection(route, "b_to_a", 3);
  const result = passengerRouteOrderBody(selection, {lat:42,lng:71,timestamp:1234});
  assert.equal(result.direction,"b_to_a");
  assert.equal(result.route_id,"route1");
  assert.equal(result.seats,3);
  assert.equal(Object.hasOwn(result,"fare"), false);
});
test("reject invalid seats and fake location before submission",()=>{
  assert.throws(()=>passengerRouteSelection(route,"a_to_b",0));
  assert.throws(()=>passengerRouteSelection(route,"a_to_b",9));
  assert.throws(()=>passengerRouteOrderBody(passengerRouteSelection(route,"a_to_b",1),
    {lat:42,lng:71,timestamp:1234,isMocked:true}));
});

test("changing route availability never cancels the initial catalog loading request", () => {
  const scope = createPassengerRouteRequestScope();
  const initialCatalog = scope.startCatalog();
  const firstAvailability = scope.startAvailability();
  scope.cancelAvailability();
  assert.equal(scope.isCurrentCatalog(initialCatalog), true);
  assert.equal(scope.isCurrentAvailability(firstAvailability), false);
  const secondAvailability = scope.startAvailability();
  assert.equal(scope.isCurrentAvailability(secondAvailability), true);
  scope.cancelCatalog();
  assert.equal(scope.isCurrentCatalog(initialCatalog), false);
  assert.equal(scope.isCurrentAvailability(secondAvailability), true);
});

test("stale quotes and stale route catalogs cannot overwrite newer requests", () => {
  const scope = createPassengerRouteRequestScope();
  const oldCatalog = scope.startCatalog();
  const newCatalog = scope.startCatalog();
  assert.equal(scope.isCurrentCatalog(oldCatalog), false);
  assert.equal(scope.isCurrentCatalog(newCatalog), true);
  const oldQuote = scope.startAvailability();
  const newQuote = scope.startAvailability();
  assert.equal(scope.isCurrentAvailability(oldQuote), false);
  assert.equal(scope.isCurrentAvailability(newQuote), true);
});

test("confirmed booking remains confirmed even when list refresh fails", async () => {
  let refreshed = 0;
  assert.equal(await syncConfirmedRouteBooking(async () => { refreshed++; throw Error("offline"); }), false);
  assert.equal(refreshed, 1);
  assert.equal(await syncConfirmedRouteBooking(async () => { refreshed++; }), true);
  assert.equal(refreshed, 2);
});

test("only ambiguous transport outcomes require authoritative order reconciliation", () => {
  for (const error of [{code:"REQUEST_TIMEOUT"},{code:"NETWORK_ERROR"},{code:"INVALID_RESPONSE",status:200}])
    assert.equal(routeBookingOutcomeUncertain(error),true);
  for (const error of [{code:"NO_DRIVERS",status:409},{code:"INVALID_RESPONSE",status:500},{code:"ROUTE_CHANGED",status:409}])
    assert.equal(routeBookingOutcomeUncertain(error),false);
});

test("route quote expires during slow location acquisition before order POST", () => {
  const quote = { key: "route-v1", checkedAt: 1000, value: { available: true } };
  assert.equal(isFreshPassengerRouteQuote(quote, "route-v1", 15999), true);
  assert.equal(isFreshPassengerRouteQuote(quote, "route-v1", 16000), false);
  assert.equal(isFreshPassengerRouteQuote(quote, "route-v2", 1100), false);
  assert.equal(isFreshPassengerRouteQuote(null, "route-v1", 1100), false);
  assert.equal(isFreshPassengerRouteQuote({ ...quote, value: {available:false} }, "route-v1", 1100), false);
  assert.equal(isFreshPassengerRouteQuote(quote, "route-v1", 999), false);
});

test("route catalog distinguishes network failure from legitimate empty routes and supports retry", () => {
  assert.equal(passengerRouteCatalogStatus({ loading: true, error: "", count: 0 }), "loading");
  assert.equal(passengerRouteCatalogStatus({ loading: false, error: "offline", count: 0 }), "error");
  assert.equal(passengerRouteCatalogStatus({ loading: false, error: "", count: 0 }), "empty");
  assert.equal(passengerRouteCatalogStatus({ loading: false, error: "", count: 2 }), "ready");
  assert.equal(passengerRouteCatalogStatus({ loading: true, error: "old error", count: 0 }), "loading");
});

test("rapid double tap cannot run two passenger booking requests before render", async () => {
  const guard = createPassengerRouteSubmissionGuard();
  let posts = 0;
  let resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const submit = async () => {
    if (!guard.tryStart()) return false;
    try { posts++; await first; return true; }
    finally { guard.finish(); }
  };
  const firstTap = submit();
  assert.equal(await submit(), false);
  assert.equal(posts, 1);
  assert.equal(guard.isInFlight(), true);
  resolveFirst();
  assert.equal(await firstTap, true);
  assert.equal(guard.isInFlight(), false);
  assert.equal(guard.tryStart(), true);
  guard.finish();
});

test("booking recovery survives remount and requires an exact server order id", async () => {
  const records = new Map();
  const storage = {
    getItem: async key => records.get(key) ?? null,
    setItem: async (key, value) => { records.set(key, value); },
    removeItem: async key => { records.delete(key); },
  };
  const key = routeBookingRecoveryKey("https://onay.example", "passenger-1");
  const another = routeBookingRecoveryKey("https://onay.example", "passenger-2");
  assert.notEqual(key, another);
  assert.equal(await readRouteBookingRecovery(storage, key), null);
  await saveRouteBookingRecovery(storage, key, {status:"in_flight",orderId:null});
  assert.deepEqual(await readRouteBookingRecovery(storage, key), {status:"in_flight",orderId:null});
  assert.equal(await readRouteBookingRecovery(storage, another), null);
  await saveRouteBookingRecovery(storage, key, {status:"confirmed",orderId:"order-123"});
  const record = await readRouteBookingRecovery(storage, key);
  assert.deepEqual(record, {status:"confirmed",orderId:"order-123"});
  assert.equal(confirmedRouteBookingPresent(record, [{id:"order-123"}]),true);
  assert.equal(confirmedRouteBookingPresent(record, [{id:"other"}]),false);
  await clearRouteBookingRecovery(storage, key);
  assert.equal(await readRouteBookingRecovery(storage, key), null);
});

test("corrupt and legacy booking recovery stay blocked", async () => {
  const storage = {getItem: async () => "{corrupt-payload}",setItem: async () => {},removeItem: async () => {}};
  assert.deepEqual(await readRouteBookingRecovery(storage, "key"), {status:"uncertain",orderId:null});
  assert.equal(confirmedRouteBookingPresent({status:"uncertain",orderId:null}, [{id:"order-123"}]),false);
  assert.rejects(() => saveRouteBookingRecovery(storage,"key",{status:"confirmed",orderId:null}));
  assert.throws(() => routeBookingRecoveryKey("", "passenger"));
  assert.throws(() => routeBookingRecoveryKey("https://onay.example", ""));
});
