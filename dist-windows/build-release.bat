@echo off
REM ============================================================================
REM Сборка релизного архива PrintNum для Windows.
REM
REM Запускать НА WINDOWS с установленными:
REM   - Rust (rustup) + MSVC Build Tools (Desktop development with C++)
REM   - Node.js 18+ (для сборки расширения)
REM
REM Результат: ..\PrintNum-win7-x64-v<версия>.zip
REM ============================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ============================================================
echo  Сборка PrintNum для Windows
echo ============================================================
echo.

REM ---------- Проверка инструментов ----------
where cargo >nul 2>&1 || (echo ОШИБКА: не найден cargo. Установите Rust. & exit /b 1)
where node  >nul 2>&1 || (echo ОШИБКА: не найден node. Установите Node.js 18+. & exit /b 1)

for /f "tokens=*" %%v in ('cargo pkgid 2^>nul') do set "PKGID=%%v"
pushd "..\src-printnum"
for /f "tokens=2 delims=#" %%v in ('cargo pkgid') do set "VERSION=%%v"
popd
if "%VERSION%"=="" set "VERSION=3.0.0"
echo Версия: %VERSION%
echo.

REM ---------- 1. Приложение ----------
echo [1/4] Сборка приложения printnum.exe...
pushd "..\src-printnum"
cargo build --release --target x86_64-pc-windows-msvc
if errorlevel 1 (echo ОШИБКА сборки приложения. & popd & exit /b 1)
popd

set "EXE=..\src-printnum\target\x86_64-pc-windows-msvc\release\printnum.exe"
if not exist "%EXE%" (echo ОШИБКА: не найден %EXE% & exit /b 1)
echo   [OK] printnum.exe
echo.

REM ---------- 2. Расширение ----------
echo [2/4] Сборка расширения...
pushd "..\extension"
if not exist "node_modules" (
    echo   Установка зависимостей расширения...
    call npm install || (echo ОШИБКА npm install & popd & exit /b 1)
)
call npm run build || (echo ОШИБКА сборки расширения & popd & exit /b 1)
popd

if not exist "..\extension\output\chrome-mv3" (
    echo ОШИБКА: не найдена папка ..\extension\output\chrome-mv3
    exit /b 1
)
echo   [OK] расширение собрано
echo.

REM ---------- 3. Компоновка архива ----------
echo [3/4] Компоновка файлов...
if exist "package" rmdir /s /q "package"
mkdir "package"

copy /y "%EXE%" "package\printnum.exe" >nul
copy /y "INSTALL-WINDOWS-7.md" "package\INSTALL-WINDOWS-7.md" >nul
copy /y "..\README.md" "package\README.md" >nul

REM READ-ME-FIRST
> "package\READ-ME-FIRST.txt" echo PrintNum for Windows 7 x64
>>"package\READ-ME-FIRST.txt" echo ============================
>>"package\READ-ME-FIRST.txt" echo.
>>"package\READ-ME-FIRST.txt" echo 1. Prochti INSTALL-WINDOWS-7.md (instrukciya).
>>"package\READ-ME-FIRST.txt" echo 2. Zapusti printnum.exe i razmeshchay ego v C:\PrintNum\
>>"package\READ-ME-FIRST.txt" echo 3. Ustanovi rasshirenie iz extension\chromium\
>>"package\READ-ME-FIRST.txt" echo    (chrome://extensions - Rezhim razrabotchika -
>>"package\READ-ME-FIRST.txt" echo     Zagruzit raspakovannoe).
>>"package\READ-ME-FIRST.txt" echo 4. Perezagruzi stranicy Ozon (F5).
>>"package\READ-ME-FIRST.txt" echo.
>>"package\READ-ME-FIRST.txt" echo Podrobnee: INSTALL-WINDOWS-7.md i papka docs

REM документация в отдельной папке
mkdir "package\docs"
copy /y "..\docs\native-messaging.md" "package\docs\" >nul
copy /y "..\docs\emulation-testing.md" "package\docs\" >nul
copy /y "..\docs\first-run.md" "package\docs\" >nul

REM native-host
mkdir "package\native-host"
copy /y "..\src-printnum\native-host\install-native-host.bat" "package\native-host\" >nul
copy /y "..\src-printnum\native-host\ru.printnum.host.json" "package\native-host\" >nul

REM расширение (распакованное + zip)
mkdir "package\extension"
mkdir "package\extension\chromium"
xcopy /e /i /q /y "..\extension\output\chrome-mv3\*" "package\extension\chromium\" >nul
pushd "..\extension"
call npm run zip >nul 2>&1
popd
for %%f in ("..\extension\output\*.zip") do copy /y "%%f" "package\extension\printnum-chrome.zip" >nul

echo   [OK] файлы собраны
echo.

REM ---------- 4. ZIP ----------
echo [4/4] Упаковка в ZIP...
set "ARCHIVE=..\PrintNum-win7-x64-v%VERSION%.zip"
if exist "%ARCHIVE%" del /q "%ARCHIVE%"

REM PowerShell для создания zip (доступен на Win7 с .NET)
powershell -NoProfile -Command "Compress-Archive -Path 'package\*' -DestinationPath '%ARCHIVE%' -Force"
if errorlevel 1 (
    echo ОШИБКА упаковки. Убедитесь, что доступен PowerShell.
    exit /b 1
)

rmdir /s /q "package"

echo.
echo ============================================================
echo  ГОТОВО
echo ============================================================
echo  Архив: %ARCHIVE%
echo.
echo  Что внутри:
echo    printnum.exe                     приложение
echo    extension\chromium\              расширение (распакованное)
echo    extension\printnum-chrome.zip    расширение (zip)
echo    native-host\                     native messaging (опционально)
echo    INSTALL-WINDOWS-7.md                  инструкция
echo ============================================================
endlocal
