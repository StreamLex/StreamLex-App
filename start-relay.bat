@echo off
REM ============================================================
REM   RELAY - lanceur tout-en-un
REM   Double-cliquez ce fichier pour tout demarrer.
REM ============================================================

REM (1) Votre cle API Anthropic n'est PLUS ici : elle se trouve dans le fichier
REM     "relay.env" (a cote de ce .bat). Ouvrez relay.env avec le Bloc-notes pour
REM     la coller/changer. Le pont la charge automatiquement.

REM (2) Discord (optionnel). Laissez DISCORD_DEVICE vide ("") pour ne PAS l'utiliser.
REM     "auto" detecte le peripherique tout seul. Si ce n'est pas le bon,
REM     double-cliquez find-discord-device.bat pour trouver le numero exact,
REM     puis mettez-le ici (ex: set "DISCORD_DEVICE=6").
set "DISCORD_DEVICE=auto"
set "DISCORD_LANG=fr"
set "DISCORD_TO=English"
set "DISCORD_LABEL=Discord"

REM ------------------------------------------------------------
cd /d "%~dp0"

where node >nul 2>nul || (echo [X] Node.js introuvable. Installez-le ici : https://nodejs.org && pause && exit /b)

if not exist "relay.env" (
  echo [!] Fichier relay.env introuvable : les sous-titres ne seront PAS traduits.
  echo     Copiez relay.env.example en relay.env et collez-y votre cle Anthropic.
  echo.
)

echo Demarrage du pont Relay...
start "Relay bridge" cmd /k node relay-bridge.js

timeout /t 2 /nobreak >nul

echo Ouverture de la fenetre de controle dans le navigateur...
start "" chrome "http://localhost:4455/control"

if not "%DISCORD_DEVICE%"=="" (
  where python >nul 2>nul
  if errorlevel 1 (
    echo [!] Python introuvable : partie Discord ignoree.
  ) else (
    echo Demarrage de la transcription Discord...
    start "Relay Discord" cmd /k python relay-discord.py --device "%DISCORD_DEVICE%" --lang %DISCORD_LANG% --to %DISCORD_TO% --label "%DISCORD_LABEL%"
  )
)

echo.
echo ============================================================
echo  Relay est lance.
echo  Dans OBS / Streamlabs, ajoutez une Source Navigateur :
echo      http://localhost:4455/overlay
echo  Pour tout arreter : fermez les fenetres ouvertes.
echo ============================================================
echo.
pause
