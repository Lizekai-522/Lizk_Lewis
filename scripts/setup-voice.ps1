$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) { python -m venv .venv; if ($LASTEXITCODE) { throw '创建环境失败' } }
& '.\.venv\Scripts\python.exe' -m pip install -r voice-service\requirements.txt
if ($LASTEXITCODE) { throw '语音依赖安装失败' }
