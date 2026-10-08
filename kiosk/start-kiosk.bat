@echo off
REM ============================================================
REM  BSB Directory - kiosk launcher (Windows, Microsoft Edge)
REM  Settings come from kiosk.conf next to this file (written by setup-kiosk.ps1):
REM     KIOSK_ID=gf-pentacity
REM     KIOSK_KEY=<token from CMS > Kiosk > Provisioning>
REM     BASE_URL=https://directory.example.com/bsb-directory
REM  Without kiosk.conf the defaults below are used (development: localhost).
REM  Autostart / watchdog: run kiosk\setup-kiosk.ps1 once as Administrator (see README-kiosk.txt).
REM ============================================================
setlocal
set "KIOSK_ID=gf-pentacity"
set "KIOSK_KEY="
set "BASE_URL=http://localhost/bsb-directory"

if exist "%~dp0kiosk.conf" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~dp0kiosk.conf") do set "%%A=%%B"
)

set "APP_URL=%BASE_URL%/?kiosk=%KIOSK_ID%"
if not "%KIOSK_KEY%"=="" set "APP_URL=%BASE_URL%/?kiosk=%KIOSK_ID%&key=%KIOSK_KEY%"

REM Persistent profile: keeps the Service Worker cache, the localStorage snapshot and the telemetry queue.
REM Never use --edge-kiosk-type=public-browsing (InPrivate: everything is wiped on every start).
set "PROFILE_DIR=%LOCALAPPDATA%\BSBKiosk\EdgeProfile"

set EDGE="%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist %EDGE% set EDGE="%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

REM Close a previous kiosk Edge (if any)
taskkill /im msedge.exe /f >nul 2>&1
timeout /t 2 /nobreak >nul

start "" %EDGE% ^
  --kiosk "%APP_URL%" ^
  --edge-kiosk-type=fullscreen ^
  --no-first-run ^
  --no-default-browser-check ^
  --user-data-dir="%PROFILE_DIR%" ^
  --disable-pinch ^
  --overscroll-history-navigation=0 ^
  --disable-features=TouchpadOverscrollHistoryNavigation,Translate,msEdgeTranslate ^
  --disable-translate ^
  --noerrdialogs ^
  --disable-session-crashed-bubble ^
  --disable-infobars ^
  --autoplay-policy=no-user-gesture-required

endlocal
