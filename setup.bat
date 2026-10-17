@echo off
chcp 65001 >nul
cd /d "%~dp0"
call npm ci
if errorlevel 1 goto failed
node src\douyin\main.mjs init
if errorlevel 1 goto failed
echo Dependencies and config are ready. See README.md for Douyin login and DSH preset setup.
pause
exit /b 0
:failed
echo Setup failed. Check the error above.
pause
exit /b 1
