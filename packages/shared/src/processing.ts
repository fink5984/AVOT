import { z } from "zod";

/**
 * Processing settings of a capture profile and the manual corrections of one
 * photo. Shared by the browser (live preview, settings dialog, editor) and the
 * server (final processing), so both always interpret them the same way.
 */

export const ROTATIONS = [0, 90, 180, 270] as const;
export type Rotation = (typeof ROTATIONS)[number];

const rotationSchema = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);

export const bgSampleSchema = z.object({
  h: z.number().min(0).max(360),
  s: z.number().min(0).max(1),
  v: z.number().min(0).max(1),
});
export type BgSample = z.infer<typeof bgSampleSchema>;

export const processingSettingsSchema = z.object({
  /**
   * Clockwise rotation relative to the camera sensor (= the live view frame).
   * 180° is the default for a camera mounted above the table, facing down.
   */
  rotation: rotationSchema.default(180),
  /** turn the green background transparent / into `background` */
  removeBackground: z.boolean().default(true),
  /** shrink the canvas to the smallest rectangle containing the book (+ margin) */
  autoCrop: z.boolean().default(true),
  /** 0..100 — higher treats more green-ish pixels as background */
  sensitivity: z.number().int().min(0).max(100).default(50),
  /**
   * Edge quality of the cut-out. precise = crisp edge, natural = soft matte with the green removed (default),
   * soft = wider feather (worn corners, fabric).
   */
  edgeQuality: z.enum(["precise", "natural", "soft"]).default("natural"),
  /** margin around the book, % of the book's longer side */
  marginPct: z.number().min(0).max(25).default(2),
  /** "transparent" or a #rrggbb colour. Transparent always produces PNG. */
  background: z.string().regex(/^(transparent|#[0-9a-fA-F]{6})$/).default("#ffffff"),
  format: z.enum(["jpeg", "png"]).default("jpeg"),
  jpegQuality: z.number().int().min(70).max(100).default(95),
  /** calibrated background colour (HSV), null = detect from the frame border */
  bgSample: bgSampleSchema.nullable().default(null),
  /** below this detection confidence nothing destructive is done; the shot is flagged for review */
  minConfidence: z.number().min(0).max(1).default(0.6),
  liveMode: z.enum(["processed", "frame", "full"]).default("processed"),
});
export type ProcessingSettings = z.infer<typeof processingSettingsSchema>;
export type EdgeQuality = ProcessingSettings["edgeQuality"];

export const DEFAULT_PROCESSING: ProcessingSettings = processingSettingsSchema.parse({});

const unit = z.number().min(0).max(1);

export const manualEditsSchema = z.object({
  /** normalised rectangle in the rotated image; replaces the automatic crop */
  crop: z.object({ x: unit, y: unit, w: z.number().min(0.01).max(1), h: z.number().min(0.01).max(1) }).nullish(),
  /** brush strokes on the rotated image: erase = background, keep = book */
  strokes: z
    .array(
      z.object({
        mode: z.enum(["erase", "keep"]),
        /** brush radius as a fraction of the longer image side */
        r: z.number().min(0.0005).max(0.2),
        pts: z.array(z.tuple([unit, unit])).min(1).max(4000),
      }),
    )
    .max(300)
    .optional(),
  /** a human looked at the result — accept it even when detection confidence is low */
  confirmed: z.boolean().optional(),
});
export type ManualEdits = z.infer<typeof manualEditsSchema>;

/** What is stored on a photo: the settings snapshot taken at capture time plus later manual corrections. */
export const photoProcessingSchema = z.object({
  settings: processingSettingsSchema,
  edits: manualEditsSchema.optional(),
});
export type PhotoProcessing = z.infer<typeof photoProcessingSchema>;

/** The output format actually written (transparency needs PNG). */
export function effectiveFormat(s: ProcessingSettings): "jpeg" | "png" {
  return s.background === "transparent" ? "png" : s.format;
}

export function parseHexColor(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * EXIF orientation → clockwise rotation (and mirroring) the viewer must apply.
 * Only used to avoid rotating twice: see {@link residualRotation}.
 */
export function exifRotation(orientation: number | undefined | null): Rotation {
  switch (orientation) {
    case 3:
    case 4:
      return 180;
    case 6:
    case 5:
      return 90;
    case 8:
    case 7:
      return 270;
    default:
      return 0;
  }
}

/**
 * The profile rotation is defined against the sensor frame (the same frame the
 * live view shows). A file whose EXIF orientation already turns the picture
 * (e.g. the camera noticed it points down and wrote Orientation=3) is first
 * normalised by the EXIF rotation; only the remainder is applied on top. The
 * net rotation of the pixels therefore always equals the profile rotation —
 * an EXIF-rotated file is never rotated twice.
 */
export function residualRotation(exifOrientation: number | undefined | null, wanted: Rotation): Rotation {
  const done = exifRotation(exifOrientation);
  return ((((wanted - done) % 360) + 360) % 360) as Rotation;
}

/* ---------------- Camera profiles ---------------- */

/** Camera control values the profile restores on connect — only controls the camera reports are ever applied. */
export const cameraProfileSettingsSchema = z.object({
  processing: processingSettingsSchema,
  camera: z.record(z.string().max(60), z.union([z.string().max(100), z.number(), z.boolean()])).default({}),
});
export type CameraProfileSettings = z.infer<typeof cameraProfileSettingsSchema>;

export const cameraProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  settings: cameraProfileSettingsSchema,
  isDefault: z.boolean().optional(),
});
export type CameraProfileInput = z.infer<typeof cameraProfileInputSchema>;

export const DEFAULT_PROFILE_NAME = "ברירת מחדל";

