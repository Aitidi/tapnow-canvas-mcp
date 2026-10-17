param([string]$Endpoint = 'http://127.0.0.1:9222')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $projectRoot 'dist\server.js'
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw '请先在项目目录运行 npm ci 和 npm run build。' }
$env:TAPNOW_CDP_URL = $Endpoint
& node $serverPath
exit $LASTEXITCODE
