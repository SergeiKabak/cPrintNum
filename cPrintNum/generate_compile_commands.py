#!/usr/bin/env python3
"""Генерирует compile_commands.json для clangd (extension/ не нужен).

Файл машино-зависимый: внутри абсолютные пути и sysroot MinGW, поэтому он
в .gitignore. Флаги намеренно повторяют build.sh — иначе clangd ругается на
код, который на самом деле собирается нормально.

    python3 generate_compile_commands.py
"""

import json
import os
import subprocess
import sys

CC = "x86_64-w64-mingw32-gcc"
SRC = "printnum-win7.c"

# Как в build.sh (COMMON_FLAGS), но без -s и линковки: clangd нужен разбор кода.
FLAGS = [
    "-municode",
    "-Os",
    "-Wall",
    "-Wextra",
    "-static",
    "-nostdlib",
    "-e",
    "wWinMain",
    "-ffreestanding",
    "-fno-builtin",
]


def run(args):
    try:
        out = subprocess.run(args, capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def main() -> int:
    cwd = os.getcwd()
    if not os.path.exists(os.path.join(cwd, SRC)):
        print(f"Запустите из каталога cPrintNum/ (нет {SRC})")
        return 1

    if not run([CC, "--version"]):
        print(f"Не найден {CC}. Установите: brew install mingw-w64")
        return 1

    # Sysroot нужен clangd, чтобы видеть заголовки MinGW (в т.ч. crt/*.h).
    sysroot = run([CC, "-print-sysroot"])
    includes = []
    if sysroot:
        includes = [f"-isystem{sysroot}/include"]
        crt = os.path.join(sysroot, "include", "crt")
        if os.path.isdir(crt):
            includes.append(f"-isystem{crt}")

    command = " ".join([CC, *FLAGS, *includes, "-c", SRC, "-o", "/dev/null"])

    data = [
        {
            "directory": cwd,
            "file": os.path.join(cwd, SRC),
            "command": command,
        }
    ]

    with open(os.path.join(cwd, "compile_commands.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"compile_commands.json создан: {SRC} ({len(FLAGS) + len(includes)} флагов)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
