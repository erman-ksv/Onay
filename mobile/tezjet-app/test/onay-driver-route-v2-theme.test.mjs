import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../components/DriverRoutePicker.tsx", import.meta.url), "utf8");

test("driver route picker uses shared Onay Driver V2 dark palette with legible states", () => {
  assert.match(source, /import \{ onayDark \} from "\.\.\/lib\/onay-auth-ui"/);
  assert.match(source, /backgroundColor: onayDark\.card, borderRadius: 24, borderWidth: 1, borderColor: onayDark\.border/);
  assert.match(source, /heading: \{[^}]*color: onayDark\.text/);
  assert.match(source, /description: \{[^}]*color: onayDark\.muted/);
  assert.match(source, /option: \{[^}]*backgroundColor: onayDark\.cardRaised/);
  assert.match(source, /selected: \{ borderColor: onayDark\.accent, backgroundColor: "#20442d" \}/);
  assert.match(source, /buttonText: \{ color: onayDark\.accentInk/);
  assert.match(source, /secondaryText: \{ color: onayDark\.text \}/);
  assert.match(source, /status: \{ color: "#c8fae0", backgroundColor: "#194b35"/);
  assert.match(source, /warning: \{ color: "#ffd19a", backgroundColor: "#4a3621"/);
  assert.match(source, /ActivityIndicator color=\{onayDark\.accent\}/);
});

test("driver route picker preserves live server values and queue mutation safeguards", () => {
  assert.match(source, /createDriverRouteClient\(endpoint, token\)/);
  assert.match(source, /const allowed = canMutateDriverRoute\(props\)/);
  assert.match(source, /const disabled = !allowed \|\| loading \|\| saving/);
  assert.match(source, /scope\.current\.isCurrent\(ticket\)/);
  assert.match(source, /onStatusChange\(\{ sessionKey, ready, hasChoice:/);
  assert.match(source, /testID="driver-route-status"/);
  assert.match(source, /testID=\{\`driver-route-\$\{route\.id\}\`\}/);
  assert.match(source, /testID="driver-route-save"/);
  assert.match(source, /testID="driver-route-clear"/);
  assert.match(source, /testID="driver-route-refresh"/);
  assert.match(source, /onPress=\{onPress\} disabled=\{disabled\}/);
});
