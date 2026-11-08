import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const qa=readFileSync(new URL("../../../scripts/line-ride-browser-qa.py",import.meta.url),"utf8");
const history=readFileSync(new URL("../components/PassengerHistory.tsx",import.meta.url),"utf8");
test("browser history chooses refresh for an open archive, toggle for a collapsed one",()=>{
  assert.ok(qa.includes('history_action = "passenger-history-refresh" if page.get_by_test_id("passenger-history-refresh").count() else "passenger-history-toggle"'));
  assert.ok(qa.includes('page.get_by_test_id(history_action).click()'));
  assert.ok(history.includes('testID="passenger-history-toggle"'));
  assert.ok(history.includes('testID="passenger-history-refresh"'));
});
test("browser history still requires authorized API 200 and all five persisted orders",()=>{
  assert.ok(qa.includes('with self.response(page, "/orders", "GET") as pending:'));
  assert.ok(qa.includes('require(pending.value.status == 200, "Full history must use real HTTP and PostgreSQL")'));
  assert.ok(qa.includes('Закрытых поездок: 5'));
  assert.ok(qa.includes('actual_ids == expected_ids'));
  assert.ok(history.includes('validateApiEndpoint(endpoint) + "/api/orders"'));
});
