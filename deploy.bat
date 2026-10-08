@echo off
xcopy /Y /Q "%~dp0extension.js" "%USERPROFILE%\.devin\extensions\local.devin-usage-0.1.0\" >nul
xcopy /Y /Q "%~dp0package.json" "%USERPROFILE%\.devin\extensions\local.devin-usage-0.1.0\" >nul
xcopy /Y /Q "%~dp0icon.png" "%USERPROFILE%\.devin\extensions\local.devin-usage-0.1.0\" >nul 2>nul
echo deployed - run "Developer: Restart Extension Host"
