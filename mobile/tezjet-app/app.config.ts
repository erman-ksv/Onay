import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ConfigContext, ExpoConfig } from "expo/config";

/** The CI receipt is the source of truth. Never hardcode a commit into this file. */
export function resolveOnayBuildMetadata(
  config: Partial<ExpoConfig>,
  rawReceipt: unknown,
  env: Record<string, string | undefined>,
) {
  const receipt = rawReceipt === null ? null : rawReceipt;
  if (receipt !== null) {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      throw new Error("Invalid build-provenance.json: expected an object");
    }
    const data = receipt as Record<string, unknown>;
    if (typeof data.sourceSha !== "string" || !/^[0-9a-f]{40}$/.test(data.sourceSha)) {
      throw new Error("Invalid build-provenance.json: sourceSha must be a full commit SHA");
    }
    if (config.android?.versionCode !== undefined && data.versionCode !== config.android.versionCode) {
      throw new Error("Build provenance versionCode does not match Expo Android config");
    }
    if (config.android?.package !== undefined && data.applicationId !== config.android.package) {
      throw new Error("Build provenance applicationId does not match Expo Android config");
    }
    if (env.ONAY_BUILD_SHA && env.ONAY_BUILD_SHA !== data.sourceSha) {
      throw new Error("ONAY_BUILD_SHA conflicts with build-provenance.json");
    }
    return {
      commit: data.sourceSha,
      branch: typeof data.sourceBranch === "string" ? data.sourceBranch : env.ONAY_BUILD_BRANCH || "local",
      runId: typeof data.runId === "string" ? data.runId : env.GITHUB_RUN_ID || null,
      versionCode: data.versionCode,
    };
  }
  // Development without a CI receipt: never claim an unverified source SHA.
  return {
    commit: env.ONAY_BUILD_SHA || "local",
    branch: env.ONAY_BUILD_BRANCH || "local",
    runId: env.GITHUB_RUN_ID || null,
    versionCode: config.android?.versionCode ?? null,
  };
}

function readBuildReceipt(): unknown {
  const filename = resolve(process.cwd(), "build-provenance.json");
  return existsSync(filename) ? JSON.parse(readFileSync(filename, "utf8")) as unknown : null;
}

/** Public build identity becomes part of the actual Expo config during export AND prebuild. */
export default function ({ config }: ConfigContext): ExpoConfig {
  return {
    ...config,
    name: config.name || "Onay",
    slug: config.slug || "tezjet",
    extra: {
      ...config.extra,
      onayDemoPreview: process.env.ONAY_DEMO_PREVIEW === "true",
      onayBuild: resolveOnayBuildMetadata(config, readBuildReceipt(), process.env),
    },
  };
}
