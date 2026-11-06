import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const qa=readFileSync(new URL("../../../scripts/line-ride-browser-qa.py",import.meta.url),"utf8");
const app=readFileSync(new URL("../app/index.tsx",import.meta.url),"utf8");
const trips=readFileSync(new URL("../components/OnayPassengerTrips.tsx",import.meta.url),"utf8");
test("browser passenger flow closes initial archive before booking in Home",()=>{
  assert.ok(qa.includes('get_by_test_id("onay-trips-back-to-active").click()'));
  assert.ok(qa.includes('get_by_test_id("onay-tab-home").click()'));
  assert.ok(qa.includes('get_by_test_id("configured-route-passenger")).to_be_visible()'));
  assert.ok(trips.includes('testID="onay-trips-back-to-active"'));
  assert.ok(app.includes('onBook={openPassengerRoutePicker}'));
});
test("browser tests actual offered order in Trips and completed ride in its archive",()=>{
  assert.ok(qa.includes('page.get_by_test_id("onay-tab-trips").click()'));
  assert.ok(qa.includes('page.get_by_test_id("passenger-trip-" + self.order_id)).to_contain_text("Ждём ответа водителя")'));
  assert.ok(qa.includes('self.passenger_page.get_by_test_id("onay-trips-open-history").click()'));
  assert.ok(qa.includes('completed_row = self.passenger_page.get_by_test_id("passenger-history-row-" + self.order_id)'));
  assert.ok(qa.includes('self.expect(completed_row).to_be_visible()'));
  assert.ok(qa.includes('self.expect(completed_row).to_contain_text(re.compile(r"QA линия A.*QA линия B"))'));
  assert.ok(qa.includes('self.expect(completed_row).to_contain_text("Поездка завершена")'));
  assert.ok(qa.includes('self.expected(api_request(self.args.api_url, "/orders/" + self.order_id, token=self.passenger_token), 200'));
});
