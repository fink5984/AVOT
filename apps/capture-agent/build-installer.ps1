<#
.SYNOPSIS
  Builds AVOT Capture Agent: tests → self-contained win-x64 publish → Inno Setup installer.
  Output: apps\capture-agent\artifacts\AvotCaptureAgent-Setup-<version>.exe

.EXAMPLE
  .\apps\capture-agent\build-installer.ps1
  .\apps\capture-agent\build-installer.ps1 -Version 0.2.0 -SkipTests
#>
param(
  [string]$Version = '0.1.0',
  [switch]$SkipTests
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

function Get-Dotnet {
  $cmd = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $local = Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet\dotnet.exe'
  if (Test-Path $local) { return $local }
  throw ".NET 10 SDK לא נמצא — https://dotnet.microsoft.com/download/dotnet/10.0"
}
function Get-Iscc {
  foreach ($p in @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe")) {
    if (Test-Path $p) { return $p }
  }
  $cmd = Get-Command iscc -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$dotnet = Get-Dotnet
$publish = Join-Path $here 'artifacts\publish'

if (-not $SkipTests) {
  Write-Host "==> בדיקות" -ForegroundColor Cyan
  & $dotnet test (Join-Path $here 'tests\AvotCapture.Tests') -c Release
  if ($LASTEXITCODE -ne 0) { throw "הבדיקות נכשלו — ההתקנה לא נבנתה" }
}

Write-Host "==> publish (self-contained, win-x64)" -ForegroundColor Cyan
if (Test-Path $publish) { Remove-Item $publish -Recurse -Force }
& $dotnet publish (Join-Path $here 'src\AvotCapture.Agent\AvotCapture.Agent.csproj') -c Release -r win-x64 --self-contained true `
  -p:Version=$Version -p:DebugType=none -o $publish
if ($LASTEXITCODE -ne 0) { throw "publish נכשל" }
# never ship Canon's proprietary DLLs from a developer machine
Get-ChildItem $publish -Recurse -Include 'EDSDK*.dll', 'EdsImage*.dll' | Remove-Item -Force

$iscc = Get-Iscc
if (-not $iscc) {
  Write-Warning "Inno Setup 6 לא מותקן — נוצרה רק תיקיית publish: $publish`nהתקינו מ-https://jrsoftware.org/isdl.php והריצו שוב."
  exit 0
}
Write-Host "==> Inno Setup" -ForegroundColor Cyan
& $iscc "/DAppVersion=$Version" "/DPublishDir=$publish" (Join-Path $here 'installer\AvotCaptureAgent.iss')
if ($LASTEXITCODE -ne 0) { throw "בניית תוכנית ההתקנה נכשלה" }
Write-Host "`nנוצר: $(Join-Path $here "artifacts\AvotCaptureAgent-Setup-$Version.exe")" -ForegroundColor Green
