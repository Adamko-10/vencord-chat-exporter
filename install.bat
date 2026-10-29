@echo off
setlocal EnableExtensions
title Install ChatExporter into Vencord
cd /d "%~dp0"

echo ==============================================================
echo   ChatExporter installer
echo   Puts the plugin into Vencord, builds Vencord and installs it
echo   into Discord. It asks you a few questions as it goes.
echo ==============================================================
echo.

rem tools installed a moment ago aren't on this window's PATH yet: look where they normally go
set "PATH=%PATH%;%ProgramFiles%\Git\cmd;%ProgramFiles%\nodejs;%APPDATA%\npm;%LOCALAPPDATA%\pnpm"

rem ---------- 1. the tools Vencord needs ----------
echo [1/6] Checking for Git, Node.js and pnpm...
where git >nul 2>nul
if not errorlevel 1 goto have_git
echo.
echo Git is not installed (Vencord is downloaded and updated with it).
call :winget_install Git.Git "Git"
where git >nul 2>nul
if errorlevel 1 goto no_git
:have_git
where node >nul 2>nul
if not errorlevel 1 goto have_node
echo.
echo Node.js is not installed (Vencord is built with it).
call :winget_install OpenJS.NodeJS.LTS "Node.js"
where node >nul 2>nul
if errorlevel 1 goto no_node
:have_node
where pnpm >nul 2>nul
if not errorlevel 1 goto have_pnpm
echo.
echo pnpm is not installed. Installing it with:  npm i -g pnpm
call npm i -g pnpm
where pnpm >nul 2>nul
if errorlevel 1 goto no_pnpm
:have_pnpm
echo       Git, Node.js and pnpm are there.

rem ---------- 2. where the plugin files are ----------
set "SRC="
if exist "%~dp0index.tsx" set "SRC=%~dp0"
if not defined SRC if exist "%~dp0chatExporter\index.tsx" set "SRC=%~dp0chatExporter\"
if not defined SRC if exist "%~dp0plugins\chatExporter\index.tsx" set "SRC=%~dp0plugins\chatExporter\"
if defined SRC goto have_src
echo.
echo The plugin files aren't next to this installer, downloading them from GitHub...
set "SRC=%TEMP%\vencord-chat-exporter"
if exist "%SRC%\" rmdir /s /q "%SRC%"
git clone --depth 1 https://github.com/Adamko-10/vencord-chat-exporter.git "%SRC%"
if errorlevel 1 goto failed
set "SRC=%SRC%\"
:have_src

rem ---------- 3. find Vencord ----------
echo.
set "VENCORD=%USERPROFILE%\Vencord"
echo [2/6] Where should ChatExporter be installed? (your Vencord source folder)
echo       Press Enter to use: %VENCORD%
echo       Or paste another path - you can drag the folder into this window.
set "ANSWER="
set /p "ANSWER=> "
if defined ANSWER set "VENCORD=%ANSWER:"=%"
if exist "%VENCORD%\package.json" goto have_vencord

echo.
echo No Vencord source found in "%VENCORD%".
echo (The normal Vencord installer doesn't include the source; custom plugins need it.)
choice /c YN /m "Download Vencord's source into that folder now"
if errorlevel 2 goto cancelled
git clone https://github.com/Vendicated/Vencord.git "%VENCORD%"
if errorlevel 1 goto failed
goto copy_step

rem ---------- 4. update Vencord ----------
:have_vencord
echo.
echo [3/6] Update Vencord?
echo       Y is best when Discord updated and Vencord or a plugin stopped working.
choice /c YN /m "Update Vencord to the newest version"
if errorlevel 2 goto copy_step
git -C "%VENCORD%" pull
if not errorlevel 1 goto copy_step
echo.
echo The update failed. Usually that means some of Vencord's own files were edited.
choice /c YN /m "Put those edits aside with git stash - can be undone - and try again"
if errorlevel 2 goto copy_step
git -C "%VENCORD%" stash
git -C "%VENCORD%" pull
if errorlevel 1 echo Update still failed - continuing with the version you have.

rem ---------- 5. copy the plugin ----------
:copy_step
echo.
echo [4/6] Copying ChatExporter into Vencord...
set "DEST=%VENCORD%\src\userplugins\chatExporter"
if not exist "%DEST%\" mkdir "%DEST%"
copy /y "%SRC%*.ts" "%DEST%\" >nul
if errorlevel 1 goto failed
copy /y "%SRC%*.tsx" "%DEST%\" >nul
if errorlevel 1 goto failed
echo       Copied to %DEST%

rem ---------- 6. build ----------
echo.
echo [5/6] Building Vencord - takes about a minute...
pushd "%VENCORD%"
call pnpm install
if errorlevel 1 goto failed_popd
call pnpm build
if errorlevel 1 goto failed_popd

rem ---------- 7. inject ----------
echo.
echo [6/6] Putting Vencord into Discord - answer the questions below
echo       (pick the Discord you use, normally the first one).
call pnpm inject
popd
echo.
echo ==============================================================
echo   Done!
echo   Fully quit Discord (tray icon - Quit) and open it again.
echo   Then: right-click any chat - Export Chat,
echo         right-click a server icon - Export All Channels,
echo         or type /exportchat in a chat.
echo   Settings: Settings - Vencord - Plugins - ChatExporter
echo   (it's switched on by itself; if not, switch it on there).
echo ==============================================================
pause
exit /b 0

rem ---------- helper: install a tool with winget ----------
:winget_install
where winget >nul 2>nul
if errorlevel 1 exit /b 1
choice /c YN /m "Install %~2 now with winget"
if errorlevel 2 exit /b 1
winget install -e --id %~1 --accept-source-agreements --accept-package-agreements
exit /b 0

rem ---------- errors ----------
:no_git
echo.
echo Git is still missing. Get it from https://git-scm.com/download/win
echo (or close this window and run the installer again if you just installed it).
goto end_pause
:no_node
echo.
echo Node.js is still missing. Get the LTS version from https://nodejs.org
echo (or close this window and run the installer again if you just installed it).
goto end_pause
:no_pnpm
echo.
echo pnpm couldn't be installed. Open a new window and run:  npm i -g pnpm
echo then run this installer again.
goto end_pause
:failed_popd
popd
:failed
echo.
echo Something FAILED - see the text above.
goto end_pause
:cancelled
echo Cancelled - nothing was changed.
:end_pause
echo.
pause
exit /b 1
