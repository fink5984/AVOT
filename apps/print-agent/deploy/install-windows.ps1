<#
.SYNOPSIS
  Installs the AVOT print agent as a startup task on the Windows PC next to the label printer.
  Run once from an elevated PowerShell:  .\install-windows.ps1 -Server https://studio.example.com -Code 12345678
#>
param(
  [Parameter(Mandatory)][string]$Server,
  [Parameter(Mandatory)][string]$Code,
  [string]$Name = "סוכן הדפסה"
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $root 'src\cli.mjs') pair --server $Server --code $Code --name $Name
if ($LASTEXITCODE -ne 0) { throw "הצימוד נכשל" }
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$(Join-Path $root 'src\cli.mjs')`" run" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName 'AVOT Print Agent' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName 'AVOT Print Agent'
Write-Host "סוכן ההדפסה הותקן ופועל. הוא יעלה אוטומטית עם Windows." -ForegroundColor Green
