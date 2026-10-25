<#
.SYNOPSIS
  Checks that this Windows machine is ready to develop / run AVOT Studio.
  Prints a clear list of what is OK and what is missing. Exit code 1 when a
  required dependency is missing.
#>
param([switch]$Quiet)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$failed = $false

function Ok($msg) { if (-not $Quiet) { Write-Host "  [OK]   $msg" -ForegroundColor Green } }
function Warn($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  [FAIL] $msg" -ForegroundColor Red; $script:failed = $true }

Write-Host "בדיקת מוכנות סביבת הפיתוח — AVOT Studio" -ForegroundColor Cyan

# Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js לא מותקן. התקינו Node.js 22 LTS מ-https://nodejs.org" }
else {
  $v = (node --version).TrimStart('v'); $major = [int]($v.Split('.')[0])
  if ($major -lt 20) { Fail "Node.js $v ישן מדי — נדרש 20.18 ומעלה (מומלץ 22 LTS)" } else { Ok "Node.js $v" }
}
if (Get-Command npm -ErrorAction SilentlyContinue) { Ok ("npm " + (npm --version)) } else { Fail "npm לא נמצא" }

# PostgreSQL
$pg = Get-Command pg_ctl -ErrorAction SilentlyContinue
if (-not $pg) { $pg = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_ctl.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 }
if ($pg) { Ok "PostgreSQL binaries נמצאו" } else { Warn "PostgreSQL לא נמצא מקומית — נדרש DATABASE_URL לשרת חיצוני" }

# .NET SDK (capture agent)
$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
$localDotnet = Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet\dotnet.exe'
if (-not $dotnet -and (Test-Path $localDotnet)) { $dotnet = Get-Item $localDotnet }
if ($dotnet) {
  $dotnetExe = if ($dotnet.Source) { $dotnet.Source } else { $dotnet.FullName }
  $sdks = & $dotnetExe --list-sdks 2>$null
  if ($sdks -match '^10\.') { Ok ".NET SDK 10 (Capture Agent)" } else { Warn ".NET 10 SDK לא נמצא — נדרש רק לפיתוח Capture Agent" }
} else { Warn ".NET SDK לא מותקן — נדרש רק לפיתוח Capture Agent. https://dotnet.microsoft.com/download/dotnet/10.0" }

# env file
$envFile = Join-Path $root 'apps\web\.env.local'
if (Test-Path $envFile) {
  $content = Get-Content $envFile -Raw
  foreach ($k in 'DATABASE_URL', 'APP_SECRET', 'APP_URL') {
    if ($content -match "(?m)^$k=.+") { Ok "$k מוגדר" } else { Fail "$k חסר ב-apps\web\.env.local" }
  }
} else { Fail "apps\web\.env.local לא קיים — הריצו .\scripts\start-dev.ps1 -Setup" }

# node_modules
if (Test-Path (Join-Path $root 'node_modules\next')) { Ok "תלויות npm מותקנות" } else { Warn "תלויות לא מותקנות — הריצו npm install" }

# Canon EDSDK (optional)
$edsdk = Join-Path $root 'apps\capture-agent\third_party\EDSDK\EDSDK.dll'
if (Test-Path $edsdk) { Ok "Canon EDSDK.dll נמצא" } else { Warn "Canon EDSDK לא הותקן (אופציונלי עד הגעת המצלמה) — ראו docs\canon-edsdk.md" }

# disk space
$drive = (Get-Item $root).PSDrive
$freeGb = [math]::Round($drive.Free / 1GB, 1)
if ($freeGb -lt 10) { Warn "נפח פנוי נמוך בכונן ${drive}: $freeGb GB" } else { Ok "נפח פנוי: $freeGb GB" }

if ($failed) { Write-Host "`nיש פריטים חסרים — תקנו את השורות המסומנות FAIL." -ForegroundColor Red; exit 1 }
Write-Host "`nהסביבה מוכנה." -ForegroundColor Green
