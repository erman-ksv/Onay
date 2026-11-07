import type { ConfigContext, ExpoConfig } from "expo/config";
/** Build identity is public metadata. No tokens or API credentials are embedded. */
export default function ({ config }: ConfigContext): ExpoConfig {
 return { ...config, name: config.name || "Onay", slug: config.slug || "tezjet", extra: {
  ...config.extra,
  onayDemoPreview: process.env.ONAY_DEMO_PREVIEW === "true",
  onayBuild: { commit: process.env.ONAY_BUILD_SHA || "local", branch: process.env.ONAY_BUILD_BRANCH || "local", runId: process.env.GITHUB_RUN_ID || null, versionCode: config.android?.versionCode || 112 },
 } };
}
