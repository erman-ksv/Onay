# Resume ONAY

1. Read `orchestration/state.json`, latest checkpoint and reports before auditing again.
2. Verify `git branch --show-current`, `git rev-parse HEAD`, `git status --short`, `git worktree list` in `/workspace/onay`; compare against saved HEAD. Never reset or discard existing changes.
3. Fetch PR #110 metadata and current CI. Only operate on `feat/artifact-auth-ui-v1`; never merge/push main.
4. Reconcile task evidence with agents and worktree changes. Saved status does not prove an agent process is still running.
5. Resume independent unfinished tasks in isolated `/workspace/onay-worktrees/<role>` checkouts. Maximum 6 specialist agents plus orchestrator.
6. Preserve APK119; diagnose the saved failed acceptance run before any Android action. Do not build another APK without need and applicable authorization.
7. Test, review and integrate confirmed commits into the existing PR branch. Record real statuses, never invented readiness or quota.
8. Reports are delivered in the live session; no external scheduler/delivery has been verified. Save reports under `orchestration/reports/` and confirm actual delivery before claiming periodic notifications.

No secrets, tokens or environment credential values belong in checkpoints.

Available Automations requires minimum 10-minute spacing (6 runs/hour), so external 5-minute delivery is BLOCKED. Do not evade this via multiple jobs. `python3 orchestration/report_snapshot.py --watch` can persist 5-minute snapshots only while its live session process runs; it does not deliver chat notifications and does not prove agent liveness. Update state under the orchestrator single-writer discipline and send the report to chat separately. No watcher has been started by Integration.
