import type { OnayLanguage } from "./onay-translations";

export const ONAY_SAVED_LANGUAGE_KEY = "onay_language_v1";

/** A corrupt/absent setting falls back to the existing Russian default, not a network request. */
export function parseOnayStartupLanguage(value: unknown): OnayLanguage {
 return value === "ru" || value === "kk" || value === "uz" ? value : "ru";
}

/** A rejected device-store read must be surfaced to retry UI, not silently accepted as Russian. */
export async function hydrateOnayStartupLanguage(read: () => Promise<string | null>): Promise<OnayLanguage> {
 return parseOnayStartupLanguage(await read());
}
