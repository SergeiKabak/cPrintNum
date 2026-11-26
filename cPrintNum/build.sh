#!/bin/bash
# build.sh — сборка PrintNum для Windows 7 x64 + сборка/упаковка расширения.
#
# 1. Кросс-компиляция C-службы (MinGW-w64):
#      printnum-win7.exe  — служба без окна и консоли (подсистема Windows)
#      printnum-diag.exe  — та же служба + консоль (диагностика/Wine)
# 2. Сборка браузерного расширения (WXT): extension/output/chrome-mv3 —
#    это и есть папка готового расширения (её содержимое идёт в архив).
# 3. Упаковка: ЕДИНЫЙ архив dist/PrintNum-<версия>-windows.zip — папка PrintNum/
#    с extension/ (manifest.json внутри), printnum-win7.exe, printnum-diag.exe,
#    config.json, install.ps1 и README.txt. Тот же архив публикуется в GitHub
#    Releases (scripts/release.sh ничего не переупаковывает).
#
# Целевая платформа — только Windows 7 x64. Собирать можно на macOS или Linux:
# нужен кросс-компилятор MinGW-w64, а для расширения — Node.js и zip.
#
# Переменные окружения:
#   SKIP_EXTENSION=1  — собрать только exe (без Node.js/расширения)
#   CC=...            — переопределить компилятор MinGW

set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

TARGET="x86_64-w64-mingw32"
SRC="printnum-win7.c"
CC="${CC:-${TARGET}-gcc}"

EXT_DIR="$ROOT_DIR/extension"
EXT_OUT="$EXT_DIR/output/chrome-mv3"
DIST="$ROOT_DIR/dist"

if ! command -v "$CC" >/dev/null 2>&1; then
    echo "❌ Не найден кросс-компилятор MinGW-w64 ($CC)."
    echo "   macOS:         brew install mingw-w64"
    echo "   Debian/Ubuntu: sudo apt install mingw-w64"
    echo "   Fedora:        sudo dnf install mingw64-gcc"
    exit 1
fi

OBJDUMP="${TARGET}-objdump"

# Общие флаги: без CRT, свой entry point wWinMain, свои strlen/memcpy.
# -Os: минимальный размер кода. -fdata-sections НЕ используем — множество
# static-буферов в отдельных секциях раздувает PE из-за выравнивания.
COMMON_FLAGS="-municode -Os -s -Wall -static -nostdlib -e wWinMain -ffreestanding -fno-builtin -ffunction-sections -Wl,--gc-sections"
LIBS="-lgcc -lkernel32 -luser32 -lgdi32 -lwinspool -lws2_32 -lshell32"

echo "=== Сборка PrintNum (single-file, Win7) + расширение ==="
echo "Target: ${TARGET}"
echo ""

build_one() {
    local src=$1
    local out=$2
    local extra_flags=$3

    echo "--- Сборка ${out} ---"

    if ${CC} ${COMMON_FLAGS} ${extra_flags} ${src} -o ${out} ${LIBS}; then
        echo "✅ Сборка успешна: ${out}"
        echo "Размер: $(ls -lh ${out} | awk '{print $5}')"
        echo "Зависимости (DLL):"
        ${OBJDUMP} -p ${out} | grep "DLL Name" | sed 's/^/  /'

        if ${OBJDUMP} -p ${out} | grep -q "api-ms-win-crt"; then
            echo "⚠️  Найдены CRT зависимости — НЕ работает на чистой Windows 7"
            exit 1
        fi
        echo "✅ CRT зависимости отсутствуют (только системные DLL Windows 7)"
        echo ""
    else
        echo "❌ Ошибка компиляции ${out}"
        exit 1
    fi
}

# 1. Основной exe — служба (--service по умолчанию, окна нет)
build_one "${SRC}" "printnum-win7.exe" "-mwindows"

# 2. Консольный диагностический вариант
build_one "${SRC}" "printnum-diag.exe" "-mconsole"

# ============================================================
# 3. Расширение
#
# Собираем через npm (WXT), если есть node_modules; иначе берём уже
# готовую сборку output/chrome-mv3. Совсем без сборки — ошибка, чтобы
# релизный архив не остался без расширения.
# ============================================================
build_extension() {
    if [ "${SKIP_EXTENSION:-0}" = "1" ]; then
        echo "--- Расширение: пропущено (SKIP_EXTENSION=1) ---"
        echo ""
        return 0
    fi

    if [ -d "$EXT_DIR/node_modules" ] && command -v npm >/dev/null 2>&1; then
        echo "--- Сборка расширения (npm run build) ---"
        ( cd "$EXT_DIR" && npm run build )
    elif [ -f "$EXT_OUT/manifest.json" ]; then
        echo "⚠️  Расширение не пересобиралось (нет npm или node_modules)."
        echo "    Используется готовая сборка: $EXT_OUT"
    else
        echo "❌ Нет сборки расширения. Установите Node.js 18+ и выполните:"
        echo "   (cd extension && npm install && npm run build)"
        echo "   Либо соберите только exe: SKIP_EXTENSION=1 ./build.sh"
        exit 1
    fi

    if [ ! -f "$EXT_OUT/manifest.json" ]; then
        echo "❌ Не найден $EXT_OUT/manifest.json"
        exit 1
    fi

    EXT_VERSION="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$EXT_OUT/manifest.json" \
        | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
    echo "✅ Расширение готово: версия ${EXT_VERSION:-?}, $(du -sh "$EXT_OUT" | awk '{print $1}')"
    echo ""
}

build_extension

# ============================================================
# 4. Упаковка
# ============================================================
echo "=== Упаковка ==="
mkdir -p "$DIST"
cp -f *.exe "$DIST"/
if [ -f config.json ]; then cp -f config.json "$DIST"/; fi

# Версия: из собранного манифеста, иначе из package.json расширения.
read_version() {
    grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null \
        | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}
VER="$(read_version "$EXT_OUT/manifest.json")"
[ -n "$VER" ] || VER="$(read_version "$EXT_DIR/package.json")"
[ -n "$VER" ] || VER="dev"
WINDOWS_ZIP="PrintNum-$VER-windows.zip"

if [ "${SKIP_EXTENSION:-0}" = "1" ]; then
    echo ""
    echo "=== Готово (без архива: SKIP_EXTENSION=1) ==="
    ls -lh "$DIST"/*.exe | awk '{print "  " $9 "  (" $5 ")"}'
    exit 0
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/PrintNum"
mkdir -p "$PKG"

# Расширение — подпапкой: в корне архива лежат exe и конфиг, а грузить как
# unpacked нужно именно extension/ (manifest.json обязан быть в её корне).
cp -R "$EXT_OUT" "$PKG/extension"

cp -f *.exe "$PKG"/
if [ -f config.json ]; then cp -f config.json "$PKG"/; fi
if [ -f scripts/install.ps1 ]; then cp -f scripts/install.ps1 "$PKG"/; fi

cat > "$PKG/README.txt" <<'TXT'
PrintNum — печать этикеток ячеек и QR для ПВЗ Ozon
==================================================

В папке:
  printnum-win7.exe   служба печати (запустить один раз, окна нет)
  printnum-diag.exe   то же + консоль (диагностика)
  config.json         настройки службы (принтер, режим GDI/ESC-POS)
  extension\          расширение для браузера
  install.ps1         автоустановка (правый клик -> Выполнить с PowerShell)

Быстрый старт
-------------
1. Запустить printnum-win7.exe (можно из этой папки).
   Появится запрос брандмауэра — разрешить для частных сетей.
   Проверка: откройте http://127.0.0.1:5000/ в браузере.

2. Установить расширение:
   • Chrome/Edge/Opera: chrome://extensions (или edge://extensions, opera://extensions)
   • включить «Режим разработчика» / Developer mode
   • «Загрузить распакованное» / Load unpacked
   • выбрать папку extension (ту, что рядом с этим файлом)

3. Открыть https://turbo-pvz.ozon.ru, войти как обычно.
   В панели браузера появится иконка PrintNum.

4. В popup: выбрать принтер, бумагу (43*25), проверить печать.

Обновление
----------
Скачать новый архив, распаковать поверх этой папки (config.json можно не
перезаписывать), в chrome://extensions нажать «Обновить» у PrintNum и
перезагрузить вкладку Ozon (F5).

Если не печатает
----------------
• http://127.0.0.1:5000/status-printer — видит ли служба принтер;
• принтер должен быть установлен в Windows (драйвер), имя — в config.json
  или в popup расширения;
• подробности: https://github.com/SergeiKabak/cPrintNum
TXT

find "$STAGE" -name '.DS_Store' -delete
find "$STAGE" -name '__MACOSX' -type d -prune -exec rm -rf {} +

rm -f "$DIST/$WINDOWS_ZIP"
( cd "$STAGE" && zip -qr "$DIST/$WINDOWS_ZIP" "PrintNum" -x '*.DS_Store' -x '__MACOSX/*' )

echo ""
echo "=== Готово ==="
ls -lh "$DIST/$WINDOWS_ZIP" | awk '{print "  " $9 "  (" $5 ")"}'
echo ""
echo "Установка:"
echo "  1) распаковать $WINDOWS_ZIP в папку, например C:\\PrintNum\\"
echo "  2) запустить printnum-win7.exe (служба на 127.0.0.1:5000)"
echo "  3) chrome://extensions → «Режим разработчика» → «Загрузить распакованное»"
echo "     → выбрать папку PrintNum\\extension"
echo ""
echo "Содержимое $WINDOWS_ZIP:"
unzip -l "$DIST/$WINDOWS_ZIP"
