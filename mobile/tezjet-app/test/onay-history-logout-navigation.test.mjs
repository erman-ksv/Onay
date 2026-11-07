import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const qa=readFileSync(new URL("../../../scripts/line-ride-browser-qa.py",import.meta.url),"utf8");
const app=readFileSync(new URL("../app/index.tsx",import.meta.url),"utf8");
const profile=readFileSync(new URL("../components/OnayPassengerProfile.tsx",import.meta.url),"utf8");
const history=readFileSync(new URL("../components/PassengerHistory.tsx",import.meta.url),"utf8");
test("pending authenticated history can be logged out from its real Profile tab",()=>{
 assert.ok(qa.includes('page.get_by_test_id("onay-tab-profile").click()'));
 assert.ok(qa.includes('self.expect(page.get_by_test_id("onay-profile-logout")).to_be_visible()'));
 assert.ok(qa.includes('page.get_by_test_id("onay-profile-logout").click()'));
 assert.ok(profile.includes('testID="onay-profile-logout" onPress={onLogout}'));
 assert.ok(app.includes('onLogout={logout}'));
 assert.ok(app.includes('setToken(""); setProfile(null);'));
});
test("actual held history GET is discarded after logout rather than restoring private rows",()=>{
 assert.ok(qa.includes('page.route("**/api/orders", delay_read)'));
 assert.ok(qa.includes('get_by_test_id("passenger-history-loading")).to_be_visible()'));
 assert.ok(qa.includes('get_by_test_id("passenger-history")).to_have_count(0)'));
 assert.ok(qa.includes('get_by_test_id("passenger-history-results")).to_have_count(0)'));
 assert.ok(history.includes('active.current?.abort()'));
 assert.ok(history.includes('generation.current === ticket && !controller.signal.aborted'));
});
