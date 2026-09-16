@echo off
setlocal EnableExtensions
title Postman Bridge - Doctor (kiem tra toan bo)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [LOI] May chua cai Node.js! Tai: https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [LOI] Chua co file .env - copy ".env.example" thanh ".env" truoc.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [..] Dang tai thu vien...
  call npm install --no-audit --no-fund
)

echo [..] Dang kiem tra toan bo he thong...
call npm run doctor

echo.
echo Neu co loi, anh chup man hinh duoc luu o thu muc .runtime\ de xem loi.
pause
endlocal
