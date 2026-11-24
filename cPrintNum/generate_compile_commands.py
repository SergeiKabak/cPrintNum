import json
import subprocess
import os

# Находим путь к MinGW sysroot
try:
    result = subprocess.run(["x86_64-w64-mingw32-gcc", "-print-sysroot"], capture_output=True, text=True, check=True)
    sysroot = result.stdout.strip()
except:
    sysroot = "/opt/homebrew/Cellar/mingw-w64/14.0.0_3/toolchain-x86_64/x86_64-w64-mingw32"

cwd = os.getcwd()
args = [
    "x86_64-w64-mingw32-gcc",
    "-municode", "-O2", "-Wall", "-static",
    "-nostdlib", "-e", "wWinMain",
    "-ffreestanding", "-fno-builtin",
    "-I.",  # локальные заголовки
    f"-isystem{sysroot}/include",  # MinGW system headers
    f"-isystem{sysroot}/include/crt",  # CRT headers (если есть)
]

# Определяем целевые файлы
targets = ["printnum-win7.c", "test-min.c"]

commands = []
for src in ["printnum-win7.c", "test-min.c"]:
    commands.append({
        "directory": cwd,
        "command": " ".join(["x86_64-w64-mingw32-gcc"] + [
            "-municode", "-O2", "-Wall", "-static",
            "-nostdlib", "-e", "wWinMain",
            "-ffreestanding", "-fno-builtin",
            f"-isystem{sysroot}/include",
            src, "-o", src.replace(".c", ".exe"),
            "-lgcc", "-lkernel32", "-luser32", "-lgdi32", "-lwinspool", "-lws2_32", "-lshell32"
        ]),
        "file": os.path.join(cwd, src)
    })

with open(os.path.join(cwd, "compile_commands.json"), "w") as f:
    json.dump(commands, f, indent=2)

print("compile_commands.json создан")
