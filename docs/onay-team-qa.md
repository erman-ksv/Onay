# ONAY independent team QA — 2026-11-14

Scope: existing PR #110, `feat/artifact-auth-ui-v1`; source baseline `2cd511526bf66559be05cfd486c038a6e5cbe449`. Work executed in isolated `/workspace/onay-worktrees/qa`, without changing another specialist worktree. This record is not a production or native Android acceptance claim.

## Verified commands

| Check | Command / setup | Result |
|---|---|---|
| Mobile unit/component checks | From `mobile/tezjet-app`: `node --experimental-strip-types --test --test-isolation=none test/*.test.mjs` | 356 PASS, 0 FAIL, including phone, GPS deadline, optional geometry, native accessibility and personal details |
| Final API integration | From `artifacts/api-server`: `node build.mjs`, then `node --test --test-concurrency=1 test/*.test.mjs`; dedicated disposable PostgreSQL16 database with actual migrations | 656 PASS, 0 FAIL including socket validation/privacy and both durable adapters |
| Required bounded queue-load CI check | API: `node --test bench/queue-load.test.mjs` against private PostgreSQL schema | 1 PASS; source-free receipt in `docs/onay-queue-load-verification.json`; no production capacity claim |
| Shared libraries | Root: `node node_modules/typescript/bin/tsc --build` | PASS |
| API typecheck | From API: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | PASS including final socket followup |
| Mockup/admin typecheck | From `artifacts/mockup-sandbox`: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | PASS |
| Scripts typecheck | From `scripts`: `node ../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | PASS |
| Mobile typecheck | From mobile: `node node_modules/typescript/bin/tsc --noEmit` | PASS including personal-details localization |
| Admin/deployment small checks | Root: `node --experimental-transform-types --test scripts/*.test.mjs deploy/onay/*.test.mjs` | 60 PASS, 0 FAIL |
| Whitespace/diff integrity | `git diff --check 2cd511526bf66559be05cfd486c038a6e5cbe449` | PASS |

## Dependency and environment provenance

Root install used the committed lockfile (`pnpm install --frozen-lockfile`) and retained supply-chain policy. Download and lockfile-policy validation succeeded; pnpm11 returned exit1 for an ignored esbuild lifecycle script. The packaged esbuild executable subsequently built the real API and all integration fixtures successfully. pnpm11 added an `allowBuilds` placeholder to the workspace configuration; QA immediately restored only that generated change. No repository manifest, dependency policy or lockfile change is included.

Mobile has no committed independent lockfile and is excluded from root workspace installation. Its exact package manifest was copied to `/tmp/onay-qa-mobile-deps`; temporary pnpm configuration retained a 1440-minute minimum package age and disabled lifecycle scripts for this verification. A git-ignored node_modules symlink exposes that isolated installation to the QA mobile tree. Actual resolved versions: Expo54.0.38, React19.1.0, ReactNative0.81.5, TypeScript5.9.3, @types/react19.1.17, expo-location19.0.8, expo-router6.0.24. These satisfy the existing manifest; they are an observed test environment, not a frozen mobile dependency guarantee.

Default sandbox execution blocked child processes/network bindings (`EPERM`) in icon generation/API fixtures. Tests were rerun with the available network permission; no tests or security controls were disabled. Plain Node strip-only mode cannot execute TypeScript parameter properties used by admin checks; the recorded transform-types invocation passed. The initial full API attempt lacked DATABASE_URL; its 409 prerequisite failures were superseded by the real-PostgreSQL642-pass run. Credentials remained in a mode0600 local temporary environment file and are not included here.

## Integration defects caught

The first localized navigation patch caused three existing source assertions to fail because they expected `accessibilityLabel={tab.label}`. Follow-up `8f4dcfa71707d274da685db20dd207653ac4c6d5` updates those guards to the translated expression and preserves layout, actions, selection and contrast checks. The six actual TSX localization cases remain enabled. Subsequent full mobile checks pass.

The first driver telemetry privacy follow-up was blocked before integration by independent QA and Security review: the passenger account snapshot preceded later awaited socket/order reads, allowing recipient revocation to make that snapshot stale. Backend follow-up `8d0b19c085cd654c2e9a75e41d2eba55fce8322a` adds a final joint authorization check and deterministic race regressions. Independent review approved the exact commit; final656-test suite includes these checks.

## Limits and remaining acceptance

No heavy browser/native E2E, APK build, release, main merge or remote push was performed. Readiness is UNKNOWN; the agreed90% gate is not established. Current-source native behavior remains UNVERIFIED. Interactive map rendering, road geometry and protected marker UI are not implemented by static geometry parsing. Historical APK119 acceptance does not validate these new mobile changes. CI for the local integrated commits is NOT RUN until a permitted remote update; current baseline native success/publication403 are separate facts.

Final source verification passed in isolated QA. Feature-branch integration and remote CI are recorded separately in orchestration/state.json. Security review snapshot is imported unchanged from `235f4ef7190c9c48ce5f3b43fe1f4a60f943d0cd:docs/onay-team-review.md`.

## MapLibre candidate documentation crosscheck

QA independently read the npm registry on2026-11-14: @maplibre/maplibre-react-native11.5.1 was published2026-10-29T21:45:10.840Z, MIT, peers Expo>=54.0.0 / ReactNative>=0.80.0 / React>=19.1.0. These ranges include the observed ONAY test environment. This verifies metadata only; generated-project compile, native rendering and tile-service compliance remain UNVERIFIED. No map SDK was installed into ONAY. Root workspace currently excludes mobile; future reproducible native dependency installation needs an explicit lock/workspace strategy.

## Existing CI trigger audit

Baseline `git grep` across docs, .github and replit.md found no existing90%/deferred-heavy-E2E designation. The current user gate is retained for deferred tooling; existing PR CI was not disabled. Existing Mobile CI historical-artifact Android acceptance and APK119 original-artifact acceptance run on matching PR updates. Current-source APK119 build is pinned to a historical SHA and Mobile CI Gradle assembly requires explicit workflow_dispatch build_apk; neither is activated by a normal feature-branch push. Existing direct APK119 publication listens only to a push changing its own workflow file, which this wave does not change. Existing mandatory CI remains separate from manually introducing deferred E2E tools. No new APK or publication is expected from these changed paths.

Parsing all workflow YAML exposed a preexisting unquoted colon in `onay-apk115-native-acceptance.yml` step name at line104; reported separately to the orchestrator. This is not caused by the current wave.

## Flaky child-process observation retained

The first final API attempt used default test-file concurrency while the bounded load check also ran:655/656 passed; the unchanged OTP restart test observed its child exit with empty output. The existing test does not include exitCode/signal in that error. The entire OTP file then passed23/23, and the entire API suite passed656/656 with test-concurrency=1; no tests were filtered, disabled or edited. Root cause remains UNKNOWN. Cgroup counters observed after the failure were oom=0 and oom_kill=0 with5.01GiB peak under8GiB maximum, so OOM is not established. A clean rerun does not erase this recorded observation.

All13 existing workflow YAML files parse after `060a0e0e21ddb6ecd1ea321a426b1d383e468475`; exact previous contents with one quoted step-name scalar equals the new contents. No jobs, conditions, permissions or commands changed in that fix.

## Reviewed source commits included

- `73ac938c4c8ef4790ba6094c4c138a790ee60755`
- `723a8666ca00bdbc8c1c65a7c581137a14521c4c`
- `28ff3b038cb1cd1a40fae4feb1b6ed636ce36b3b`
- `9ce7b6c539526d085139daa8c628450727d203f8`
- `1c42b72231e203b32625db12070d516ee79cce1b`
- `db98a7039cd3ecc6bc6b4b428166d74c0e06c1d6`
- `a322c1dc3bef7803e74875cb17446aea2d0472f8`
- `8f4dcfa71707d274da685db20dd207653ac4c6d5`
- `afe033a9be0025901bfce89658a354fe31579210`
- `771bfcd647ba41428ea511f785a727a205e9a902`
- `62d8af1c0e22b7e1b41db7b9998888e42dcfbc62`
- `8d0b19c085cd654c2e9a75e41d2eba55fce8322a`
- `060a0e0e21ddb6ecd1ea321a426b1d383e468475`
- `120d114c83698cab050fbfa7930086c23f74acac`
- `0c1fb21b3268da6e0bca319def15a7553384f472`

## Follow-up: supported CI runners and historical APK115 contract

After feature push71ecf1a, main CI and staging passed. Both browser workflows failed before scenarios at pinned Playwright installation because ubuntu-latest resolved to Ubuntu26.04, unsupported by Playwright1.56.0. The follow-up changes only those two browser jobs to ubuntu-24.04, explicitly listed in tagged Playwright1.56.0 nativeDeps.ts. All13YAML files parse; exact old/new semantic and text comparison preserves every other job field and pinned browser version. No tests were disabled or browser tooling upgraded.

The newly parsed historical APK115 workflow reached native UI and failed because the current shared script expected the later APK116 standalone personal-data/email page. The workflow validates APK115 artifact run42406229478, source5c9f94044608f762c8f382a1e23afaa7a3d4c569. That source has no OnayPersonalDetails.tsx: OnayPassengerProfile.tsx renders a read-only native modal with onay-profile-personal-details/name/support, the supplied demo account name, a registration/support explanation, arrow Back and Modal.onRequestClose. Failed actual UI XML matched that source. Commitc3bef32 later added the standalone/email assertions for APK116;6c92483 corrected only the pre-upgrade baseline, leaving the upgraded115 mismatch.

The shared script now accepts only explicitly verified target versions115/116. Version115 requires its actual read-only identity name, registration explanation, enabled support action and both Back paths; version116 retains standalone screen/email/read-only-placeholder assertions. Both preserve upgrade, native screenshots/XML, driver states, activation guard and dark/light chats. Unsupported versions fail closed before interaction. `python3 scripts/onay_driver_personal_contract_test.py`:5 tests PASS with versioned native-helper fixtures, including missing/wrong identity/support, legacy-page rejection for116, missing116email and both broken Back paths. Python compilation and whitespace checks PASS. These deterministic checks do not claim a new native run passed. No APK was rebuilt; current-source native acceptance remains UNVERIFIED.
