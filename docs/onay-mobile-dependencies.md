# Reproducible isolated mobile dependencies

Verified2026-11-15 from base `c44b1248a61d1a8c405fa3fc015c2c0b233b05eb`, worktree `onay-agent/mobile-lock`. The existing nested `mobile/tezjet-app/pnpm-workspace.yaml` remains the installation boundary. No application source, native SDK, root lockfile, root workspace override or historical release workflow is changed.

## Why isolation

Root workspace membership does not include mobile. Its global overrides remove macOS/Windows/other platform binary packages and force backend tooling versions; importing these into mobile would expand the change and risk Expo developer platforms. Mobile instead retains `packages: []`, gets its own committed lockfile and explicit supply-chain settings: minimumReleaseAge1440, no release-age exemptions, autoInstallPeersfalse, strictPeerDependenciesfalse (matching existing root.npmrc), empty onlyBuiltDependencies and strictDepBuildstrue. No hook allowlist entry was needed for the tested Linux dependency graph. Other host platforms remain runtimeUNVERIFIED; their optional packages are retained rather than stripped.

Package manager10.34.9 matches actual successful GitHub Mobile CI run43674504168/job132691569898. Both active mobile installs now use frozen lockfiles from mobile cwd. Driver browser workflow's existing pnpm cache key includes root and mobile lockfiles; Mobile CI does not gain a new cache. Existing application tests, exports, artifact/provenance and native build guards remain enabled.

## Exact local verification

Run Corepack from the mobile directory; `--dir mobile/...` from root does not change Corepack's own package-manager discovery. The wrong-cwd attempt selected another manager and was rejected by packageManager version validation before writing a lock. It was corrected by using mobile cwd, without bypassing that check.

```sh
cd mobile/tezjet-app
corepack pnpm --version
corepack pnpm install --lockfile-only --ignore-scripts
corepack pnpm install --frozen-lockfile
corepack pnpm config get minimumReleaseAge
corepack pnpm config get strictDepBuilds
corepack pnpm config get onlyBuiltDependencies --json
node node_modules/typescript/bin/tsc --noEmit
node --experimental-strip-types --test --test-isolation=none test/*.test.mjs
EXPO_NO_TELEMETRY=1 CI=1 ONAY_DEMO_PREVIEW=true EXPO_PUBLIC_API_URL= node node_modules/expo/bin/cli export --clear --platform android --platform ios --platform web --output-dir /tmp/onay-mobile-lock-export
```

Sandbox-specific writable Corepack/XDG cache locations were supplied under /tmp. No HOME variable or security policy was overridden. Initial Expo export could not create CLI telemetry state under read-only home; telemetry was disabled for local verification and export then passed. This was an environment adjustment, not a dependency/application repair.

- Two fresh installations, first in the isolated worktree and second with copied manifest/workspace/lock in an empty temporary directory, both completed using `install --frozen-lockfile` **without --ignore-scripts**. The explicit lifecycle policy was active.
- Both preserved byte-identical lockfileSHA256 `243e57c03ac4d80e81d0efe515e7dc290cd67ed59c921b51906d138ba37ed8a1`. All696 package resolutions carry integrity hashes.
- Effective configuration readback: minimumReleaseAge1440, strictDepBuildstrue, onlyBuiltDependencies[]. Both node_modules metadata files show pendingBuilds[]. The informational ignored-builds CLI command was inconclusive in this environment; it is not credited as proof.
- An isolated negative fixture using esbuild0.28.2 and the same policy failed frozen install with ERR_PNPM_IGNORED_BUILDS; no hook was approved. This proves the explicit deny rather than claiming an ignored hook ran successfully. No fixture dependency was added to ONAY.
- Changing only the second temporary manifest's TypeScript range caused ERR_PNPM_OUTDATED_LOCKFILE. The fixture manifest was restored.
- Mobile TypeScriptPASS; complete mobile Node suite356PASS/0FAIL. Android/iOS Hermes JS and Web exportsPASS. No APK, prebuild, emulator, native SDK or production operation was run.
- Root lock/workspace files compare byte-for-byte with the base. All13 workflowYAML files parse. The two active workflow changes are pinned pnpm version, frozen mobile install and the driver's existing cache dependency paths; all other fields compare identically.

## Dependency versions

All20 direct resolved versions match the successful source-matched Mobile CI installation listed above. Existing manifest dependency ranges were not changed. Transitive resolution is now recorded for the first time in the mobile lockfile; there was no previous committed mobile lock graph to compare, so complete historical transitive equality is not claimed.

| Package | Resolved version |
|---|---|
| @react-native-async-storage/async-storage | 2.2.0 |
| expo | 54.0.38 |
| expo-clipboard | 8.0.8 |
| expo-constants | 18.0.14 |
| expo-linking | 8.0.12 |
| expo-location | 19.0.8 |
| expo-navigation-bar | 5.0.10 |
| expo-router | 6.0.24 |
| expo-splash-screen | 31.0.13 |
| expo-status-bar | 3.0.9 |
| react | 19.1.0 |
| react-dom | 19.1.0 |
| react-native | 0.81.5 |
| react-native-gesture-handler | 2.28.0 |
| react-native-safe-area-context | 5.6.2 |
| react-native-screens | 4.16.0 |
| react-native-web | 0.21.4 |
| socket.io-client | 4.8.4 |
| @types/react | 19.1.17 |
| typescript | 5.9.3 |

Optional Darwin, Windows and Android package entries remain in this lockfile. Native compile and runtime behavior on those hosts has not been tested here. A future dependency hook requiring execution must be inspected and approved by exact package/version before a narrow allowlist change; never approve all hooks or remove the release-age delay.

## Rollback and next gate

Revert this isolated dependency-policy commit as a unit to restore the previous install behavior; no data migration or application-source rollback is involved. Review the dependency graph, lockfile integrity, active CI install boundary and supply-chain settings before integration. New-commit remote CI is NOT RUN at this document's creation. No claim is made that the interactive map exists or overall readiness has reached90%. Future MapLibre work starts from this reproducible graph and still requires its own dependency, native and service review.
