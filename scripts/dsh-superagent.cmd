@echo off
REM Runs the supervisor with a Python that has psutil, under the name an operator types in cmd.exe or PowerShell.
setlocal
if defined DSH_SUPERAGENT_PYTHON (
  "%DSH_SUPERAGENT_PYTHON%" "%~dp0dsh-superagent.py" %*
  exit /b %errorlevel%
)
where python >nul 2>nul
if errorlevel 1 (
  py -3 "%~dp0dsh-superagent.py" %*
) else (
  python "%~dp0dsh-superagent.py" %*
)
exit /b %errorlevel%
