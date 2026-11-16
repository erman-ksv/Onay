# Onay APK121 E2E v6 - replace the ineffective ADB short hold fallback with
# one scrcpy mouse click. Patch a local script only. No app/APK/CI changes.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE 'Downloads'
$target = Get-ChildItem $root -Recurse -File -Filter 'Run-Onay-APK121-E2E.ps1' |
  Where-Object { $_.FullName -match 'Onay-APK121-E2E-v4' } |
  Select-Object -First 1
if (-not $target) { throw 'E2E v4/v5 test file is missing in Downloads.' }
$source = [System.IO.File]::ReadAllText($target.FullName)
if ($source.Contains('ONAY-E2E-V6-')) {
  Write-Host "Already patched to v6: $($target.FullName)" -ForegroundColor Green
  exit 0
}
$start = $source.IndexOf('function Press-Decline-With-Hold {')
$end = $source.IndexOf('function Decline-Offer-With-Verification {', $start)
if ($start -lt 0 -or $end -le $start -or $source -notmatch 'Decline still not applied') {
  throw 'This is not the expected E2E v5 script; no changes made.'
}
$replacement = @'
function Press-Decline-With-Hold {
  # v6: Use scrcpy to inject a real Windows mouse click into the mirrored
  # Android display. This is INDEPENDENT of adb shell input tap/swipe.
  $id = 'onay-demo-driver-cancel'
  $node = Wait-Node -id $id -Scroll
  if ($node.GetAttribute('clickable') -ne 'true' -or $node.GetAttribute('enabled') -ne 'true') {
    throw "Decline is not clickable/enabled: $id"
  }
  $bounds = $node.GetAttribute('bounds')
  $b = [regex]::Match($bounds, '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$')
  if (-not $b.Success) { throw "Invalid Android bounds: $bounds" }
  $ax = ([int]$b.Groups[1].Value + [int]$b.Groups[3].Value) / 2.0
  $ay = ([int]$b.Groups[2].Value + [int]$b.Groups[4].Value) / 2.0
  $scrcpy = Get-Command scrcpy.exe -CommandType Application -ErrorAction SilentlyContinue
  if (-not $scrcpy) { throw 'scrcpy.exe is not in PATH; scrcpy fallback unavailable.' }

  # Win32 coordinates are desktop physical pixels. GetClientRect excludes
  # scrcpy title bars; aspect-ratio calculations account for letterboxing.
  if (-not ('OnayScrcpyUiInputV6' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OnayScrcpyUiInputV6 {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string klass,string name);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd,ref Point pt);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint buttons,UIntPtr extraInfo);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
  }
  [void][OnayScrcpyUiInputV6]::SetProcessDPIAware()
  $sizes = ADB @('shell','wm','size')
  $mm = [regex]::Matches($sizes, '(?:Physical|Override) size:\s*(\d+)x(\d+)')
  if ($mm.Count -lt 1) { throw "Cannot determine Android screen size: $sizes" }
  $sw = [double]$mm[$mm.Count-1].Groups[1].Value
  $sh = [double]$mm[$mm.Count-1].Groups[2].Value
  if ($sw -le 0 -or $sh -le 0 -or $sw -ge $sh) { throw 'This scrcpy test supports portrait Android only.' }

  $title = "ONAY-E2E-V6-$PID"
  $quotedSerial = '"' + $script:Serial + '"'
  $args = @('-s', $quotedSerial, '--max-size=1024', '--no-audio', "--window-title=$title")
  $proc = Start-Process -FilePath $scrcpy.Source -ArgumentList $args -PassThru
  try {
    $hwnd = [IntPtr]::Zero
    for ($i=0; $i -lt 35; $i++) {
      Start-Sleep -Milliseconds 300
      $hwnd = [OnayScrcpyUiInputV6]::FindWindow($null, $title)
      if ($hwnd -ne [IntPtr]::Zero) { break }
      if ($proc.HasExited) { throw "scrcpy quit before creating its window (exit $($proc.ExitCode))." }
    }
    if ($hwnd -eq [IntPtr]::Zero) { throw 'scrcpy test window did not appear.' }
    $r = New-Object OnayScrcpyUiInputV6+Rect
    $p = New-Object OnayScrcpyUiInputV6+Point
    if (-not [OnayScrcpyUiInputV6]::GetClientRect($hwnd, [ref]$r)) { throw 'Cannot read scrcpy client rectangle.' }
    if (-not [OnayScrcpyUiInputV6]::ClientToScreen($hwnd, [ref]$p)) { throw 'Cannot map scrcpy client to screen.' }
    $cw = [double]($r.Right-$r.Left)
    $ch = [double]($r.Bottom-$r.Top)
    if ($cw -le 50 -or $ch -le 50) { throw 'scrcpy display is too small.' }
    $scale = [math]::Min($cw / $sw, $ch / $sh)
    $sx = [int][math]::Round($p.X + ($cw - $sw*$scale)/2.0 + $ax*$scale)
    $sy = [int][math]::Round($p.Y + ($ch - $sh*$scale)/2.0 + $ay*$scale)
    $note = "SCRCPY_CLICK android=($ax,$ay) screen=($sx,$sy) bounds=$bounds video=$($cw)x$($ch) device=$($sw)x$($sh)"
    [void]$script:Notes.Add($note)
    Write-Host $note -ForegroundColor Cyan
    [void][OnayScrcpyUiInputV6]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 420
    [void][OnayScrcpyUiInputV6]::SetCursorPos($sx,$sy)
    Start-Sleep -Milliseconds 160
    [OnayScrcpyUiInputV6]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 110
    [OnayScrcpyUiInputV6]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 800
  } finally {
    if ($proc -and -not $proc.HasExited) {
      [void]$proc.CloseMainWindow()
    }
  }
}
'@
$patched = $source.Substring(0,$start) + $replacement + [Environment]::NewLine + $source.Substring($end)
$backup = "$($target.FullName).v5.bak"
[System.IO.File]::WriteAllText($backup,$source,(New-Object System.Text.UTF8Encoding($true)))
[System.IO.File]::WriteAllText($target.FullName,$patched,(New-Object System.Text.UTF8Encoding($true)))
Write-Host "PATCHED v6: $($target.FullName)" -ForegroundColor Green
Write-Host "BACKUP: $backup"
Write-Host 'This replaces ONLY the second decline input path; v6 is not yet verified on the phone.'
