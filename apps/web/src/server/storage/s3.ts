import "server-only";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage, PutResult, ReadUrlOptions } from "./types";

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/**
 * S3-compatible storage (Cloudflare R2, AWS S3, …). Large bodies go through
 * lib-storage's managed multipart upload (8 MiB parts, retried per part), so
 * RAW files never sit fully in memory.
 */
export class S3Storage implements ObjectStorage {
  readonly driver = "s3" as const;
  private readonly client: S3Client;

  constructor(private readonly cfg: S3Config) {
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint || undefined,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async putStream(key: string, body: Readable, contentType: string): Promise<PutResult> {
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    body.on("error", (e) => meter.destroy(e));
    body.pipe(meter);
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.cfg.bucket, Key: key, Body: meter, ContentType: contentType },
      partSize: 8 * 1024 * 1024,
      queueSize: 4,
      leavePartsOnError: false,
    });
    await upload.done();
    return { sha256: hash.digest("hex"), sizeBytes: size };
  }

  putBuffer(key: string, body: Buffer, contentType: string): Promise<PutResult> {
    return this.putStream(key, Readable.from([body]), contentType);
  }

  async getStream(key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty body for ${key}`);
    return res.Body as Readable;
  }

  async getBuffer(key: string): Promise<Buffer> {
    const stream = await this.getStream(key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return true;
    } catch (err) {
      if (err instanceof NotFound || (err as { name?: string }).name === "NotFound") return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }

  readUrl(key: string, opts: ReadUrlOptions = {}): Promise<string> {
    const disposition = opts.filename
      ? `${opts.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(opts.filename)}`
      : undefined;
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        ResponseContentDisposition: disposition,
        ResponseContentType: opts.contentType,
      }),
      { expiresIn: opts.expiresInSeconds ?? 300 },
    );
  }
}
