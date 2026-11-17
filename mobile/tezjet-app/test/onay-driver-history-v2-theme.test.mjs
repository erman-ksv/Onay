import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../components/DriverHistory.tsx", import.meta.url), "utf8");

test("driver history retains Onay V2 dark readable card, rows, summary and empty state", () => {
  assert.match(source, /import \{ onayDark \} from "\.\.\/lib\/onay-auth-ui"/);
  for (const token of ["card", "border", "cardRaised", "text", "muted", "accent", "danger"]) {
    assert.ok(source.includes("onayDark." + token), "Missing theme token " + token);
  }
  for (const surface of ["card", "heading", "button", "buttonText", "totals", "money", "empty", "emptyTitle", "row", "rowTitle", "rowAmount", "error"]) {
    assert.ok(source.includes("  " + surface + ": {"), "Missing styled surface " + surface);
  }
  assert.match(source, /testID="driver-history-empty"/);
  assert.match(source, /testID="driver-history-totals" style=\{s\.totals\}/);
  assert.match(source, /<Text style=\{s\.money\} key=\{money\.currency\}>\{formatFareMoney\(money\)\}<\/Text>/);
});

test("driver history keeps server-only actual closed journeys and honest fare accounting", () => {
  assert.match(source, /validateApiEndpoint\(endpoint\) \+ "\/api\/orders"/);
  assert.match(source, /Authorization: \`Bearer \$\{token\}\`/);
  assert.match(source, /parseDriverHistory\(await response\.json\(\), driverId\)/);
  assert.match(source, /generation\.current === ticket && !controller\.signal\.aborted/);
  assert.match(source, /snapshot\.totals === null/);
  assert.match(source, /order\.status === "cancelled" \? " · не входит в заработок"/);
  assert.match(source, /snapshot\.rows\.slice\(0, limit\)/);
  assert.match(source, /setLimit\(value => value \+ 20\)/);
  assert.match(source, /testID="driver-history-toggle"/);
  assert.match(source, /testID="driver-history-refresh"/);
  assert.match(source, /testID="driver-history-error" accessibilityRole="alert"/);
});
