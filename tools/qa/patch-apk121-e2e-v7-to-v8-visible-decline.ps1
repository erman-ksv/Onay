# ONAY APK121 E2E v8: do not tap a partially clipped decline button.
# Patch an already installed Windows E2E v7. Only the local test script changes.
$ErrorActionPreference = 'Stop'
$target = Get-ChildItem (Join-Path $env:USERPROFILE 'Downloads') -Recurse -File -Filter 'Run-Onay-APK121-E2E.ps1' |
  Where-Object { $_.FullName -match 'Onay-APK121-E2E-v4' } | Select-Object -First 1
if (-not $target) { throw 'Existing APK121 E2E script not found in Downloads.' }
$original = [System.IO.File]::ReadAllText($target.FullName)
if ($original.Contains('ONAY-E2E-V8-VISIBLE-TARGET')) {
  Write-Host "Already patched to v8: $($target.FullName)" -ForegroundColor Green
  exit 0
}
$start = $original.IndexOf('function Press-Decline-With-Hold {')
$end = $original.IndexOf('function Decline-Offer-With-Verification {', $start)
if ($start -lt 0 -or $end -le $start -or $original -notmatch 'ONAY-E2E-V7-WINDOW-DETECTION') {
  throw 'Expected E2E v7 script not found. No files were changed.'
}
$newMethods = @'
# ONAY-E2E-V8-VISIBLE-TARGET
# A UIAutomator resource-id alone does NOT prove an accessible tap rectangle:
# scrolling/clipping can report bounds=[63,1469][657,1446] (inverted height).
function Get-VisibleDeclineTapPosition {
  $last = ''
  for($step=1; $step -le 7; $step++) {
    $ui = Get-UI
    $decline = Find-Node $ui 'onay-demo-driver-cancel'
    $nav = Find-Node $ui 'onay-driver-tab-line'
    $bounds = if($null -ne $decline) { $decline.GetAttribute('bounds') } else { '<not in hierarchy>' }
    $navBounds = if($null -ne $nav) { $nav.GetAttribute('bounds') } else { '<nav not in hierarchy>' }
    $reason = 'missing decline or driver navigation node'
    if($null -ne $decline -and $null -ne $nav) {
      $dm = [regex]::Match($bounds, '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$')
      $nm = [regex]::Match($navBounds, '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$')
      if($dm.Success -and $nm.Success) {
        $left = [int]$dm.Groups[1].Value
        $top = [int]$dm.Groups[2].Value
        $right = [int]$dm.Groups[3].Value
        $bottom = [int]$dm.Groups[4].Value
        $navTop = [int]$nm.Groups[2].Value
        # Require the ENTIRE decline button to fit above the bottom tab bar.
        if($right -gt $left -and $bottom -gt $top -and
           ($right-$left) -ge 40 -and ($bottom-$top) -ge 40 -and
           $top -ge 100 -and $bottom -le ($navTop-20) -and
           $decline.GetAttribute('clickable') -eq 'true' -and
           $decline.GetAttribute('enabled') -eq 'true') {
          $x = [int][math]::Floor(($left+$right)/2)
          $y = [int][math]::Floor(($top+$bottom)/2)
          $note = "DECLINE_VISIBLE x=$x y=$y bounds=$bounds navTop=$navTop step=$step"
          [void]$script:Notes.Add($note)
          Write-Host $note -ForegroundColor Green
          return [pscustomobject]@{ X=$x; Y=$y; Bounds=$bounds }
        }
        $reason = "clipped/inverted or overlapping nav; top=$top bottom=$bottom navTop=$navTop"
      } else { $reason = 'invalid Android bounds format' }
    }
    $last = "attempt=$step bounds=$bounds nav=$navBounds reason=$reason"
    [void]$script:Notes.Add("DECLINE_SCROLL $last")
    Write-Host "DECLINE_SCROLL $last" -ForegroundColor DarkYellow
    if($step -lt 7) {
      # Finger moves up inside the scrollable content, not over the tab bar.
      Swipe-Up
      Start-Sleep -Milliseconds 850
    }
  }
  throw "Decline could not be scrolled fully above bottom navigation: $last. Refusing unsafe tap."
}
function Tap-Decline-Visible {
  $p = Get-VisibleDeclineTapPosition
  $null = ADB @('shell','input','tap',"$($p.X)","$($p.Y)")
  Start-Sleep -Milliseconds 900
}
function Press-Decline-With-Hold {
  # Retry a stationary 160ms contact ONLY after revalidating onscreen bounds.
  # This does not use scrcpy/Windows desktop coordinates.
  $p = Get-VisibleDeclineTapPosition
  Write-Host "DECLINE_HOLD x=$($p.X) y=$($p.Y) duration=160ms" -ForegroundColor Cyan
  $null = ADB @('shell','input','swipe',"$($p.X)","$($p.Y)","$($p.X)","$($p.Y)",'160')
  Start-Sleep -Milliseconds 900
}
'@
$declineStart = $end
$declineEnd = $original.IndexOf('function Assert-Selected(', $declineStart)
if($declineEnd -le $declineStart) { throw 'Decline function end not found. No files changed.' }
$declineText = $original.Substring($declineStart, $declineEnd-$declineStart)
$call = "Tap 'onay-demo-driver-cancel' -Scroll"
if($declineText.Split([string[]]@($call), [StringSplitOptions]::None).Count -ne 2) {
  throw 'Unique decline tap call not found. No files changed.'
}
$declineText = $declineText.Replace($call, 'Tap-Decline-Visible')
$patched = $original.Substring(0,$start) + $newMethods + [Environment]::NewLine +
  $declineText + $original.Substring($declineEnd)
$backup = "$($target.FullName).v7.bak"
[System.IO.File]::WriteAllText($backup, $original, (New-Object System.Text.UTF8Encoding($true)))
[System.IO.File]::WriteAllText($target.FullName, $patched, (New-Object System.Text.UTF8Encoding($true)))
Write-Host "PATCHED v8: $($target.FullName)" -ForegroundColor Green
Write-Host "BACKUP: $backup"
Write-Host 'Visible bounds + bottom-nav exclusion added. Not yet verified on Samsung.'
