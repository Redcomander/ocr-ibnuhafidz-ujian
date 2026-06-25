$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$nodeCmd = Get-Command node -ErrorAction Stop
$nodePath = $nodeCmd.Source

$logDir = Join-Path $PSScriptRoot 'logs'
if (-not (Test-Path $logDir)) {
  New-Item -Path $logDir -ItemType Directory | Out-Null
}

$logFile = Join-Path $logDir 'connector.log'
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
"[$stamp] Starting scanner connector service..." | Out-File -FilePath $logFile -Encoding utf8 -Append

& $nodePath "server.js" 2>&1 | Tee-Object -FilePath $logFile -Append
