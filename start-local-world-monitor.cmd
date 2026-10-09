@echo off
setlocal
cd /d "%~dp0"
where git >nul 2>nul
if errorlevel 1 goto needgit
where node >nul 2>nul
if errorlevel 1 goto neednode
where npm >nul 2>nul
if errorlevel 1 goto neednode
if not exist "official\package.json" (
  echo [World Monitor] Downloading official source...
  git submodule update --init --depth 1 official
  if errorlevel 1 goto failed
)
pushd official
if not exist "node_modules\vite\package.json" (
  echo [World Monitor] Installing dependencies for the first run...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    popd
    goto failed
  )
)
echo [World Monitor] Starting local dashboard on http://localhost:3000/
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 6; Start-Process 'http://localhost:3000/'"
call npm run dev -- --host 127.0.0.1
popd
pause
exit /b %errorlevel%
:needgit
echo [ERROR] Git is required. Install Git, or use Open-Official-WorldMonitor.url.
goto failed
:neednode
echo [ERROR] Node.js 22+ and npm are required. Or use Open-Official-WorldMonitor.url.
goto failed
:failed
echo [ERROR] Local launch did not complete. Try the official site shortcut.
pause
exit /b 1
