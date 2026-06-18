@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Relay - Discord bot setup

echo ============================================================
echo   RELAY - Per-person Discord captions: guided setup
echo ============================================================
echo.
echo This walks you through the one-time setup, then starts the bot.
echo You'll do a few clicks in your browser when prompted.
echo.

REM ---- Python check -----------------------------------------------------------
where python >nul 2>nul
if errorlevel 1 (
  echo [X] Python is not installed. Get it from https://python.org  (tick "Add to PATH"),
  echo     then run this file again.
  echo.
  pause
  exit /b
)

REM ---- 1) dependencies --------------------------------------------------------
echo [1/4] Installing bot dependencies (one time, ~1 minute)...
python -m pip install --upgrade --quiet -r requirements.txt
if errorlevel 1 (
  echo [X] Dependency install failed. Check your internet connection and retry.
  pause
  exit /b
)
echo       done.
echo.

REM ---- 2) bot token -----------------------------------------------------------
echo [2/4] Bot token
echo   1. Open https://discord.com/developers/applications  -^>  New Application
echo   2. Left menu "Bot"  -^>  Reset Token  -^>  Copy it
echo   3. On that same page, turn ON  "SERVER MEMBERS INTENT"  and Save
echo.
set "TOKEN="
set /p "TOKEN=Paste the bot token here (or press Enter if it's already in relay.env): "
if not "!TOKEN!"=="" (
  set "DBT=!TOKEN!"
  powershell -NoProfile -Command "$f=Join-Path (Get-Location) 'relay.env'; $t=$env:DBT; $c=@(); if(Test-Path $f){$c=@(Get-Content $f)}; if($c -match '^DISCORD_BOT_TOKEN='){$c=$c -replace '^DISCORD_BOT_TOKEN=.*',('DISCORD_BOT_TOKEN='+$t)}else{$c+=('DISCORD_BOT_TOKEN='+$t)}; [IO.File]::WriteAllLines($f,$c)"
  set "DBT="
  echo       token saved to relay.env
)
echo.

REM ---- 3) invite the bot to the server ---------------------------------------
echo [3/4] Invite the bot to your Discord server
echo   Find your "Application ID" in the Developer Portal -^> General Information.
echo.
set "CLIENTID="
set /p "CLIENTID=Paste your Application ID (or Enter to skip if already invited): "
if not "!CLIENTID!"=="" (
  echo   Opening the invite link in your browser - pick your server and Authorize...
  start "" "https://discord.com/oauth2/authorize?client_id=!CLIENTID!&permissions=1049600&scope=bot"
  echo.
  echo   Press a key here once you've authorized the bot on your server.
  pause >nul
)
echo.

REM ---- 4) pick a channel and go ----------------------------------------------
echo [4/4] Starting up - here are the voice channels the bot can see:
echo.
python relay-discord-bot.py --list-channels
echo.
set "CHAN="
set /p "CHAN=Paste the voice channel ID to caption: "
set "LANG=English"
set /p "LANG=Translate captions INTO which language? [English]: "
echo.
echo Make sure the Relay app / bridge is running so captions reach your overlay.
echo Starting the bot now - press Ctrl+C in this window to stop.
echo ------------------------------------------------------------
python relay-discord-bot.py --channel "!CHAN!" --to "!LANG!"
echo ------------------------------------------------------------
echo Bot stopped.
pause
