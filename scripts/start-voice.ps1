$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonExe = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) { throw '请先在项目中运行 python -m venv .venv 并安装 voice-service/requirements.txt' }
$env:MODELSCOPE_HOME = Join-Path $projectRoot 'data\modelscope-config'
$env:MODELSCOPE_CACHE = Join-Path $projectRoot 'data\models'
$env:HF_HOME = Join-Path $projectRoot 'data\huggingface'
Set-Location -LiteralPath (Join-Path $projectRoot 'voice-service')
& $pythonExe app.py
