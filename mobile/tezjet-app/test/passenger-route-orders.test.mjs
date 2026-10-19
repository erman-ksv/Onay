import assert from "node:assert/strict";
import { test } from "node:test";
import { passengerRouteSelection, passengerRouteSelectionKey,
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
