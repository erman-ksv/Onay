# ONAY task queue

Baseline: `2cd511526bf66559be05cfd486c038a6e5cbe449`, PR #110, branch `feat/artifact-auth-ui-v1`.

| Role | Task | Status | Evidence |
|---|---|---|---|
| Integration | Clone existing repository and isolate 7 specialist worktrees | VERIFIED | git worktree list; clean baseline |
| Frontend | Audit passenger UI/navigation and prioritize real regressions | QUEUED | — |
| UI/UX | Audit pinned design, accessibility, RU/UZ/KZ | QUEUED | — |
| Maps | Audit map, geolocation, route selection and API contract | QUEUED | — |
| Backend | Audit API/auth/orders; preserve allocation rules | QUEUED | — |
| Android | Diagnose APK119 acceptance run 42492883918; no rebuild | QUEUED | Failed CI API snapshot |
| QA | Establish appropriate local checks and regression evidence | QUEUED | Local tests NOT RUN |
| Security | Review auth/API and specialist diffs | QUEUED | — |

No task is DONE without commit SHA, passing appropriate tests, review and integration verification. Historical artifact tests do not verify current native source. Heavy deferred E2E remains gated on agreed 90% readiness; readiness is UNKNOWN.
