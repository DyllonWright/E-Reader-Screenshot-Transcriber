@echo off
title E-Reader Screenshot Transcriber GUI
echo ==========================================================
echo  Starting E-Reader Screenshot Transcriber GUI...
echo ==========================================================
echo.

:: Verify Node.js is available
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: Node.js is not installed or not in your PATH.
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

:: Auto-install dependencies if missing
if not exist "node_modules\express" (
    echo Express package not found. Bootstrapping project dependencies...
    call npm install
    echo.
)

:: Run the local GUI Express Server
node gui/server.js

if %errorlevel% neq 0 (
    echo.
    echo An error occurred during server execution.
    pause
    exit /b 1
)
