@echo off
REM ============================================================================
REM Регистрация PrintNum как native messaging host для Chrome/Edge/Яндекс.
REM
REM Использование:
REM   install-native-host.bat <путь-к-printnum.exe> <ID-расширения>
REM
REM Пример:
REM   install-native-host.bat C:\PrintNum\printnum.exe abcdefghijklmnopabcdefghijklmnop
REM
REM ID расширения: chrome://extensions → карточка PrintNum → «ID».
REM Скрипт создаёт host-манифест и прописывает его в реестр для браузеров.
REM ============================================================================
setlocal EnableDelayedExpansion

if "%~1"=="" (
    echo Ошибка: не указан путь к printnum.exe
    echo Использование: %~nx0 ^<путь-к-printnum.exe^> ^<ID-расширения^>
    exit /b 1
)
if "%~2"=="" (
    echo Ошибка: не указан ID расширения
    echo Использование: %~nx0 ^<путь-к-printnum.exe^> ^<ID-расширения^>
    exit /b 1
)

set "EXE_PATH=%~1"
set "EXT_ID=%~2"
set "HOST_NAME=ru.printnum.host"

REM Проверяем, что файл существует.
if not exist "%EXE_PATH%" (
    echo Ошибка: файл не найден: %EXE_PATH%
    exit /b 1
)

REM Каталог для host-манифеста рядом с приложением.
for %%I in ("%EXE_PATH%") do set "APP_DIR=%%~dpI"
set "MANIFEST=%APP_DIR%%HOST_NAME%.json"

echo Создаю манифест: %MANIFEST%
> "%MANIFEST%" echo {
>>"%MANIFEST%" echo   "name": "%HOST_NAME%",
>>"%MANIFEST%" echo   "description": "PrintNum native messaging host",
>>"%MANIFEST%" echo   "path": "%EXE_PATH:\=\\%",
>>"%MANIFEST%" echo   "type": "stdio",
>>"%MANIFEST%" echo   "allowed_origins": ["chrome-extension://%EXT_ID%/"]
>>"%MANIFEST%" echo }

echo.
echo Регистрирую в реестре для браузеров...

REM Chrome
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
echo   [OK] Google Chrome

REM Edge
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
echo   [OK] Microsoft Edge

REM Яндекс.Браузер
reg add "HKCU\Software\Yandex\YandexBrowser\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
echo   [OK] Yandex Browser

REM Chromium
reg add "HKCU\Software\Chromium\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
echo   [OK] Chromium

echo.
echo Готово. Перезапустите браузер.
endlocal
