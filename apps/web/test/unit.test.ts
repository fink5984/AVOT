import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { registerCaptureSchema } from "@avot/shared";
import { safeSegment, uniqueName } from "@/server/services/filenames";
import { parseLotsCsv } from "@/server/services/csv-import";
import { can } from "@/server/auth/permissions";
import { hashPassword, verifyPassword, passwordProblem } from "@/server/auth/password";
import { decryptSecret, encryptSecret, signPayload, verifySignedPayload } from "@/server/crypto";
import { signControlToken } from "@/server/services/control-token";
import { lotIdFromCode } from "@/server/services/search";
import { contentDisposition } from "@/server/http";
import { isTypingTarget, keyLabel } from "@/lib/capture/prefs";

describe("ZIP / file names", () => {
  it("removes characters Windows forbids and keeps Hebrew", () => {
    expect(safeSegment('נועם אלימלך: "ליוורנו" / תקמ*ח?')).toBe("נועם אלימלך ליוורנו תקמ ח");
    expect(safeSegment("CON")).toBe("_CON");
    expect(safeSegment("name...")).toBe("name");
    expect(safeSegment("‮evil")).toBe("evil");
  });
  it("de-duplicates names case-insensitively", () => {
    const used = new Set<string>();
    expect(uniqueName("Lot-001", used)).toBe("Lot-001");
    expect(uniqueName("lot-001", used)).toBe("lot-001 (2)");
  });
  it("encodes Hebrew download names per RFC 5987", () => {
    expect(contentDisposition("קטלוג.zip")).toContain("filename*=UTF-8''%D7%A7");
  });
});

describe("CSV import parsing", () => {
  it("accepts Hebrew headers, validates rows and detects duplicate numbers", () => {
    const csv = "﻿מספר,שם ספר,מחבר\n1,נועם אלימלך,ר' אלימלך מליז'נסק\n,שולחן ערוך,\n1,כפול,\nx,מספר שגוי,\n,,\n";
    const r = parseLotsCsv(csv);
    expect(r.rows.map((x) => x.title)).toEqual(["נועם אלימלך", "שולחן ערוך"]);
    expect(r.rows[0]!.author).toBe("ר' אלימלך מליז'נסק");
    expect(r.errors.map((e) => e.line)).toEqual([4, 5]);
  });
  it("reports unknown columns", () => {
    expect(parseLotsCsv("title,price\nא,5\n").unknownColumns).toEqual(["price"]);
  });
});

describe("permissions", () => {
  it("matches the role matrix of the specification", () => {
    expect(can("VIEWER", "photo.capture")).toBe(false);
    expect(can("VIEWER", "photo.download")).toBe(true);
    expect(can("PHOTOGRAPHER", "photo.capture")).toBe(true);
    expect(can("PHOTOGRAPHER", "lot.edit")).toBe(false);
    expect(can("EDITOR", "export.create")).toBe(true);
    expect(can("EDITOR", "user.manage")).toBe(false);
    expect(can("ADMIN", "catalog.delete")).toBe(true);
  });
});

describe("crypto", () => {
  it("hashes and verifies passwords with scrypt", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(passwordProblem("short")).not.toBeNull();
  });
  it("round-trips encrypted device secrets", () => {
    const enc = encryptSecret("s3cr3t");
    expect(enc).not.toContain("s3cr3t");
    expect(decryptSecret(enc)).toBe("s3cr3t");
  });
  it("signed download links expire and resist tampering", () => {
    const t = signPayload({ k: "key", exp: Math.floor(Date.now() / 1000) + 60 });
    expect(verifySignedPayload<{ k: string; exp: number }>(t)?.k).toBe("key");
    expect(verifySignedPayload(t.replace(/^./, "x"))).toBeNull();
    expect(verifySignedPayload(signPayload({ k: "key", exp: 1 }))).toBeNull();
  });
  it("control tokens use the HMAC format the C# agent verifies", () => {
    const token = signControlToken("secret", { v: 1, deviceId: "d", orgId: "o", userId: "u", userName: "n", origin: "http://localhost:3000", exp: 1, nonce: "x" });
    const [body, sig] = token.split(".");
    expect(sig).toBe(createHmac("sha256", "secret").update(body!).digest("base64url"));
  });
});

describe("capture contract", () => {
  const base = {
    captureId: "6f1d1c7e-9a7e-4b6a-9a37-8b2b1f0c1a11",
    lotId: "0b7c3a4e-1d2f-4e5a-8b6c-7d8e9f0a1b2c",
    category: "TITLE_PAGE",
    source: "WEBCAM",
    capturedAt: new Date().toISOString(),
    files: [{ role: "PRIMARY", originalFilename: "a.jpg", mimeType: "image/jpeg", sizeBytes: 100, sha256: "a".repeat(64) }],
  };
  it("accepts a valid registration and rejects bad checksums / categories", () => {
    expect(registerCaptureSchema.safeParse(base).success).toBe(true);
    expect(registerCaptureSchema.safeParse({ ...base, category: "BACK" }).success).toBe(false);
    expect(registerCaptureSchema.safeParse({ ...base, files: [{ ...base.files[0], sha256: "XYZ" }] }).success).toBe(false);
  });
});

describe("labels & shortcuts", () => {
  it("extracts lot ids from scanned QR payloads", () => {
    const id = "0b7c3a4e-1d2f-4e5a-8b6c-7d8e9f0a1b2c";
    expect(lotIdFromCode(`https://studio.avot.co.il/l/${id}`)).toBe(id);
    expect(lotIdFromCode(`AVOT-LOT:${id.toUpperCase()}`)).toBe(id);
    expect(lotIdFromCode("נועם אלימלך")).toBeNull();
  });
  it("labels key codes independent of keyboard layout", () => {
    expect(keyLabel("KeyN")).toBe("N");
    expect(keyLabel("Digit3")).toBe("3");
    expect(keyLabel("Space")).toBe("רווח");
  });
  it("treats checkboxes as non-typing targets but text inputs as typing", () => {
    // minimal DOM stand-ins
    class FakeInput {
      type: string;
      constructor(t: string) {
        this.type = t;
      }
    }
    (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement = FakeInput;
    expect(isTypingTarget(new FakeInput("checkbox") as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(new FakeInput("text") as unknown as EventTarget)).toBe(true);
  });
});

describe("camera scan gate (no double reads)", () => {
  it("reports a code once while it stays in view, a different code at once, the same code again after it left and the cooldown passed", async () => {
    const { createCodeGate } = await import("@/lib/scanner/camera");
    let t = 1_000;
    const gate = createCodeGate(2500, 900, () => t);
    expect(gate("ITM-000001")).toBe(true);
    for (let i = 0; i < 20; i++) {
      t += 110; // ~20 consecutive frames of the same barcode
      expect(gate("ITM-000001")).toBe(false);
    }
    t += 100;
    expect(gate("ITM-000002")).toBe(true); // next book immediately
    t += 100;
    expect(gate("ITM-000001")).toBe(true); // A → B → A is three real scans
    t += 1_000; // out of view
    expect(gate("ITM-000001")).toBe(false); // still inside the 2.5 s cooldown after its last report
    t += 1_500;
    expect(gate("ITM-000001")).toBe(true); // shown again on purpose
  });
});

describe("capture desktop update manifest", () => {
  it("tells a station about a newer version only, with a verified-download description", async () => {
    const { releaseSchema, updateAnswer, compareVersions } = await import("@/server/services/agent-release");
    const rel = releaseSchema.parse({ version: "1.2.0", url: "https://files.example.com/AvotCaptureDesktop-Setup-1.2.0.exe", sha256: "A".repeat(64), sizeBytes: 123, minVersion: "1.0.0" });
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(updateAnswer(rel, "1.1.0")).toMatchObject({ updateAvailable: true, latest: "1.2.0", sha256: "a".repeat(64), mandatory: false });
    expect(updateAnswer(rel, "0.9.0")).toMatchObject({ updateAvailable: true, mandatory: true });
    expect(updateAnswer(rel, "1.2.0")).toEqual({ updateAvailable: false, latest: "1.2.0", mandatory: false });
    expect(updateAnswer(null, "1.0.0")).toEqual({ updateAvailable: false, latest: null });
  });
  it("refuses plain-http installers and malformed hashes", async () => {
    const { releaseSchema } = await import("@/server/services/agent-release");
    expect(releaseSchema.safeParse({ version: "1.0.0", url: "http://evil.example.com/x.exe", sha256: "a".repeat(64) }).success).toBe(false);
    expect(releaseSchema.safeParse({ version: "1.0.0", url: "https://ok.example.com/x.exe", sha256: "xyz" }).success).toBe(false);
  });
});

describe("agent heartbeat payload", () => {
  it("accepts the body a station sends when it has no camera model / last error / sync time yet (nulls omitted)", async () => {
    const { heartbeatSchema } = await import("@avot/shared");
    const body = { agentVersion: "0.2.1", apiVersion: 1, cameraKind: "CANON", cameraConnected: true, storagePath: "C:\\Photos", freeDiskBytes: 38_000_000_000, pendingUploads: 0, failedUploads: 0 };
    expect(heartbeatSchema.safeParse(body).success).toBe(true);
    expect(heartbeatSchema.safeParse({ ...body, cameraModel: null, lastSyncAt: null, lastError: null, controllingUserId: null }).success).toBe(true);
    expect(heartbeatSchema.safeParse({ ...body, freeDiskBytes: -1 }).success).toBe(false);
  });
});