<#
.SYNOPSIS
  BSB Directory - one-time setup of a Windows 10/11 kiosk PC (CMS_SPEC 8.5). Run as Administrator.

.DESCRIPTION
  - writes C:\BSBKiosk\kiosk.conf (kiosk id, token, server URL) + copies start-kiosk.bat / watchdog.ps1
  - Microsoft Edge policies (kiosk lockdown: URL allowlist, no devtools/downloads/print/translate/passwords, autoplay)
  - disables edge swipe, notifications, touch-keyboard auto pop-up, three/four-finger gestures (kiosk user, at logon)
  - power plan: display/sleep never; Windows Update active hours 08-23, no auto reboot while logged on
  - Task Scheduler: start Edge at logon (+20 s), watchdog loop, daily Edge restart 04:30, weekly reboot Sun 05:00,
    optional display-off at night
  Edge runs with --edge-kiosk-type=fullscreen and a PERSISTENT profile (NOT public-browsing / InPrivate),
  otherwise the Service Worker cache, localStorage snapshot and telemetry queue would be wiped at every start.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup-kiosk.ps1 -KioskId gf-pentacity -Key <token from CMS> `
      -BaseUrl https://directory.example.com/bsb-directory -KioskUser Kiosk

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup-kiosk.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$KioskId,
  [string]$Key = '',
  [string]$BaseUrl = 'https://directory.example.com/bsb-directory',
  [string]$KioskUser = 'Kiosk',
  [string]$InstallDir = 'C:\BSBKiosk',
  [string]$DisplayOffAt = '',            # e.g. '22:30' -> monitor off every night (a touch wakes it up again)
  [string]$AutologonExe = '',            # optional: path to Sysinternals Autologon64.exe (password stored LSA-encrypted)
  [switch]$DisableUsbStorage,            # USBSTOR Start=4 (no USB sticks)
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

function Assert-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script as Administrator.' }
}
function Set-Reg([string]$Path, [string]$Name, $Value, [string]$Type = 'DWord') {
  if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
  New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}
function Set-RegList([string]$Path, [string[]]$Values) {   # Edge list policies: values named 1, 2, 3 ...
  if (Test-Path $Path) { Remove-Item -Path $Path -Recurse -Force }
  New-Item -Path $Path -Force | Out-Null
  $i = 1; foreach ($v in $Values) { New-ItemProperty -Path $Path -Name ([string]$i) -Value $v -PropertyType String -Force | Out-Null; $i++ }
}
function Step([string]$t) { Write-Host "==> $t" -ForegroundColor Cyan }

Assert-Admin
$TaskPath = '\BSB Kiosk\'
$EdgePol = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'

if ($Uninstall) {
  Step 'Removing scheduled tasks and Edge kiosk policies'
  Get-ScheduledTask -TaskPath $TaskPath -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
  if (Test-Path $EdgePol) { Remove-Item $EdgePol -Recurse -Force }
  Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\EdgeUI' -Name AllowEdgeSwipe -ErrorAction SilentlyContinue
  Write-Host "Done. $InstallDir was kept (delete it manually if needed)."
  return
}
if (-not $KioskId) { throw 'Parameter -KioskId is required (e.g. gf-pentacity).' }
if ($BaseUrl -notmatch '^https://') { Write-Warning 'BaseUrl is not HTTPS: the Service Worker (offline cache) will NOT work. Use the real domain + certificate (CMS_SPEC 8.3).' }
if (-not $Key) { Write-Warning 'No -Key given: the kiosk works, but heartbeat/telemetry are rejected (401). Create a token in CMS > Kiosk > Provisioning.' }
$BaseUrl = $BaseUrl.TrimEnd('/')
$host_ = ([Uri]$BaseUrl).Host

# ---------------------------------------------------------------- files
Step "Installing launcher files to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot 'start-kiosk.bat') $InstallDir
Copy-Item -Force (Join-Path $PSScriptRoot 'watchdog.ps1') $InstallDir
$conf = @(
  "KIOSK_ID=$KioskId",
  "KIOSK_KEY=$Key",
  "BASE_URL=$BaseUrl"
)
Set-Content -Path (Join-Path $InstallDir 'kiosk.conf') -Value $conf -Encoding ASCII
# the token is a credential: only Administrators, SYSTEM and the kiosk account may read the folder
try {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $inh = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  $none = [System.Security.AccessControl.PropagationFlags]::None
  foreach ($id in @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM')) {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($id, 'FullControl', $inh, $none, 'Allow')))
  }
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("$env:COMPUTERNAME\$KioskUser", 'ReadAndExecute', $inh, $none, 'Allow')))
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("$env:COMPUTERNAME\$KioskUser", 'Modify', $inh, $none, 'Allow')))  # watchdog log
  Set-Acl -Path $InstallDir -AclObject $acl
} catch { Write-Warning "Could not restrict ACL on $InstallDir ($_). Does the local user '$KioskUser' exist?" }

# ---------------------------------------------------------------- Edge policies
Step 'Microsoft Edge kiosk policies (HKLM\SOFTWARE\Policies\Microsoft\Edge)'
Set-RegList "$EdgePol\URLBlocklist" @('*')
Set-RegList "$EdgePol\URLAllowlist" @($host_, 'about:blank')
$dw = @{
  DeveloperToolsAvailability = 2      # no F12 / devtools
  DownloadRestrictions = 3            # block all downloads
  PrintingEnabled = 0
  TranslateEnabled = 0
  PasswordManagerEnabled = 0
  AutofillAddressEnabled = 0
  AutofillCreditCardEnabled = 0
  HideFirstRunExperience = 1
  AutoplayAllowed = 1                 # muted promo videos
  BrowserSignin = 0
  SyncDisabled = 1
  InPrivateModeAvailability = 1       # no InPrivate (it would bypass the persistent cache)
  BackgroundModeEnabled = 0
  StartupBoostEnabled = 0
  EdgeShoppingAssistantEnabled = 0
  EdgeCollectionsEnabled = 0
  HubsSidebarEnabled = 0
  ShowRecommendationsEnabled = 0
  SpotlightExperiencesAndRecommendationsEnabled = 0
  PersonalizationReportingEnabled = 0
  DefaultNotificationsSetting = 2
  DefaultPopupsSetting = 2
  DefaultGeolocationSetting = 2
  FullscreenAllowed = 1
  KioskDeleteDownloadsOnExit = 1
  ConfigureOnlineTextToSpeech = 0
}
foreach ($k in $dw.Keys) { Set-Reg $EdgePol $k $dw[$k] }
# NOTE: do NOT set RestoreOnStartup; the URL comes from start-kiosk.bat (--kiosk <url>).

# ---------------------------------------------------------------- Windows shell / input
Step 'Disable edge swipe (all users), error dialogs, update reboots'
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\EdgeUI' 'AllowEdgeSwipe' 0
Set-Reg 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting' 'DontShowUI' 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' 'SetActiveHours' 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' 'ActiveHoursStart' 8
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' 'ActiveHoursEnd' 23
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' 'DeferFeatureUpdates' 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' 'DeferFeatureUpdatesPeriodInDays' 180
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' 'NoAutoRebootWithLoggedOnUsers' 1
if ($DisableUsbStorage) { Step 'Disable USB mass storage'; Set-Reg 'HKLM:\SYSTEM\CurrentControlSet\Services\USBSTOR' 'Start' 4 }

# ---------------------------------------------------------------- power
Step 'Power: display & sleep never (AC), hibernate off'
& powercfg /change monitor-timeout-ac 0 | Out-Null
& powercfg /change standby-timeout-ac 0 | Out-Null
& powercfg /change hibernate-timeout-ac 0 | Out-Null
& powercfg /hibernate off | Out-Null
& powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0 2>$null | Out-Null  # USB selective suspend off (touch frame)
& powercfg /setactive SCHEME_CURRENT | Out-Null

# ---------------------------------------------------------------- scheduled tasks
Step "Scheduled tasks in Task Scheduler folder '$TaskPath'"
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$wd = Join-Path $InstallDir 'watchdog.ps1'
$userId = "$env:COMPUTERNAME\$KioskUser"
$userPrincipal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$sysPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

function Register-Task([string]$Name, $Action, $Trigger, $Principal, [string]$Desc) {
  Unregister-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Action $Action -Trigger $Trigger -Principal $Principal -Settings $set -Description $Desc | Out-Null
  Write-Host "    + $Name"
}
# 1) start Edge 20 s after the kiosk user logs on (more reliable than the Startup folder)
$t1 = New-ScheduledTaskTrigger -AtLogOn -User $userId; $t1.Delay = 'PT20S'
Register-Task 'Start kiosk' (New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument "/c `"$InstallDir\start-kiosk.bat`"" -WorkingDirectory $InstallDir) $t1 $userPrincipal 'Start Microsoft Edge in kiosk mode'
# 2) per-user lockdown (gestures, notifications, touch keyboard, taskbar) + watchdog loop (checks Edge every 60 s)
$t2 = New-ScheduledTaskTrigger -AtLogOn -User $userId; $t2.Delay = 'PT40S'
Register-Task 'Watchdog' (New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wd`" -UserSetup -Loop" -WorkingDirectory $InstallDir) $t2 $userPrincipal 'Restart Edge if it is not running / not responding'
# 3) daily Edge restart 04:30 (frees memory, picks up a new app build)
Register-Task 'Daily Edge restart' (New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wd`" -RestartEdge" -WorkingDirectory $InstallDir) (New-ScheduledTaskTrigger -Daily -At '04:30') $userPrincipal 'Restart Edge daily'
# 4) weekly reboot Sunday 05:00
Register-Task 'Weekly reboot' (New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\shutdown.exe" -Argument '/r /t 60 /c "BSB kiosk weekly reboot"') (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '05:00') $sysPrincipal 'Weekly reboot'
# 5) optional: monitor off at night (touch / mouse wakes it; or use BIOS RTC wake + shutdown instead)
if ($DisplayOffAt) {
  Register-Task 'Display off' (New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wd`" -DisplayOff" -WorkingDirectory $InstallDir) (New-ScheduledTaskTrigger -Daily -At $DisplayOffAt) $userPrincipal 'Turn the display off after mall hours'
}

# ---------------------------------------------------------------- autologon (optional)
if ($AutologonExe) {
  if (Test-Path $AutologonExe) {
    $pw = Read-Host -AsSecureString "Password for local user '$KioskUser' (stored LSA-encrypted by Autologon)"
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
    & $AutologonExe $KioskUser $env:COMPUTERNAME $plain /accepteula | Out-Null
    $plain = $null
    Step "Autologon configured for $KioskUser"
  } else { Write-Warning "Autologon exe not found: $AutologonExe" }
}

Write-Host ''
Write-Host 'Setup complete.' -ForegroundColor Green
Write-Host "  Launch URL : $BaseUrl/?kiosk=$KioskId&key=****"
Write-Host "  Config     : $InstallDir\kiosk.conf"
Write-Host "  Log        : $InstallDir\watchdog.log"
Write-Host 'Manual checks (see kiosk\README-kiosk.txt): BIOS "Restore on AC power loss = On", Settings > Touch gestures off,'
Write-Host 'Focus Assist = Alarms only, remote support (MeshCentral/AnyDesk), sign out and log in as the kiosk user to test.'
