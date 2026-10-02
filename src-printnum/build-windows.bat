@echo off
REM ============================================================================
REM  Сборка PrintNum под Windows 7 SP1 x64.
REM
REM  Боевой таргет: x86_64-win7-windows-msvc
REM    - std собирается с vendor = "win7" (через -Z build-std), поэтому не
REM      импортирует отсутствующие в Win7 функции WaitOnAddress/WakeByAddress;
REM    - +crt-static встраивает CRT (не нужны ни MSVC Redistributable, ни UCRT);
REM    - Slint =1.13.0 (см. Cargo.toml) убирает SystemParametersInfoForDpi.
REM
REM  Требуется: Rust + MSVC Build Tools ("Desktop development with C++").
REM  Node.js и Python НЕ нужны.
REM ============================================================================
setlocal

REM Кодировка консоли = OEM 866 (кириллица). Сам .bat-файл сохранён в CP866,
REM поэтому кириллица в echo отображается корректно и на Windows 7,
REM и на Windows 10/11. chcp гарантирует нужную кодовую страницу.
chcp 866 >nul

cd /d "%~dp0"

set "TARGET=x86_64-win7-windows-msvc"
set "EXE=target\%TARGET%\release\printnum.exe"

echo [1/4] Проверка toolchain (nightly + rust-src)...
rustup toolchain list 2>nul | findstr /c:"nightly" >nul
if errorlevel 1 (
    echo   Установка nightly с компонентом rust-src...
    rustup toolchain install nightly --component rust-src
    if errorlevel 1 (
        echo   [ERROR] Не удалось установить nightly/rust-src.
        exit /b 1
    )
)
echo   [OK] toolchain готов.
echo.

echo [2/4] Сборка release под Windows 7 (%TARGET%)...
echo   Первая сборка занимает 10-20 минут (пересборка std).
echo.
cargo build --release --target %TARGET% -Z build-std=std,panic_abort
if errorlevel 1 (
    echo.
    echo   [ERROR] Ошибка сборки.
    echo   Убедитесь, что установлены MSVC Build Tools
    echo   ^(workload "Desktop development with C++"^).
    exit /b 1
)
echo   [OK] printnum.exe собран.
echo.

echo [3/4] Проверка совместимости с Windows 7...
if not exist "%EXE%" (
    echo   [ERROR] не найден: %EXE%
    exit /b 1
)
where dumpbin >nul 2>&1
if errorlevel 1 (
    echo   [SKIP] dumpbin недоступен.
    echo          Запустите скрипт из "Developer Command Prompt for VS",
    echo          чтобы включить автоматическую проверку импортов.
    goto done
)
powershell -NoProfile -Command "$bad = & dumpbin /imports '%EXE%' 2>$null | Select-String -Pattern 'ForDpi','WaitOnAddress','WakeByAddress','api-ms-win-crt-','VCRUNTIME','MSVCP'; if ($bad) { Write-Host '  [FAIL] Incompatible Win7 imports found:' -ForegroundColor Red; $bad | ForEach-Object { Write-Host ('    ' + $_.Line.Trim()) }; exit 1 } else { Write-Host '  [OK] No incompatible imports - Win7 OK' -ForegroundColor Green }"
if errorlevel 1 (
    echo.
    echo   Сборка НЕ совместима с Windows 7. Проверьте таргет и версии зависимостей.
    exit /b 1
)

:done
echo.
echo [4/4] Готово: %EXE%
echo.
echo Скопируйте printnum.exe на целевую машину Windows 7 SP1 x64.
echo Печать доступна при наличии установленного принтера.
endlocal
