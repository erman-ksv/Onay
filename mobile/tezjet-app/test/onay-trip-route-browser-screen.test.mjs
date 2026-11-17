import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const qa=readFileSync(new URL("../../../scripts/passenger-route-stops-browser-qa.py",import.meta.url),"utf8");
const app=readFileSync(new URL("../app/index.tsx",import.meta.url),"utf8");
test("real route booking opens the dedicated Trips tab before checking the persisted ride",()=>{
 assert.ok(qa.includes('self.page.get_by_test_id("onay-tab-trips").click()'));
 assert.ok(qa.includes('ride = self.page.get_by_test_id("passenger-trip-" + self.order_id)'));
 assert.ok(qa.includes('self.expect(ride).to_be_visible()'));
 assert.ok(qa.includes('ride.get_by_text("Точка подачи: " + self.stop("D")["name"], exact=True)'));
 assert.ok(qa.includes('ride.get_by_text("Куда: " + self.stop("C")["name"], exact=True)'));
 assert.ok(app.includes('trips={<>'));
});
test("browser route QA still validates real quoted fare, location, FIFO driver and durable order",()=>{
 for(const evidence of ['"/orders/route", "POST"','order["offered_driver_id"] == first_b["id"]','order["fare"]["totalKzt"] == self.reverse_fare["totalKzt"]','"Fetch durable selected-segment order"','"Resolving the committed replacement restores exactly one live order'])assert.ok(qa.includes(evidence),evidence);
});
