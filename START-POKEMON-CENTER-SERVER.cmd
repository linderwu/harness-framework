@echo off
setlocal

rem Codex Desktop MCP singleton/session cleanup is wired through:
rem %USERPROFILE%\.codex\config.toml -> mcp-single-instance-launcher.mjs
if not exist "%~dp0repos\jormungand\scripts\mcp-single-instance-launcher.mjs" (
  echo Missing MCP singleton launcher.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0repos\jormungand\scripts\start-pokemon-center-server.ps1"

if errorlevel 1 (
  echo.
  echo Pokemon Center Server failed to start.
  pause
)

endlocal
