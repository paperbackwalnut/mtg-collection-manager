@echo off
set "HOST=0.0.0.0"
set "LAN_ACCESS=1"
call "%~dp0start.bat"
exit /b %errorlevel%
