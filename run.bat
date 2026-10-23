@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0scripts\launch.mjs"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo This source checkout has no bundled Node runtime.
    echo Obtain the Windows release folder, or install Node.js 22.16 or newer.
    pause
    exit /b 1
  )
  node "%~dp0scripts\launch.mjs"
)
if errorlevel 1 pause
