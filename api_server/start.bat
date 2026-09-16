@echo off
echo Starting Postman Enterprise API Service...
echo Dashboard: http://localhost:8000/api/dashboard
echo API Docs:  http://localhost:8000/docs
echo.
cd /d "%~dp0"
python start.py
pause
