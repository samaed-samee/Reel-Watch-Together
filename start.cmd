@echo off
rem Serves this folder on http://localhost:8000 and opens it.
rem Opening index.html directly (file://) breaks YouTube with "error 153".
rem --bind 127.0.0.1 keeps the server off the local network.
cd /d "%~dp0"
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 900; Start-Process 'http://localhost:8000/'"
where py >nul 2>nul && (py -m http.server 8000 --bind 127.0.0.1) || (python -m http.server 8000 --bind 127.0.0.1)
