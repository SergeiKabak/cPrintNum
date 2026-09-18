@echo off
REM Сборка PrintNum под Windows 7 x64.
REM Требуется только Rust (MSVC toolchain). Node.js и Python не нужны.
setlocal

cd /d "%~dp0"

echo [1/2] Сборка release-бинарника (x86_64-pc-windows-msvc)...
cargo build --release --target x86_64-pc-windows-msvc
if errorlevel 1 (
    echo Ошибка сборки.
    exit /b 1
)

echo [2/2] Готово: target\x86_64-pc-windows-msvc\release\printnum.exe
echo.
echo Для запуска скопируйте printnum.exe на целевую машину.
echo Печать доступна только при наличии установленного принтера.
endlocal
