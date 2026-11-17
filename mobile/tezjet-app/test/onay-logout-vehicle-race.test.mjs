import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const start = app.indexOf("  async function logout() {");
const end = app.indexOf("  async function getCoordinates()", start);
const logout = app.slice(start, end);

test("driver logout unmounts token-bound views before server revocation", () => {
  assert.ok(start > 0 && end > start);
  assert.ok(logout.includes("const logoutToken = token;"));
  assert.ok(logout.includes("await clearSession();"));
  assert.ok(logout.includes('request<void>("/api/auth/logout", logoutToken, { method: "POST" })'));
  assert.ok(logout.indexOf("await clearSession();") < logout.indexOf('request<void>("/api/auth/logout", logoutToken'));
  assert.ok(app.includes('key={driverRouteSession} endpoint={apiBase} token={token} blocked='));
  assert.ok(app.indexOf('if (entryScreen === "auth")') < app.indexOf('return <OnayDriverShell'));
  assert.ok(app.includes('if (!profile || !token) return <OnayScreenFrame'));
});

test("logout still revokes captured server token and keeps offline/failure cleanup", () => {
  assert.ok(logout.includes('if (logoutToken)'));
  assert.ok(logout.includes("catch { /* local session is already cleared, even when offline */ }"));
  assert.ok(logout.includes('setMessage(""); setDataError("");'));
  assert.ok(logout.includes("} finally { setBusy(false); }"));
  assert.ok(app.includes('currentToken.current = "";'));
  assert.ok(app.includes('setToken(""); setProfile(null);'));
  assert.ok(app.includes('await AsyncStorage.removeItem(TOKEN)'));
  assert.ok(app.includes('activeController.current?.abort()') === false, "Vehicle request cancellation belongs inside the vehicle component");
});
