# ONAY independent team review — 2026-11-14

Scope: PR #110, branch `feat/artifact-auth-ui-v1`, audited baseline
`2cd511526bf66559be05cfd486c038a6e5cbe449`. Reviews were read-only in isolated
worktrees. Approval below means code review approval of the named commit;
integration verification and remote CI remain separate gates.

| Role | Reviewed source commit | Result | Independently executed check |
| --- | --- | --- | --- |
| Maps | `723a8666ca00bdbc8c1c65a7c581137a14521c4c` | APPROVE | `node --test --test-isolation=none test/passenger-location.test.mjs`: 4 passed |
| Android | `73ac938c4c8ef4790ba6094c4c138a790ee60755` | APPROVE | `node --test --test-isolation=none test/onay-apk119-workflow-boundary.test.mjs`: 3 passed; commit diff whitespace check passed |
| Frontend | `28ff3b038cb1cd1a40fae4feb1b6ed636ce36b3b` | APPROVE | `node --test --test-isolation=none test/onay-auth-ui.test.mjs`: 9 passed |
| UI/UX | `9ce7b6c539526d085139daa8c628450727d203f8` | APPROVE | `node --test --test-isolation=none test/onay-navigation-a11y-language.test.mjs`: 6 passed |
| Backend | `a322c1dc3bef7803e74875cb17446aea2d0472f8` | APPROVE | `node --test --test-isolation=none test/queue-session.test.mjs`: 3 passed; commit diff whitespace check passed |
| UI/UX test compatibility | `8f4dcfa71707d274da685db20dd207653ac4c6d5` | APPROVE | Three existing navigation/layout guard files: 7 passed; component/language and passenger-tab tests: 9 passed |
| Maps static geometry | `afe033a9be0025901bfce89658a354fe31579210` | APPROVE | Geometry, driver-routes and passenger-route-orders tests: 29 passed |
| UI/UX personal details | `771bfcd647ba41428ea511f785a727a205e9a902` | APPROVE | Personal-details language and existing profile tests: 9 passed |
| Backend telemetry validation | `62d8af1c0e22b7e1b41db7b9998888e42dcfbc62` | APPROVE | Driver-location validator tests: 3 passed; commit diff whitespace check passed |
| Backend telemetry privacy | `8d0b19c085cd654c2e9a75e41d2eba55fce8322a` | APPROVE | Socket/validator tests: 25 passed; subsequently added authorization lookup recovery test: 1 passed; commit diff whitespace check passed |
| Android workflow YAML | `060a0e0e21ddb6ecd1ea321a426b1d383e468475` | APPROVE | All 13 workflow YAML files parsed with PyYAML; source diff contains only quoting one step name |

Mobile commands above ran from the respective `mobile/tezjet-app` directories.
The Backend command ran from `artifacts/api-server`.

## Review reasoning

Maps bounds a pending native GPS fix with a 15-second deadline and clears its
timer. Late resolution/rejection cannot resume the booking POST. Existing
selection, account scope, quote freshness, idempotency and persisted recovery
guards remain present. Native GPS cancellation is unavailable; the helper only
bounds the application wait. Physical Android GPS was not tested.

Android removes only the duplicate `publish-direct-apk` job from the PR-triggered
workflow. Other jobs, original artifact checks, signing comparison, installed
source verification and acceptance commands remain unchanged. The separate
branch-triggered delivery workflow is unchanged and retains its successful QA
gate, original source SHA, APK SHA256 and prerelease safeguards. No APK was
built, workflow dispatched or release published during this review.

Frontend corrects the misleading additional `+998` prefix when an international
number such as `+1` or `+44` is pasted, and raises the native field limit from 14
to 16 characters so an E.164 number with 15 digits and its plus can be pasted.
The prior displayed field retained the plus, so ordinary editing that preserved
it did not necessarily rewrite the country. Review does not claim otherwise.
Existing Uzbekistan and Kazakhstan handling remains. No SMS was sent.

UI/UX uses the existing language context for native tab and Back accessibility
labels. IDs, navigation callbacks and selected state remain unchanged. The test
executes transpiled components with native primitives stubbed; it does not
establish physical TalkBack behavior. Follow-up commit `8f4dcfa` updates only three
literal source guard expectations to require the localized label expression.
All other geometry, action, state and theme assertions are retained; no tests
were disabled. The original source commit alone caused these three stale
expectations to fail, so both commits are required for integration.

Backend passes the authenticated session version to queue leave, status and
location mutations. MemoryStore validates it before changing state; PostgreSQL
validates role and version inside the queue mutation transaction while holding
the account SHARE lock. Queue-before-account lock order matches existing role
switch and join behavior. Optional arguments preserve internal dispatcher calls.
FIFO, seat, allocation and lifecycle rules are unchanged. The author additionally
reported 121 passing durable tests for account roles, seat locks and route queues
against disposable PostgreSQL 16; these durable checks were not independently
rerun by this reviewer. The three real-controller MemoryStore race checks were
independently rerun and passed.

The optional route-stop geometry parser permits only finite, geographically
bounded numeric latitude/longitude. It preserves historical routes without
geometry and strips unrelated response fields; no live driver telemetry is
introduced. The personal-details follow-up translates static labels and
fallbacks while preserving account values through NativeText. The explanatory
full-name note translates only its static fragments. Email save behavior and API
contracts are unchanged.

The telemetry validation follow-up allowlists finite, bounded numeric
coordinates, positive finite timestamps and boolean mock flags. It strips
unrelated client data and preserves authenticated sender checks. The author
reported 19 socket/validator tests passing; the reviewer independently executed
the three pure validator checks. Audience restriction is a separate fix.

## Telemetry privacy finding — fixed in reviewed source

P1 privacy: `artifacts/api-server/src/socket.ts:124` accepts driver location from
an authenticated, approved driver, then line 143 uses `socket.broadcast.emit`
to send the driver ID and exact location to every other authenticated socket.
Recipients are not restricted to a related order or route. The existing test
`artifacts/api-server/test/socket-errors.test.mjs:162` explicitly expects an
unrelated passenger observer to receive that location. A frontend consumer is
not required for an authenticated client to subscribe. The original payload
validation gap was fixed by `62d8af1`; that commit alone does not restrict the
recipient audience.

Commit `8d0b19c` replaces global broadcast with the passenger audience of a current
accepted order, using the existing assigned-driver access policy and statuses
`en_route_to_c`, `arrived_at_c`, `boarded_waiting`, `in_transit`. It adds no admin,
nearby-driver or unrelated-passenger rights and changes no allocation rules.
The last awaited authorization check evaluates the current order and both
account roles/session versions together: synchronously in MemoryStore and with
one joined SQL statement in PostgresStore. Sender approval is checked from the
same authority snapshot. JWT expiry and socket metadata are checked before
synchronous per-socket emission. The existing event payload remains unchanged
apart from the prior validation allowlist.

Review rejected an intermediate implementation that combined an old passenger
account snapshot with later order checks. The final tests use detached account
snapshots and pause recipient socket discovery before cancellation,
reassignment, recipient/sender session revocation or sender approval revocation;
all five cases deny delivery. Positive accepted-ride delivery, per-passenger
deduplication, unrelated/admin/driver and inactive-order denial also passed.
The reviewer independently executed the 25 socket/validator cases, then the
subsequently added authorization-store-error recovery case. The author reported
83 durable account-role tests passing against disposable PostgreSQL, including
both adapters' joint authorization checks; those were not independently rerun.
This closes the global-audience and multi-read stale-authority findings in the
reviewed source. Integrated tests and remote CI remain separate release gates.

Authorization uses a fresh consistent store decision before emission; it does
not claim network delivery can be revoked after authorization completes.

The Android YAML follow-up quotes a step name containing a colon. This restores
valid YAML without changing conditions, commands, permissions or acceptance
behavior. No emulator or APK build was run to check this syntax correction.

No P0 auth bypass was identified in the inspected HTTP/socket guards. This is a
bounded review, not a complete security certification. Existing authentication
checks include current role/session version, driver approval, OTP budgets before
body parsing, private response no-store headers and order actor ownership.

## Verification limits

Remote CI for the new commits: NOT RUN at review time. Integrated application
verification: pending Integration/QA. No browser/emulator E2E, production changes,
main merge or push were performed. Execution budget and remaining quota: UNKNOWN.
The historical PR41 checklist in `docs/TEZJET_CHECKLIST.md` is not evidence that
current PR110 readiness meets the 90% gate for heavy E2E.
