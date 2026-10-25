import { readFile } from "node:fs/promises";

/** Minimal ZIP central-directory reader (names only) — enough to assert export structure. */
export default class ZipNames {
  private constructor(private readonly entries: string[]) {}

  static async fromFile(path: string) {
    const buf = await readFile(path);
    // end of central directory record (supports ZIP64 locator by scanning for central headers)
    const names: string[] = [];
    for (let i = 0; i < buf.length - 46; i++) {
      if (buf.readUInt32LE(i) === 0x02014b50) {
        const nameLen = buf.readUInt16LE(i + 28);
        const extraLen = buf.readUInt16LE(i + 30);
        const commentLen = buf.readUInt16LE(i + 32);
        names.push(buf.subarray(i + 46, i + 46 + nameLen).toString("utf8"));
        i += 45 + nameLen + extraLen + commentLen;
      }
    }
    return new ZipNames(names);
  }

  names() {
    return this.entries;
  }
}
