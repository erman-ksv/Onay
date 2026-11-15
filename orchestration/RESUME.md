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

Resume update2026-11-15: integrated tree d77e509 matches QA87f7558; finalAPI656/mobile356/load1/admin60/typechecks5/YAML13 PASS. See docs/onay-team-qa.md and docs/onay-team-review.md. Current local task is normalfeaturebranch push and actualCI monitoring. Ordinary existing mandatory CI is authorized; do not introduce deferred heavy E2E or new APK builds. A time jump occurred; never infer process continuity. OneNote journal root-owned, existingONAYpage discovered; private receipts/bindings under ignored orchestration/onenote-queue/. Discover destination through OneNote rather than storing private IDs in git.

2026-11-15 follow-up: old remote71ecf1a finished6SUCCESS/3FAIL/3SKIP; allAPK119checksSUCCESSwithbuildSKIPPED. Browser2failures were Ubuntu26 unsupported by pinnedPlaywright; local180d2cf pins browserjobsUbuntu24 only. Historical115native script mismatched later116screen; local1c426fc provides explicit115/116contracts, five deterministic tests and ROOTindependentreviewPASS. No oldCI jobs active before followuppush. Private QAenv deleted; disposablePGalreadyabsent, no othercontainers touched.

Mobile reproducibility follow-up: source d807cf3 independently approved by ROOT/Security, integrated6090b8c. Existingnestedworkspace retained with committedmobilelock/pnpm10.34.9/1440age/strictdenyhooks, exact20directversions unchanged. Twofreshfrozen installs/noignore-scripts, negativehook/drift, mobile356/typecheck/3JSexports PASS. See docs/onay-mobile-dependencies.md and independentreview+auditinventory. Audit is NOTclean:0critical/5high/6moderate/1low; separate scopedremediation required. No SDK/native build. Prior remote c44 completed9SUCCESS3SKIP; newdependency-commit CI pending normalfeaturepush.
