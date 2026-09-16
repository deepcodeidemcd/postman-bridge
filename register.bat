@echo off
echo ========================================
echo  Postman Enterprise Auto Registration
echo ========================================
echo.
echo Prerequisites:
echo   1. nodriver (pip install nodriver)
echo   2. Chrome browser installed
echo.
echo Flow:
echo   1. Create Postman account
echo   2. Verify email (manual)
echo   3. Login
echo   4. Upgrade to Enterprise Trial
echo.

set /p NUM="Enter number of accounts to register (default 1): "
if "%NUM%"=="" set NUM=1

echo.
echo Registering %NUM% account(s)...
echo.

python postman_enterprise_register.py %NUM%

echo.
pause
