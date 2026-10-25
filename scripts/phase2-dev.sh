#!/usr/bin/env sh
# Development server for Phase 2 testing against the migrated COPY of the dev
# database (avot_studio_phase2, created by migration-dry-run.ps1 -KeepCopy) and
# a copy of local storage. The original dev database is not touched.
cd "$(dirname "$0")/../apps/web" || exit 1
BASE=$(grep '^DATABASE_URL=' .env.local | sed 's/^DATABASE_URL="//; s/?.*//; s/"$//')
export DATABASE_URL="${BASE%/*}/avot_studio_phase2?schema=public"
export STORAGE_LOCAL_DIR=".data/storage-phase2"
export APP_URL="http://localhost:${PORT:-3100}"
exec npx next dev -p "${PORT:-3100}"
