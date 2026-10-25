<#
.SYNOPSIS
  Full logical backup of the AVOT Studio database (pg_dump, custom format) and,
  for the local storage driver, a copy of the stored originals. Run before every
  schema migration.

.EXAMPLE
  .\scripts\db-backup.ps1                     # uses DATABASE_URL from apps\web\.env.local
  .\scripts\db-backup.ps1 -Label pre-phase2
  .\scripts\db-backup.ps1 -DatabaseUrl "postgresql://…"   # e.g. the Railway database

  Restore (into an EMPTY database):
  pg_restore --clean --if-exists --no-owner -d "<url>" backups\<file>.dump
#>
param(
  [string]$DatabaseUrl,
  [string]$Label = "manual",
  [switch]$SkipStorage
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root 'apps\web\.env.local'

function Find-PgBin {
  $cmd = Get-Command pg_dump -ErrorAction SilentlyContinue
  if ($cmd) { return Split-Path -Parent $cmd.Source }
  $c = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
  if ($c) { return Split-Path -Parent $c[0].FullName }
  throw "pg_dump לא נמצא. התקינו את כלי הלקוח של PostgreSQL."
}

if (-not $DatabaseUrl) {
  $line = Get-Content $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
  if (-not $line) { throw "DATABASE_URL לא מוגדר ב-apps\web\.env.local" }
  $DatabaseUrl = ($line -replace '^DATABASE_URL=', '').Trim('"', ' ')
}
# pg_dump does not understand Prisma's ?schema= parameter
$pgUrl = $DatabaseUrl -replace '\?.*$', ''

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dir = Join-Path $root 'backups'
New-Item -ItemType Directory -Force $dir | Out-Null
$dump = Join-Path $dir "avot-$stamp-$Label.dump"

$bin = Find-PgBin
& (Join-Path $bin 'pg_dump.exe') --format=custom --no-owner --file=$dump $pgUrl
if ($LASTEXITCODE -ne 0) { throw "pg_dump נכשל" }
# a dump that cannot be listed is not a backup
& (Join-Path $bin 'pg_restore.exe') --list $dump | Out-Null
if ($LASTEXITCODE -ne 0) { throw "קובץ הגיבוי אינו קריא: $dump" }
$hash = (Get-FileHash $dump -Algorithm SHA256).Hash.ToLower()
Set-Content "$dump.sha256" "$hash  $(Split-Path -Leaf $dump)" -Encoding ascii
Write-Host "גיבוי מסד נתונים: $dump ($([math]::Round((Get-Item $dump).Length / 1KB)) KB, sha256 $hash)" -ForegroundColor Green

if (-not $SkipStorage) {
  $storage = Join-Path $root 'apps\web\.data\storage'
  if (Test-Path $storage) {
    $zip = Join-Path $dir "storage-$stamp-$Label.zip"
    Compress-Archive -Path (Join-Path $storage '*') -DestinationPath $zip -CompressionLevel Fastest
    Write-Host "גיבוי אחסון מקומי: $zip" -ForegroundColor Green
  } else {
    Write-Host "אחסון מקומי לא נמצא (S3/R2?) — קבצי המקור אינם משתנים במיגרציה; גבו את ה-bucket לפי docs/security.md." -ForegroundColor Yellow
  }
}
