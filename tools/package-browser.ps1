$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $taskRoot 'extension\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.permissions -contains 'nativeMessaging') { throw 'Browser-only package must not request nativeMessaging.' }
$packageName = 'Berriz-Replay-Saver-v' + $manifest.version
$packagePath = Join-Path $taskRoot $packageName
New-Item -ItemType Directory -Path $packagePath -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $taskRoot 'extension') -File | Copy-Item -Destination $packagePath -Force
Copy-Item -LiteralPath (Join-Path $taskRoot 'README.md'), (Join-Path $taskRoot 'VERIFICATION.md') -Destination $packagePath -Force
$docsPath = Join-Path $packagePath 'docs'
New-Item -ItemType Directory -Path $docsPath -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $taskRoot 'docs\progress-preview.png') -Destination $docsPath -Force
$zipPath = Join-Path $taskRoot ($packageName + '.zip')
$files = @(Get-ChildItem -LiteralPath $packagePath | ForEach-Object { $_.FullName })
Compress-Archive -LiteralPath $files -DestinationPath $zipPath -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    if (-not ($archive.Entries.FullName -contains 'manifest.json')) { throw 'ZIP must have manifest.json at its root.' }
    if ($archive.Entries.FullName -match '(\.exe$|install\.)') { throw 'Unexpected native installer in package.' }
} finally { $archive.Dispose() }
Write-Output $packagePath
Write-Output $zipPath
