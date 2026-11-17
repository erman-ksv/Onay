import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("native OTP Back returns to phone only outside an in-flight verification", () => {
  const auth = read("../components/OnayAuthScreen.tsx");
  assert.match(auth, /if \(!props.requested \|\| Platform.OS !== "android"\) return;/);
  assert.match(auth, /BackHandler.addEventListener\("hardwareBackPress", \(\) => \{\s*if \(!props.busy\) props.onBackToPhone\(\);\s*return true;/);
  assert.match(auth, /return \(\) => subscription.remove\(\);/);
});

test("logout resets driver navigation before revocation can finish", () => {
  const app = read("../app/index.tsx");
  const logout = app.slice(app.indexOf("async function logout()"), app.indexOf("async function getCoordinates()"));
  const clear = app.slice(app.indexOf("const clearSession = useCallback"), app.indexOf("async function saveEndpoint()"));
  const reset = clear.indexOf('setDriverTab("line"); setDriverSubpage(null); setRouteEditorOpen(false); setBookingPage(null)');
  assert.ok(reset >= 0);
  assert.ok(reset < clear.indexOf("await AsyncStorage.removeItem(TOKEN)"));
  assert.ok(logout.indexOf("await clearSession()") < logout.indexOf('await request<void>("/api/auth/logout"'));
});

test("fresh unconfigured startup opens auth, with endpoint setup still required for real OTP", () => {
  const app = read("../app/index.tsx");
  assert.ok(app.includes('const [showEndpointSettings, setShowEndpointSettings] = useState(false);'));
  assert.ok(app.includes('if (!apiBase) setShowEndpointSettings(true); else void login(verify);'));
});
