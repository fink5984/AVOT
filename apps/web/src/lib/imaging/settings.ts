// Single source of truth lives in the shared package (it is also part of the register contract).
export {
  ROTATIONS,
  DEFAULT_PROCESSING,
  bgSampleSchema,
  processingSettingsSchema,
  manualEditsSchema,
  photoProcessingSchema,
  effectiveFormat,
  parseHexColor,
  exifRotation,
  residualRotation,
} from "@avot/shared";
export type { Rotation, BgSample, ProcessingSettings, ManualEdits, PhotoProcessing } from "@avot/shared";

