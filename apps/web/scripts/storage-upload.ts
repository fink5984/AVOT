/**
 * Copies the local development storage (STORAGE_LOCAL_DIR, default .data/storage)
 * to S3 / Cloudflare R2 under the SAME object keys, so a database moved to a
 * server keeps pointing at existing files. Existing objects with the same size
 * are skipped; nothing is deleted on either side.
 *
 *   S3_ENDPOINT=… S3_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… npx tsx scripts/storage-upload.ts [--dry-run]
 *
 * Afterwards the check `--verify` compares every PhotoFile.storageKey in the
 * database (DATABASE_URL) with the bucket and reports missing / size-mismatched objects.
 */
import { readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";

const dir = path.resolve(process.env.STORAGE_LOCAL_DIR ?? ".data/storage");
const bucket = process.env.S3_BUCKET;
const dryRun = process.argv.includes("--dry-run");
const verify = process.argv.includes("--verify");
if (!bucket || !process.env.S3_ENDPOINT || !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) {
  console.error("נדרשים S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY");
  process.exit(2);
}
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? "auto",
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
});

async function remoteSize(key: string): Promise<number | null> {
  try {
    return (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentLength ?? null;
  } catch {
    return null;
  }
}

async function* walk(d: string): AsyncGenerator<string> {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

async function upload() {
  let uploaded = 0;
  let skipped = 0;
  let bytes = 0;
  for await (const file of walk(dir)) {
    const key = path.relative(dir, file).split(path.sep).join("/");
    if (key.endsWith(".tmp") || key.includes("/.tmp")) continue;
    const size = (await stat(file)).size;
    if ((await remoteSize(key)) === size) {
      skipped++;
      continue;
    }
    if (!dryRun) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(file), ContentLength: size }));
      if ((await remoteSize(key)) !== size) throw new Error(`size mismatch after upload: ${key}`);
    }
    uploaded++;
    bytes += size;
    if (uploaded % 50 === 0) console.log(`… ${uploaded} files`);
  }
  console.log(`${dryRun ? "[dry-run] would upload" : "uploaded"} ${uploaded} files (${(bytes / 1024 / 1024).toFixed(1)} MB), ${skipped} already present`);
}

async function check() {
  const db = new PrismaClient();
  const files = await db.photoFile.findMany({ where: { uploadStatus: "VERIFIED" }, select: { storageKey: true, sizeBytes: true } });
  const assets = await db.photoAsset.findMany({ select: { thumbKey: true, previewKey: true } });
  await db.$disconnect();
  let missing = 0;
  for (const f of files) {
    const size = await remoteSize(f.storageKey);
    if (size !== Number(f.sizeBytes)) {
      missing++;
      console.log(`✘ ${f.storageKey} (${size === null ? "חסר" : `גודל ${size} ≠ ${f.sizeBytes}`})`);
    }
  }
  const derived = assets.flatMap((a) => [a.thumbKey, a.previewKey]).filter((k): k is string => !!k);
  let missingDerived = 0;
  for (const k of derived) if ((await remoteSize(k)) === null) missingDerived++;
  console.log(`מקורות: ${files.length - missing}/${files.length} תקינים · תמונות מוקטנות חסרות: ${missingDerived}/${derived.length} (נוצרות מחדש אוטומטית)`);
  if (missing) process.exitCode = 1;
}

(verify ? check() : upload()).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
