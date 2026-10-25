import "server-only";
import type { ControlTokenPayload } from "@avot/shared";
import { db } from "../db";
import { decryptSecret, hmacSha256, randomToken, safeEqual } from "../crypto";

/**
 * Control tokens authorise one browser tab to drive one capture station's
 * camera through the agent's 127.0.0.1 API. They are HMAC-signed with the
 * per-device secret created at pairing, so the agent can verify them offline.
 */
export function signControlToken(secret: string, payload: ControlTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmacSha256(secret, body)}`;
}

export async function issueControlToken(opts: {
  deviceId: string;
  orgId: string;
  userId: string;
  userName: string;
  origin: string;
  ttlSeconds?: number;
}): Promise<{ token: string; expiresAt: number }> {
  const device = await db.device.findFirst({
    where: { id: opts.deviceId, organizationId: opts.orgId, revokedAt: null },
  });
  if (!device) throw new Error("device not found");
  const exp = Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 8 * 60 * 60);
  const payload: ControlTokenPayload = {
    v: 1,
    deviceId: device.id,
    orgId: opts.orgId,
    userId: opts.userId,
    userName: opts.userName,
    origin: opts.origin,
    exp,
    nonce: randomToken(9),
  };
  return { token: signControlToken(decryptSecret(device.secretEnc), payload), expiresAt: exp };
}

/**
 * Verifies a token presented by the agent with an upload. Expiry is NOT
 * enforced here on purpose: an offline queue may upload hours after the shot;
 * the token only attributes the shot to the user who pressed capture.
 */
export async function verifyControlTokenForAttribution(
  token: string,
  deviceId: string,
): Promise<ControlTokenPayload | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const device = await db.device.findUnique({ where: { id: deviceId } });
  if (!device) return null;
  if (!safeEqual(sig, hmacSha256(decryptSecret(device.secretEnc), body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ControlTokenPayload;
    return payload.deviceId === deviceId ? payload : null;
  } catch {
    return null;
  }
}
