<#
.SYNOPSIS
  Dry run of pending Prisma migrations against a COPY of the database, with a
  reconciliation report. The real database is only read (pg_dump).

  1. pg_dump of the source database (also kept as a backup)
  2. restore into a throw-away database  <name>_dryrun
  3. snapshot of the data (old schema) → prisma migrate deploy on the copy
  4. reconciliation checks → backups\migration-report-<stamp>.md
  5. the copy is dropped (unless -KeepCopy)

.EXAMPLE
  .\scripts\migration-dry-run.ps1
  .\scripts\migration-dry-run.ps1 -KeepCopy -CopyName avot_studio_phase2   # keep the migrated copy for testing
#>
param(
  [string]$DatabaseUrl,
  [switch]$KeepCopy,
  [string]$CopyName
)
$ErrorActionPreference = 'Stop'
# psql NOTICEs ("does not exist, skipping") go to stderr; they are not errors
$env:PGOPTIONS = '-c client_min_messages=warning'
$root = Split-Path -Parent $PSScriptRoot
$web = Join-Path $root 'apps\web'
$envFile = Join-Path $web '.env.local'

function Find-PgBin {
  $cmd = Get-Command pg_dump -ErrorAction SilentlyContinue
  if ($cmd) { return Split-Path -Parent $cmd.Source }
  $c = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
  if ($c) { return Split-Path -Parent $c[0].FullName }
  throw "pg_dump לא נמצא"
}
if (-not $DatabaseUrl) {
  $line = Get-Content $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
  $DatabaseUrl = ($line -replace '^DATABASE_URL=', '').Trim('"', ' ')
}
$bin = Find-PgBin
$base = $DatabaseUrl -replace '\?.*$', ''
$m = [regex]::Match($base, '^(?<prefix>postgres(ql)?://[^/]+/)(?<db>[^/?]+)$')
if (-not $m.Success) { throw "DATABASE_URL לא בפורמט הצפוי" }
$copyName = if ($CopyName) { $CopyName } else { "$($m.Groups['db'].Value)_dryrun" }
$adminUrl = "$($m.Groups['prefix'].Value)postgres"
$copyUrl = "$($m.Groups['prefix'].Value)$copyName"

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dir = Join-Path $root 'backups'
New-Item -ItemType Directory -Force $dir | Out-Null
$dump = Join-Path $dir "avot-$stamp-dryrun-source.dump"
$snap = Join-Path $dir "migration-snapshot-$stamp.json"
$report = Join-Path $dir "migration-report-$stamp.md"

Write-Host "1/5 גיבוי המקור → $dump" -ForegroundColor Cyan
& (Join-Path $bin 'pg_dump.exe') --format=custom --no-owner --file=$dump $base
if ($LASTEXITCODE -ne 0) { throw "pg_dump נכשל" }

Write-Host "2/5 יצירת עותק $copyName" -ForegroundColor Cyan
& (Join-Path $bin 'psql.exe') $adminUrl -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS `"$copyName`"" -c "CREATE DATABASE `"$copyName`""
if ($LASTEXITCODE -ne 0) { throw "יצירת העותק נכשלה" }
& (Join-Path $bin 'pg_restore.exe') --no-owner -d $copyUrl $dump
if ($LASTEXITCODE -ne 0) { throw "שחזור לעותק נכשל" }

Push-Location $web
try {
  Write-Host "3/5 צילום מצב לפני המיגרציה" -ForegroundColor Cyan
  npx tsx scripts/migration-report.ts snapshot $snap "$copyUrl`?schema=public"
  if ($LASTEXITCODE -ne 0) { throw "snapshot נכשל" }

  Write-Host "4/5 prisma migrate deploy על העותק" -ForegroundColor Cyan
  $env:DATABASE_URL = "$copyUrl`?schema=public"
  npx prisma migrate deploy
  if ($LASTEXITCODE -ne 0) { throw "המיגרציה נכשלה על העותק — מסד הנתונים האמיתי לא שונה" }

  Write-Host "5/5 בדיקות התאמה" -ForegroundColor Cyan
  npx tsx scripts/migration-report.ts verify $snap $report "$copyUrl`?schema=public"
  $ok = $LASTEXITCODE -eq 0
} finally {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  Pop-Location
}

if ($KeepCopy) { Write-Host "העותק נשמר: $copyUrl" -ForegroundColor Yellow }
else {
  & (Join-Path $bin 'psql.exe') $adminUrl -q -c "DROP DATABASE IF EXISTS `"$copyName`""
}
if ($ok) { Write-Host "Dry run תקין. דו`"ח: $report" -ForegroundColor Green }
else { Write-Host "Dry run נכשל. דו`"ח: $report" -ForegroundColor Red; exit 1 }
