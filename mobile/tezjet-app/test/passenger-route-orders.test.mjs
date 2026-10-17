import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePassengerRouteCatalog, parsePassengerRouteAvailability, passengerRouteEndpoints,
  passengerRouteKey, passengerRouteAvailabilityPath, passengerRouteOrderPayload } from "../lib/passenger-route-orders.ts";
const route = { id:"r1",name:"Село — Город",updatedAt:"2026-10-18T00:00:00.000Z",
  stops:[{id:"a",code:"A",name:"Село",sequence:1,position:1},{id:"b",code:"B",name:"Город",sequence:2,position:2}],
  pitaks:{aStopCode:"A",bStopCode:"B",radiusMeters:100},currency:"KZT",pricePerStopKzt:100 };
const read=()=>parsePassengerRouteCatalog({routes:[route]})[0];
test("catalog is validated and never falls back to old C/D",()=>{
  assert.equal(read().name,"Село — Город");
  assert.deepEqual(parsePassengerRouteCatalog({routes:[]}),[]);
  for(const value of [{},{routes:[route,route]},{routes:[{...route,currency:"USD"}]},
    {routes:[{...route,pricePerStopKzt:-1}]},{routes:[{...route,stops:[]}]}]){
    assert.throws(()=>parsePassengerRouteCatalog(value),{code:"INVALID_RESPONSE"});
  }
});
test("A↔B direction and exact version, seats bind availability",()=>{
  const r=read();
  assert.equal(passengerRouteEndpoints(r,"a_to_b").from.name,"Село");
  assert.equal(passengerRouteEndpoints(r,"b_to_a").from.name,"Город");
  assert.notEqual(passengerRouteKey(r,"a_to_b",2),passengerRouteKey(r,"b_to_a",2));
  assert.notEqual(passengerRouteKey(r,"a_to_b",2),passengerRouteKey({...r,updatedAt:"new"},"a_to_b",2));
  assert.notEqual(passengerRouteKey(r,"a_to_b",2),passengerRouteKey(r,"a_to_b",3));
  const u=new URL(passengerRouteAvailabilityPath(r,"b_to_a",2),"https://example.org");
  assert.equal(u.pathname,"/api/orders/route/availability");
  assert.deepEqual(Object.fromEntries(u.searchParams),{route_id:"r1",direction:"b_to_a",expected_updated_at:route.updatedAt,seats:"2"});
});
test("booking payload contains only the server route contract; malformed GPS and seats fail",()=>{
  const loc={lat:41.1,lng:69.2,timestamp:1700000000000,isMocked:false};
  assert.deepEqual(passengerRouteOrderPayload(read(),"a_to_b",2,loc),{
    route_id:"r1",direction:"a_to_b",expected_updated_at:route.updatedAt,seats:2,pickup_location:loc});
  for(const n of [0,9,NaN,1.5])assert.throws(()=>passengerRouteOrderPayload(read(),"a_to_b",n,loc),{code:"VALIDATION_ERROR"});
  for(const loc of [{lat:91,lng:69,timestamp:1,isMocked:false},{lat:41,lng:69,timestamp:1,isMocked:true}])
    assert.throws(()=>passengerRouteOrderPayload(read(),"a_to_b",1,loc),{code:"INVALID_COORDINATES"});
});
test("invalid availability never silently becomes yes or invents fare",()=>{
  const no={available:false,eligible_driver_count:0,offer_timeout_seconds:60,fare:{currency:"KZT",totalKzt:300}};
  assert.deepEqual(parsePassengerRouteAvailability(no),no);
  for(const value of [{}, {...no,available:true},{...no,fare:null},{...no,fare:{currency:"USD",totalKzt:300}}])
    assert.throws(()=>parsePassengerRouteAvailability(value),{code:"INVALID_RESPONSE"});
});
