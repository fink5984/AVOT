<#
.SYNOPSIS
  Starts the AVOT Studio development environment on Windows (no Docker / WSL).

.EXAMPLE
  .\scripts\start-dev.ps1 -Setup      # first run: env file, deps, database, migrations, admin user
  .\scripts\start-dev.ps1             # web app only (http://localhost:3000)
  .\scripts\start-dev.ps1 -Agent      # web app + Capture Agent (separate window)
  .\scripts\start-dev.ps1 -AgentOnly  # Capture Agent only
#>
param(
  [switch]$Setup,
  [switch]$Agent,
  [switch]$AgentOnly,
  [switch]$SkipDb
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$web = Join-Path $root 'apps\web'
$envFile = Join-Path $web '.env.local'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Die($msg) { Write-Host "`nשגיאה: $msg" -ForegroundColor Red; exit 1 }

function Get-DotnetExe {
  $cmd = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $local = Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet\dotnet.exe'
  if (Test-Path $local) { return $local }
  Die ".NET 10 SDK לא נמצא. התקינו מ-https://dotnet.microsoft.com/download/dotnet/10.0"
}

function Start-AgentWindow {
  $dotnet = Get-DotnetExe
  $proj = Join-Path $root 'apps\capture-agent\src\AvotCapture.Agent\AvotCapture.Agent.csproj'
  if (-not (Test-Path $proj)) { Die "פרויקט Capture Agent לא נמצא: $proj" }
  Step "מפעיל Capture Agent בחלון נפרד"
  Start-Process -FilePath $dotnet -ArgumentList @('run', '--project', "`"$proj`"") -WorkingDirectory $root
}

if ($AgentOnly) { Start-AgentWindow; exit 0 }

Step "בדיקת סביבה"
& (Join-Path $PSScriptRoot 'check-env.ps1') -Quiet
$envReady = ($LASTEXITCODE -eq 0)
if (-not $envReady -and -not $Setup) { Die "הסביבה אינה מוכנה. הריצו: .\scripts\start-dev.ps1 -Setup" }

if ($Setup) {
  if (-not (Test-Path $envFile)) {
    Step "יוצר apps\web\.env.local מתוך .env.example"
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = [Convert]::ToBase64String($bytes)
    (Get-Content (Join-Path $web '.env.example') -Raw) `
      -replace '(?m)^APP_SECRET=.*$', "APP_SECRET=`"$secret`"" `
      -replace '(?m)^DATABASE_URL=.*\r?\n', '' |
      Set-Content $envFile -Encoding utf8
  }
  Step "npm install"
  Push-Location $root; try { npm install; if ($LASTEXITCODE -ne 0) { Die "npm install נכשל" } } finally { Pop-Location }
  Push-Location $web; try { npx playwright install chromium } finally { Pop-Location }
}

$hasExternalDb = (Test-Path $envFile) -and ((Get-Content $envFile -Raw) -match '(?m)^DATABASE_URL=.*@(?!127\.0\.0\.1:5433)')
if (-not $SkipDb -and -not $hasExternalDb) {
  Step "מפעיל PostgreSQL מקומי לפיתוח"
  & (Join-Path $PSScriptRoot 'dev-db.ps1')
}

Push-Location $web
try {
  Step "מריץ migrations"
  npx prisma migrate deploy
  if ($LASTEXITCODE -ne 0) { Die "הרצת migrations נכשלה — בדקו DATABASE_URL" }

  if ($Setup) {
    Step "יצירת משתמש מנהל ראשון"
    npm run create-admin
  }

  if ($Agent) { Start-AgentWindow }

  Step "מפעיל את האתר: http://localhost:3000"
  npm run dev
} finally { Pop-Location }
