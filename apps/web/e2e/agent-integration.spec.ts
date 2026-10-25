import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createCatalog, login, quickAddLot, strip } from "./helpers";

/**
 * Browser ↔ Capture Agent ↔ server, with a real agent process running its
 * built-in simulator camera (Canon EDSDK itself requires hardware).
 * Requires a built agent: `dotnet build apps/capture-agent/AvotCapture.sln`.
 */
const AGENT_EXE = path.resolve(__dirname, "../../capture-agent/src/AvotCapture.Agent/bin/Debug/net10.0-windows/AvotCaptureAgent.exe");
const PORT = 47899;
// a per-user .NET install (dotnet-install.ps1) is found through DOTNET_ROOT
const localDotnet = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "dotnet");
const env = { ...process.env, ...(existsSync(localDotnet) ? { DOTNET_ROOT: localDotnet } : {}) };

test.skip(process.platform !== "win32" || !existsSync(AGENT_EXE), "Capture Agent not built on this machine");

test("capture through the paired Windows agent: lease, live view, per-category shots, verified sync", async ({ page, baseURL }) => {
  const data = mkdtempSync(path.join(tmpdir(), "avot-agent-e2e-"));
  let agent: ChildProcess | null = null;
  let deviceId: string | null = null;
  try {
    await login(page);
    const origin = new URL(baseURL!).origin;
    const code = await page.request.post("/api/devices/pairing-code", { data: { name: `E2E station ${Date.now()}` }, headers: { origin } }).then((r) => r.json());

    const pair = spawnSync(AGENT_EXE, ["--data", data, "--storage", path.join(data, "photos"), "--port", String(PORT), "--camera", "SIMULATOR", "--pair", origin, code.code, "E2E"], { encoding: "utf8", timeout: 60_000, env });
    expect(pair.status, pair.stderr || pair.stdout).toBe(0);

    agent = spawn(AGENT_EXE, ["--data", data, "--headless"], { stdio: "ignore", env });
    await expect.poll(async () => (await fetch(`http://127.0.0.1:${PORT}/v1/hello`, { headers: { origin } }).then((r) => r.json()).catch(() => null))?.paired, { timeout: 30_000 }).toBe(true);

    // point this user's capture screen at the test port
    await page.request.put("/api/preferences/capture", { data: { value: { agentUrl: `http://127.0.0.1:${PORT}`, lastCamera: null } }, headers: { origin } });
    await page.evaluate(() => localStorage.removeItem("avot.capturePrefs"));

    await createCatalog(page, `קטלוג עמדה ${Date.now()}`);
    await quickAddLot(page, "ספר דרך העמדה");
    await page.getByRole("row", { name: /ספר דרך העמדה/ }).getByRole("link", { name: /צילום פריט/ }).click();
    await expect(page).toHaveURL(/\/capture\//);
    const lotId = page.url().split("/capture/")[1]!.split("?")[0]!;

    const picker = page.getByRole("dialog", { name: "בחירת מצלמה" });
    await picker.getByRole("button", { name: /סימולטור Capture Agent/ }).click();
    await expect(page.getByRole("button", { name: "צילום (רווח)" })).toBeEnabled({ timeout: 30_000 });
    await expect(page.locator("img[src*='liveview.mjpg']")).toBeVisible(); // live view stays local (127.0.0.1)

    await page.getByRole("radio", { name: /שער/ }).click();
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press("Space");
      await page.waitForTimeout(700);
    }
    await page.getByRole("radio", { name: /תמונות חוץ/ }).click();
    await page.keyboard.press("Space");

    await expect(page.locator('[data-testid=strip-item][data-category="EXTERIOR"][data-stage="VERIFIED"]')).toHaveCount(1, { timeout: 60_000 });
    await expect
      .poll(async () => (await page.request.get(`/api/lots/${lotId}/assets`).then((r) => r.json())).assets.filter((a: { uploadStatus: string }) => a.uploadStatus === "VERIFIED").length, { timeout: 60_000 })
      .toBe(3);
    await expect(page.getByRole("radio", { name: /שער/ })).toContainText("2");
    const assets = (await page.request.get(`/api/lots/${lotId}/assets`).then((r) => r.json())).assets as { category: string; uploadStatus: string; source: string }[];
    expect(assets.filter((a) => a.category === "TITLE_PAGE")).toHaveLength(2);
    expect(assets.filter((a) => a.category === "EXTERIOR")).toHaveLength(1);
    expect(assets.every((a) => a.uploadStatus === "VERIFIED" && a.source === "SIMULATOR")).toBeTruthy();

    // the station reports its state to the server
    const stations = await page.request.get("/api/devices").then((r) => r.json());
    const hello = await fetch(`http://127.0.0.1:${PORT}/v1/hello`, { headers: { origin } }).then((r) => r.json());
    deviceId = hello.deviceId;
    const station = stations.devices.find((d: { id: string }) => d.id === hello.deviceId);
    expect(station?.online).toBeTruthy();

    // the agent rejects requests that lack a valid control token
    const forged = await fetch(`http://127.0.0.1:${PORT}/v1/status`, { headers: { origin, authorization: "Bearer forged.token", "x-avot-lease": "x" } });
    expect(forged.status).toBe(401);
    const foreign = await fetch(`http://127.0.0.1:${PORT}/v1/status`, { headers: { origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
  } finally {
    agent?.kill();
    if (deviceId) await page.request.delete(`/api/devices/${deviceId}`, { headers: { origin: new URL(baseURL!).origin } });
  }
});
