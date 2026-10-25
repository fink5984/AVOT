// API smoke test against a running dev server.
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";

const BASE = process.env.BASE ?? "http://localhost:3000";
let cookie = "";
async function call(path, { method = "GET", json, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    redirect: "manual",
    headers: { origin: BASE, cookie, ...(json ? { "content-type": "application/json" } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text.slice(0, 200); }
  return { status: res.status, data, headers: res.headers };
}
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } else console.log("ok  ", m); };

let r = await call("/api/auth/login", { method: "POST", json: { email: "admin@avot.local", password: "wrong-password" } });
assert(r.status === 401, "wrong password rejected");
r = await call("/api/auth/login", { method: "POST", json: { email: "admin@avot.local", password: "Avot-Dev-2026!" } });
assert(r.status === 200 && cookie, "login");

r = await call("/api/catalogs", { method: "POST", json: { number: "S" + Date.now().toString().slice(-6), name: "קטלוג בדיקה" } });
assert(r.status === 201, "create catalog");
const catalogId = r.data.catalog.id;

r = await call(`/api/catalogs/${catalogId}/lots`, { method: "POST", json: { title: "נועם אלימלך" } });
assert(r.status === 201 && r.data.lot.lotNumber === 1, "create lot with auto number 1");
const lotId = r.data.lot.id;
r = await call(`/api/catalogs/${catalogId}/lots`, { method: "POST", json: { title: "ספר שני" } });
assert(r.data.lot.lotNumber === 2, "second lot gets number 2");

// CSRF: mutation without Origin must fail
const noOrigin = await fetch(BASE + `/api/catalogs/${catalogId}/lots`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) });
assert(noOrigin.status === 403, "mutation without Origin rejected (CSRF)");

const jpeg = await sharp({ create: { width: 3200, height: 2400, channels: 3, background: { r: 200, g: 180, b: 150 } } })
  .composite([{ input: Buffer.from(`<svg width="3200" height="2400"><text x="200" y="600" font-size="300">TEST</text></svg>`) }])
  .jpeg({ quality: 90 }).toBuffer();
const sha = createHash("sha256").update(jpeg).digest("hex");
const captureId = randomUUID();
const reg = { captureId, lotId, category: "TITLE_PAGE", source: "WEBCAM", capturedAt: new Date().toISOString(), files: [{ role: "PRIMARY", originalFilename: "t.jpg", mimeType: "image/jpeg", sizeBytes: jpeg.length, sha256: sha, width: 3200, height: 2400 }] };
r = await call("/api/captures", { method: "POST", json: reg });
assert(r.status === 200 && r.data.sequence === 1, "register capture");
const fileId = r.data.files[0].fileId;
r = await call("/api/captures", { method: "POST", json: reg });
assert(r.status === 200 && r.data.files[0].fileId === fileId, "register is idempotent");
r = await call("/api/captures", { method: "POST", json: { ...reg, category: "COVER" } });
assert(r.status === 409, "same captureId with other category rejected");

// corrupted upload → checksum mismatch, stays not verified
const bad = Buffer.from(jpeg); bad[bad.length - 10] ^= 0xff;
r = await call(`/api/files/${fileId}/content`, { method: "PUT", body: bad, headers: { "content-type": "image/jpeg" } });
assert(r.status === 422, "corrupted bytes rejected by SHA-256 check");
r = await call(`/api/files/${fileId}/content`, { method: "PUT", body: jpeg, headers: { "content-type": "image/jpeg" } });
assert(r.status === 200 && r.data.uploadStatus === "VERIFIED", "upload verified");
r = await call(`/api/files/${fileId}/content`, { method: "PUT", body: jpeg, headers: { "content-type": "image/jpeg" } });
assert(r.status === 200, "repeat upload is a no-op");

r = await call(`/api/lots/${lotId}/assets`);
const a = r.data.assets[0];
assert(r.data.assets.length === 1 && a.category === "TITLE_PAGE" && a.uploadStatus === "VERIFIED", "one verified asset in TITLE_PAGE");
assert(a.thumbUrl && a.width === 3200, "thumbnail generated, dimensions recorded");
r = await call(a.thumbUrl);
assert(r.status === 200 && r.headers.get("content-type") === "image/webp", "thumbnail served");
r = await call(`/api/assets/${a.id}/original`);
assert(r.status === 200, "original served to authorised user");

const anon = await fetch(BASE + a.thumbUrl);
assert(anon.status === 401, "anonymous access to image denied");

r = await call("/api/assets/delete", { method: "POST", json: { assetIds: [a.id] } });
r = await call(`/api/lots/${lotId}/assets`);
assert(r.data.assets.length === 0, "soft delete hides asset");
r = await call("/api/assets/restore", { method: "POST", json: { assetIds: [a.id] } });
r = await call(`/api/lots/${lotId}/assets`);
assert(r.data.assets.length === 1, "restore brings it back");

r = await call("/api/exports", { method: "POST", json: { scope: "lot", lotId } });
assert(r.status === 202, "export job queued");
const jobId = r.data.job.id;
let job;
for (let i = 0; i < 40; i++) {
  await new Promise((res) => setTimeout(res, 1000));
  job = (await call(`/api/exports/${jobId}`)).data.job;
  if (job.status === "SUCCEEDED" || job.status === "FAILED") break;
}
assert(job.status === "SUCCEEDED", `export job finished (${job.status} ${job.error ?? ""})`);
r = await call(`/api/exports/${jobId}/download`);
assert(r.status === 302, "export download redirects to signed link");
const zipRes = await fetch(BASE + r.headers.get("location"));
const zip = Buffer.from(await zipRes.arrayBuffer());
assert(zip.subarray(0, 2).toString() === "PK" && zip.includes(Buffer.from("Lot-001/title-page/L001-title-page-001.jpg")), "zip contains Lot-001/title-page/L001-title-page-001.jpg");

r = await call(`/api/search?q=${encodeURIComponent("אלימלך")}`);
assert(r.data.lots.some((l) => l.id === lotId), "Hebrew search finds the lot");
console.log("\nALL SMOKE CHECKS PASSED");
