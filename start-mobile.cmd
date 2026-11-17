@echo off
rem Serve this folder on ALL interfaces so a phone on the same Wi-Fi can open it.
rem The normal start.cmd binds to 127.0.0.1 (this PC only), which a phone cannot reach.
cd /d "%~dp0"

rem Grab the current LAN IPv4 (skip loopback / APIPA).
set "IP="
for /f %%i in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0get-ip.ps1"') do set "IP=%%i"
if not defined IP set "IP=YOUR-PC-IP"

echo.
echo  ============================================================
echo   Reel on your phone:   http://%IP%:8000/
echo  ============================================================
echo.
echo  Phone and PC must be on the SAME Wi-Fi.
echo  Windows Firewall may ask to allow Python - click Allow.
echo.
echo  IMPORTANT: a plain http LAN address is an INSECURE context on Android.
echo  Encrypted chat (crypto.subtle) and the service worker are disabled there.
echo  To test everything, either:
echo    1) Android Chrome: chrome://flags/#unsafely-treat-insecure-origin-as-secure
echo       add http://%IP%:8000 and restart Chrome, or
echo    2) use an HTTPS tunnel (cloudflared / ngrok) and open that https URL.
echo.

where py >nul 2>nul && (py -m http.server 8000 --bind 0.0.0.0) || (python -m http.server 8000 --bind 0.0.0.0)
