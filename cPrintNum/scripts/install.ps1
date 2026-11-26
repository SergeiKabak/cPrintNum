# install.ps1 — установка PrintNum на компьютер оператора ПВЗ.
#
#   Правая кнопка -> «Выполнить с PowerShell»  (или: powershell -ExecutionPolicy Bypass -File install.ps1)
#
# Что делает:
#   1. скачивает последний релиз PrintNum с GitHub;
#   2. распаковывает в %LOCALAPPDATA%\PrintNum (без прав администратора);
#   3. запускает службу печати printnum-win7.exe;
#   4. открывает chrome://extensions и печатает путь к папке расширения.
#
# Ничего не пишет в реестр, не ставит службу Windows, не требует админа.

$ErrorActionPreference = "Stop"

$repo    = "kirill18734/PrintNum"
$dest    = Join-Path $env:LOCALAPPDATA "PrintNum"
$zipPath = Join-Path $env:TEMP "printnum-windows.zip"

Write-Host ""
Write-Host "  PrintNum — установка" -ForegroundColor Cyan
Write-Host "  --------------------"
Write-Host ""

# ---------- скачивание ----------
$release = $null
try {
    $release = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$repo/releases/latest"
} catch {
    Write-Host "  Не удалось получить сведения о релизе." -ForegroundColor Yellow
    Write-Host "  Скачайте архив вручную: https://github.com/$repo/releases/latest"
    exit 1
}

$asset = $release.assets | Where-Object { $_.name -like "*windows.zip" } | Select-Object -First 1
if (-not $asset) {
    Write-Host "  В релизе нет архива *-windows.zip." -ForegroundColor Yellow
    Write-Host "  Открываю страницу релизов: https://github.com/$repo/releases/latest"
    Start-Process "https://github.com/$repo/releases/latest"
    exit 1
}

Write-Host "  Версия: $($release.tag_name)"
Write-Host "  Скачиваю $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) МБ)..."

Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $zipPath

# ---------- распаковка ----------
if (Test-Path $dest) {
    Write-Host "  Обновляю существующую установку в $dest"
    if (Test-Path (Join-Path $dest "config.json")) {
        Copy-Item (Join-Path $dest "config.json") "$env:TEMP\printnum-config-backup.json" -Force
    }
    Remove-Item (Join-Path $dest "extension") -Recurse -Force -ErrorAction SilentlyContinue
} else {
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
}

Expand-Archive -Path $zipPath -DestinationPath $dest -Force
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

# Expand-Archive кладёт содержимое в подпапку PrintNum — поднимаем наверх.
$inner = Join-Path $dest "PrintNum"
if (Test-Path (Join-Path $inner "printnum-win7.exe")) {
    Get-ChildItem $inner -Force | Move-Item -Destination $dest -Force
    Remove-Item $inner -Recurse -Force
}

if (Test-Path "$env:TEMP\printnum-config-backup.json") {
    Copy-Item "$env:TEMP\printnum-config-backup.json" (Join-Path $dest "config.json") -Force
    Remove-Item "$env:TEMP\printnum-config-backup.json" -Force
}

$extDir = Join-Path $dest "extension"
$exe    = Join-Path $dest "printnum-win7.exe"

# ---------- запуск службы ----------
Write-Host ""
if (Test-Path $exe) {
    $running = Get-Process -Name "printnum-win7" -ErrorAction SilentlyContinue
    if (-not $running) {
        Start-Process -FilePath $exe -WorkingDirectory $dest
        Start-Sleep -Seconds 2
        Write-Host "  Служба печати запущена." -ForegroundColor Green
    } else {
        Write-Host "  Служба печати уже работает." -ForegroundColor Green
    }

    try {
        $status = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:5000/" -TimeoutSec 3
        Write-Host "  http://127.0.0.1:5000 отвечает: ок"
    } catch {
        Write-Host "  Служба не отвечает на 127.0.0.1:5000." -ForegroundColor Yellow
        Write-Host "  Проверьте, не блокирует ли брандмауэр, и запустите printnum-diag.exe для логов."
    }
}

# ---------- установка расширения ----------
Write-Host ""
Write-Host "  Установка расширения" -ForegroundColor Cyan
Write-Host "  1. В открывшемся окне включите «Режим разработчика»."
Write-Host "  2. Нажмите «Загрузить распакованное»."
Write-Host "  3. Выберите папку:"
Write-Host "     $extDir" -ForegroundColor Yellow
Write-Host ""

Set-Clipboard -Value $extDir -ErrorAction SilentlyContinue
Write-Host "  (путь скопирован в буфер обмена)"

$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chrome) {
    $url = if ($chrome -like "*msedge*") { "edge://extensions/" } else { "chrome://extensions/" }
    Start-Process $chrome $url
} else {
    Write-Host "  Браузер не найден — откройте chrome://extensions вручную." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Готово. Не забудьте перезагрузить вкладку Ozon (F5)." -ForegroundColor Green
Write-Host ""
