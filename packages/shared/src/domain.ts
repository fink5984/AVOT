/**
 * Stable domain keys. These strings are persisted in the database and in the
 * Capture Agent's local store, so they must never be renamed. Display names
 * live in the i18n dictionaries, not here.
 */

export const PHOTO_CATEGORIES = ["COVER", "TITLE_PAGE", "INTERIOR", "EXTERIOR"] as const;
export type PhotoCategory = (typeof PHOTO_CATEGORIES)[number];

/** Folder slug used in ZIP exports and in the agent's local folder tree. */
export const CATEGORY_SLUG: Record<PhotoCategory, string> = {
  COVER: "cover",
  TITLE_PAGE: "title-page",
  INTERIOR: "interior",
  EXTERIOR: "exterior",
};

export const ROLES = ["ADMIN", "EDITOR", "PHOTOGRAPHER", "WAREHOUSE", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

export const LOT_STATUSES = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "PENDING_REVIEW",
  "COMPLETED",
  "NEEDS_RESHOOT",
] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];

export const CATALOG_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

export const CAPTURE_SOURCES = ["WEBCAM", "CANON_EDSDK", "DIGICAMCONTROL", "SIMULATOR", "IMPORT"] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export const FILE_ROLES = ["PRIMARY", "RAW"] as const;
export type FileRole = (typeof FILE_ROLES)[number];

export const UPLOAD_STATUSES = ["PENDING", "UPLOADING", "VERIFIED", "FAILED"] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

/**
 * Client-side lifecycle of a single capture. Each stage is shown separately in
 * the UI — a shot is never presented as "saved in the cloud" before the server
 * confirmed the SHA-256 of every original file.
 */
export const CAPTURE_STAGES = [
  "CAPTURING", // shutter command sent, waiting for image data
  "SAVED_LOCAL", // original durably written on this machine (IndexedDB / agent disk)
  "QUEUED", // waiting for upload (offline, backoff…)
  "UPLOADING",
  "VERIFIED", // server stored it and verified the checksum
  "FAILED", // capture itself failed — nothing was stored
  "NEEDS_ATTENTION", // stored locally but upload keeps failing / checksum mismatch
] as const;
export type CaptureStage = (typeof CAPTURE_STAGES)[number];

/** Default per-category requirements for a new lot. */
export interface CategoryRequirement {
  required: boolean;
  min: number;
}
export type CategoryRequirements = Record<PhotoCategory, CategoryRequirement>;

export const DEFAULT_REQUIREMENTS: CategoryRequirements = {
  COVER: { required: true, min: 1 },
  TITLE_PAGE: { required: true, min: 1 },
  INTERIOR: { required: true, min: 1 },
  EXTERIOR: { required: false, min: 0 },
};

/** Formats the lot number for folders and labels: 7 → "007". */
export function padLotNumber(n: number, width = 3): string {
  return String(n).padStart(width, "0");
}

export const ACCEPTED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/tiff"] as const;
export const RAW_EXTENSIONS = ["cr3", "cr2", "dng"] as const;

/* ───────────── Phase 2: inventory, auction houses, warehouse ───────────── */

/** Photography workflow of a physical copy (same keys as the legacy lot status). */
export const PHOTO_STATUSES = LOT_STATUSES;
export type PhotoStatus = LotStatus;

export const PHYSICAL_STATUSES = ["AWAITING_STORAGE", "IN_STORAGE", "AWAITING_PICK", "PICKED", "PACKED", "SHIPPED", "MISSING"] as const;
export type PhysicalStatus = (typeof PHYSICAL_STATUSES)[number];

export const COMMERCIAL_STATUSES = ["UNASSIGNED", "ASSIGNED", "OFFERED", "SOLD", "UNSOLD", "WITHDRAWN"] as const;
export type CommercialStatus = (typeof COMMERCIAL_STATUSES)[number];
/** outcomes that end a catalog assignment */
export const ENDING_COMMERCIAL_STATUSES = ["SOLD", "UNSOLD", "WITHDRAWN"] as const satisfies readonly CommercialStatus[];

export const BOOK_SIZES = ["UNKNOWN", "SMALL", "MEDIUM", "LARGE", "OVERSIZE"] as const;
export type BookSize = (typeof BOOK_SIZES)[number];

export const SCAN_MODES = ["STORE", "TRANSFER", "FIND", "PICK", "COUNT"] as const;
export type ScanMode = (typeof SCAN_MODES)[number];

export const PICK_STATUSES = ["OPEN", "PICKED", "PACKED", "SHIPPED", "CANCELLED"] as const;
export type PickStatus = (typeof PICK_STATUSES)[number];

/** The numbering scheme: the public inventory number is INVENTORY_BASE + serial (1 → 10000001). Digits only, any length. */
export const INVENTORY_BASE = 10_000_000n;
/** 35 → "10000035". Digits only, brand-neutral, never changes when the book moves between houses or catalogs. */
export function formatInventoryNumber(serial: number | bigint): string {
  return String(INVENTORY_BASE + BigInt(serial));
}

/** Pre-numeric tag format ("ITM-000035"); kept so printed tags keep working (aliases in the database). */
export const LEGACY_INVENTORY_PREFIX = "ITM-";
export function formatLegacyInventoryNumber(serial: number | bigint): string {
  return `${LEGACY_INVENTORY_PREFIX}${String(serial).padStart(6, "0")}`;
}
/** True for the current numeric format. */
export const isInventoryNumber = (v: string) => /^\d{8,19}$/.test(v);

/**
 * Location code of a shelf from its hierarchy: warehouse W1, column C4, shelf 04 → "LOC-W1-C4-04". There is no cell
 * level. The code is only the scannable value; workers see formatLocationLabel().
 */
export function formatLocationCode(parts: { warehouse?: string | null; zone: string; shelf: string }): string {
  const seg = (v: string) => v.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return ["LOC", ...(parts.warehouse ? [seg(parts.warehouse)] : []), seg(parts.zone), seg(parts.shelf)].join("-");
}

const plainNumber = (code: string) => (/^\d+$/.test(code) ? String(Number(code)) : code);

/**
 * THE way a place is shown to people, everywhere: "מחסן 1 · עמודה 4 · מדף 4". Real names, no codes, no cells.
 * The server and every screen use this one function (the server wraps it for database rows).
 */
export function formatLocationLabel(parts: { warehouseName: string; zoneName?: string | null; zoneCode: string; shelfCode: string }): string {
  return [parts.warehouseName, parts.zoneName?.trim() || `עמודה ${plainNumber(parts.zoneCode)}`, `מדף ${plainNumber(parts.shelfCode)}`].join(" · ");
}

/**
 * Column (zone) identification label: "COL-C1" / "COL-W2-C1". It is NOT a place a book can be put on —
 * scanners tell the worker to scan a shelf instead (a book must always get an exact shelf).
 */
export function formatZoneCode(parts: { warehouse?: string | null; zone: string }): string {
  const seg = (v: string) => v.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return ["COL", ...(parts.warehouse ? [seg(parts.warehouse)] : []), seg(parts.zone)].join("-");
}

/** Work-mode command barcodes. They only switch the scanner UI — every action is still authorised by the server. */
export const COMMAND_CODES = {
  "CMD-STORE": "STORE",
  "CMD-TRANSFER": "TRANSFER",
  "CMD-FIND": "FIND",
  "CMD-COUNT": "COUNT",
  "CMD-PICK": "PICK",
} as const satisfies Record<string, ScanMode>;
export type CommandCode = keyof typeof COMMAND_CODES;

export type ScannedCode =
  | { type: "ITEM"; value: string }
  | { type: "LOCATION"; value: string }
  /** a warehouse column label — identifies a column, never a shelf */
  | { type: "ZONE"; value: string }
  | { type: "COMMAND"; value: CommandCode; mode: ScanMode }
  /** legacy catalog label (QR with AVOT-LOT:<uuid> or /l/<uuid>) */
  | { type: "LOT"; value: string }
  | { type: "UNKNOWN"; value: string };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Classifies raw scanner output. Keyboard-wedge scanners may add whitespace,
 * control characters or a lowercase keyboard layout — all normalised here.
 */
export function classifyCode(raw: string): ScannedCode {
  // eslint-disable-next-line no-control-regex
  const v = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const up = v.toUpperCase();
  if (up in COMMAND_CODES) return { type: "COMMAND", value: up as CommandCode, mode: COMMAND_CODES[up as CommandCode] };
  // legacy printed tag "ITM-000035" (value normalised to 6 digits; resolved through the alias table)
  if (/^ITM-\d{1,9}$/.test(up)) return { type: "ITEM", value: formatLegacyInventoryNumber(Number(up.slice(4))) };
  // current numeric inventory number (also matches long external numeric barcodes: the lookup treats both alike)
  if (/^\d{8,19}$/.test(v)) return { type: "ITEM", value: v };
  if (/^LOC(-[A-Z0-9]+){2,5}$/.test(up)) return { type: "LOCATION", value: up };
  if (/^COL(-[A-Z0-9]+){1,2}$/.test(up)) return { type: "ZONE", value: up };
  const lot = v.match(new RegExp(`(?:AVOT-LOT:|/l/)(${UUID})`, "i"));
  if (lot) return { type: "LOT", value: lot[1]!.toLowerCase() };
  return { type: "UNKNOWN", value: v };
}
