# Apply the APK121 decline E2E v5 fallback to an already downloaded v4 script.
# No APK/repository/main changes. Local test script only.
$ErrorActionPreference = 'Stop'
$downloads = Join-Path $env:USERPROFILE 'Downloads'
$target = Get-ChildItem $downloads -Recurse -File -Filter 'Run-Onay-APK121-E2E.ps1' |
  Where-Object { $_.FullName -match 'Onay-APK121-E2E-v4' } |
  Select-Object -First 1
if (-not $target) { throw 'E2E v4 not found in Downloads. Keep the previous v4 archive extracted.' }
$source = [System.IO.File]::ReadAllText($target.FullName)
if ($source -match 'function Press-Decline-With-Hold') {
  Write-Host 'Patch already present, no changes made.'
  Write-Host "SCRIPT: $($target.FullName)"
  exit 0
}
$start = $source.IndexOf('function Decline-Offer-With-Verification {')
$end = $source.IndexOf('function Assert-Selected(', $start)
if ($start -lt 0 -or $end -le $start -or -not $source.Contains('Driver decline NOT applied after two confirmed visible taps')) {
  throw 'Unexpected E2E script version; nothing changed.'
}
$replacement = @'
function Press-Decline-With-Hold {
  $id = 'onay-demo-driver-cancel'
  $node = Wait-Node -id $id -Scroll
  if($node.GetAttribute('clickable') -ne 'true' -or $node.GetAttribute('enabled') -ne 'true') { throw "Decline control not clickable/enabled: $id" }
  $bounds = $node.GetAttribute('bounds')
  $m = [regex]::Match($bounds,'^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$')
  if(-not $m.Success){ throw "Invalid decline bounds: $bounds" }
  $x = [int][math]::Floor(([int]$m.Groups[1].Value+[int]$m.Groups[3].Value)/2)
  $y = [int][math]::Floor(([int]$m.Groups[2].Value+[int]$m.Groups[4].Value)/2)
  [void]$script:Notes.Add("DECLINE_HOLD at ($x,$y) bounds=$bounds duration=160ms")
  Write-Host "DECLINE_HOLD at ($x,$y)" -ForegroundColor Cyan
  $null = ADB @('shell','input','swipe',"$x","$y","$x","$y",'160')
  Start-Sleep -Milliseconds 850
}
function Decline-Offer-With-Verification {
  $before=Get-UI
  if($null -eq (Find-Node $before 'onay-demo-driver-order')) { throw 'Decline precondition: missing offer' }
  if($null -eq (Find-Node $before 'onay-demo-driver-cancel')) { throw 'Decline precondition: missing decline button' }
  if((Find-Node $before 'onay-driver-online').GetAttribute('checked') -ne 'true') { throw 'Decline precondition: driver offline' }
  Capture 'decline_before'
  for($attempt=1;$attempt -le 2;$attempt++) {
    Start-Sleep -Milliseconds 900
    if($attempt -eq 1) { Tap 'onay-demo-driver-cancel' -Scroll }
    else { Press-Decline-With-Hold }
    for($poll=1;$poll -le 5;$poll++) {
      Start-Sleep -Milliseconds 400
      $after=Get-UI
      $offerPresent=$null -ne (Find-Node $after 'onay-demo-driver-order')
      $cancelPresent=$null -ne (Find-Node $after 'onay-demo-driver-cancel')
      $noOfferPresent=$null -ne (Find-Node $after 'onay-demo-driver-no-offer')
      if($noOfferPresent -and -not $offerPresent) {
        Capture "decline_after_attempt_$attempt"
        return
      }
      if(-not $offerPresent -and -not $cancelPresent) {
        Capture "decline_after_attempt_$attempt"
        Expect-Node 'onay-demo-driver-no-offer' -Scroll
        Expect-NotNode 'onay-demo-driver-order'
        return
      }
    }
    Write-Host "DECLINE attempt=$attempt offer=$offerPresent noOffer=$noOfferPresent" -ForegroundColor Cyan
    Capture "decline_after_attempt_$attempt"
    if($attempt -eq 1 -and $offerPresent -and $cancelPresent) { continue }
    break
  }
  throw 'Decline still not applied after tap and 160ms hold. Check saved UI diagnostics.'
}
'@
$patched = $source.Substring(0,$start) + $replacement + [Environment]::NewLine + $source.Substring($end)
$backup = "$($target.FullName).v4.bak"
[System.IO.File]::WriteAllText($backup,$source,[System.Text.UTF8Encoding]::new($true))
[System.IO.File]::WriteAllText($target.FullName,$patched,[System.Text.UTF8Encoding]::new($true))
Write-Host "PATCHED: $($target.FullName)" -ForegroundColor Green
Write-Host "BACKUP: $backup"
