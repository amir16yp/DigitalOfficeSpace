@echo off
setlocal
cd /d "%~dp0"

where cargo >nul 2>&1 || (
  echo cargo is not on PATH.
  exit /b 1
)
where npm >nul 2>&1 || (
  echo npm is not on PATH.
  exit /b 1
)

if not exist "client\node_modules\" (
  echo Installing client dependencies...
  call npm install --prefix client
  if errorlevel 1 exit /b 1
)

echo Starting the office server. Its log stays in the office-server window.
start "office-server" cmd /k cargo run --manifest-path server\Cargo.toml

echo Waiting for http://127.0.0.1:8080 ...
powershell -NoProfile -Command "for($i=0;$i -lt 180;$i++){ try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',8080); $c.Close(); exit 0 } catch { Start-Sleep -Seconds 1 } }; exit 1"
if errorlevel 1 (
  echo The office server never accepted connections. Read the office-server window.
  exit /b 1
)

echo Server is up. Starting Vite.
call npm run dev --prefix client
set CODE=%ERRORLEVEL%

taskkill /FI "WINDOWTITLE eq office-server*" /T /F >nul 2>&1
exit /b %CODE%
