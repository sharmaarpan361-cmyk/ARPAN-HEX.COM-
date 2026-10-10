@echo off
cd /d "%~dp0"
if not exist hex.db (
  echo FIRST TIME SETUP
  set /p ADMIN_EMAIL=Type your email and press Enter: 
  set /p ADMIN_PASSWORD=Type a new password, 12 or more letters/numbers, no spaces, and press Enter: 
)
echo.
echo Starting ARPAN HEX IND. Keep this window open. Open http://localhost:3000 in your browser.
node server.js
pause
