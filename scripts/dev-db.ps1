<#
.SYNOPSIS
  Creates and runs a private PostgreSQL cluster for development, inside the
  project folder (.devdb), using the PostgreSQL binaries already installed on
  Windows. No Docker, no WSL, no admin rights, and the system PostgreSQL
  service is left untouched.

.EXAMPLE
  .\scripts\dev-db.ps1            # create (first time) and start
  .\scripts\dev-db.ps1 -Stop
  .\scripts\dev-db.ps1 -Status
#>
param(
  [int]$Port = 5433,
  [switch]$Stop,
  [switch]$Status
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root '.devdb\data'
$logFile = Join-Path $root '.devdb\postgres.log'
$envFile = Join-Path $root 'apps\web\.env.local'
$dbName = 'avot_studio'
$dbUser = 'avot'

function Find-PgBin {
  $cmd = Get-Command pg_ctl -ErrorAction SilentlyContinue
  if ($cmd) { return Split-Path -Parent $cmd.Source }
  $candidates = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_ctl.exe' -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending
  if ($candidates) { return Split-Path -Parent $candidates[0].FullName }
  throw "PostgreSQL לא נמצא. התקינו PostgreSQL 15+ מ-https://www.postgresql.org/download/windows/ או הגדירו DATABASE_URL לשרת קיים."
}

$bin = Find-PgBin
$pgCtl = Join-Path $bin 'pg_ctl.exe'

if ($Status) { & $pgCtl status -D $dataDir; exit $LASTEXITCODE }
if ($Stop) { & $pgCtl stop -D $dataDir -m fast; exit $LASTEXITCODE }

if (-not (Test-Path (Join-Path $dataDir 'PG_VERSION'))) {
  Write-Host "יוצר אשכול PostgreSQL לפיתוח ב-$dataDir" -ForegroundColor Cyan
  New-Item -ItemType Directory -Force (Split-Path $dataDir) | Out-Null
  $password = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
  $pwFile = Join-Path $root '.devdb\pw.tmp'
  Set-Content -Path $pwFile -Value $password -NoNewline -Encoding ascii
  try {
    & (Join-Path $bin 'initdb.exe') -D $dataDir -U $dbUser --pwfile=$pwFile --auth=scram-sha-256 -E UTF8 --no-locale | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "initdb נכשל" }
  } finally { Remove-Item $pwFile -Force -ErrorAction SilentlyContinue }

  Add-Content (Join-Path $dataDir 'postgresql.conf') "`nlisten_addresses = '127.0.0.1'`nport = $Port`n"

  $url = "postgresql://${dbUser}:${password}@127.0.0.1:${Port}/${dbName}?schema=public"
  if (Test-Path $envFile) {
    $content = Get-Content $envFile -Raw
    if ($content -match '(?m)^DATABASE_URL=') {
      $content = $content -replace '(?m)^DATABASE_URL=.*$', "DATABASE_URL=`"$url`""
    } else { $content += "`nDATABASE_URL=`"$url`"`n" }
    Set-Content $envFile $content -Encoding utf8
  } else {
    Set-Content $envFile "DATABASE_URL=`"$url`"`n" -Encoding utf8
  }
  Write-Host "DATABASE_URL נכתב ל-apps\web\.env.local" -ForegroundColor Green
  $script:created = $true
}

& $pgCtl status -D $dataDir *> $null
if ($LASTEXITCODE -ne 0) {
  # Start-Process: the postgres child must not inherit this console's output
  # handles, otherwise the calling shell waits for the server to exit.
  $p = Start-Process -FilePath $pgCtl -ArgumentList @('start', '-D', "`"$dataDir`"", '-l', "`"$logFile`"", '-w') `
    -WindowStyle Hidden -PassThru
  # WaitForExit waits for pg_ctl only; Start-Process -Wait would also wait for postgres itself
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { throw "הפעלת PostgreSQL נכשלה. ראו $logFile" }
}

# create the database if missing (idempotent)
$pwLine = (Get-Content $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1)
if ($pwLine -match 'postgresql://[^:]+:([^@]+)@127\.0\.0\.1') {
  $env:PGPASSWORD = $Matches[1]
  try {
    $exists = & (Join-Path $bin 'psql.exe') -h 127.0.0.1 -p $Port -U $dbUser -d postgres -tAc "select 1 from pg_database where datname='$dbName'"
    if ($exists -ne '1') { & (Join-Path $bin 'createdb.exe') -h 127.0.0.1 -p $Port -U $dbUser $dbName }
  } finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
}
Write-Host "PostgreSQL לפיתוח פעיל על 127.0.0.1:$Port" -ForegroundColor Green
