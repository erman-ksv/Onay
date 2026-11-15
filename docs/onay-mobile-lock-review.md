# Mobile dependency security review

Reviewed commit: `d807cf37a37f73bd319bd0fb8ae10895a00e657c`.
Decision: APPROVE the reproducibility and supply-chain-policy change, with existing dependency advisories recorded below. This is not a clean audit or production approval.

Independent checks: all 20 manifest specifiers unchanged; sole mobile importer; all 696 registry package resolutions have SHA512 integrity and no custom tarball/git/directory resolution; root lock/workspace/.npmrc byte-identical; all 13 workflow YAML files parse; semantic CI diff limited to pinned pnpm, frozen mobile install and cache dependency paths. Application/native source and permission guards unchanged.

One official-registry production audit ran using pnpm10.34.9: `pnpm audit --prod --json --registry=https://registry.npmjs.org`. Exit1; no API error. Registry classification: {"info": 0, "low": 1, "moderate": 6, "high": 5, "critical": 0}. Sanitized durable audit inventory: `docs/onay-mobile-audit-inventory.json`; raw output remained local.

| Package | Locked version | Severity | Advisory |
|---|---|---|---|
| postcss | 8.4.49 | moderate | https://github.com/advisories/GHSA-qx2v-qp2m-jg93 |
| postcss | 8.4.49 | high | https://github.com/advisories/GHSA-6g55-p6wh-862q |
| postcss | 8.4.49 | moderate | https://github.com/advisories/GHSA-fxqj-rqcc-2cmp |
| postcss | 8.4.49 | high | https://github.com/advisories/GHSA-r28c-9q8g-f849 |
| decode-uri-component | 0.2.2 | moderate | https://github.com/advisories/GHSA-vcc3-ghjq-m6fr |
| image-size | 1.2.1 | high | https://github.com/advisories/GHSA-5p2g-fcmc-qvqq |
| image-size | 1.2.1 | high | https://github.com/advisories/GHSA-w3rx-r6r6-pgpr |
| deepmerge | 4.3.1 | low | https://github.com/advisories/GHSA-gcqx-w48m-w2h4 |
| decode-uri-component | 0.2.2 | high | https://github.com/advisories/GHSA-qr28-fpjm-wq7f |
| glob | 13.0.7 | moderate | https://github.com/advisories/GHSA-3g3m-2fjr-6pw4 |
| minimatch | 10.2.6,9.0.9 | moderate | https://github.com/advisories/GHSA-g3hv-75wg-m249 |

Exposure notes: postcss and image-size paths are Metro/CSS/image build tooling and matter for untrusted source/assets. decode-uri-component is installed through expo-router/query-string; an exploitable application path was not established. The inspected Expo Router query parser uses URL.searchParams; the observed query-string use serializes paths. Audit production classification includes tooling because Expo is a declared runtime dependency. Advisory counts are registry package findings, not proven application exploits.

All direct resolved versions match author-reported prior successful CI; the mobile transitive graph was not previously committed, so full historical transitive equivalence cannot be independently established. Freezing this graph introduces no declared range upgrade. Follow up with separately scoped upstream-compatible dependency triage; do not apply blind overrides, major upgrades or audit-fix commands.

Clean installs, negative hook/lock fixtures, typecheck,356 tests and3 platform JavaScript exports are author-reported in docs/onay-mobile-dependencies.md; not rerun by this reviewer. New-source remote CI remains pending integration. No APK, native build, release, SMS or production operation performed. Budget/quota: UNKNOWN.

Imported from the independent Security reviewer evidence after exact source approval; local-path reference replaced with the sanitized durable inventory. The historical graph advisory counts do not establish exploitability or production acceptance.
