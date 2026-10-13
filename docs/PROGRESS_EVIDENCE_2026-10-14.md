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
