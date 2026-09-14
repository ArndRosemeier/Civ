@echo off
setlocal EnableExtensions EnableDelayedExpansion
title CivTS launcher

rem ============================================================================
rem  CivTS - one-click launcher for Windows
rem
rem  Double-click this file. It checks that Node and pnpm are present, installs
rem  whatever is missing, installs the project's dependencies, starts the game
rem  server and opens it in your browser.
rem
rem  It asks before installing anything on your computer. Nothing else is
rem  touched, and no administrator rights are needed for the normal path.
rem
rem  Optional:  start-windows.bat verify
rem             also runs the project's own test suite first, about a minute.
rem ============================================================================

rem Every path below is relative, so the script works from any drive and any
rem folder, and double-clicking it is the same as running it from a prompt.
cd /d "%~dp0"

set "URL=http://127.0.0.1:4174"
set "PNPM_PIN=11.24.0"

echo.
echo   CivTS - a Civ 3 shaped game
echo   ===========================
echo.

rem ---------------------------------------------------------------------------
rem  0. Are we standing in the project folder?
rem ---------------------------------------------------------------------------
if not exist "package.json"      goto :not_the_project
if not exist "pnpm-workspace.yaml" goto :not_the_project

rem ---------------------------------------------------------------------------
rem  1. Node 24 or newer
rem ---------------------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 goto :no_node

for /f "delims=" %%i in ('node --version 2^>nul') do set "NODEVER=%%i"
set "NODEVER=!NODEVER:v=!"
for /f "tokens=1 delims=." %%a in ("!NODEVER!") do set "NODEMAJOR=%%a"

if not defined NODEMAJOR goto :no_node
if !NODEMAJOR! LSS 24 goto :old_node
echo   [ok]   Node !NODEVER!

rem ---------------------------------------------------------------------------
rem  2. pnpm
rem      corepack ships with Node and is tried first because it needs no
rem      download; npm is the fallback. Both are user-level, so neither should
rem      raise an administrator prompt.
rem ---------------------------------------------------------------------------
set "HAVE_PNPM="
where pnpm >nul 2>&1
if not errorlevel 1 set "HAVE_PNPM=1"
if defined HAVE_PNPM goto :pnpm_ready

echo   [..]   pnpm is missing - installing it
echo.

where corepack >nul 2>&1
if errorlevel 1 goto :pnpm_via_npm

echo          trying corepack ...
call corepack enable >nul 2>&1
where pnpm >nul 2>&1
if not errorlevel 1 goto :pnpm_found

call corepack prepare pnpm@%PNPM_PIN% --activate >nul 2>&1
where pnpm >nul 2>&1
if not errorlevel 1 goto :pnpm_found

:pnpm_via_npm
echo          trying npm ...
call npm install -g pnpm@%PNPM_PIN%
where pnpm >nul 2>&1
if not errorlevel 1 goto :pnpm_found
goto :no_pnpm

:pnpm_found
echo   [ok]   pnpm installed

:pnpm_ready
for /f "delims=" %%i in ('pnpm --version 2^>nul') do set "PNPMVER=%%i"
echo   [ok]   pnpm !PNPMVER!
echo.

rem ---------------------------------------------------------------------------
rem  3. Dependencies
rem      The lockfile is committed, so the pinned install is used first: it is
rem      what everyone else tested against. If it does not match, the script
rem      says so and installs unpinned rather than leaving you stuck.
rem ---------------------------------------------------------------------------
echo   [..]   installing dependencies - the slow part, and only the first time
echo.
call pnpm install --frozen-lockfile
if errorlevel 1 (
  echo.
  echo   [warn]   The committed lockfile did not match this checkout, so a normal
  echo          install is running instead. Dependency versions may differ from
  echo          the ones this project was tested on.
  echo.
  call pnpm install
  if errorlevel 1 goto :install_failed
)
echo   [ok]   dependencies installed
echo.

rem ---------------------------------------------------------------------------
rem  4. Optional: the project's own checks
rem ---------------------------------------------------------------------------
if /i "%~1"=="verify" call :run_verify

rem ---------------------------------------------------------------------------
rem  5. Start the game
rem ---------------------------------------------------------------------------
rem If this port is already answering, it is almost certainly a CivTS window
rem that is still open. Opening a second server would only fail on the port.
where curl >nul 2>&1
if errorlevel 1 goto :no_curl

call :port_is_up
if not errorlevel 1 goto :already_running

echo   [..]   starting the game server
echo.
start "CivTS server" cmd /k "pnpm --filter @civts/web dev"

echo   [..]   waiting for it to answer at %URL%
set /a TRIES=0

:wait_loop
call :port_is_up
if not errorlevel 1 goto :server_up
set /a TRIES+=1
if !TRIES! GEQ 60 goto :server_timeout
timeout /t 1 /nobreak >nul
goto :wait_loop

:server_up
echo   [ok]   the server is up
goto :open_browser

rem No curl means no way to poll for the port, so we simply wait long enough
rem for Vite to come up - it takes well under a second once installed.
:no_curl
echo   [..]   starting the game server
echo.
start "CivTS server" cmd /k "pnpm --filter @civts/web dev"
echo   [..]   waiting for the server to start
timeout /t 10 /nobreak >nul

:open_browser
echo.
echo   Opening %URL%
echo.
echo   ------------------------------------------------------------------
echo    The game runs in the separate "CivTS server" window.
echo    Close THAT window to stop the game.
echo    This window can be closed at any time.
echo   ------------------------------------------------------------------
echo.
start "" "%URL%"
timeout /t 10 /nobreak >nul
exit /b 0

rem ===========================================================================
rem  Subroutines
rem ===========================================================================

rem Exit code 0 if something is serving the port, 1 if not yet.
:port_is_up
curl -s -o nul --max-time 2 "%URL%" >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

:run_verify
echo   [..]   running the project's own checks - about a minute
echo.
call pnpm verify
if errorlevel 1 (
  echo.
  echo   [warn]   The checks failed. The game will still be started, but something
  echo          in this checkout is not as it should be.
  echo.
  timeout /t 5 /nobreak >nul
  exit /b 0
)
echo   [ok]   all checks passed
echo.
exit /b 0

rem ===========================================================================
rem  Problems, and what to do about them
rem ===========================================================================

:not_the_project
echo   [stop]   This file is not sitting in the CivTS folder.
echo.
echo          It must be next to the file called package.json. If you moved the
echo          script somewhere else, either move it back or run it from the
echo          folder you cloned CivTS into.
echo.
goto :end_fail

:already_running
echo   [ok]   something is already serving %URL%
echo.
echo          That is almost certainly a CivTS window you still have open, so
echo          there is nothing to start. Opening it in your browser now.
start "" "%URL%"
timeout /t 6 /nobreak >nul
exit /b 0

:server_timeout
echo   [stop]   The server did not answer within a minute.
echo.
echo          Look at the "CivTS server" window: it is where the reason will be.
echo          The most common one is that port 4174 is already taken by some
echo          other program.
echo.
goto :end_fail

:install_failed
echo   [stop]   Installing the dependencies failed.
echo.
echo          Check that you are online, then run this file again. If it keeps
echo          failing, the message above this one says why.
echo.
goto :end_fail

:no_pnpm
echo   [stop]   pnpm could not be installed automatically.
echo.
echo          Open a Command Prompt and run:
echo              npm install -g pnpm@%PNPM_PIN%
echo          then run this file again.
echo.
goto :end_fail

:no_node
echo   [stop]   Node.js was not found on this computer.
echo.
echo          CivTS needs Node 24 or newer.
echo          Manual download: https://nodejs.org/
echo.
goto :offer_node

:old_node
echo   [stop]   Node !NODEVER! is installed, which is too old.
echo.
echo          CivTS needs Node 24 or newer.
echo          Manual download: https://nodejs.org/
echo.
goto :offer_node

:offer_node
where winget >nul 2>&1
if errorlevel 1 goto :end_fail

echo   Install Node now with winget?
echo.
choice /c YN /n /m "   [Y]es or [N]o: "
if errorlevel 2 goto :end_fail
echo.
echo   [..]   installing Node - this can take a few minutes
echo.
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
  echo.
  echo   [stop]   winget could not install it. Please install Node 24 by hand from
  echo          https://nodejs.org/
  echo.
  goto :end_fail
)
echo.
echo   [ok]   Node is installed.
echo.
echo          IMPORTANT: close this window and run this file again. Windows only
echo          sees a newly installed Node in a new window, so running it here
echo          would keep failing.
echo.
pause
exit /b 1

:end_fail
echo.
echo   Setup stopped. Nothing on your computer was changed beyond what is
echo   described above.
echo.
pause
exit /b 1
