@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js 22 LTS from https://nodejs.org/ and try again.
  goto :fail
)
node scripts\check-node.mjs || goto :fail

where pnpm >nul 2>nul
if errorlevel 1 (
  where corepack >nul 2>nul
  if errorlevel 1 (
    echo pnpm is required. Install it with: npm install --global pnpm
    goto :fail
  )
  set "PM=corepack pnpm"
) else (
  set "PM=pnpm"
)

echo Installing or checking dependencies...
call %PM% install --frozen-lockfile || goto :fail
call %PM% run metadata:check || goto :fail
call %PM% start || goto :fail
exit /b 0

:fail
echo.
echo Startup failed. Review the message above, then try again.
pause
exit /b 1
