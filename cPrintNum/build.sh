#!/bin/bash
# build.sh — сборка PrintNum для Windows 7 x64 + сборка/упаковка расширения.
#
# 1. Кросс-компиляция C-службы (MinGW-w64):
#      printnum-win7.exe  — служба без окна и консоли (подсистема Windows)
#      printnum-diag.exe  — та же служба + консоль (диагностика/Wine)
# 2. Сборка браузерного расширения (WXT): extension/output/chrome-mv3 —
#    это и есть папка готового расширения (её содержимое идёт в архив).
# 3. Упаковка: ЕДИНЫЙ архив dist/PrintNum-win7.zip — файлы расширения в корне
#    (manifest.json рядом) + printnum-win7.exe, printnum-diag.exe, config.json.
#    Распаковал в папку — запускаешь exe и эту же папку грузишь как расширение.
#
# Переменные окружения:
#   SKIP_EXTENSION=1  — собрать только exe (без Node.js/расширения)

set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

TARGET="x86_64-w64-mingw32"
CC="${TARGET}-gcc"
SRC="printnum-win7.c"

EXT_DIR="$ROOT_DIR/extension"
EXT_OUT="$EXT_DIR/output/chrome-mv3"
DIST="$ROOT_DIR/dist"
RELEASE_ZIP="PrintNum-win7.zip"
# Старое имя отдельного архива расширения — удаляем, если осталось в dist/.
LEGACY_EXT_ZIP="PrintNum-extension-chrome.zip"

# Общие флаги: без CRT, свой entry point wWinMain, свои strlen/memcpy.
# -Os: минимальный размер кода. -fdata-sections НЕ используем — множество
# static-буферов в отдельных секциях раздувает PE из-за выравнивания.
COMMON_FLAGS="-municode -Os -s -Wall -static -nostdlib -e wWinMain -ffreestanding -fno-builtin -ffunction-sections -Wl,--gc-sections"
LIBS="-lgcc -lkernel32 -luser32 -lgdi32 -lwinspool -lws2_32 -lshell32"

echo "=== Сборка PrintNum (single-file, Win7) + расширение ==="
echo "Target: ${TARGET}"
echo ""

if ! command -v ${CC} &> /dev/null; then
    echo "Ошибка: ${CC} не найден. Установите: brew install mingw-w64"
    exit 1
fi

build_one() {
    local src=$1
    local out=$2
    local extra_flags=$3

    echo "--- Сборка ${out} ---"

    if ${CC} ${COMMON_FLAGS} ${extra_flags} ${src} -o ${out} ${LIBS}; then
        echo "✅ Сборка успешна: ${out}"
        echo "Размер: $(ls -lh ${out} | awk '{print $5}')"
        echo "Зависимости (DLL):"
        ${TARGET}-objdump -p ${out} | grep "DLL Name" | sed 's/^/  /'

        if ${TARGET}-objdump -p ${out} | grep -q "api-ms-win-crt"; then
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

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Расширение — в корень архива: manifest.json лежит рядом с exe, поэтому
# одну и ту же папку можно и запускать, и грузить как unpacked extension.
if [ "${SKIP_EXTENSION:-0}" != "1" ]; then
    cp -R "$EXT_OUT/." "$STAGE/"
fi

# Приложение и конфиг — рядом.
cp *.exe "$STAGE"/
if [ -f config.json ]; then cp config.json "$STAGE"/; fi

find "$STAGE" -name '.DS_Store' -delete
find "$STAGE" -name '__MACOSX' -type d -prune -exec rm -rf {} +

rm -f "$DIST/$RELEASE_ZIP" "$DIST/$LEGACY_EXT_ZIP"
( cd "$STAGE" && zip -qr "$DIST/$RELEASE_ZIP" . -x '*.DS_Store' -x '__MACOSX/*' )

echo ""
echo "=== Готово ==="
ls -lh "$DIST"/*.zip | awk '{print "  " $9 "  (" $5 ")"}'
echo ""
echo "Установка:"
echo "  1) распаковать $RELEASE_ZIP в папку, например C:\\PrintNum\\"
echo "  2) запустить printnum-win7.exe (служба на 127.0.0.1:5000)"
if [ "${SKIP_EXTENSION:-0}" != "1" ]; then
    echo "  3) chrome://extensions → «Режим разработчика» → «Загрузить распакованное»"
    echo "     → выбрать ЭТУ ЖЕ папку (manifest.json лежит в корне архива)"
fi
echo ""
echo "Содержимое $RELEASE_ZIP:"
unzip -l "$DIST/$RELEASE_ZIP"
