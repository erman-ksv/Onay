# R04: Android emulator SDK archive provisioning

Date: 2026-11-17 UTC. Base: `135d849afeb6ee226a1531b822041cf13d6f5c36`.

## Observed failure and corrected target

Run [43926815713](https://github.com/erman-ksv/Onay/actions/runs/43926815713),
job [133508421394](https://github.com/erman-ksv/Onay/actions/runs/43926815713/job/133508421394),
failed before native acceptance. At `2026-11-16T18:15:50.6224511Z`, sdkmanager
reported `Archive is not a ZIP archive` while downloading
`emulator-linux_x64-167…`; the installation step exited 1. The logs do not retain
the downloaded bytes, so their precise corruption mechanism is unproven.

The run metadata identifies `.github/workflows/onay-apk118-startup-release.yml`,
not `.github/workflows/onay-apk119-publish-only.yml`. This patch changes the former
only. The delivery-only workflow is unchanged.

## Change

The provisioning helper reads official Google SDK metadata over verified HTTPS,
selects the stable Linux x64 emulator, and downloads to a fresh temporary file.
Before installation it verifies metadata size, the published checksum, ZIP CRC,
archive paths, required binaries, executable permissions and source revision.
Downloads have three attempts with bounded backoff; certificate failures and
permanent HTTP failures stop immediately. Failed attempts never replace the
download or installed emulator. Installation stages the emulator before replacing
that SDK package, leaving other SDK packages untouched.

The generated local SDK package receipt identifies the verified revision to
sdkmanager. The workflow independently checks `sdkmanager --list_installed`
recognizes it before proceeding to existing shared-library, KVM and native QA
checks. Provisioning diagnostics join the existing always-uploaded QA evidence.

All APK artifact IDs/source/checksum/signer checks, original APK build guard,
workflow permissions and native acceptance commands remain unchanged. No new
dependencies, APK builds or publication commands were introduced.

## Checks and limits

- `python3 -m unittest discover -s scripts -p test_provision_android_emulator.py -v`:
  17 behavioral tests PASS, using real ZIP fixtures and injected HTTP responses.
  Covers successful installation, fresh retry recovery, HTML/non-ZIP responses,
  truncated HTTP/ZIP, checksum/CRC mismatch, absent Content-Length, size limits,
  HTTP errors, TLS certificate failures, untrusted URLs/redirects, unsafe members,
  missing binaries and preservation of an existing emulator on failure.
- All repository workflow YAML parses. Semantic comparison against the base
  confirms all acceptance steps other than emulator provisioning are identical;
  other jobs, permissions and concurrency are identical. `git diff --check` PASS.
- Live official metadata fetched over verified HTTPS selects emulator `37.2.13`,
  `emulator-linux_x64-16740729.zip`, size `349658551`, Google-published SHA1
  `f41f9e31eb5ca64926603c03265c50bbc0ff4172`. The helper parses that live metadata.
- A 65,536-byte HTTPS Range read of the official ZIP tail confirms 451 central
  directory entries, 903,291,749 expanded bytes, no symlinks, and mode `100755` for
  both required emulator binaries. This is a compatibility observation, **not**
  verification of the entire downloaded archive.
- Full real SDK installation / sdkmanager recognition: NOT RUN in this workspace
  (no Android SDK installed). Native acceptance on the fix: UNVERIFIED.
- Remote CI on this unpublished fix: BLOCKED by the current no-push instruction.
  The old failing run was not rerun or credited as proof. No APK was rebuilt or
  changed; no release, push or merge occurred.

Independent QA and security review are required before integration. R04 is not
DONE until the approved CI verification of the actual fix passes.

## Integration continuation — 2026-11-17 10:08 UTC

Android's interrupted working files were preserved losslessly in
`orchestration/phase1/checkpoints/R04-interrupted.json` before continuation.
Integration independently reran the17 offline behavioral tests:17 PASS. All13
workflow YAML files parsed. A parsed semantic comparison against135d849 confirms
only the emulator provisioning step's run command and two new PR path filters
differ; every other step, job, condition, permission and concurrency field is
identical. Source review confirms verified HTTPS, official-host redirect checks,
bounded retries, pre-install checksum/CRC/path/revision checks and staged rollback.
`git diff --check` passed. No dependency install or SDK network download was run
during this continuation. The live metadata/range observations above are retained
Android-author evidence, not independently repeated here. Full SDK recognition
and native acceptance remain UNVERIFIED; no push is authorized.
