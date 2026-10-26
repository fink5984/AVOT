# API contracts (v1)

Shared schemas: `packages/shared/src/contracts.ts` (Zod). The C# agent mirrors them in `AvotCapture.Core`. Bump `API_VERSION` on breaking changes; the server rejects pairing from a different API version and the agent reports its version in every heartbeat.

Errors are always `{ "error": { "code": string, "message": string (Hebrew), "details"?: any } }` with codes `UNAUTHENTICATED 401, FORBIDDEN 403, BAD_ORIGIN 403, NOT_FOUND 404, CONFLICT 409, VALIDATION 400, CHECKSUM_MISMATCH 422, PAYLOAD_TOO_LARGE 413, RATE_LIMITED 429, INTERNAL 500`.

Authentication: browser — `avot_session` cookie (HttpOnly, SameSite=Lax, Secure on HTTPS) and, for cookie-authenticated mutations, an `Origin` header equal to the app origin (CSRF). Agent — `Authorization: Bearer <deviceToken>`.

## Capture upload protocol (browser and agent)

### 1. `POST /api/captures` — register a shot (idempotent)
```json
{
  "captureId": "uuid (client generated at shutter time)",
  "lotId": "uuid", "category": "COVER|TITLE_PAGE|INTERIOR|EXTERIOR",
  "source": "WEBCAM|CANON_EDSDK|SIMULATOR|IMPORT",
  "capturedAt": "ISO-8601", "sessionId": "uuid?", "cameraName": "string?", "exif": {},
  "controlToken": "agent only — attributes the shot to the user who pressed capture",
  "files": [{ "role": "PRIMARY|RAW", "originalFilename": "IMG_0001.JPG", "mimeType": "image/jpeg",
              "sizeBytes": 12345678, "sha256": "64 lowercase hex", "width": 6960, "height": 4640 }]
}
```
→ `200 { assetId, captureId, sequence, files: [{ fileId, role, uploadStatus, uploadUrl }] }`.
Same `captureId` again → same answer. Same `captureId` with a different book/category → `409`.

**Phase 2:** photos belong to the inventory book. Send `inventoryItemId` (and optionally `lotId` for provenance). `lotId` alone is still accepted and may hold **either a lot id or an inventory id** — this is how the Capture Agent (API v1, unchanged) targets a book; for an inventory book the browser sends `catalogNumber: "INV"` and `lotNumber: <serial>` in the agent context, so the agent's local folders become `Catalog-INV/Lot-000184`.

### 2. `PUT {uploadUrl}` (`/api/files/{fileId}/content`) — raw bytes, streamed
The server streams into object storage while hashing. Stored SHA-256 and size must equal the declared values, otherwise the object is deleted and `422 CHECKSUM_MISMATCH` is returned. Success: `200 { fileId, assetId, uploadStatus: "VERIFIED", sha256, sizeBytes }`. Repeating a verified upload returns 200 without rewriting. Thumbnails/previews are generated after every file of the shot is verified.

### 3. `GET /api/captures/{captureId}` — reconciliation
Returns the registration response (current per-file status) or 404.

## Agent ↔ server

| Method | Path | Auth | Body / result |
|---|---|---|---|
| POST | `/api/agent/pair` | — (rate limited) | `{ code (8 digits), name, machineName, agentVersion, apiVersion }` → `{ deviceId, organizationId, deviceToken, deviceSecret, name }` (code: single use, 15 min) |
| POST | `/api/agent/heartbeat` | device | `{ agentVersion, apiVersion, cameraKind, cameraModel, cameraConnected, storagePath, freeDiskBytes, pendingUploads, failedUploads, lastSyncAt, lastError, controllingUserId }` → `{ serverTime, apiVersion, name, revoked }` |
| POST | `/api/captures`, PUT `/api/files/{id}/content` | device | as above |

## Browser → server (selection)

`POST /api/devices/{id}/control-token` (photo.capture) → `{ token, expiresAt }` where
`token = base64url(JSON payload) + "." + base64url(HMAC-SHA256(deviceSecret, base64urlPayload))`,
payload `{ v:1, deviceId, orgId, userId, userName, origin, exp (unix s), nonce }`.

Other routes: catalogs, lots (+ `/assets`, `/capture-context`, `/categories/{c}`, `/duplicate`, `/move`), assets (`PATCH`, `/primary`, `/thumb`, `/preview`, `/original?role=RAW&download=1`, `/reorder`, `/move`, `/delete`, `/restore`), exports (`POST`, `GET /{id}`, `GET /{id}/download` → 302 signed URL), users, devices, preferences, search, health. Each handler is in `apps/web/src/app/api/**/route.ts`.

## Local agent API — `http://127.0.0.1:47800` (port configurable)

All responses `Cache-Control: no-store`. CORS: only the paired server origin (`/v1/hello` also answers any origin while unpaired). Requests whose `Host` is not `127.0.0.1:<port>`/`localhost:<port>` → 421.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/hello` | — | `{ product:"avot-capture-agent", version, apiVersion, paired, deviceId, deviceName, serverOrigin, camera:{kind,model,connected} }` |
| POST | `/v1/session` | `{ token }` | verifies control token (signature, device, expiry, Origin) → `{ leaseId, expiresInSeconds:30 }`; another user holds the lease → 409 |
| POST | `/v1/release` | token + lease | ends the lease, stops live view |
| GET | `/v1/status` | token + lease | camera status (only controls the camera reports as settable), queue, disk `{freeBytes, level: ok|low|critical}` |
| GET | `/v1/events?since=n` | token + lease | `{ cursor, events:[{ seq, type:"capture"|"camera", captureId, stage, lotId, category, error, external, hasThumb, assetId }] }` (`since=-1` → current cursor only) |
| POST | `/v1/context` | token + lease | active lot/category for the camera's own shutter button |
| POST | `/v1/capture` | token + lease | `{ captureId, lotId, catalogId, category, lotNumber, catalogNumber, sessionId? }` → `202 { captureId, stage }` once the shutter fired. 503 camera disconnected · 507 disk below minimum · 409 busy |
| POST | `/v1/settings` | token + lease | `{ id, value }` — ids from `/v1/status` controls only |
| POST | `/v1/autofocus` | token + lease | |
| GET | `/v1/liveview.mjpg?k=<leaseId>` | lease id | `multipart/x-mixed-replace` JPEG frames ≤15 fps |
| GET | `/v1/captures/{id}/thumb?k=<leaseId>` | lease id | 480px JPEG of the local original |

Headers for "token + lease": `Authorization: Bearer <controlToken>`, `X-Avot-Lease: <leaseId>`. A lease expires after 30 s without requests; a superseded lease (same user, newer tab) gets `409 TAKEN_OVER`.

## עיבוד תמונות ספר — תוספות (תאימות אחורה מלאה, API v1)
- `POST /api/captures` — שדה אופציונלי `processing` (`ProcessingSettings`, `packages/shared/src/processing.ts`): ההגדרות שקפאו ברגע הלחיצה. חסר → פרופיל ברירת המחדל של הארגון אם קיים, אחרת ללא עיבוד. `source` חדש: `DIGICAMCONTROL`.
- Heartbeat: `cameraKind` יכול להיות `DIGICAM`. בקשות `/v1/capture` ו-`/v1/context` ב-Agent מקבלות אובייקט `processing` אופציונלי (≤ 4KB, מועבר לשרת כמו שהוא).
- `GET/POST /api/camera-profiles`, `PATCH/DELETE /api/camera-profiles/{id}` (photo.capture) — `{ name, settings: { processing, camera }, isDefault? }`; פרופיל ברירת מחדל אחד לארגון (נוצר בשימוש הראשון).
- `AssetDto.processed` = `{ state: QUEUED|PREVIEW_READY|DONE|NEEDS_REVIEW|FAILED, hasFile, mime, width, height, confidence, warnings[], settings, edits }` (null לתמונה שלא עובדה). `thumbUrl`/`previewUrl` מציגים כבר את המעובד.
- `GET /api/assets/{id}/processed[?download=1]` — קובץ מעובד ברזולוציה מלאה (photo.download). `GET /api/assets/{id}/original` נשאר המקור ללא שינוי.
- `POST /api/assets/{id}/process` (photo.organize) — `{ settings?: Partial<ProcessingSettings>, edits?: { crop?: {x,y,w,h}|null, strokes?: [...] }, restore?: true }` → `{ asset }`.
- `GET /api/assets/{id}/edit-source?rotation=` — עותק עבודה מסובב (≈1400px) לעורך התיקון.
- ייצוא: `variant: "processed"`, ו-`catalog-jpeg` מבוסס על המעובד כשקיים.

## Phase 2 routes (selection)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET/POST | `/api/inventory` | inventory.view / inventory.create | list (`view`, `q`, `house`, `sort`, `page`) / receive a book |
| GET/PATCH | `/api/inventory/{id}` | inventory.view / inventory.edit (`photoStatus`: lot.status) | |
| POST | `/api/inventory/{id}/assign` | catalog.assign | `{ catalogId, lotNumber?, title?, shortDescription?, description?, replaceActive?, endOutcome? }` → 409 with `details.activeLot` if already assigned |
| POST | `/api/inventory/bulk-assign`, `/api/inventory/import` | catalog.assign / inventory.import | |
| GET/POST | `/api/inventory/{id}/location` | warehouse.view / warehouse.manage | suggestions / manual correction |
| POST | `/api/lots/{id}/commercial` | commercial.edit | `{ status: ASSIGNED|OFFERED|SOLD|UNSOLD|WITHDRAWN }`; SOLD creates a pick task |
| POST | `/api/catalogs/{id}/close` | commercial.edit | active lots → UNSOLD, catalog archived |
| POST | `/api/lots/{id}/display` | lot.edit | hide/show a photo in this lot, or `{ reset: true }` |
| POST | `/api/scan`, `/api/scan/batch` | warehouse.operate (FIND: warehouse.view) | `scanOpSchema`; idempotent on `opId` |
| GET/POST | `/api/scan/events`, `/api/scan/events/{id}/resolve` | warehouse.view / warehouse.manage | conflict review |
| GET/POST | `/api/picks`, `/api/picks/{id}/{packed|shipped|cancel}` | warehouse.view / pick.fulfil / pick.manage | |
| GET/POST | `/api/counts`, `/api/counts/{id}`, `/api/counts/{id}/{submit|approve|cancel}` | warehouse.* | approve applies only the selected corrections |
| GET/POST | `/api/warehouse`, `/zones`, `/shelves`, `/locations` | warehouse.view / warehouse.manage | |
| GET | `/api/labels/zpl?items=…&locations=…&size=50x25` | label.print | ZPL II |
| GET/PATCH | `/api/houses`, `/api/houses/{id}` | catalog.view / house.manage | |

`GET /api/lots/{id}` keeps its v1 shape: `primaryAssetId` is the effective primary photo (lot override, else the book's) and `status` the book's photography status.
