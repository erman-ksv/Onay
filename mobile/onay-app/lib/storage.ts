export const TOKEN_STORAGE_KEY = "onay_access_token";
export const API_ENDPOINT_STORAGE_KEY = "onay_api_endpoint";

// Compatibility keys are read only while upgrading an existing device store.
const LEGACY_TOKEN_KEY = "tezjet_access_token";
const LEGACY_ENDPOINT_KEY = "tezjet_api_endpoint";

type SessionStorage = {
  multiGet(keys: string[]): Promise<readonly (readonly [string, string | null])[]>;
  multiSet(entries: [string, string][]): Promise<unknown>;
  multiRemove(keys: string[]): Promise<unknown>;
};

export async function readStoredSession(storage: SessionStorage): Promise<{ endpoint: string | null; token: string | null }> {
  const values = new Map(await storage.multiGet([
    API_ENDPOINT_STORAGE_KEY, TOKEN_STORAGE_KEY, LEGACY_ENDPOINT_KEY, LEGACY_TOKEN_KEY,
  ]));
  const currentEndpoint = values.get(API_ENDPOINT_STORAGE_KEY) ?? null;
  const legacyEndpoint = values.get(LEGACY_ENDPOINT_KEY) ?? null;
  const endpoint = currentEndpoint ?? legacyEndpoint;
  // A leftover token from another server must never follow a newer endpoint.
  const endpointChanged = currentEndpoint !== null && currentEndpoint !== legacyEndpoint;
  const token = values.get(TOKEN_STORAGE_KEY) ?? (endpointChanged ? null : values.get(LEGACY_TOKEN_KEY) ?? null);
  const migrated: [string, string][] = [];
  if (currentEndpoint === null && endpoint !== null) migrated.push([API_ENDPOINT_STORAGE_KEY, endpoint]);
  if (values.get(TOKEN_STORAGE_KEY) == null && token !== null) migrated.push([TOKEN_STORAGE_KEY, token]);

  try {
    if (migrated.length) await storage.multiSet(migrated);
    // Remove the old copies only after the new values have been saved.
    await storage.multiRemove([LEGACY_ENDPOINT_KEY, LEGACY_TOKEN_KEY]);
  } catch {
    // A failed migration must not discard the restored session or its backup.
    // The next launch will retry the copy/cleanup.
  }
  return { endpoint, token };
}

export async function clearStoredToken(storage: Pick<SessionStorage, "multiRemove">): Promise<void> {
  // Clear both namespaces so a legacy token cannot restore a signed-out session.
  await storage.multiRemove([TOKEN_STORAGE_KEY, LEGACY_TOKEN_KEY]);
}
