# Scoped PostCSS remediation and compatibility evidence

Base: `b2720c2e87c2ef2e4e2e0358c4f8b1af881ffbf1`, existing PR110. Isolated branch `onay-agent/mobile-postcss`; verification resumed2026-11-15 after a saved usage-limit interruption. Status at this record: local checks PASS; exact-commit independent review and new-source remote CI PENDING. The current feature branch was not changed during implementation.

The mobile workspace adds only `@expo/metro-config@54.0.17>postcss:8.5.23`. This is an explicitly approved compatibility exception outside the parent's declared `~8.4.32`, supported by real Metro transformer tests. It is not described as an in-range dependency refresh. No application source,20direct dependency versions, root configuration/lock, native SDK or permissions changed.

The lockfile differs only by the exact override, PostCSS8.4.49→8.5.23 registry integrity and one Metro consumer edge. PostCSS's already-locked nanoid/picocolors/source-map-js dependencies remain identical. All696 registry package resolutions retain SHA512 integrity; the new package integrity matches cached official-registry metadata. Release-age1440, empty dependency-hook allowlist and strictDepBuilds remain effective and unchanged.

## Executed evidence

| Check | Result |
|---|---|
| Fresh frozen mobile install, without ignore-scripts | PASS, completed before the interruption; existing lock/install evidence was preserved, not re-applied. Actual Metro resolves8.5.23. |
| Effective policy readback after resume |1440 minutes, strictDepBuildstrue, onlyBuiltDependencies[] |
| Four advisory regressions against old8.4.49 | Four expected failures, one per advisory class; temporary copy of the regression module substituted only the tested PostCSS entry. No old package was added to the graph. |
| Fixed-graph targeted tests |7PASS: four advisory cases, legitimate local/inline maps, actual Metro CSS plugin/map transform |
| Full mobile Node suite |363PASS,0FAIL, no tests disabled |
| Mobile TypeScript |PASS |
| JS exports |Android Hermes, iOS Hermes and Web PASS; no APK/prebuild/emulator |
| Exact graph/policy invariants |PASS: all20 importer versions unchanged, one package/consumer edge only, root files/manifests untouched |
| One bounded official-registry production audit |Measured0critical/3high/4moderate/1low; exit1 due remaining advisories, no API error; no second audit or audit-fix command |

The audited baseline was0critical/5high/6moderate/1low. All four PostCSS advisory IDs are absent from the measured candidate inventory: GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849, GHSA-fxqj-rqcc-2cmp and GHSA-qx2v-qp2m-jg93. The eight remaining occurrences are still OPEN. Sanitized final evidence is `docs/onay-postcss-audit-inventory.json`; this is not a clean security audit, exploitability assessment or production approval.

Security cases use generated temporary sentinel files exclusively, with separate worker execution bounded at10seconds and complete cleanup. They verify no sentinel read for non-map/traversing annotations or map autoload without from, and no literal closing-style sequence in serialized output. Legitimate local and inline maps retain sourcesContent. No real host/private files or browser script execution is involved.

The compatibility case invokes the actual `@expo/metro-config` PostCSS transformer, discovered through the installed Expo dependency. A temporary postcss.config.mjs explicitly enables a declaration plugin and map:true; the result must report hasPostcss, change red→green and contain an inline map. Ordinary app JS exports alone would not exercise this optional branch. No PostCSS config was added to the application.

Commands, from mobile/tezjet-app:

```sh
corepack pnpm install --lockfile-only --ignore-scripts --prefer-offline
corepack pnpm install --frozen-lockfile
corepack pnpm config get minimumReleaseAge
corepack pnpm config get strictDepBuilds
corepack pnpm config get onlyBuiltDependencies --json
node --test --test-isolation=none test/postcss-security.test.mjs
node node_modules/typescript/bin/tsc --noEmit
node --experimental-strip-types --test --test-isolation=none test/*.test.mjs
EXPO_NO_TELEMETRY=1 CI=1 ONAY_DEMO_PREVIEW=true EXPO_PUBLIC_API_URL= node node_modules/expo/bin/cli export --clear --platform android --platform ios --platform web --output-dir /tmp/onay-postcss-export
timeout 60s corepack pnpm audit --prod --json --registry=https://registry.npmjs.org
```

Sandbox Corepack/store/cache paths were redirected to writable temporary directories; HOME and security checks were not changed. One initial version of the new test mishandled an absent result.map; that test-harness error was corrected before the recorded successful runs. No product behavior or assertions were weakened.

Candidate lockfileSHA256: `96e8a058253efc12a7f335f0ff3d429291d9e6afd0cf5bf338f5e1fc30c189a0`. Revert this scoped dependency/test/evidence commit as a unit if compatibility regresses. Do not remove release-age or hook checks, introduce broad overrides or upgrade unrelated parent majors to silence remaining advisories. Current-source native acceptance and the interactive map remain UNVERIFIED/unimplemented; this change does not authorize new native permissions or an APK build.

The following is the original Security review plan, retained as historical reasoning. Its predicted results and required checks describe the pre-implementation stage; measured results above supersede predictions.

## Historical approved Security plan (prepared before implementation)

Prepared 2026-11-15T04:27:19.224396+00:00. Baseline reviewed dependency commit d807cf37a37f73bd319bd0fb8ae10895a00e657c. Read-only investigation: no application, manifest, workspace or lock changes. Metadata fetched once per package from https://registry.npmjs.org/. Official PostCSS8.5.23 tarball fetched once, SHA512 verified against registry; only four source files inspected, no install/hooks.

## Advisory inventory

| Severity | Advisory | Locked dependency path | Vulnerable range | First candidate clearing all findings on package | Release date UTC / age |
|---|---|---|---|---|---|
| moderate | GHSA-qx2v-qp2m-jg93 | 8.4.49: .>expo>@expo/metro-config>postcss | <8.5.10 | 8.5.23 | 2026-07-24 / 113.47 days |
| high | GHSA-6g55-p6wh-862q | 8.4.49: .>expo>@expo/metro-config>postcss | <=8.5.11 | 8.5.23 | 2026-07-24 / 113.47 days |
| moderate | GHSA-fxqj-rqcc-2cmp | 8.4.49: .>expo>@expo/metro-config>postcss | <=8.5.22 | 8.5.23 | 2026-07-24 / 113.47 days |
| high | GHSA-r28c-9q8g-f849 | 8.4.49: .>expo>@expo/metro-config>postcss | <=8.5.17 | 8.5.23 | 2026-07-24 / 113.47 days |
| moderate | GHSA-vcc3-ghjq-m6fr | 0.2.2: .>expo-router>query-string>decode-uri-component | <=0.4.2 | 0.5.1 | 2026-10-23 / 22.65 days |
| high | GHSA-5p2g-fcmc-qvqq | 1.2.1: .>expo>@expo/metro>metro>image-size | >=1.2.0 <=2.0.2 | 2.0.3 | 2026-09-14 / 61.52 days |
| high | GHSA-w3rx-r6r6-pgpr | 1.2.1: .>expo>@expo/metro>metro>image-size | >=0.6.3 <=2.0.2 | 2.0.3 | 2026-09-14 / 61.52 days |
| low | GHSA-gcqx-w48m-w2h4 | 4.3.1: .>expo>@expo/config>deepmerge | >=4.2.0 <=4.3.1 | none published | N/A |
| high | GHSA-qr28-fpjm-wq7f | 0.2.2: .>expo-router>query-string>decode-uri-component | <=0.5.0 | 0.5.1 | 2026-10-23 / 22.65 days |
| moderate | GHSA-3g3m-2fjr-6pw4 | 13.0.7: .>expo>@expo/cli>glob | >=9.0.0 <=14.0.1 | 14.0.2 | 2026-10-27 / 18.26 days |
| moderate | GHSA-g3hv-75wg-m249 | 10.2.6: .>expo>@expo/cli>glob>minimatch; 9.0.9: .>expo>@expo/cli>minimatch | >=7.0.0 <11.0.1 | 11.0.1 | 2026-10-27 / 18.25 days |

The inventory contains 11 advisory IDs and12 vulnerable occurrences counted by registry:5high,6moderate,1low. Minimatch has two affected installed versions for one advisory. All candidate versions above exceed the1440-minute release-age requirement. Original metadata and raw audit remained local; baseline sanitized inventory is in docs/onay-mobile-audit-inventory.json.

## Minimal first patch: PostCSS only

Candidate: exactly PostCSS8.5.23 for the parent edge `@expo/metro-config@54.0.17>postcss`, scoped only inside the isolated mobile workspace. This is a proposed reviewed exact parent-child override/constraint, never a global `postcss` override. It changes no20direct dependency versions, Expo54.0.38, RN0.81.5 or React19.1.0.

Important compatibility boundary: parent declares `~8.4.32`;8.5.23 is outside that range. There is no fixed release satisfying the existing range, so this requires an explicit narrow compatibility exception supported by tests; it is not a routine semver-compatible refresh. Same PostCSS major, Node engine and CommonJS/ESM entry shapes remain. Metro consumer calls require(postcss).default(plugins).process(src,processOptions);8.5.23 source still exports postcss.default=postcss and the same public processor shape. Direct patch dependencies nanoid^3.3.16,picocolors^1.1.1,source-map-js^1.2.1 are already satisfied by the current locked3.3.20/1.1.1/1.2.2 versions, so avoid unrelated resolver churn.

This candidate clears the two high source-map disclosure IDs and both PostCSS moderate IDs in the current inventory. The inspected patched previous-map implementation blocks source-map autoload without a CSS filename and rejects paths outside that CSS directory. No application exploit or fixed-version regression has yet been executed by this reviewer.

Required implementation and acceptance by Integration/QA:

1. Add only the exact parent-child constraint and regenerate only its necessary lock resolutions with pnpm10.34.9; retain release-age and deny-hook settings and all20direct resolutions. Review the full lock diff and integrity.
2. Add bounded source-level regression cases for all four PostCSS advisories: external/traversing sourceMappingURL must not read a temporary sentinel outside the CSS directory; absent `from` must not auto-read a map; legitimate local/inline source-map behavior must remain supported; CSS serialization must handle the advisory closing-style payload as specified by the upstream fix. Use temp fixtures and worker timeout, never real host/private files.
3. Exercise Metro actual PostCSS transformer with an explicit temporary postcss.config and representative plugin/from/map options. The current app has no discovered CSS/PostCSS config, and ordinary JS exports may skip this branch, so passing exports alone is insufficient compatibility proof.
4. Fresh frozen install without ignore-scripts; verify effective deny-hook/age policy, unchanged lock after install, direct-version equality. Run TypeScript,356baseline mobile tests plus meaningful new regressions, Android/iOS/Web JS exports. No SDK/prebuild/APK/emulator.
5. One bounded official-registry audit on final graph; expected reduction is5high/6moderate/1low to3high/4moderate/1low,0critical. This is a prediction, not a measured fixed-graph result. Remote CI required on exact integrated SHA.

## Remaining compatible-update blockers

- image-size1.2.1 is required by metro0.83.3 as^1.0.2. The latest1.x is still1.2.1; fixed2.0.3 is a major/API change (dual exported entry layout, Node>=18 vs>=16, filename API moved to /fromFile). Metro source uses default-callable require interop, so a blind major override is unsafe. Keep the two high IDs OPEN; separately investigate an upstream Metro-compatible backport or reviewed exact-package patch, with malformed ICNS/JXL/HEIF timeout regressions and actual Metro asset transformation. No parent-major upgrade authorized by this plan.
- decode-uri-component0.2.2 is required by CommonJS query-string7.1.3 as^0.2.2. Fixed0.5.1 is outside range and ESM-only with Node>=14.16, while query-string uses require(decode-uri-component). Node22 require behavior does not prove Metro/Hermes compatibility. Latest query-string7.x remains7.1.3; a parent-major change is out of scope. Keep one high and one moderate ID OPEN pending compatible upstream backport or separately reviewed package patch.
- glob13.0.7 is the newest13.x and parents declare^13.0.0. Fixed14.0.2 changes minimatch^10 to^11 and path-scurry^2 to^3; this is not a safe patch resolution. One moderate ID remains OPEN.
- minimatch9.0.9 and10.2.6 are newest respective major lines; parent ranges are CLI^9.0.0 and glob^10.2.2. Fixed11.0.1 crosses both major ranges and changes matching implementation/dependencies. Two moderate occurrences remain OPEN. A coordinated upstream-compatible backport should consider glob+minimatch together; no blanket override.
- deepmerge4.3.1 remains latest and audit supplies patched_versions<0.0.0 (no published fix). @expo/config12.0.14 uses it for configuration/plugin merge, not observed account data. One low finding OPEN; review upstream patch or safe-data boundary separately.

No strict in-range update clears any listed finding. If the scoped PostCSS minor exception is not accepted or its compatibility tests fail, all12 occurrences remain open; do not force it. After a verified PostCSS-only change, eight occurrences remain blocked under current constraints:3high,4moderate,1low.

## Reachability and priority

PostCSS is build tooling under Expo Metro; processing requires a discovered PostCSS config, and malformed source-map annotations matter for attacker-controlled CSS/build inputs. image-size is called from Metro Assets; normal asset extensions are filtered but untrusted bytes with a permitted filename could still reach format detection, so do not claim the file-extension gate eliminates exposure. These are build/dev input risks, not established remote mobile backend exploits.

decode-uri-component is present through expo-router/query-string. The inspected Expo Router6.0.24 incoming query parser uses new URL(...).searchParams, while observed query-string use serializes paths; the old queryString.parse call is commented out. An actual malformed-deep-link path to the vulnerable decoder has not been established. Keep the advisory visible without claiming a proven app exploit. Glob/minimatch traverse source/project paths in CLI tooling; deepmerge combines config/plugin objects.

Prioritize the PostCSS narrow candidate (2high+2moderate) first, then separately scoped compatible backport research for image-size(2high) and decode-uri(1high+1moderate). Do not perform broad audit-fix, major SDK/parent upgrade, hook allow-all, release-age exemptions, new secrets or paid services. Execution/quota limits UNKNOWN.
