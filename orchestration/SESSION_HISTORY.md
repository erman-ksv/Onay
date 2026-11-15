# ONAY session history recovered from Git

Recorded: 2026-11-15T09:01:06.694936+00:00

PR110: https://github.com/erman-ksv/Onay/pull/110

Git committer timestamps below do not reconstruct exact original agent execution times. Full technical diffs remain in Git. No main merge, production release or new APK claimed.

## 2026-11-14T17:55:41Z — docs(orchestration): establish isolated team checkpoint and session reports

Commit: https://github.com/erman-ksv/Onay/commit/f9f5e789dbacb2531bda62bc037e3ffdbda66524

Files: orchestration/RESUME.md, orchestration/TASKS.md, orchestration/checkpoints/initial.json, orchestration/report_snapshot.py, orchestration/reports/2026-11-14T17-55-19Z.md, orchestration/reports/2026-11-14T17-55-41Z.md, orchestration/state.json

## 2026-11-14T18:12:39Z — fix(ci): keep APK119 release delivery outside pull request QA

Commit: https://github.com/erman-ksv/Onay/commit/04a8fe00a533d9147ac30afe44ecad8436513c50

Files: .github/workflows/onay-apk118-startup-release.yml, mobile/tezjet-app/test/onay-apk119-workflow-boundary.test.mjs

## 2026-11-14T18:12:39Z — fix(mobile): bound passenger GPS wait before route booking

Commit: https://github.com/erman-ksv/Onay/commit/ee1820c04b6927840ab910db2c8a4771bf07931f

Files: mobile/tezjet-app/components/PassengerRouteOrder.tsx, mobile/tezjet-app/lib/passenger-location.ts, mobile/tezjet-app/test/passenger-location.test.mjs

## 2026-11-14T18:12:39Z — fix(mobile): preserve pasted international phone recipients

Commit: https://github.com/erman-ksv/Onay/commit/3ae05c06bf768f450a7a21f1a1cee545619172b9

Files: mobile/tezjet-app/components/OnayAuthScreen.tsx, mobile/tezjet-app/lib/onay-auth-ui.ts, mobile/tezjet-app/test/onay-auth-ui.test.mjs

## 2026-11-14T18:12:39Z — fix(mobile): localize native navigation accessibility labels

Commit: https://github.com/erman-ksv/Onay/commit/8809123bd31f3451049cbdb3a36110432a41bc30

Files: mobile/tezjet-app/components/OnayPassengerTabBar.tsx, mobile/tezjet-app/components/OnayScreenFrame.tsx, mobile/tezjet-app/test/onay-navigation-a11y-language.test.mjs

## 2026-11-14T18:12:39Z — docs: record passenger frontend acceptance evidence

Commit: https://github.com/erman-ksv/Onay/commit/d1c7d96410dd2527b03e6bd387f43995c20a5803

Files: docs/onay-passenger-readiness.md

## 2026-11-14T18:12:39Z — docs(onay): record grounded interactive map delivery plan

Commit: https://github.com/erman-ksv/Onay/commit/3e895442f3595b92e30ccb2da9632ea7efc84e22

Files: docs/onay-map-readiness.md

## 2026-11-14T18:12:39Z — fix(api): reject revoked sessions in queue mutations

Commit: https://github.com/erman-ksv/Onay/commit/59819a697f6c7dd807a10d3546590ea52e8a0f0e

Files: artifacts/api-server/src/controllers/queueController.ts, artifacts/api-server/src/store/memoryStore.ts, artifacts/api-server/src/store/postgresStore.ts, artifacts/api-server/src/store/storeContract.ts, artifacts/api-server/test/account-roles.test.mjs, artifacts/api-server/test/queue-session.test.mjs

## 2026-11-14T18:12:39Z — test(mobile): retain layout guards with localized navigation labels

Commit: https://github.com/erman-ksv/Onay/commit/94b5e015366baf9eaff8486a26ecdfc00da23c16

Files: mobile/tezjet-app/test/onay-navigation-reference-v2.test.mjs, mobile/tezjet-app/test/onay-tabbar-floating-layout.test.mjs, mobile/tezjet-app/test/onay-tabbar-responsive-reference-regression.test.mjs

## 2026-11-14T18:12:39Z — fix(mobile): preserve validated optional route stop geometry

Commit: https://github.com/erman-ksv/Onay/commit/2c60a83f328e9445a58e05b47d7d3361039a7650

Files: mobile/tezjet-app/lib/driver-routes.ts, mobile/tezjet-app/test/driver-route-geometry.test.mjs

## 2026-11-14T18:12:39Z — fix(mobile): localize personal details without translating account values

Commit: https://github.com/erman-ksv/Onay/commit/552be94560449617e404c77e6f927ccde1c85e82

Files: mobile/tezjet-app/components/OnayPersonalDetails.tsx, mobile/tezjet-app/lib/onay-translations.ts, mobile/tezjet-app/test/onay-personal-details-language.test.mjs, mobile/tezjet-app/test/onay-profile-personal-details.test.mjs

## 2026-11-14T18:12:39Z — fix(api): validate driver socket location payloads

Commit: https://github.com/erman-ksv/Onay/commit/e55c4c40e1a2d1b1fe6c81249bde4c6ee7d423fb

Files: artifacts/api-server/src/socket.ts, artifacts/api-server/src/utils/driverLocation.ts, artifacts/api-server/test/driver-location.test.mjs, artifacts/api-server/test/socket-errors.test.mjs

## 2026-11-14T18:12:39Z — fix(api): scope driver telemetry to current ride passengers

Commit: https://github.com/erman-ksv/Onay/commit/d0eca38a5be3c8f8c809c30f57f7c7dcb2946a0b

Files: artifacts/api-server/src/socket.ts, artifacts/api-server/src/store/memoryStore.ts, artifacts/api-server/src/store/postgresStore.ts, artifacts/api-server/src/store/storeContract.ts, artifacts/api-server/src/utils/driverLocation.ts, artifacts/api-server/test/account-roles.test.mjs, artifacts/api-server/test/socket-errors.test.mjs

## 2026-11-14T18:12:39Z — fix(ci): quote Android acceptance step name containing colon

Commit: https://github.com/erman-ksv/Onay/commit/194dbdfbeaa680306f60dabc3e07208e5681b3ca

Files: .github/workflows/onay-apk115-native-acceptance.yml

## 2026-11-14T18:12:39Z — docs(onay): verify MapLibre native renderer candidate and gates

Commit: https://github.com/erman-ksv/Onay/commit/c63323b272e1b20a263b39f0619096bc14f0d1ed

Files: docs/onay-maplibre-compatibility.md

## 2026-11-14T18:12:39Z — docs(onay): clarify mobile dependency lock strategy prerequisite

Commit: https://github.com/erman-ksv/Onay/commit/87ba4b922c288bec7370db2e248aa749a9427d62

Files: docs/onay-maplibre-compatibility.md

## 2026-11-14T18:12:39Z — docs(onay): preserve independent integration QA and review evidence

Commit: https://github.com/erman-ksv/Onay/commit/d77e509d08d2f7cca8ba7f11419caa76a72abad8

Files: docs/onay-queue-load-verification.json, docs/onay-team-qa.md, docs/onay-team-review.md

## 2026-11-15T03:55:16Z — docs(orchestration): checkpoint verified integration and private journal boundary

Commit: https://github.com/erman-ksv/Onay/commit/71ecf1aa66838d5ac6a4ca5a48d7871b4115ba44

Files: .gitignore, orchestration/RESUME.md, orchestration/TASKS.md, orchestration/checkpoints/active-wave.json, orchestration/reports/2026-11-14T17-58-30Z.md, orchestration/reports/2026-11-14T18-03-30Z.md, orchestration/reports/2026-11-14T18-08-49Z.md, orchestration/reports/2026-11-15T03-54-team.md, orchestration/state.json

## 2026-11-15T04:00:43Z — fix(ci): pin browser QA to Playwright-supported Ubuntu 24.04

Commit: https://github.com/erman-ksv/Onay/commit/180d2cf7a65858ebf8c5e870fce638d2d957b1aa

Files: .github/workflows/admin-layout-qa.yml, .github/workflows/driver-route-qa.yml

## 2026-11-15T04:05:43Z — test(android): verify personal details against pinned APK version

Commit: https://github.com/erman-ksv/Onay/commit/1c426fcd0dcd5e4566885ba15d60b6004a70b788

Files: docs/onay-team-qa.md, scripts/onay-driver-mode-chats-android-qa.py, scripts/onay_driver_personal_contract_test.py

## 2026-11-15T04:06:07Z — docs(orchestration): record CI diagnoses and reviewed follow-up gates

Commit: https://github.com/erman-ksv/Onay/commit/c44b1248a61d1a8c405fa3fc015c2c0b233b05eb

Files: orchestration/RESUME.md, orchestration/checkpoints/active-wave.json, orchestration/checkpoints/remote-ci-71ecf1a.json, orchestration/reports/2026-11-15T04-00-team.md, orchestration/state.json

## 2026-11-15T04:24:41Z — build(mobile): freeze isolated dependencies with explicit supply-chain policy

Commit: https://github.com/erman-ksv/Onay/commit/6090b8c995e762acd00653c562a71d020e49b7a2

Files: .github/workflows/driver-route-qa.yml, .github/workflows/mobile-ci.yml, docs/onay-mobile-dependencies.md, mobile/tezjet-app/README.md, mobile/tezjet-app/package.json, mobile/tezjet-app/pnpm-lock.yaml, mobile/tezjet-app/pnpm-workspace.yaml

## 2026-11-15T04:25:22Z — docs(onay): retain dependency review, audit inventory and verified checkpoint

Commit: https://github.com/erman-ksv/Onay/commit/b2720c2e87c2ef2e4e2e0358c4f8b1af881ffbf1

Files: docs/onay-mobile-audit-inventory.json, docs/onay-mobile-lock-review.md, orchestration/RESUME.md, orchestration/checkpoints/active-wave.json, orchestration/checkpoints/remote-ci-c44b124.json, orchestration/reports/2026-11-15T04-05-team.md, orchestration/reports/2026-11-15T04-10-team.md, orchestration/reports/2026-11-15T04-15-team.md, orchestration/state.json

## Verified remote CI on b2720c2e87c2ef2e4e2e0358c4f8b1af881ffbf1

- Onay APK115 native UI acceptance from published artifact only: success — https://github.com/erman-ksv/Onay/actions/runs/43676735075
- Admin route layout browser QA: success — https://github.com/erman-ksv/Onay/actions/runs/43676735123
- Onay final passenger details and driver overview APK116: skipped — https://github.com/erman-ksv/Onay/actions/runs/43676735119
- Deliver existing APK118 as a direct Android download: skipped — https://github.com/erman-ksv/Onay/actions/runs/43676735104
- Onay APK113 -> APK114 Android reproduction (existing artifacts only): success — https://github.com/erman-ksv/Onay/actions/runs/43676735014
- Onay APK116 native QA - already published artifact only: success — https://github.com/erman-ksv/Onay/actions/runs/43676735032
- TezJet Mobile CI: success — https://github.com/erman-ksv/Onay/actions/runs/43676734995
- Onay APK119 compiled resources and Android acceptance (reuse original Gradle APK): success — https://github.com/erman-ksv/Onay/actions/runs/43676735012
- Driver route planning browser QA: success — https://github.com/erman-ksv/Onay/actions/runs/43676735031
- Onay APK117 one build and Android About native acceptance: skipped — https://github.com/erman-ksv/Onay/actions/runs/43676734992
- Onay staging runtime smoke: success — https://github.com/erman-ksv/Onay/actions/runs/43676735013
- CI: success — https://github.com/erman-ksv/Onay/actions/runs/43676735022

Local evidence: docs/onay-team-qa.md, docs/onay-team-review.md, docs/onay-mobile-dependencies.md, docs/onay-mobile-lock-review.md

Original per-agent timestamps and complete past process continuity unavailable; not invented. Historical OTP child failure cause UNKNOWN. No current readiness percentage can be calculated from confirmed acceptance evidence.
