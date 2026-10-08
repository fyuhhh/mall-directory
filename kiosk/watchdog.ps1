<#
.SYNOPSIS
  BSB Directory kiosk watchdog (CMS_SPEC 8.5 #4). Runs as the kiosk user (Task Scheduler, see setup-kiosk.ps1).

  watchdog.ps1               one check: Edge (kiosk profile) running and responding? otherwise start-kiosk.bat
  watchdog.ps1 -Loop         check every 60 s forever (the 'Watchdog' logon task)
  watchdog.ps1 -UserSetup    apply per-user lockdown (gestures, notifications, touch keyboard, taskbar auto-hide)
  watchdog.ps1 -RestartEdge  close Edge and start the kiosk again (daily 04:30)
  watchdog.ps1 -DisplayOff   turn the monitor off (night)

  If the directory server does not answer (health check), the watchdog does NOTHING except log it:
  the Service Worker keeps the kiosk working from its cache, and restarting Edge would not help.
#>
[CmdletBinding()]
param([switch]$Loop, [switch]$UserSetup, [switch]$RestartEdge, [switch]$DisplayOff, [int]$IntervalSec = 60)
$ErrorActionPreference = 'Continue'
$Dir = $PSScriptRoot
$Log = Join-Path $Dir 'watchdog.log'
$Bat = Join-Path $Dir 'start-kiosk.bat'
$ProfileMarker = 'BSBKiosk\EdgeProfile'

function Log([string]$m) {
  try {
    if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 1MB) { Move-Item -Force $Log "$Log.1" }
    Add-Content -Path $Log -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $m)
  } catch {}
}
function Read-Conf {
  $c = @{}
  $f = Join-Path $Dir 'kiosk.conf'
  if (Test-Path $f) { Get-Content $f | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $c[$Matches[1]] = $Matches[2].Trim() } } }
  return $c
}
function Get-KioskEdge {
  # only the Edge processes that use the kiosk profile (other Edge windows are ignored)
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$ProfileMarker*" }
}
function Start-Kiosk([string]$why) {
  Log "start kiosk ($why)"
  Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList "/c `"$Bat`"" -WorkingDirectory $Dir -WindowStyle Hidden
}
function Stop-KioskEdge {
  Get-KioskEdge | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
  Start-Sleep -Seconds 2
}

$script:notResponding = 0
$script:healthFail = 0
function Check-Once {
  $edge = @(Get-KioskEdge)
  if ($edge.Count -eq 0) { Start-Kiosk 'Edge not running'; $script:notResponding = 0; return }
  # main window hung? (3 consecutive checks = ~3 min) -> restart
  $ui = Get-Process -Id ($edge | ForEach-Object { $_.ProcessId }) -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
  if ($ui -and -not ($ui | Where-Object { $_.Responding })) {
    $script:notResponding++
    if ($script:notResponding -ge 3) { Log 'Edge not responding x3 -> restart'; Stop-KioskEdge; Start-Kiosk 'hung'; $script:notResponding = 0 }
  } else { $script:notResponding = 0 }
  # server health: log only (the Service Worker serves the kiosk from cache while the server is down)
  $conf = Read-Conf
  if ($conf.BASE_URL) {
    try {
      $r = Invoke-WebRequest -Uri ($conf.BASE_URL + '/data/version.json?probe=1') -UseBasicParsing -TimeoutSec 8
      if ($script:healthFail -ge 10) { Log "server reachable again after $($script:healthFail) failed checks" }
      $script:healthFail = 0
    } catch {
      $script:healthFail++
      if ($script:healthFail -eq 10) { Log "server unreachable for 10 checks ($($_.Exception.Message)) - kiosk keeps running from cache" }
    }
  }
}

function Apply-UserSetup {
  function Set-U([string]$Path, [string]$Name, $Value, [string]$Type = 'DWord') {
    try { if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }; New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null } catch { Log "UserSetup $Path\$Name failed: $_" }
  }
  Set-U 'HKCU:\Control Panel\Desktop' 'TouchGestureSetting' 0                                   # Win11: three/four-finger touch gestures off (verify per build)
  Set-U 'HKCU:\Software\Microsoft\TabletTip\1.7' 'EnableDesktopModeAutoInvoke' 0                 # no automatic touch keyboard
  Set-U 'HKCU:\Software\Microsoft\TabletTip\1.7' 'TipbandDesiredVisibility' 0
  Set-U 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' 'ToastEnabled' 0      # no toasts
  Set-U 'HKCU:\Software\Policies\Microsoft\Windows\Explorer' 'DisableNotificationCenter' 1
  Set-U 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' 'TaskbarSmallIcons' 1
  # taskbar auto-hide (StuckRects3 byte 8: 3 = auto-hide, 2 = always visible)
  try {
    $k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StuckRects3'
    $v = (Get-ItemProperty -Path $k -Name Settings -ErrorAction Stop).Settings
    if ($v[8] -ne 3) { $v[8] = 3; Set-ItemProperty -Path $k -Name Settings -Value $v; Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue }
  } catch { Log "taskbar auto-hide not applied: $_" }
  Log 'user lockdown applied'
}

function Set-DisplayOff {
  Add-Type -Namespace BSB -Name Mon -MemberDefinition '[DllImport("user32.dll")] public static extern int SendMessage(int hWnd, int hMsg, int wParam, int lParam);'
  [BSB.Mon]::SendMessage(0xFFFF, 0x0112, 0xF170, 2) | Out-Null   # HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, off
  Log 'display off'
}

if ($UserSetup) { Apply-UserSetup }
if ($DisplayOff) { Set-DisplayOff; return }
if ($RestartEdge) { Log 'scheduled Edge restart'; Stop-KioskEdge; Start-Kiosk 'daily restart'; return }
if ($Loop) {
  Log "watchdog loop started (every $IntervalSec s)"
  while ($true) { try { Check-Once } catch { Log "check failed: $_" }; Start-Sleep -Seconds $IntervalSec }
} else { Check-Once }
