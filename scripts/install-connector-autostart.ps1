param(
  [string]$TaskName = 'OCRScannerConnector',
  [switch]$RunNow
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runScript = Join-Path $PSScriptRoot 'run-connector.ps1'

if (-not (Test-Path $runScript)) {
  throw "Run script not found: $runScript"
}

$nodeExists = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeExists) {
  throw 'Node.js is not installed or not available in PATH. Install Node.js first.'
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Scheduled task '$TaskName' installed."

if ($RunNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Scheduled task '$TaskName' started."
}
