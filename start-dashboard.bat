@echo off
title Dashboard Server

echo.
echo ===============================
echo DASHBOARD SERVER BASLATILIYOR
echo ===============================
echo.

cd /d "%~dp0"

echo Python HTTP server baslatiliyor...

start http://127.0.0.1:5500

python -m http.server 5500

pause