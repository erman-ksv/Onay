import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const qa = readFileSync(new URL("../../../scripts/line-ride-browser-qa.py", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const trips = readFileSync(new URL("../components/OnayPassengerTrips.tsx", import.meta.url), "utf8");

test("real browser QA navigates through V2 Trips to the server-backed history", () => {
  assert.ok(qa.includes('self.passenger_page.get_by_test_id("onay-tab-trips").click()'));
  assert.ok(qa.includes('self.passenger_page.get_by_test_id("onay-trips-open-history").click()'));
  assert.ok(qa.includes('with self.response(self.passenger_page, "/orders", "GET") as pending:'));
  assert.ok(qa.includes('require(pending.value.status == 200, "Passenger history must read the real authorized API")'));
  assert.ok(qa.includes('self.expect(self.passenger_page.get_by_test_id("passenger-history-empty")).to_be_visible()'));
  assert.ok(qa.includes('self.expect(self.control("passenger-history")).to_have_count(0)'));
  assert.ok(app.includes('historyOpen={tripsHistoryOpen}'));
  assert.ok(trips.includes('testID="onay-trips-open-history"'));
});

test("history after reload still reads real API and checks six persistent rides", () => {
  assert.ok(qa.includes('page.reload(wait_until="domcontentloaded")'));
  assert.ok(qa.includes('page.get_by_test_id("onay-tab-trips").click()'));
  assert.ok(qa.includes('page.get_by_test_id("onay-trips-open-history").click()'));
  assert.ok(qa.includes('require(pending.value.status == 200, "Reloaded Trips history must use the authorized API")'));
  assert.ok(qa.includes('Закрытых поездок: 6'));
  assert.ok(qa.includes('self.expect(page.get_by_test_id("passenger-history-error")).to_be_visible()'));
  assert.ok(qa.includes('self.expect(page.get_by_test_id("passenger-history-results")).to_have_count(0)'));
  assert.ok(qa.includes('self.expect(page.get_by_test_id("passenger-history-results")).to_contain_text("Закрытых поездок: 6")'));
});
