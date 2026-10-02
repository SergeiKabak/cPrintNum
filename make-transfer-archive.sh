#!/usr/bin/env bash
#
# Сборка архива с исходниками PrintNum для передачи на Windows-машину,
# где выполняется компиляция под Windows 7 x64.
#
# Почему нужен отдельный архив:
#   Боевой .exe собирается только в Windows-окружении (компилятор
#   x86_64-win7-windows-msvc, MSVC-линкер, CRT). С macOS собрать его нельзя,
#   поэтому на сборщик передаётся архив исходников, а не готовый бинарник.
#
# Использование:
#   ./make-transfer-archive.sh              # версия берётся из Cargo.toml
#   ./make-transfer-archive.sh 3.0.1        # явная версия
#   ./make-transfer-archive.sh --with-lock  # включить Cargo.lock (фикс. зависимости)
#
# Результат: PrintNum-SOURCE-win7-v<VERSION>.zip в корне репозитория.

set -euo pipefail

cd "$(dirname "$0")"

# --- разбор аргументов -------------------------------------------------------
VERSION=""
WITH_LOCK=0
for arg in "$@"; do
    case "$arg" in
        --with-lock) WITH_LOCK=1 ;;
        -h|--help)
            sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        -*) echo "Неизвестный флаг: $arg" >&2; exit 2 ;;
        *)  VERSION="$arg" ;;
    esac
done

SRC_DIR="src-printnum"
MANIFEST="$SRC_DIR/Cargo.toml"

[ -f "$MANIFEST" ] || { echo "Не найден $MANIFEST" >&2; exit 1; }

# --- версия ------------------------------------------------------------------
if [ -z "$VERSION" ]; then
    VERSION=$(sed -n 's/^version *= *"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)
fi
[ -n "$VERSION" ] || { echo "Не удалось определить версию" >&2; exit 1; }

ARCHIVE="PrintNum-SOURCE-win7-v${VERSION}.zip"
rm -f "$ARCHIVE"

# --- обязательные файлы ------------------------------------------------------
# Список того, без чего сборка на Windows не пройдёт.
REQUIRED=(
    "$SRC_DIR/src"
    "$SRC_DIR/ui"
    "$SRC_DIR/Cargo.toml"
    "$SRC_DIR/build.rs"
    "$SRC_DIR/rust-toolchain.toml"
    "$SRC_DIR/.cargo/config.toml"
    "$SRC_DIR/build-windows.bat"
    "BUILD.bat"
    "README.md"
    "docs"
)

missing=0
for path in "${REQUIRED[@]}"; do
    if [ ! -e "$path" ]; then
        echo "ОШИБКА: отсутствует обязательный файл: $path" >&2
        missing=1
    fi
done
[ "$missing" -eq 0 ] || exit 1

# --- сборка архива -----------------------------------------------------------
# Намеренно НЕ включаем:
#   target/  — бинарники и кэш, создаются при сборке;
#   .git/    — не нужен на сборщике;
#   patches/ — не нужны: Slint 1.13.0 не требует патчей.
INCLUDE=("${REQUIRED[@]}")
# Cargo.lock — опционально: фиксирует точные версии зависимостей.
[ "$WITH_LOCK" -eq 1 ] && INCLUDE+=("$SRC_DIR/Cargo.lock")

# Готовая сборка браузерного расширения — опционально.
#
# Папка появляется только после `npm run build` в extension/, поэтому
# в REQUIRED её класть нельзя — иначе скрипт падал бы до сборки расширения.
# Кладём её, если она есть: тогда на Windows не нужны Node.js и npm.
EXT_BUILD="extension/output/chrome-mv3"
if [ -d "$EXT_BUILD" ]; then
    INCLUDE+=("$EXT_BUILD")
    echo "Расширение:   готовую сборку кладём (Node.js на Windows не потребуется)"
else
    echo "Расширение:   сборка не найдена ($EXT_BUILD), будет собираться на Windows"
fi

zip -rq "$ARCHIVE" "${INCLUDE[@]}"

# --- отчёт -------------------------------------------------------------------
echo "Создан архив: $ARCHIVE"
echo "Размер:       $(du -h "$ARCHIVE" | cut -f1)"
echo "Файлов:       $(unzip -l "$ARCHIVE" | tail -1 | awk '{print $2}')"
echo
echo "На Windows:"
echo "  1) распаковать архив;"
echo "  2) запустить BUILD.bat  (или сборку вручную):"
echo "     cargo +nightly build --release \\"
echo "         --target x86_64-win7-windows-msvc \\"
echo "         -Z build-std=std,panic_abort"
echo
echo "Проверка результата на Windows:"
echo "  dumpbin /imports target\\x86_64-win7-windows-msvc\\release\\printnum.exe"
echo "  НЕ должно быть: ForDpi, WaitOnAddress, WakeByAddress*, api-ms-win-crt-*, VCRUNTIME*, MSVCP*"
