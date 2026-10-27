<#
.SYNOPSIS
  Builds AVOT Capture Desktop: tests → self-contained win-x64 publish → Inno Setup installer.
  Output: apps\capture-agent\artifacts\AvotCaptureDesktop-Setup-<version>.exe

.EXAMPLE
  .\apps\capture-agent\build-installer.ps1
  .\apps\capture-agent\build-installer.ps1 -Version 0.2.0 -SkipTests
#>
param(
  [string]$Version = '0.1.0',
  [switch]$SkipTests,
  # prints / writes the release manifest the station's updater and the website download button read
  [switch]$Publish,
  # where the installer will be hosted (HTTPS), e.g. your R2 public URL; required with -Publish
  [string]$DownloadUrl,
  # optional: SHA-1 thumbprint of the code-signing certificate to pin (stations then refuse any other signer)
  [string]$SignerThumbprint
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
$publishDir = Join-Path $here 'artifacts\publish'

if (-not $SkipTests) {
  Write-Host "==> בדיקות" -ForegroundColor Cyan
  & $dotnet test (Join-Path $here 'tests\AvotCapture.Tests') -c Release
  if ($LASTEXITCODE -ne 0) { throw "הבדיקות נכשלו — ההתקנה לא נבנתה" }
}

Write-Host "==> publish (self-contained, win-x64)" -ForegroundColor Cyan
if (Test-Path $publishDir) { Remove-Item $publishDir -Recurse -Force }
& $dotnet publish (Join-Path $here 'src\AvotCapture.Agent\AvotCapture.Agent.csproj') -c Release -r win-x64 --self-contained true `
  -p:Version=$Version -p:DebugType=none -o $publishDir
if ($LASTEXITCODE -ne 0) { throw "publish נכשל" }
# never ship Canon's proprietary DLLs from a developer machine
Get-ChildItem $publishDir -Recurse -Include 'EDSDK*.dll', 'EdsImage*.dll' | Remove-Item -Force

$iscc = Get-Iscc
if (-not $iscc) {
  Write-Warning "Inno Setup 6 לא מותקן — נוצרה רק תיקיית publish: $publishDir`nהתקינו מ-https://jrsoftware.org/isdl.php והריצו שוב."
  exit 0
}
Write-Host "==> Inno Setup" -ForegroundColor Cyan
& $iscc "/DAppVersion=$Version" "/DPublishDir=$publishDir" (Join-Path $here 'installer\AvotCaptureDesktop.iss')
if ($LASTEXITCODE -ne 0) { throw "בניית תוכנית ההתקנה נכשלה" }
$setup = Join-Path $here "artifacts\AvotCaptureDesktop-Setup-$Version.exe"
Write-Host "`nנוצר: $setup" -ForegroundColor Green

if ($Publish) {
  if (-not $DownloadUrl -or -not $DownloadUrl.StartsWith('https://')) { throw "-Publish דורש -DownloadUrl בכתובת https://" }
  $hash = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLower()
  $manifest = [ordered]@{ version = $Version; url = $DownloadUrl; sha256 = $hash; sizeBytes = (Get-Item $setup).Length }
  if ($SignerThumbprint) { $manifest.signerThumbprint = $SignerThumbprint.ToLower() }
  $json = $manifest | ConvertTo-Json
  $out = Join-Path $here 'artifacts\capture-desktop.json'
  Set-Content $out $json -Encoding utf8
  Write-Host "`nמניפסט שחרור נכתב ל-$out" -ForegroundColor Cyan
  Write-Host "1) העלו את $setup אל $DownloadUrl"
  Write-Host "2) בשרת (Railway) הגדירו את המשתנה AGENT_RELEASE_MANIFEST לתוכן הבא — העמדות יקבלו את העדכון, וכפתור ההורדה באתר יצביע עליו:"
  Write-Host $json
}
