import assert from "node:assert/strict";
import { test } from "node:test";
import { clearStoredToken, readStoredSession } from "../lib/storage.ts";

function memoryStorage(entries = {}, options = {}) {
  const values = new Map(Object.entries(entries));
  const calls = [];
  return {
    values,
    calls,
    async multiGet(keys) {
      if (options.failRead) throw new Error("read failed");
      return keys.map(key => [key, values.get(key) ?? null]);
    },
    async multiSet(entries) {
      calls.push(["set", entries]);
      if (options.failWrite) throw new Error("write failed");
      for (const [key, value] of entries) values.set(key, value);
    },
    async multiRemove(keys) {
      calls.push(["remove", keys]);
      if (options.failRemove) throw new Error("remove failed");
      for (const key of keys) values.delete(key);
    },
  };
}

test("existing endpoint and token move to Onay keys before legacy cleanup", async () => {
  const storage = memoryStorage({
    tezjet_api_endpoint: "https://existing.example.invalid",
    tezjet_access_token: "existing-session",
  });
  assert.deepEqual(await readStoredSession(storage), {
    endpoint: "https://existing.example.invalid", token: "existing-session",
  });
  assert.deepEqual(Object.fromEntries(storage.values), {
    onay_api_endpoint: "https://existing.example.invalid", onay_access_token: "existing-session",
  });
  assert.deepEqual(storage.calls.map(([operation]) => operation), ["set", "remove"]);
});

test("a failed copy preserves legacy values and restores the session for this launch", async () => {
  const storage = memoryStorage({
    tezjet_api_endpoint: "https://existing.example.invalid", tezjet_access_token: "existing-session",
  }, { failWrite: true });
  assert.deepEqual(await readStoredSession(storage), {
    endpoint: "https://existing.example.invalid", token: "existing-session",
  });
  assert.equal(storage.values.get("tezjet_access_token"), "existing-session");
  assert.equal(storage.values.get("tezjet_api_endpoint"), "https://existing.example.invalid");
  assert.deepEqual(storage.calls.map(([operation]) => operation), ["set"]);
});

test("a failed cleanup leaves saved Onay values authoritative on the next launch", async () => {
  const storage = memoryStorage({
    tezjet_api_endpoint: "https://existing.example.invalid", tezjet_access_token: "existing-session",
  }, { failRemove: true });
  await readStoredSession(storage);
  storage.values.set("onay_access_token", "current-session");
  assert.deepEqual(await readStoredSession(storage), {
    endpoint: "https://existing.example.invalid", token: "current-session",
  });
  assert.equal(storage.values.get("tezjet_access_token"), "existing-session");
});

test("Onay keys take precedence over older endpoint and session values", async () => {
  const storage = memoryStorage({
    onay_api_endpoint: "https://current.example.invalid", onay_access_token: "current-session",
    tezjet_api_endpoint: "https://previous.example.invalid", tezjet_access_token: "previous-session",
  });
  assert.deepEqual(await readStoredSession(storage), {
    endpoint: "https://current.example.invalid", token: "current-session",
  });
  assert.equal(storage.values.has("tezjet_access_token"), false);
});

test("a copied endpoint can still recover its legacy token after a partial migration", async () => {
  const storage = memoryStorage({
    onay_api_endpoint: "https://existing.example.invalid",
    tezjet_api_endpoint: "https://existing.example.invalid", tezjet_access_token: "existing-session",
  });
  assert.deepEqual(await readStoredSession(storage), {
    endpoint: "https://existing.example.invalid", token: "existing-session",
  });
  assert.equal(storage.values.get("onay_access_token"), "existing-session");
});

test("a newer server never restores a legacy token from another or unknown server", async () => {
  for (const legacyEndpoint of ["https://previous.example.invalid", undefined]) {
    const storage = memoryStorage({
      onay_api_endpoint: "https://current.example.invalid", tezjet_access_token: "previous-session",
      ...(legacyEndpoint ? { tezjet_api_endpoint: legacyEndpoint } : {}),
    });
    assert.deepEqual(await readStoredSession(storage), {
      endpoint: "https://current.example.invalid", token: null,
    });
    assert.equal(storage.values.has("onay_access_token"), false);
  }
});

test("a legacy token without a saved endpoint is preserved for the build-time API", async () => {
  const storage = memoryStorage({ tezjet_access_token: "existing-session" });
  assert.deepEqual(await readStoredSession(storage), { endpoint: null, token: "existing-session" });
  assert.equal(storage.values.get("onay_access_token"), "existing-session");
});

test("sign-out clears both token namespaces while keeping the API setting", async () => {
  const storage = memoryStorage({
    onay_api_endpoint: "https://existing.example.invalid", onay_access_token: "current-session",
    tezjet_access_token: "previous-session",
  });
  await clearStoredToken(storage);
  assert.deepEqual(await readStoredSession(storage), {
    endpoint: "https://existing.example.invalid", token: null,
  });
});

test("failed token deletion propagates so changing API servers can stop", async () => {
  const storage = memoryStorage({ onay_access_token: "current-session" }, { failRemove: true });
  await assert.rejects(clearStoredToken(storage), /remove failed/);
  assert.equal(storage.values.get("onay_access_token"), "current-session");
});

test("an unreadable store propagates an error without mutating its saved values", async () => {
  const storage = memoryStorage({ tezjet_access_token: "existing-session" }, { failRead: true });
  await assert.rejects(readStoredSession(storage), /read failed/);
  assert.equal(storage.values.get("tezjet_access_token"), "existing-session");
  assert.deepEqual(storage.calls, []);
});
