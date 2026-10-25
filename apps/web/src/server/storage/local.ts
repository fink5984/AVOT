import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { signPayload } from "../crypto";
import type { ObjectStorage, PutResult, ReadUrlOptions } from "./types";

/**
 * Local-disk storage for development and tests. Writes go to a temp file in the
 * same directory, are fsync'ed, then atomically renamed into place — a crash
 * never leaves a half-written object under the final key.
 */
export class LocalStorage implements ObjectStorage {
  readonly driver = "local" as const;
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error("Invalid storage key");
    return full;
  }

  async putStream(key: string, body: Readable): Promise<PutResult> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.part-${randomBytes(6).toString("hex")}`;
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(tmp, { flags: "wx" }));
      const fh = await open(tmp, "r+");
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return { sha256: hash.digest("hex"), sizeBytes: size };
  }

  putBuffer(key: string, body: Buffer): Promise<PutResult> {
    return this.putStream(key, Readable.from([body]));
  }

  async getStream(key: string): Promise<Readable> {
    const p = this.resolve(key);
    await stat(p);
    return createReadStream(p);
  }

  getBuffer(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async readUrl(key: string, opts: ReadUrlOptions = {}): Promise<string> {
    const token = signPayload({
      k: key,
      fn: opts.filename,
      inl: opts.inline ?? false,
      ct: opts.contentType,
      exp: Math.floor(Date.now() / 1000) + (opts.expiresInSeconds ?? 300),
    });
    return `/api/files?t=${encodeURIComponent(token)}`;
  }
}
