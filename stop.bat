@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=8787"
if exist ".env" for /f "usebackq tokens=1,* delims==" %%a in (`findstr /B /C:"BRIDGE_PORT=" .env 2^>nul`) do set "PORT=%%b"

powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force; Write-Host '[OK] Da dung server (port %PORT%, pid' $c.OwningProcess ')' } else { Write-Host '[i] Khong co server nao dang chay o port %PORT%.' }"
pause
endlocal
