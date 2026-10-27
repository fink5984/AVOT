import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/*
 * Release manifest of AVOT Capture Desktop (the Windows capture station software).
 * Source, in order: env AGENT_RELEASE_MANIFEST (JSON) → public/updates/capture-desktop.json.
 * `build-installer.ps1 -Publish` prints the manifest for the build it just made. The installer file itself
 * is hosted wherever `url` points (R2 / the web app) over HTTPS; the station verifies SHA-256 (and, when a
 * signer thumbprint is pinned, the Authenticode signature) before running anything.
 */
export const releaseSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  url: z.string().url().refine((u) => u.startsWith("https://") || u.startsWith("http://localhost") || u.startsWith("http://127.0.0.1"), "https only"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  sizeBytes: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
  /** stations older than this must update before they sync again (breaking API changes) */
  minVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  /** pinned Authenticode signer thumbprint (SHA-1 hex); when set the station refuses unsigned / differently signed installers */
  signerThumbprint: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
});
export type AgentRelease = z.infer<typeof releaseSchema>;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export async function loadRelease(): Promise<AgentRelease | null> {
  try {
    const raw = process.env.AGENT_RELEASE_MANIFEST ?? (await readFile(path.join(process.cwd(), "public", "updates", "capture-desktop.json"), "utf8"));
    const parsed = releaseSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** What a station running `current` is told. */
export function updateAnswer(release: AgentRelease | null, current: string) {
  if (!release) return { updateAvailable: false as const, latest: null };
  const newer = compareVersions(release.version, current) > 0;
  return {
    updateAvailable: newer,
    latest: release.version,
    mandatory: !!release.minVersion && compareVersions(current, release.minVersion) < 0,
    ...(newer ? { url: release.url, sha256: release.sha256.toLowerCase(), sizeBytes: release.sizeBytes ?? null, notes: release.notes ?? null, signerThumbprint: release.signerThumbprint?.toLowerCase() ?? null } : {}),
  };
}
