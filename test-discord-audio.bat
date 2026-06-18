@echo off
REM ============================================================
REM   Verifie EN DIRECT que le son de Discord arrive bien.
REM   Une barre de niveau bouge quand un ami parle.
REM   Laissez DEVICE sur "auto", ou mettez le numero trouve par
REM   find-discord-device.bat (ex: set "DEVICE=6").
REM   Fermez la fenetre (ou Ctrl+C) pour arreter.
REM ============================================================
set "DEVICE=auto"

cd /d "%~dp0"
where python >nul 2>nul || (echo [X] Python introuvable : https://python.org && pause && exit /b)
python relay-discord.py --monitor --device "%DEVICE%"
echo.
pause
