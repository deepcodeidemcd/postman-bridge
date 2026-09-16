@echo off
setlocal EnableExtensions
title Postman OpenAI Bridge
cd /d "%~dp0"

rem ===== 1. Kiem tra Node.js =====
where node >nul 2>nul
if errorlevel 1 (
  echo [LOI] May chua cai Node.js!
  echo       Tai ve tai https://nodejs.org  (ban 20 tro len).
  echo.
  pause
  exit /b 1
)

rem ===== 2. Kiem tra file .env =====
if not exist ".env" (
  echo [LOI] Chua co file .env!
  echo       Copy ".env.example" thanh ".env" roi dien
  echo       POSTMAN_WORKSPACE_URL = link workspace Postman cua ban.
  echo.
  pause
  exit /b 1
)

rem ===== 3. Doc port tu .env (mac dinh 8787) =====
set "PORT=8787"
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /B /C:"BRIDGE_PORT=" .env 2^>nul`) do set "PORT=%%b"

rem ===== 4. Canh bao neu server dang chay san =====
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }" >nul 2>nul
if errorlevel 1 (
  echo [!] Port %PORT% dang co server chay roi.
  echo     Mo http://127.0.0.1:%PORT%/admin de dung, hoac doi BRIDGE_PORT trong .env.
  echo.
  choice /C YN /M "Van chay them server moi (Y/N)"
  if errorlevel 2 exit /b 0
)

rem ===== 5. Mo Chrome debug (an) neu chua co =====
findstr /B /C:"BROWSER_CDP_URL=" .env >nul 2>nul
if not errorlevel 1 (
  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
  if errorlevel 1 (
    set "CHROME_PATH="
    if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
    if not defined CHROME_PATH if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    if not defined CHROME_PATH if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
    if defined CHROME_PATH (
      findstr /B /C:"BROWSER_CDP_HIDDEN=true" .env >nul 2>nul
      if not errorlevel 1 (
        echo [..] Mo Chrome debug che do an (headless)...
        start "" "%CHROME_PATH%" --headless=new --window-size=1400,900 --remote-debugging-port=9222 --user-data-dir="%~dp0.chrome-cdp-profile" --no-first-run --no-default-browser-check
      ) else (
        echo [..] Mo cua so Chrome debug...
        start "" "%CHROME_PATH%" --remote-debugging-port=9222 --user-data-dir="%~dp0.chrome-cdp-profile" --no-first-run --no-default-browser-check
      )
    )
  )
)

rem ===== 6. Cai dat thu vien lan dau =====
if not exist "node_modules" (
  echo [..] Lan dau chay - dang tai thu vien (1-2 phut)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [LOI] Cai dat that bai. Kiem tra mang roi thu lai.
    echo.
    pause
    exit /b 1
  )
)

echo ==================================================
echo   Postman OpenAI Bridge
echo   UI quan ly   : http://127.0.0.1:%PORT%/admin
echo   API (Cursor) : http://127.0.0.1:%PORT%/v1
echo   API key      : xem o UI - tab He thong
echo.
echo   - Giu cua so nay MO khi dang su dung.
echo   - Bam Ctrl+C roi Y de dung server.
echo   - Neu Chrome debug chua mo, server tu mo sau
echo     vai giay - dang nhap Postman neu duoc hoi.
echo ==================================================
echo.

call npm start

echo.
echo Server da dung.
pause
endlocal
