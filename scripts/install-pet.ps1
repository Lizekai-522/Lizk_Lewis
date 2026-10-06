# One-time local dependency install for the optional Qt pet. Never writes a model key.
$ErrorActionPreference = 'Stop'
$componentRoot = Join-Path $env:LOCALAPPDATA 'Lewis\pet-runtime'
$pythonExe = Join-Path $componentRoot 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) {
  if (Get-Command py -ErrorAction SilentlyContinue) { & py -3 -m venv $componentRoot }
  elseif (Get-Command python -ErrorAction SilentlyContinue) { & python -m venv $componentRoot }
  else { throw '请先安装 Python 3.11 或更新版本，再运行此脚本。' }
  if ($LASTEXITCODE -ne 0) { throw '独立环境创建失败，请检查 Python 安装。' }
}
& $pythonExe -m pip install 'PySide6==6.11.2' requests psutil pynvml --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw '组件依赖安装失败，请检查网络后重试。' }
Write-Host '大肥鱼组件已安装。重新启动 Lewis 即可，无需单独填写 Key。'
