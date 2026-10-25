import type { Readable } from "node:stream";

export interface PutResult {
  sha256: string;
  sizeBytes: number;
}

export interface ReadUrlOptions {
  filename?: string;
  inline?: boolean;
  contentType?: string;
  expiresInSeconds?: number;
}

/**
 * Durable object storage. Implementations must only resolve `put*` once the
 * bytes are durably stored, and must compute the SHA-256 of the bytes actually
 * written so the caller can verify against the uploader's declared checksum.
 */
export interface ObjectStorage {
  readonly driver: "local" | "s3";
  putStream(key: string, body: Readable, contentType: string): Promise<PutResult>;
  putBuffer(key: string, body: Buffer, contentType: string): Promise<PutResult>;
  getStream(key: string): Promise<Readable>;
  getBuffer(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Short-lived URL the browser can GET directly. */
  readUrl(key: string, opts?: ReadUrlOptions): Promise<string>;
}
