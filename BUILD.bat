@echo off
REM ============================================================================
REM  PrintNum - automatic build for Windows 7 x64
REM
REM  What it does:
REM    1. Checks tools (Rust, Node.js)
REM    2. Builds printnum.exe
REM    3. Builds the browser extension
REM    4. Packs everything into PrintNum-win7-x64-v<version>.zip
REM
REM  Run: double-click this file (or run BUILD.bat in cmd)
REM
REM  Requirements (install once):
REM    - Rust              https://rustup.rs/
REM    - MSVC Build Tools  https://visualstudio.microsoft.com/downloads/
REM                        ("Desktop development with C++" workload)
REM    - Node.js 18+       https://nodejs.org/
REM ============================================================================
setlocal EnableDelayedExpansion
REM Кодировка консоли = OEM 866 (кириллица). Нужна, чтобы русский текст,
REM который выводят вызываемые шаги/скрипты, отображался корректно.
chcp 866 >nul
cd /d "%~dp0"

set "ROOT=%CD%"
set "FAIL=0"

echo.
echo ============================================================================
echo   PrintNum - build for Windows 7 x64
echo ============================================================================
echo   Folder: %ROOT%
echo.

REM ============================================================================
REM  STEP 1. Check tools
REM ============================================================================
echo [1/5] Checking tools...
echo.

set "HAS_CARGO=0"
set "HAS_NODE=0"

where cargo >nul 2>&1 && set "HAS_CARGO=1"
where node  >nul 2>&1 && set "HAS_NODE=1"

if "%HAS_CARGO%"=="1" (
    for /f "tokens=*" %%v in ('cargo --version 2^>nul') do set "CARGO_VER=%%v"
    echo   [OK] Rust: !CARGO_VER!
) else (
    echo   [MISSING] Rust not found.
    set "FAIL=1"
)

if "%HAS_NODE%"=="1" (
    for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
    echo   [OK] Node.js: !NODE_VER!
) else (
    echo   [MISSING] Node.js not found.
    set "FAIL=1"
)

if "%FAIL%"=="1" (
    echo.
    echo ----------------------------------------------------------------------------
    echo   CANNOT BUILD: install missing tools first.
    echo ----------------------------------------------------------------------------
    echo.
    echo   Rust:              https://rustup.rs/
    echo   MSVC Build Tools:  https://visualstudio.microsoft.com/downloads/
    echo                      Workload: "Desktop development with C++"
    echo   Node.js 18+:       https://nodejs.org/
    echo.
    echo   After install, run this file again.
    echo.
    pause
    exit /b 1
)

echo.

REM ============================================================================
REM  STEP 2. Rust toolchain + target для Windows 7
REM ============================================================================
echo [2/5] Checking Rust toolchain (nightly + rust-src) и target win7...

REM Таргет x86_64-win7-windows-msvc требует -Z build-std => nightly + rust-src.
REM Это ключ к совместимости с Windows 7: std соберётся с vendor = "win7"
REM и не будет импортировать отсутствующие в Win7 функции (WaitOnAddress).
rustup toolchain list 2>nul | findstr /c:"nightly" >nul
if errorlevel 1 (
    echo   Installing nightly toolchain with rust-src...
    rustup toolchain install nightly --component rust-src
    if errorlevel 1 (
        echo   [ERROR] could not install nightly/rust-src.
        pause
        exit /b 1
    )
)
REM rust-src мог не установиться вместе с уже имеющимся nightly.
rustup component list --toolchain nightly 2>nul | findstr /c:"rust-src (installed)" >nul
if errorlevel 1 (
    echo   Adding rust-src component...
    rustup component add rust-src --toolchain nightly
)
echo   [OK] toolchain ready.
echo.

REM ============================================================================
REM  STEP 3. Build application
REM ============================================================================
echo [3/5] Building printnum.exe (Windows 7 x64)...
echo   (first build takes 10-20 minutes: std is rebuilt for Win7)
echo.
pushd "src-printnum"
cargo build --release --target x86_64-win7-windows-msvc -Z build-std=std,panic_abort
if errorlevel 1 (
    echo.
    echo   [ERROR] Application build failed.
    echo   Make sure MSVC Build Tools is installed
    echo   (workload "Desktop development with C++").
    popd
    pause
    exit /b 1
)
popd

set "EXE=src-printnum\target\x86_64-win7-windows-msvc\release\printnum.exe"
if not exist "%EXE%" (
    echo   [ERROR] not found: %EXE%
    pause
    exit /b 1
)
echo   [OK] printnum.exe built.
echo.

REM ============================================================================
REM  STEP 4. Build extension
REM ============================================================================
echo [4/5] Building browser extension...
pushd "extension"

if not exist "node_modules" (
    echo   Installing dependencies (npm install)...
    call npm install
    if errorlevel 1 (
        echo   [ERROR] npm install failed.
        popd
        pause
        exit /b 1
    )
)

call npm run build
if errorlevel 1 (
    echo   [ERROR] extension build failed.
    popd
    pause
    exit /b 1
)

call npm run zip >nul 2>&1
popd

if not exist "extension\output\chrome-mv3\manifest.json" (
    echo   [ERROR] not found: extension\output\chrome-mv3
    pause
    exit /b 1
)
echo   [OK] extension built.
echo.

REM ============================================================================
REM  STEP 5. Build release archive
REM ============================================================================
echo [5/5] Packing release archive...
echo.

set "VERSION=3.0.0"
REM Version from Cargo.toml: line `version = "3.0.0"` -> take 3rd token.
for /f "tokens=3" %%v in ('findstr /b "version = " src-printnum\Cargo.toml') do (
    set "VERSION=%%~v"
    goto :version_done
)
:version_done

set "PKG=package"
if exist "%PKG%" rmdir /s /q "%PKG%"
mkdir "%PKG%"

copy /y "%EXE%" "%PKG%\printnum.exe" >nul
copy /y "dist-windows\INSTALL-WINDOWS-7.md" "%PKG%\INSTALL-WINDOWS-7.md" >nul
copy /y "README.md" "%PKG%\PROJECT-README.md" >nul

REM native-host
mkdir "%PKG%\native-host"
copy /y "src-printnum\native-host\install-native-host.bat" "%PKG%\native-host\" >nul
copy /y "src-printnum\native-host\ru.printnum.host.json" "%PKG%\native-host\" >nul

REM docs
mkdir "%PKG%\docs"
copy /y "docs\native-messaging.md" "%PKG%\docs\" >nul
copy /y "docs\emulation-testing.md" "%PKG%\docs\" >nul
copy /y "docs\first-run.md" "%PKG%\docs\" >nul

REM extension (unpacked + zip)
mkdir "%PKG%\extension"
mkdir "%PKG%\extension\chromium"
xcopy /e /i /q /y "extension\output\chrome-mv3\*" "%PKG%\extension\chromium\" >nul
for %%f in ("extension\output\*.zip") do copy /y "%%f" "%PKG%\extension\printnum-chrome.zip" >nul

REM readme (ASCII only)
> "%PKG%\READ-ME-FIRST.txt" echo PrintNum for Windows 7 x64
>>"%PKG%\READ-ME-FIRST.txt" echo ============================
>>"%PKG%\READ-ME-FIRST.txt" echo.
>>"%PKG%\READ-ME-FIRST.txt" echo 1. Read INSTALL-WINDOWS-7.md (guide).
>>"%PKG%\READ-ME-FIRST.txt" echo 2. Put printnum.exe into C:\PrintNum\ and run it.
>>"%PKG%\READ-ME-FIRST.txt" echo 3. Install the extension from extension\chromium\
>>"%PKG%\READ-ME-FIRST.txt" echo    (chrome://extensions - Developer mode -
>>"%PKG%\READ-ME-FIRST.txt" echo     Load unpacked).
>>"%PKG%\READ-ME-FIRST.txt" echo 4. Reload Ozon pages (F5).
>>"%PKG%\READ-ME-FIRST.txt" echo.
>>"%PKG%\READ-ME-FIRST.txt" echo Requirements: Windows 7 SP1 x64, printer, browser.
>>"%PKG%\READ-ME-FIRST.txt" echo Python, Node.js, WebView2 are NOT needed.

set "ARCHIVE=%ROOT%\PrintNum-win7-x64-v%VERSION%.zip"
if exist "%ARCHIVE%" del /q "%ARCHIVE%"

powershell -NoProfile -Command "Compress-Archive -Path '%PKG%\*' -DestinationPath '%ARCHIVE%' -Force"
if errorlevel 1 (
    echo   [ERROR] could not create ZIP. Is PowerShell available?
    pause
    exit /b 1
)

rmdir /s /q "%PKG%"

echo.
echo ============================================================================
echo   DONE!
echo ============================================================================
echo.
echo   Archive: %ARCHIVE%
echo.
echo   Contents:
echo     printnum.exe                    application
echo     extension\chromium\             extension (unpacked)
echo     extension\printnum-chrome.zip    extension (zip)
echo     native-host\                    native messaging (optional)
echo     docs\                           documentation
echo     INSTALL-WINDOWS-7.md            user guide
echo     READ-ME-FIRST.txt               quick note
echo.
echo   Next: copy the archive to a Windows 7 PC and
echo   follow INSTALL-WINDOWS-7.md
echo ============================================================================
echo.
pause
endlocal