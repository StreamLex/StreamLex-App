@echo off
REM ============================================================
REM   Trouve QUEL peripherique capte le son de Discord.
REM   1) Mettez un ami en train de parler dans Discord (ou jouez un son).
REM   2) Double-cliquez ce fichier et regardez quelle ligne monte.
REM   3) Notez le numero [N] le plus fort -> c'est votre --device.
REM ============================================================
cd /d "%~dp0"
where python >nul 2>nul || (echo [X] Python introuvable : https://python.org && pause && exit /b)
python relay-discord.py --scan
echo.
pause
