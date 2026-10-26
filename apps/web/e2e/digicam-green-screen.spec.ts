import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { leatherFill, renderScene, roundedRect } from "../test/imaging-fixtures";
import { login } from "./helpers";

/**
 * Full chain with everything real except the camera driver: browser ↔ real Capture Agent process
 * (DIGICAM mode) ↔ real web server + database + storage + background jobs. digiCamControl itself
 * is replaced by a protocol mock (its documented web API), so this proves the AVOT side — NOT that a
 * real digiCamControl / EOS R7 behaves the same. Hardware checks: docs/hardware-acceptance.md.
 *
 * Needs a built agent: `dotnet build apps/capture-agent/AvotCapture.sln`.
 */
const AGENT_EXE = path.resolve(__dirname, "../../capture-agent/src/AvotCapture.Agent/bin/Debug/net10.0-windows/AvotCaptureAgent.exe");
const AGENT_PORT = 47898;
const DCC_PORT = 55513;
const localDotnet = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "dotnet");
const env = { ...process.env, ...(existsSync(localDotnet) ? { DOTNET_ROOT: localDotnet } : {}) };

test.skip(process.platform !== "win32" || !existsSync(AGENT_EXE), "Capture Agent not built on this machine");

const W = 1200;
const H = 800;
const BOOK = { x: 330, y: 70, w: 520, h: 660 };

/** Book on a green table, seen by the sensor: a 5-bit shot id (black / white squares) and a red corner marker. */
async function shotJpeg(id: number, size = { w: W, h: H }): Promise<Buffer> {
  const sx = size.w / W;
  const lf = leatherFill(BOOK.x, BOOK.y);
  const scene = renderScene({
    width: size.w,
    height: size.h,
    outline: roundedRect(BOOK.x * sx, BOOK.y * sx, BOOK.w * sx, BOOK.h * sx, 16 * sx, 6),
    seed: id,
    fill: (x, y) => {
      const ux = x / sx;
      const uy = y / sx;
      if (uy > BOOK.y + 30 && uy < BOOK.y + 70 && ux > BOOK.x + 30 && ux < BOOK.x + 30 + 5 * 50) return (id >> Math.floor((ux - BOOK.x - 30) / 50)) & 1 ? [250, 250, 250] : [10, 10, 10];
      if (ux > BOOK.x + 30 && ux < BOOK.x + 90 && uy > BOOK.y + 100 && uy < BOOK.y + 160) return [220, 20, 20];
      return lf(ux, uy);
    },
  });
  return sharp(Buffer.from(scene.rgb), { raw: { width: size.w, height: size.h, channels: 3 } }).jpeg({ quality: 94, chromaSubsampling: "4:4:4" }).toBuffer();
}

/** Minimal digiCamControl web server (documented single-command API) that "photographs" prepared JPEGs. */
class MockDcc {
  folder = "";
  cameras = ["Canon EOS R7 (mock)"];
  live = false;
  shot = 0;
  props: Record<string, { options: string[]; current: string }> = {
    iso: { options: ["100", "200", "400", "800"], current: "100" },
    aperture: { options: ["f/5.6", "f/8", "f/11"], current: "f/8" },
    compressionsetting: { options: ["JPEG Large Fine", "RAW"], current: "JPEG Large Fine" },
  };
  readonly log: string[] = [];
  readonly sha: string[] = [];
  private server: http.Server | null = null;
  constructor(private readonly shots: Buffer[], private readonly liveFrame: Buffer) {}

  start() {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${DCC_PORT}`);
      this.log.push(decodeURIComponent(url.pathname + url.search));
      const text = (s: string) => res.writeHead(200, { "content-type": "text/plain" }).end(s);
      if (url.pathname === "/liveview.jpg") return this.live ? res.writeHead(200, { "content-type": "image/jpeg" }).end(this.liveFrame) : res.writeHead(200).end();
      const cmd = url.searchParams.get("CMD");
      if (cmd) {
        if (cmd === "LiveViewWnd_Show") this.live = true;
        if (cmd === "LiveViewWnd_Hide") this.live = false;
        return text("OK");
      }
      const p1 = url.searchParams.get("param1") ?? "";
      const p2 = url.searchParams.get("param2") ?? "";
      switch (url.searchParams.get("slc")) {
        case "list":
          return text(p1 === "cameras" ? this.cameras.join("\n") : p1 === "cmds" ? "LiveView_Focus\nLiveView_Capture" : (this.props[p1]?.options.join("\n") ?? ""));
        case "get":
          return text(this.props[p1]?.current ?? "");
        case "set":
          if (p1 === "session.folder") {
            this.folder = p2;
            return text("OK");
          }
          if (p1 === "transfer") return text("OK");
          if (this.props[p1]?.options.includes(p2)) {
            this.props[p1]!.current = p2;
            return text("OK");
          }
          return text("Error: unknown parameter");
        case "capture":
        case "capturenoaf": {
          if (!this.cameras.length) return text("Error: no camera");
          const jpg = this.shots[this.shot % this.shots.length]!;
          this.shot++;
          this.sha.push(createHash("sha256").update(jpg).digest("hex"));
          const file = path.join(this.folder, `DSC_${String(this.shot).padStart(4, "0")}.JPG`);
          setTimeout(() => writeFileSync(file, jpg), 150);
          return text("OK");
        }
        default:
          return text("Error: unknown command");
      }
    });
    return new Promise<void>((resolve) => this.server!.listen(DCC_PORT, "127.0.0.1", resolve));
  }
  stop() {
    this.server?.close();
  }
}

async function decodeMarker(buf: Buffer, rotated180: boolean): Promise<{ id: number; redAtBottomRight: boolean; corner: number[] }> {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3));
  const margin = Math.round(0.02 * BOOK.h);
  let id = 0;
  for (let bit = 0; bit < 5; bit++) {
    const dx = 30 + bit * 50 + 25;
    const x = rotated180 ? info.width - 1 - (margin + dx) : margin + dx;
    const y = rotated180 ? info.height - 1 - (margin + 50) : margin + 50;
    if (px(x, y)[0]! > 128) id |= 1 << bit;
  }
  const rx = rotated180 ? info.width - 1 - (margin + 60) : margin + 60;
  const ry = rotated180 ? info.height - 1 - (margin + 130) : margin + 130;
  const [r, g, b] = px(rx, ry);
  return { id, redAtBottomRight: rotated180 && r! > 180 && g! < 90 && b! < 90, corner: px(2, 2) };
}

async function assetsOf(page: Page, itemId: string) {
  return (await page.request.get(`/api/lots/${itemId}/assets`).then((r) => r.json())).assets as {
    id: string;
    category: string;
    uploadStatus: string;
    source: string;
    sequence: number;
    processed: { state: string; hasFile: boolean; width: number | null; height: number | null; settings: { rotation: number } | null } | null;
    files: { sha256: string }[];
  }[];
}

test("digiCamControl provider end to end: rotated processed live view, 6 rapid shots, crop + background removal, settings that persist, USB unplug", async ({ page, baseURL }) => {
  test.setTimeout(420_000);
  const data = mkdtempSync(path.join(tmpdir(), "avot-digicam-e2e-"));
  const origin = new URL(baseURL!).origin;
  const shots = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => shotJpeg(i)));
  const mock = new MockDcc(shots, await shotJpeg(31, { w: 640, h: 427 }));
  let agent: ChildProcess | null = null;
  let deviceId: string | null = null;
  try {
    await mock.start();
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(data, "settings.json"), JSON.stringify({ DigiCamUrl: `http://127.0.0.1:${DCC_PORT}`, DigiCamAutoLaunch: false, CameraMode: "DIGICAM" }));

    await login(page);
    const code = await page.request.post("/api/devices/pairing-code", { data: { name: `E2E digicam ${Date.now()}` }, headers: { origin } }).then((r) => r.json());
    const pair = spawnSync(AGENT_EXE, ["--data", data, "--storage", path.join(data, "photos"), "--port", String(AGENT_PORT), "--camera", "DIGICAM", "--pair", origin, code.code, "E2E digicam"], { encoding: "utf8", timeout: 60_000, env });
    expect(pair.status, pair.stderr || pair.stdout).toBe(0);
    agent = spawn(AGENT_EXE, ["--data", data, "--headless"], { stdio: "ignore", env });
    const hello = () => fetch(`http://127.0.0.1:${AGENT_PORT}/v1/hello`, { headers: { origin } }).then((r) => r.json()).catch(() => null);
    await expect.poll(async () => (await hello())?.camera?.kind === "DIGICAM" && (await hello())?.camera?.connected, { timeout: 40_000 }).toBe(true);
    deviceId = (await hello()).deviceId;

    // a clean profile: the default (180°, remove background, crop, white)
    for (const p of await page.request.get("/api/camera-profiles").then((r) => r.json()).then((j) => j.profiles as { id: string; isDefault: boolean }[])) {
      if (!p.isDefault) await page.request.delete(`/api/camera-profiles/${p.id}`, { headers: { origin } });
      else {
        const processing = { rotation: 180, removeBackground: true, autoCrop: true, sensitivity: 50, marginPct: 2, background: "#ffffff", format: "jpeg", jpegQuality: 95, bgSample: null, minConfidence: 0.6, liveMode: "processed" };
        await page.request.patch(`/api/camera-profiles/${p.id}`, { data: { settings: { processing, camera: {} } }, headers: { origin } });
      }
    }
    await page.request.put("/api/preferences/capture", { data: { value: { agentUrl: `http://127.0.0.1:${AGENT_PORT}`, lastCamera: null, activeProfileId: null, sound: false } }, headers: { origin } });
    await page.evaluate(() => localStorage.removeItem("avot.capturePrefs"));

    const itemRes = await page.request.post("/api/inventory", { data: { title: `Digicam book ${Math.random().toString(36).slice(2)}`, author: `Author ${Math.random().toString(36).slice(2)}` }, headers: { origin } });
    const item = await itemRes.json();
    expect(itemRes.ok(), JSON.stringify(item)).toBe(true);
    const itemId = item.item.id as string;
    await page.goto(`/capture/${itemId}?category=COVER`);

    // ── camera choice: the agent's digiCamControl camera
    const picker = page.getByRole("dialog", { name: "בחירת מצלמה" });
    await expect(picker).toBeVisible();
    await picker.getByRole("button", { name: /Canon EOS R7 \(mock\)/ }).click();
    await expect(page.getByTestId("live-segmentation")).toBeVisible({ timeout: 40_000 });

    // ── live view: rotated 180° on the display side, processed (green hidden, white background)
    const rotated = await page.getByTestId("live-segmentation").evaluate((c) => (c.parentElement as HTMLElement).style.transform);
    expect(rotated).toContain("rotate(180deg)");
    await expect
      .poll(async () => page.getByTestId("live-segmentation").evaluate((c: HTMLCanvasElement) => {
        const px = c.getContext("2d")!.getImageData(3, 3, 1, 1).data;
        return `${px[0]},${px[1]},${px[2]}`;
      }), { timeout: 30_000 })
      .toBe("255,255,255");
    await expect(page.getByTestId("live-low-confidence")).toHaveCount(0);

    // ── six shots in a row, switching category while shooting (keys 1..4)
    const plan = ["COVER", "TITLE_PAGE", "INTERIOR", "EXTERIOR", "INTERIOR", "COVER"] as const;
    const keys = { COVER: "1", TITLE_PAGE: "2", INTERIOR: "3", EXTERIOR: "4" } as const;
    for (const cat of plan) {
      await page.keyboard.press(keys[cat]);
      await page.keyboard.press("Space");
      await page.waitForTimeout(900);
    }
    await expect(page.getByTestId("strip-item")).toHaveCount(0 + 6, { timeout: 5_000 }).catch(() => undefined); // strip may be filtered by category
    await expect.poll(async () => (await assetsOf(page, itemId)).filter((a) => a.uploadStatus === "VERIFIED").length, { timeout: 120_000 }).toBe(6);
    await expect.poll(async () => (await assetsOf(page, itemId)).filter((a) => a.processed?.state === "DONE").length, { timeout: 180_000 }).toBe(6);

    const assets = (await assetsOf(page, itemId)).sort((a, b) => a.sequence - b.sequence);
    expect(assets.map((a) => a.category)).toEqual([...plan]); // association survived rapid category switching
    for (const [i, a] of assets.entries()) {
      expect(a.source).toBe("DIGICAMCONTROL");
      expect(a.files[0]!.sha256).toBe(mock.sha[i]); // the stored original is exactly what the camera produced
      expect(a.processed?.hasFile).toBe(true);
      expect(a.processed?.settings?.rotation).toBe(180);
      const processed = await page.request.get(`/api/assets/${a.id}/processed`).then((r) => r.body());
      const meta = await sharp(processed).metadata();
      expect(Math.abs(meta.width! - BOOK.w * 1.04)).toBeLessThan(24); // cropped to the book (+ 2 % margin each side)
      expect(Math.abs(meta.height! - BOOK.h * 1.04)).toBeLessThan(24);
      const m = await decodeMarker(processed, true);
      expect(m.id, `shot ${i + 1}`).toBe(i + 1); // its own picture, rotated in the pixels
      expect(m.redAtBottomRight).toBe(true);
      expect(m.corner.every((v) => v > 240)).toBe(true); // white background, no green
    }

    // ── manual correction: restore the original, then it is processed again from the camera file
    const first = assets[0]!;
    const restored = await page.request.post(`/api/assets/${first.id}/process`, { data: { restore: true }, headers: { origin } }).then((r) => r.json());
    expect(restored.asset.processed).toBeNull();
    const orig = await page.request.get(`/api/assets/${first.id}/original`).then((r) => r.body());
    expect(createHash("sha256").update(orig).digest("hex")).toBe(mock.sha[0]);

    // ── settings dialog: reachable while shooting, applies at once, persists across reloads
    await page.getByRole("button", { name: "הגדרות מצלמה ועיבוד" }).click();
    const dlg = page.getByRole("dialog", { name: "הגדרות מצלמה" });
    await expect(dlg.getByRole("radio", { name: "180°" })).toHaveAttribute("aria-checked", "true");
    await dlg.getByLabel("ISO").selectOption("400");
    await expect.poll(() => mock.props.iso!.current).toBe("400"); // the camera's own control, supported options only
    await expect(dlg.getByLabel("איזון לבן")).toHaveCount(0); // not reported by the camera → not shown
    await dlg.getByRole("button", { name: "שמירת הגדרות המצלמה הנוכחיות בפרופיל" }).click();
    await dlg.getByRole("radio", { name: "שקוף (PNG)" }).click();
    await dlg.getByRole("radio", { name: "מסגרת חיתוך" }).click();
    await expect.poll(async () => (await page.request.get("/api/camera-profiles").then((r) => r.json())).profiles[0].settings.processing.background, { timeout: 15_000 }).toBe("transparent");
    await dlg.getByRole("button", { name: "סגירה" }).last().click();

    mock.props.iso!.current = "100"; // another session / the dial changed it meanwhile
    await page.reload();
    await expect(page.getByRole("dialog", { name: "בחירת מצלמה" })).toHaveCount(0).catch(() => undefined);
    await expect.poll(() => mock.props.iso!.current, { timeout: 40_000 }).toBe("400"); // profile restored into the camera on connect

    // the next shot uses the transparent PNG profile
    await page.keyboard.press("Space");
    await expect.poll(async () => (await assetsOf(page, itemId)).filter((a) => a.processed?.state === "DONE" && a.processed.settings).length, { timeout: 120_000 }).toBeGreaterThan(5);
    const latest = (await assetsOf(page, itemId)).sort((a, b) => b.sequence - a.sequence)[0]!;
    const png = await page.request.get(`/api/assets/${latest.id}/processed`);
    expect(png.headers()["content-type"]).toBe("image/png");
    expect((await sharp(await png.body()).metadata()).hasAlpha).toBe(true);

    // ── USB unplug: clear status, no shot accepted, automatic reconnection, shooting resumes
    const before = (await assetsOf(page, itemId)).length;
    mock.cameras = [];
    await expect(page.getByText("מנותק", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Space");
    await page.waitForTimeout(1000);
    expect((await assetsOf(page, itemId)).length).toBe(before);
    mock.cameras = ["Canon EOS R7 (mock)"];
    await expect.poll(async () => (await hello())?.camera?.connected, { timeout: 40_000 }).toBe(true);
    await expect(page.getByTestId("live-segmentation")).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Space");
    await expect.poll(async () => (await assetsOf(page, itemId)).length, { timeout: 90_000 }).toBe(before + 1);
  } finally {
    agent?.kill();
    mock.stop();
    if (deviceId) await page.request.delete(`/api/devices/${deviceId}`, { headers: { origin } });
  }
});
