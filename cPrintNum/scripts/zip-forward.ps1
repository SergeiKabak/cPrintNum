<#
  zip-forward.ps1 — кладёт папку в zip, гарантируя ПРЯМЫЕ слэши в путях.

  Зачем: MSYS2-шный zip 3.0 (win32), Windows PowerShell 5.1 Compress-Archive и
  .NET Framework ZipFile::CreateFromDirectory пишут разделители как "dir\file".
  Такой архив Windows Explorer распаковывает плоским файлом с обратными слэшами
  в имени. Здесь имена собираются вручную через "/".

  Примеры:
    powershell -File zip-forward.ps1 -Src C:\stage\PrintNum -Dst out.zip
    powershell -File zip-forward.ps1 -Src C:\ext\chrome-mv3 -Dst ext.zip -ContentsOnly
#>
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Dst,
  # Не включать имя папки в пути (архив «содержимое папки»).
  [switch]$ContentsOnly
)

$ErrorActionPreference = "Stop"
# ZipArchiveMode живёт в System.IO.Compression, ZipFile/CreateEntryFromFile —
# в System.IO.Compression.FileSystem. Нужны обе сборки (.NET Framework).
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$base = (Get-Item -LiteralPath $Src).FullName
if (-not (Test-Path -LiteralPath $base)) { throw "Нет папки: $base" }
$leaf = Split-Path $base -Leaf

if (Test-Path -LiteralPath $Dst) { Remove-Item -LiteralPath $Dst -Force }
$dir = Split-Path -Parent $Dst
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$zip = [System.IO.Compression.ZipFile]::Open($Dst, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -LiteralPath $base -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($base.Length + 1).Replace('\', '/')
    if ($ContentsOnly) { $name = $rel } else { $name = "$leaf/$rel" }
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip, $_.FullName, $name, [System.IO.Compression.CompressionLevel]::Optimal)
  }
}
finally { $zip.Dispose() }

Write-Output "ok: $Dst"
