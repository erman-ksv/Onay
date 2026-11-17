export type OnayBuildMode = "demo" | "live";

function positiveBuildCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function displayVersion(value: unknown): string | null {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value) ? value : null;
}

/**
 * Compare device-native versionCode with the immutable CI build receipt.
 * Never invent a code/SHA when build metadata is unavailable.
 */
export function getOnayBuildIdentity(
  configuredVersion: unknown,
  nativeVersion: unknown,
  nativeBuildCode: unknown,
  buildReceipt: unknown,
  mode: OnayBuildMode,
) {
  const receipt: Record<string, unknown> = buildReceipt && typeof buildReceipt === "object"
    ? buildReceipt as Record<string, unknown> : {};
  const nativeCode = positiveBuildCode(nativeBuildCode);
  const receiptCode = positiveBuildCode(receipt.versionCode);
  const sourceSha = typeof receipt.commit === "string" && /^[0-9a-f]{40}$/i.test(receipt.commit)
    ? receipt.commit.toLowerCase() : null;

  return {
    version: displayVersion(nativeVersion) ?? displayVersion(configuredVersion) ?? "недоступна",
    versionCode: nativeCode ?? receiptCode,
    sourceSha,
    shortSha: sourceSha?.slice(0, 12) ?? "недоступен",
    mode: mode === "demo" ? "Демо" : "Обычный",
    versionMismatch: nativeCode !== null && receiptCode !== null && nativeCode !== receiptCode,
    codeSource: nativeCode !== null ? "native" : receiptCode !== null ? "receipt" : "unavailable",
  };
}
