import type { PhotoCategory } from "@avot/shared";
import type { QualityReport } from "./derivatives";

export interface AssetDto {
  id: string;
  /** owner — the physical book */
  inventoryItemId: string;
  /** provenance: the lot / catalog the shot was taken for (null when shot from inventory) */
  lotId: string | null;
  catalogId: string | null;
  category: PhotoCategory;
  captureId: string;
  sequence: number;
  sortOrder: number;
  isPrimary: boolean;
  displayName: string | null;
  notes: string | null;
  rotation: number;
  crop: { x: number; y: number; w: number; h: number } | null;
  width: number | null;
  height: number | null;
  capturedAt: string;
  source: string;
  cameraName: string | null;
  hasThumb: boolean;
  thumbUrl: string | null;
  previewUrl: string | null;
  processingStatus: string;
  quality: QualityReport | null;
  needsReshoot: boolean;
  reshootNote: string | null;
  deletedAt: string | null;
  createdBy: { id: string; name: string } | null;
  /** worst-case across the shot's files: VERIFIED only when every original is verified */
  uploadStatus: "PENDING" | "UPLOADING" | "VERIFIED" | "FAILED";
  files: { id: string; role: string; mimeType: string; extension: string; sizeBytes: number; uploadStatus: string; sha256: string; originalFilename: string }[];
}

type AssetRow = {
  id: string;
  inventoryItemId: string;
  lotId: string | null;
  catalogId: string | null;
  category: PhotoCategory;
  captureId: string;
  sequence: number;
  sortOrder: number;
  isPrimary: boolean;
  displayName: string | null;
  notes: string | null;
  rotation: number;
  crop: unknown;
  width: number | null;
  height: number | null;
  capturedAt: Date;
  source: string;
  cameraName: string | null;
  thumbKey: string | null;
  processingStatus: string;
  quality: unknown;
  needsReshoot: boolean;
  reshootNote: string | null;
  deletedAt: Date | null;
  createdBy: { id: string; name: string } | null;
  files: { id: string; role: string; mimeType: string; extension: string; sizeBytes: bigint; uploadStatus: string; sha256: string; originalFilename: string }[];
};

const RANK = { FAILED: 0, PENDING: 1, UPLOADING: 2, VERIFIED: 3 } as const;

export function toAssetDto(a: AssetRow): AssetDto {
  const status = a.files.reduce<keyof typeof RANK>(
    (worst, f) => (RANK[f.uploadStatus as keyof typeof RANK] < RANK[worst] ? (f.uploadStatus as keyof typeof RANK) : worst),
    "VERIFIED",
  );
  return {
    id: a.id,
    inventoryItemId: a.inventoryItemId,
    lotId: a.lotId,
    catalogId: a.catalogId,
    category: a.category,
    captureId: a.captureId,
    sequence: a.sequence,
    sortOrder: a.sortOrder,
    isPrimary: a.isPrimary,
    displayName: a.displayName,
    notes: a.notes,
    rotation: a.rotation,
    crop: (a.crop as AssetDto["crop"]) ?? null,
    width: a.width,
    height: a.height,
    capturedAt: a.capturedAt.toISOString(),
    source: a.source,
    cameraName: a.cameraName,
    hasThumb: !!a.thumbKey,
    thumbUrl: a.thumbKey ? `/api/assets/${a.id}/thumb` : null,
    previewUrl: a.thumbKey ? `/api/assets/${a.id}/preview` : null,
    processingStatus: a.processingStatus,
    quality: (a.quality as QualityReport | null) ?? null,
    needsReshoot: a.needsReshoot,
    reshootNote: a.reshootNote,
    deletedAt: a.deletedAt?.toISOString() ?? null,
    createdBy: a.createdBy,
    uploadStatus: a.files.length ? status : "PENDING",
    files: a.files.map((f) => ({ ...f, sizeBytes: Number(f.sizeBytes) })),
  };
}
