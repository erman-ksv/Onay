# R01 — isolated integration manifest

The JSON manifest records measured Git refs, exact QA-exclusive commits and changed paths. Four new worktrees start at PR110 feature HEAD `135d849afeb6ee226a1531b822041cf13d6f5c36`. Existing worktrees and the dirty original checkout remain preserved. No unmerged entries were found in the original checkout at the recorded snapshot. Its pending orchestration changes belong to the prior session and are not imported here.

## Selective transfer decision

Both QA branches diverge at `bdab7194989ed742451e46f929ee73386691acc6`. `git cherry 135d849 origin/qa/apk121-driver-decline-e2e` marks all seven exclusive commits with `+`: none is patch-equivalent to the current base. The APK120 branch contains the first three of these commits. **No QA commit is authorized for transfer in R01–R04.** APK version bumps are excluded; icon/splash assertions require a separate future scope review; demo driver-decline source and its test belong to deferred R05+ work. Do not cherry-pick either branch wholesale or transplant its dependency/demo files. Future selection must inspect each exact commit, test semantics and current source independently, with explicit scope authorization.

## Current authorized integration sequence

1. Commit this R01 documentation only. Application tests are NOT RUN for this documentation step.
2. Security owns R02 `artifacts/api-server/test/queue-privacy.test.mjs` and sanitized evidence; Backend owns the R03 minimal DTO fix. Await exact test/fix SHAs and independent source review. Preserve driver allocation rules.
3. Android owns R04 validated SDK emulator download in the approved startup-release workflow and regression evidence; no APK rebuild.
4. Integration alone performs local selective cherry-picks of reviewed R02/R03/R04 commits into `phase1-integration`, resolves only their necessary conflicts, and runs meaningful combined checks using Backend's checked dependency graph and disposable test DB. Reused workspace symlinks must point to this candidate source, not stale worktree application code.
5. Record exact integrated SHAs, commands and results. No push, merge, new APK or R05–R34 work is permitted.

## Storage and dependency ownership

A measured ENOSPC incident blocked initial installs. Root reports Backend's filtered pinned pnpm10.34.9 install subsequently passed with169 packages; no new installs are required. Backend is the sole dependency writer. Security owns cleanup of only its newly generated failed-install directories and restoration of its own unintended policy placeholder. Do not delete old stores, receipts, source, worktrees or historical artifacts. Private DB env files must never be printed or committed. Limits and readiness remain UNKNOWN.

## Evidence and recovery

`R01_MANIFEST.json` captures exact fetched refs, the complete selective QA inventory, original dirty-path snapshot and four worktree owners. Reproduce with `git merge-base`, `git log BASE..REF`, `git diff-tree` and `git cherry` against the recorded refs. Documentation verification: JSON parsing, exact base checks, staged paths inspection and `git diff --check`. Resume from these new worktrees without resetting or reapplying prior session changes. Root owns OneNote delivery; no private page identifiers are stored here.
