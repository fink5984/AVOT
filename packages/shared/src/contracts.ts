import { z } from "zod";
import { CAPTURE_SOURCES, FILE_ROLES, PHOTO_CATEGORIES, SCAN_MODES } from "./domain";
import { processingSettingsSchema } from "./processing";

/**
 * Wire contracts shared by the web server, the browser capture screen and
 * (mirrored in C#) the Windows Capture Agent. Bump API_VERSION on breaking change.
 * Documented in docs/api-contracts.md.
 */
export const API_VERSION = 1;

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, "sha256 must be lowercase hex");

export const captureFileSchema = z.object({
  role: z.enum(FILE_ROLES),
  originalFilename: z.string().min(1).max(255),
  mimeType: z.string().min(3).max(100),
  sizeBytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
  sha256: sha256Hex,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type CaptureFileInput = z.infer<typeof captureFileSchema>;

/**
 * Step 1 of an upload: register the shot. Idempotent on `captureId` — repeating
 * the call returns the same asset and the files' current upload state.
 */
export const registerCaptureSchema = z.object({
  captureId: z.string().uuid(),
  /**
   * Capture target. Photos belong to the inventory item; `lotId` (catalog
   * context) is kept for provenance and for the Capture Agent, which sends a
   * single opaque target id in `lotId` — the server accepts a lot id or an
   * inventory item id there (API v1 stays compatible).
   */
  inventoryItemId: z.string().uuid().optional(),
  lotId: z.string().uuid().optional(),
  category: z.enum(PHOTO_CATEGORIES),
  source: z.enum(CAPTURE_SOURCES),
  capturedAt: z.string().datetime(),
  sessionId: z.string().uuid().optional(),
  cameraName: z.string().max(200).optional(),
  exif: z.record(z.string(), z.unknown()).optional(),
  files: z.array(captureFileSchema).min(1).max(2),
  /** Agent uploads: the browser-issued control token, proves which user pressed capture. */
  controlToken: z.string().max(2000).optional(),
  /**
   * Green-screen processing settings frozen when the shutter was pressed (rotation,
   * background removal, crop …). Absent → the organization's default profile applies.
   */
  processing: processingSettingsSchema.optional(),
}).refine((v) => v.inventoryItemId || v.lotId, { message: "inventoryItemId or lotId is required", path: ["inventoryItemId"] });
export type RegisterCaptureInput = z.infer<typeof registerCaptureSchema>;

export interface RegisteredFile {
  fileId: string;
  role: (typeof FILE_ROLES)[number];
  uploadStatus: "PENDING" | "UPLOADING" | "VERIFIED" | "FAILED";
  /** Relative URL for `PUT` of the raw bytes. */
  uploadUrl: string;
}

export interface RegisterCaptureResponse {
  assetId: string;
  captureId: string;
  sequence: number;
  files: RegisteredFile[];
}

export interface UploadFileResponse {
  fileId: string;
  assetId: string;
  uploadStatus: "VERIFIED";
  sha256: string;
  sizeBytes: number;
}

/* ---------------- Agent ↔ server ---------------- */

export const pairDeviceSchema = z.object({
  code: z.string().regex(/^\d{8}$/),
  name: z.string().min(1).max(100),
  machineName: z.string().max(200),
  agentVersion: z.string().max(50),
  apiVersion: z.number().int(),
});

export const heartbeatSchema = z.object({
  agentVersion: z.string().max(50),
  apiVersion: z.number().int(),
  cameraKind: z.enum(["CANON", "DIGICAM", "SIMULATOR", "NONE"]),
  cameraModel: z.string().max(200).nullable(),
  cameraConnected: z.boolean(),
  storagePath: z.string().max(500),
  freeDiskBytes: z.number().int().nonnegative(),
  pendingUploads: z.number().int().nonnegative(),
  failedUploads: z.number().int().nonnegative(),
  lastSyncAt: z.string().datetime().nullable(),
  lastError: z.string().max(2000).nullable(),
  controllingUserId: z.string().uuid().nullable(),
});
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;

/* ---------------- Browser ↔ local agent ---------------- */

/** Payload signed (HMAC-SHA256 with the device secret) into a control token. */
export interface ControlTokenPayload {
  v: 1;
  deviceId: string;
  orgId: string;
  userId: string;
  userName: string;
  origin: string;
  /** unix seconds */
  exp: number;
  nonce: string;
}

export const agentCaptureRequestSchema = z.object({
  captureId: z.string().uuid(),
  lotId: z.string().uuid(),
  catalogId: z.string().uuid(),
  category: z.enum(PHOTO_CATEGORIES),
  lotNumber: z.number().int(),
  catalogNumber: z.string().max(50),
  sessionId: z.string().uuid().optional(),
  /** processing settings of the active profile, frozen with the shot */
  processing: processingSettingsSchema.optional(),
});
export type AgentCaptureRequest = z.infer<typeof agentCaptureRequestSchema>;

/* ---------------- Warehouse scanner ↔ server ---------------- */

/**
 * One scan from a handheld. `opId` is generated on the device at scan time and
 * is the idempotency key: re-sending (retry, offline queue flush, double
 * submit) never applies an operation twice.
 */
export const scanOpSchema = z.object({
  opId: z.string().uuid(),
  mode: z.enum(SCAN_MODES),
  code: z.string().trim().min(1).max(200),
  /** active location on the device when the book was scanned (STORE / TRANSFER / COUNT) */
  contextLocationId: z.string().uuid().nullish(),
  countSessionId: z.string().uuid().nullish(),
  /** device clock when the scan happened */
  clientAt: z.string().datetime(),
  /** true when the op was queued offline and is being synced late */
  deferred: z.boolean().optional(),
  deviceLabel: z.string().max(100).optional(),
});
export type ScanOpInput = z.infer<typeof scanOpSchema>;

export const scanBatchSchema = z.object({ ops: z.array(scanOpSchema).min(1).max(200) });

export type ScanOutcome = "OK" | "NOOP" | "ERROR" | "CONFLICT";

export interface ScanResponse {
  opId: string;
  result: ScanOutcome;
  /** Hebrew, shown on the handheld */
  message: string;
  /** succeeded, but the worker should look (e.g. counted book is recorded elsewhere) */
  warning?: boolean;
  codeType: "ITEM" | "LOCATION" | "COMMAND" | "LOT" | "UNKNOWN";
  /** the device should make this its active location */
  activeLocation?: { id: string; code: string; label: string } | null;
  item?: {
    id: string;
    inventoryNumber: string;
    title: string;
    thumbUrl: string | null;
    location: { id: string; code: string; label: string } | null;
    physicalStatus: string;
    commercialStatus: string;
    photoStatus: string;
    assignment: { house: string; catalogNumber: string; lotNumber: number } | null;
    allowed: string[];
  } | null;
  /** an earlier response for the same opId was replayed */
  replayed?: boolean;
  pick?: { taskId: string; remaining: number } | null;
  count?: { sessionId: string; scannedInLocation: number } | null;
}
