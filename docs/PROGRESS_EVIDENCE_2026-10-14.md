# TezJet implementation evidence register — 2026-10-14

This register records **verified GitHub changes** only. It is not a new percentage-of-readiness calculation.

## Baseline and counting rules

- The last reported row-based baseline on 2026-10-13 is **70 of 151 TezJet checklist items (46.4%)**.
- The reported baseline counted some written tasks awaiting acceptance, so it is **not** a release-readiness metric.
- The 21 Agent-Factory checklist items are separate and must not be added to the TezJet denominator.
- The source file listing all 151 individually numbered items, their statuses and acceptance criteria was **not located in this repository** as of this audit. Without that baseline, the following seven merged PRs cannot be assumed to represent seven previously uncounted tasks.
- Each item may count as newly complete only after: (1) matching the exact original checklist row, (2) checking that it was *not* included in the baseline 70, (3) validating its acceptance requirements and (4) ensuring no overlap with another PR's row.
- Until that mapping exists, report **last documented baseline 70/151 (46.4%)**, plus the evidence below, **not** an invented updated percentage.
- Reaching 65% by the row-based method requires at least **99/151**, i.e. **29 additional confirmed rows** relative to the last documented baseline (before reconciliation).

## Verified merged PRs since the baseline report

| PR | Implemented capability | Successful PR CI run | Checklist row / delta |
| --- | --- | --- | --- |
| [#24](https://github.com/erman-ksv/TezJet/pull/24) | Admin-only passenger directory with role-aware selection | [CI #170](https://github.com/erman-ksv/TezJet/actions/runs/38455631095) | Not yet mapped |
| [#25](https://github.com/erman-ksv/TezJet/pull/25) | Admin-only read-only order directory | [CI #172](https://github.com/erman-ksv/TezJet/actions/runs/38456778916) | Not yet mapped |
| [#26](https://github.com/erman-ksv/TezJet/pull/26) | Order-status filter for admin listing | [CI #174](https://github.com/erman-ksv/TezJet/actions/runs/38457331059) | Not yet mapped |
| [#27](https://github.com/erman-ksv/TezJet/pull/27) | Aggregate trip statistics, admin-only | [CI #180](https://github.com/erman-ksv/TezJet/actions/runs/38460052670) | Not yet mapped |
| [#28](https://github.com/erman-ksv/TezJet/pull/28) | Redacted read-only admin FIFO overview | [CI #178](https://github.com/erman-ksv/TezJet/actions/runs/38458674482) | Not yet mapped |
| [#29](https://github.com/erman-ksv/TezJet/pull/29) | Read an individual admin route with its stops | [CI #182](https://github.com/erman-ksv/TezJet/actions/runs/38460670389) | Not yet mapped |
| [#30](https://github.com/erman-ksv/TezJet/pull/30) | Filter admin routes by active/inactive state | [CI #184](https://github.com/erman-ksv/TezJet/actions/runs/38461112117) | Not yet mapped |

All seven PRs were checked as **merged**. Each linked final CI run had **conclusion=success**. This means these changes are verified in CI, not that each maps to a unique checklist item or was tested on physical devices.

## Recovered original section 9: Admin panel — 12 items

The earlier full checklist was described as **section 9: 0 of 12 completed at baseline**. The following names are recovered from that prior checklist discussion, **not original globally unique item IDs**. The section is about delivering the **admin panel workflow**, so API-only improvements do not automatically satisfy each combined UI/backend requirement.

| # within section 9 | Original admin-panel requirement | Evidence from merged work | Outstanding acceptance gap | Fully confirmed new item? |
| --- | --- | --- | --- | --- |
| 1 | Administrator authorization | Existing admin JWT and `requireRole("admin")` protect endpoints | Usable end-to-end admin login/panel and its acceptance not established here | No |
| 2 | Passenger and driver lists | [#24](https://github.com/erman-ksv/TezJet/pull/24) adds passenger API; driver API already existed | Admin UI for both directories and acceptance not shown | No |
| 3 | Approve and block drivers | Existing driver approval endpoint | Explicit driver-block workflow, UI and checks not established | No |
| 4 | Manage A/B pitaks and route stops | Existing route/stop catalog; [#29](https://github.com/erman-ksv/TezJet/pull/29) single-route read; [#30](https://github.com/erman-ksv/TezJet/pull/30) active filter | Persistent configurable A/B pitaks, independent semantics and admin UI missing/not verified | No |
| 5 | Configure tariffs per stop | Existing route fare CRUD and #29 route read | End-to-end admin tariff editing/acceptance not established | No |
| 6 | Change the 60-second offer timeout | Existing environment-configurable server timeout | Admin control with persisted settings and behavior tests not established | No |
| 7 | View queues in real time | [#28](https://github.com/erman-ksv/TezJet/pull/28) adds read-only FIFO snapshot API | Realtime admin updates/dashboard and acceptance not established | No |
| 8 | View and cancel orders | [#25](https://github.com/erman-ksv/TezJet/pull/25) read-only order API; [#26](https://github.com/erman-ksv/TezJet/pull/26) status filters | Administrative cancellation workflow and panel not established | No |
| 9 | Monitor active trips | #26 has `active` order-status filter | Real-time active-trip monitoring screen and workflow not established | No |
| 10 | Action and dispute log | No evidence from #24–#30 | Audit/event log and dispute workflow not established | No |
| 11 | Staff roles and privileges | Existing admin-only API guard | Granular staff roles and permission management not established | No |
| 12 | Trip and revenue statistics | [#27](https://github.com/erman-ksv/TezJet/pull/27) provides aggregate trip counts | Revenue statistics and complete panel/reporting flow not established | No |

**Reconciliation result for section 9:** 7 merged PRs implement verified **partial capabilities** mapped to the 12 tasks above. **0 additional fully accepted section-9 rows can currently be proved** from those PRs. This is not the claim that zero lines of code were implemented: every PR has a successful CI run (listed above). It means the checklist counts whole requirements, and the available evidence does not prove full end-to-end acceptance for any of these combined rows.

**Conservative post-PR count:** retain **70/151 = 46.4% (historical baseline, no verified increment from #24–#30)**. This is **not** a fresh audit of all 151 rows or an estimate of release readiness. The previous hypothetical 77/151 = 51.0% must **not** be presented as the confirmed number.

To raise this metric accurately: finish a complete original section-9 item (including admin UI, required operations, tests and review), record exact original item ID and evidence, verify it was previously uncounted, then add **one** to numerator; do not count API endpoints or PRs as rows by default.

## Pending reconciliation

- [ ] Retrieve or reconstruct the **original 151-item TezJet checklist**, preserving original item IDs and baseline completion flags.
- [ ] Map every PR #24–#30 to those item IDs, including overlap and previously partially implemented work.
- [ ] Re-evaluate each row's original acceptance criteria, not just whether an endpoint exists.
- [ ] Compute `verified_completed / 151 * 100` and remaining to 99 rows. Include a date, source and evidence for each changed row.
- [ ] Keep Agent-Factory's 21 items out of this percentage.
- [ ] Do not equate verified API tests with mobile-device acceptance or production readiness.

## Known larger work areas (not completed by PRs #24–#30)

- Persistent administrator-configured A/B pitaks, intermediate stops and distinct FIFO point semantics.
- Smart Pickup and real location/geofencing workflows.
- Production SMS/OTP integration and permanent hosting.
- Physical Android/iOS end-to-end checks, store publishing and release/legal acceptance.

This file records evidence, not a completion claim for those larger areas.
