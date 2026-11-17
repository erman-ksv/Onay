# R05: mobile dependency security verification on Node 22

Implementation: `73104935ab588d833d2230cfa63218a4e0d1b2c1`, based on
`d88895f3a36d5ed92bf8bcf2e768cc7d94eee0b8` (tree identical to validated R01–R04
source `86dfaf54396a1a82e81ae4abf992b284b8fdccce`). The ten implementation files
are exact copies of the previously reviewed `b186920` candidate; they were absent
from this base, so no existing patch was applied twice.

## Dependency boundary

Only two parent-scoped dependency edges change:

- `metro@0.83.3 > image-size`: `1.2.1` → `2.0.3`, with the reviewed Metro Assets
  adapter for the removed filename overload. Buffer reads remain synchronous;
  filename reads use the upstream bounded async `imageSizeFromFile` API.
- `query-string@7.1.3 > decode-uri-component`: `0.2.2` → `0.5.1`, with the exact
  CommonJS/ESM-default adapter and existing plus-to-space wrapper preserved.

The orphaned NPM `queue@6.0.2` package disappears; this does not affect the backend
driver queue. All 20 direct specifiers/importers, every other package resolution,
existing PostCSS override, root lock/policy, Expo/RN versions, UI, SDK/permissions
and Android configuration remain unchanged. All 695 package resolutions retain
SHA512 integrity; patch SHA256 values match the lock. The 1440-minute release
delay, empty build-script allowlist and `strictDepBuilds: true` remain active.

Malformed `x=%25C2%FF` intentionally yields literal `%C2%FF` rather than the old
replacement-character result. The upstream fixed decoder avoids rescanning
decoded output. Valid UTF-8, plus/encoded-plus, arrays, duplicate keys, query
options and Router parent behavior are exercised by the retained corpus.

## Measured checks

All new measurements use actual **Node 22.23.5** and pnpm **10.34.9** on the
implementation SHA above. Node was downloaded from nodejs.org over verified TLS
and checked against its official SHA256 manifest; see [runtime receipt](evidence/r05-mobile-dependencies/runtime.json).

| Check | Result |
| --- | --- |
| New isolated frozen install, offline, lifecycle policy active | PASS; 684 reused, 0 downloaded, no `--ignore-scripts` |
| Full mobile suite | 393 PASS / 0 FAIL / 0 SKIP |
| TypeScript | PASS |
| Actual complete application JS export | Android and iOS PASS; both genuine Hermes bytecode outputs |
| Installed Metro decoder graph | Android, iOS and Web execution PASS, 616 checks per platform including 300 corpus cases |
| Native probe syntax acceptance | Android and iOS probe outputs compiled by the installed Hermes compiler; device runtime UNVERIFIED |
| Bounded decoder advisory controls | Old RED / candidate GREEN; 500 ms wall and 32 MiB worker heap limits; all workers terminated |
| Graph, integrity and policy comparison | PASS; exact two upgrades plus one orphan removal |
| One bounded official production audit | **0 critical / 0 high / 3 moderate / 0 low**, 696 dependencies reported by the audit |

The audit's three moderate occurrences are glob/minimatch findings, recorded in
the [audit receipt](evidence/r05-mobile-dependencies/audit.json). Exit 1 reflects
those findings, with no API error or suppression. This is not a clean-audit claim.
The audit dependency count and lock package-record count measure different grains.

See [verification receipt](evidence/r05-mobile-dependencies/verification.json),
[actual emitted Metro results](evidence/r05-mobile-dependencies/metro.json) and
[bounded control results](evidence/r05-mobile-dependencies/bounded-parent.json).
Receipts bind the implementation SHA, lock/patch hashes, Node runtime and output
hashes. Historical Node 24 evidence was not reused as proof of Node 22 execution.

## Reproduction and remaining gate

From the isolated `mobile/tezjet-app` workspace, using Node 22 and pinned pnpm:

```sh
pnpm install --frozen-lockfile --offline --store-dir /tmp/onay-mobile-lock-store --package-import-method hardlink
node --experimental-strip-types --test --test-concurrency=1 test/*.test.mjs
node node_modules/typescript/bin/tsc --noEmit
EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 CI=1 ONAY_DEMO_PREVIEW=true EXPO_PUBLIC_API_URL= node node_modules/expo/bin/cli export --platform android --platform ios --max-workers 1 --output-dir dist/r05-app-export
node scripts/decoder-evidence/metro-proof.cjs dist/r05-decoder-proof
node scripts/decoder-evidence/bounded-parent.cjs /absolute/path/to/retained/baseline/query-string/index.js
npm_config_fetch_retries=0 timeout 60s pnpm audit --prod --json --registry=https://registry.npmjs.org
```

The offline install requires the existing reviewed store. The bounded control
requires a retained baseline parent with decoder `0.2.2`; it does not install
vulnerable code into the candidate. The Metro probe executes actual emitted
modules, while Router source-function extraction is explicitly not a UI mount.

The first local suite attempt hit the sandbox's EPERM on the existing icon
generator subprocess. The authorized normal-process run passed all 393 tests;
no test or check was disabled. Node 22 uses an experimental spelling for the
no-isolation flag; the successful final command uses ordinary process isolation.

Independent security and integrated QA review remain required. New-source remote
CI is NOT RUN; there was no push or merge. No prebuild, APK, emulator, native SDK,
permission, SMS request, deployment or paid service was introduced. JavaScript
exports and Hermes compilation do not establish physical Android acceptance.

Rollback must restore both exact parent patches, both scoped overrides and the
mobile lock together, then repeat frozen installation and relevant checks. A
rollback restores the old advisory exposure; findings must never be hidden.
