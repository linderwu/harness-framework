@echo off
setlocal

rem Usage:
rem   START-POKEMON-CENTER-SERVER.cmd          start missing services
rem   START-POKEMON-CENTER-SERVER.cmd restart  restart local services

rem Codex Desktop MCP singleton/session cleanup is wired through:
rem %USERPROFILE%\.codex\config.toml -> mcp-single-instance-launcher.mjs
if not exist "%~dp0repos\jormungand\scripts\mcp-single-instance-launcher.mjs" (
  echo Missing MCP singleton launcher.
  pause
  exit /b 1
)

set "SERVER_ARGS="
if /I "%~1"=="restart" set "SERVER_ARGS=-Restart"
if /I "%~1"=="restart-local" set "SERVER_ARGS=-Restart -SkipPublicVerification"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0repos\jormungand\scripts\start-pokemon-center-server.ps1" %SERVER_ARGS%

if errorlevel 1 (
  echo.
  echo Pokemon Center Server failed to start.
  pause
)

endlocal
