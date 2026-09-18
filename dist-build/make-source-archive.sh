#!/usr/bin/env bash
#
# Создаёт архив с исходниками PrintNum для сборки на Windows 10.
#
# Работает на любой ОС (macOS/Linux), использует git archive —
# попадают только отслеживаемые файлы (без target/, node_modules/, .env).
#
# Результат: PrintNum-SOURCE-for-Windows-build.zip в корне проекта.
#
# На Windows сборка:
#   cd src-printnum && build-windows.bat
#   cd ..\extension && npm install && npm run build
#   cd ..\dist-windows && build-release.bat

set -euo pipefail
cd "$(dirname "$0")/.."

OUT="PrintNum-SOURCE-for-Windows-build.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[1/3] Экспорт отслеживаемых файлов из git..."
git archive HEAD | tar -x -C "$TMP"

echo "[2/3] Добавление инструкций в корень архива..."
cp dist-build/BUILD-WINDOWS-10-FOR-WIN7.md "$TMP/BUILD-WINDOWS-10-FOR-WIN7.md"
cp dist-build/README.txt "$TMP/README.txt"
# Корневой README проекта переименуем, чтобы не путался с README.txt
mv "$TMP/README.md" "$TMP/PROJECT-README.md"

# На всякий случай убираем возможные секреты/артефакты.
rm -f "$TMP/.env"

echo "[3/3] Упаковка..."
rm -f "$OUT"
( cd "$TMP" && zip -r -q "$OLDPWD/$OUT" . -x '*.DS_Store' )

echo
echo "Готово: $OUT"
echo "Размер: $(ls -la "$OUT" | awk '{print $5}') байт"
echo
echo "На Windows 10: распакуйте и следуйте BUILD-WINDOWS-10-FOR-WIN7.md"
