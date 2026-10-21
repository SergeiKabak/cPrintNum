#!/bin/bash
# build.sh — Сборка PrintNum для Windows 7 x64 (single-file версия)
# Использует MinGW-w64 кросс-компилятор.
# Результат: printnum-win7.exe (GUI), printnum-diag.exe (консоль)

set -e

TARGET="x86_64-w64-mingw32"
CC="${TARGET}-gcc"
SRC="printnum-win7.c"

# Общие флаги: без CRT, свой entry point wWinMain, свои strlen/memcpy.
# -Os: минимальный размер кода. -fdata-sections НЕ используем — множество
# static-буферов в отдельных секциях раздувает PE из-за выравнивания.
COMMON_FLAGS="-municode -Os -s -Wall -static -nostdlib -e wWinMain -ffreestanding -fno-builtin -ffunction-sections -Wl,--gc-sections"
LIBS="-lgcc -lkernel32 -luser32 -lgdi32 -lwinspool -lws2_32 -lshell32"

echo "=== Сборка PrintNum (single-file, Win7) ==="
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
    ${CC} ${COMMON_FLAGS} ${extra_flags} ${src} -o ${out} ${LIBS}

    if [ $? -eq 0 ]; then
        echo "✅ Сборка успешна: ${out}"
        SIZE=$(ls -lh ${out} | awk '{print $5}')
        echo "Размер: ${SIZE}"
        echo "Зависимости (DLL):"
        ${TARGET}-objdump -p ${out} | grep "DLL Name" | sed 's/^/  /'

        if ${TARGET}-objdump -p ${out} | grep -q "api-ms-win-crt"; then
            echo "⚠️  Найдены CRT зависимости — НЕ работает на чистой Windows 7"
            exit 1
        else
            echo "✅ CRT зависимости отсутствуют (только системные DLL Windows 7)"
        fi
        echo ""
    else
        echo "❌ Ошибка компиляции ${out}"
        exit 1
    fi
}

# 1. Основной exe (GUI служба)
build_one "${SRC}" "printnum-win7.exe" "-mwindows"

# 2. Консольный диагностический вариант
build_one "${SRC}" "printnum-diag.exe" "-mconsole"

echo ""
echo "=== Все артефакты готовы ==="
ls -lh *.exe

# Упаковка в dist/
mkdir -p dist
cp *.exe dist/
if [ -f config.json ]; then cp config.json dist/; fi
cd dist
rm -f PrintNum-win7.zip
zip -q PrintNum-win7.zip *.exe config.json 2>/dev/null || zip -q PrintNum-win7.zip *.exe
echo ""
echo "Архив: dist/PrintNum-win7.zip"
unzip -l PrintNum-win7.zip