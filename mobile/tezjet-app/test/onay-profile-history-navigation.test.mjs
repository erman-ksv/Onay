import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const history = readFileSync(new URL("../components/PassengerHistory.tsx", import.meta.url), "utf8");
const profile = readFileSync(new URL("../components/OnayPassengerProfile.tsx", import.meta.url), "utf8");

test("Profile History opens the history anchor, not just the active Trips tab", () => {
  assert.match(profile, /row\("history", "История поездок", onHistory\)/);
  assert.match(app, /onHistory=\{openPassengerHistory\}/);
  assert.match(app, /function openPassengerHistory\(\) \{/);
  assert.match(app, /setHistoryOpenRequest\(revision => revision \+ 1\)/);
  assert.match(app, /setPassengerTab\("trips"\)/);
  assert.match(app, /homeScroll\.current\?\.scrollTo\(\{ y: Math\.max\(0, tripsSectionY - 12\), animated: true \}\)/);
  assert.match(app, /testID="onay-passenger-history-anchor" onLayout=\{event => setHistorySectionY\(event\.nativeEvent\.layout\.y\)\}/);
  assert.match(app, /openRequest=\{historyOpenRequest\}/);
});

test("Explicit history request expands server-backed archive without creating orders", () => {
  assert.match(history, /openRequest\?: number/);
  assert.match(history, /useEffect\(\(\) => \{ if \(openRequest > 0\) setOpen\(true\); \}, \[openRequest\]\)/);
  assert.match(history, /if \(open\) void load\(\)/);
  assert.match(history, /validateApiEndpoint\(endpoint\) \+ "\/api\/orders"/);
  assert.match(history, /generation\.current === ticket && !controller\.signal\.aborted/);
  assert.match(history, /testID="passenger-history-toggle"/);
  assert.match(history, /testID="passenger-history-refresh"/);
  assert.doesNotMatch(app.slice(app.indexOf("function openPassengerHistory()"), app.indexOf("function openPassengerRoutePicker()")), /request<|\/api\/orders|\/api\/queue|order\(/);
});
