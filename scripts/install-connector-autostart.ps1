param(
  [string]$TaskName = 'OCRScannerConnector',
  [switch]$RunNow
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runScript = Join-Path $PSScriptRoot 'run-connector.ps1'
$startupDir = [Environment]::GetFolderPath('Startup')
$startupCmd = Join-Path $startupDir 'OCRScannerConnector.cmd'

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

try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "Scheduled task '$TaskName' installed."

  if (Test-Path $startupCmd) {
    Remove-Item $startupCmd -Force -ErrorAction SilentlyContinue
  }
} catch {
  $message = $_.Exception.Message
  if ($message -match '0x80070005|Access is denied') {
    Write-Warning "Scheduled Task permission denied. Falling back to Startup folder launcher."

    $cmdContent = @(
      '@echo off',
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $runScript + '"'
    ) -join "`r`n"

    Set-Content -Path $startupCmd -Value $cmdContent -Encoding ascii
    Write-Host "Startup launcher created: $startupCmd"
  } else {
    throw
  }
}

if ($RunNow) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Scheduled task '$TaskName' started."
  } else {
    Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runScript`"" -WindowStyle Hidden
    Write-Host 'Connector started via Startup launcher fallback.'
  }
}
