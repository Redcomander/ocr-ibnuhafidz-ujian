param(
  [string]$TaskName = 'OCRScannerConnector'
)

$ErrorActionPreference = 'Stop'

$startupDir = [Environment]::GetFolderPath('Startup')
$startupCmd = Join-Path $startupDir 'OCRScannerConnector.cmd'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Scheduled task '$TaskName' removed."
} else {
  Write-Host "Scheduled task '$TaskName' not found."
}

if (Test-Path $startupCmd) {
  Remove-Item $startupCmd -Force
  Write-Host "Startup launcher removed: $startupCmd"
}
