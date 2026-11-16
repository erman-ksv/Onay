# ONAY APK121 Windows E2E: fix scrcpy window discovery in installed v6 test.
# Requires prior v6 patch. Modifies only local test script and creates a backup.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE 'Downloads'
$target = Get-ChildItem $root -Recurse -File -Filter 'Run-Onay-APK121-E2E.ps1' |
  Where-Object { $_.FullName -match 'Onay-APK121-E2E-v4' } | Select-Object -First 1
if (-not $target) { throw 'E2E v6 local file not found under Downloads.' }
$src = [System.IO.File]::ReadAllText($target.FullName)
$old = '$hwnd = [OnayScrcpyUiInputV6]::FindWindow($null, $title)'
$marker = '# ONAY-E2E-V7-WINDOW-DETECTION'
if ($src.Contains($marker)) { Write-Host "Already patched: $($target.FullName)"; exit 0 }
if (-not $src.Contains($old)) { throw 'Expected v6 scrcpy window lookup not found; file unchanged.' }
$replacement = @'
      # ONAY-E2E-V7-WINDOW-DETECTION
      # scrcpy can show a window whose title differs from --window-title.
      # The newly launched scrcpy process is dedicated to this test.
      $proc.Refresh()
      $hwnd = $proc.MainWindowHandle
      if ($hwnd -eq [IntPtr]::Zero) {
        $hwnd = [OnayScrcpyUiInputV6]::FindWindow($null, $title)
      }
'@
$patched = $src.Replace($old, $replacement.TrimEnd())
$oldFailure = "if (`$hwnd -eq [IntPtr]::Zero) { throw 'scrcpy test window did not appear.' }"
$newFailure = @'
    if ($hwnd -eq [IntPtr]::Zero) {
      $proc.Refresh()
      $info = @(Get-Process -Name scrcpy -ErrorAction SilentlyContinue |
        ForEach-Object { "pid=$($_.Id),handle=$($_.MainWindowHandle),title=$($_.MainWindowTitle)" }) -join '; '
      throw "scrcpy window not found. launched_pid=$($proc.Id); discovered=$info"
    }
'@
if ($patched.Contains($oldFailure)) {
  $patched = $patched.Replace($oldFailure, $newFailure.TrimEnd())
}
$backup = "$($target.FullName).v6.bak"
[System.IO.File]::WriteAllText($backup, $src, (New-Object System.Text.UTF8Encoding($true)))
[System.IO.File]::WriteAllText($target.FullName, $patched, (New-Object System.Text.UTF8Encoding($true)))
Write-Host "PATCHED v7: $($target.FullName)" -ForegroundColor Green
Write-Host "BACKUP: $backup"
Write-Host 'Window lookup fixed in local E2E only. Not yet verified on Samsung.'
