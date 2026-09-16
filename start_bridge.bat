@echo off
title postman-openai-bridge
cd /d D:\hoat_hinh\postman-openai-bridge-v0.1.0
:loop
echo [%date% %time%] starting bridge...
node --import tsx src/server.ts >> bridge_run.log 2>&1
echo [%date% %time%] bridge exited, restarting in 3s...
timeout /t 3 /nobreak >nul
goto loop
