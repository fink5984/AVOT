import "server-only";
import { env } from "../env";
import { LocalStorage } from "./local";
import { S3Storage } from "./s3";
import type { ObjectStorage } from "./types";

export type { ObjectStorage } from "./types";

let instance: ObjectStorage | undefined;

export function storage(): ObjectStorage {
  if (instance) return instance;
  const e = env();
  instance =
    e.STORAGE_DRIVER === "s3"
      ? new S3Storage({
          endpoint: e.S3_ENDPOINT,
          region: e.S3_REGION,
          bucket: e.S3_BUCKET!,
          accessKeyId: e.S3_ACCESS_KEY_ID!,
          secretAccessKey: e.S3_SECRET_ACCESS_KEY!,
          forcePathStyle: e.S3_FORCE_PATH_STYLE,
        })
      : new LocalStorage(e.STORAGE_LOCAL_DIR);
  return instance;
}

/** Storage key layout. Opaque UUIDs only — no guessable or personal data in keys. */
export const keys = {
  original: (orgId: string, assetId: string, role: string, ext: string) =>
    `orgs/${orgId}/originals/${assetId}/${role.toLowerCase()}.${ext}`,
  thumb: (orgId: string, assetId: string) => `orgs/${orgId}/derived/${assetId}/thumb.webp`,
  preview: (orgId: string, assetId: string) => `orgs/${orgId}/derived/${assetId}/preview.jpg`,
  export: (orgId: string, jobId: string) => `orgs/${orgId}/exports/${jobId}.zip`,
};
