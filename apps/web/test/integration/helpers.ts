import { db } from "@/server/db";
import type { DevicePrincipal, UserPrincipal } from "@/server/auth/principal";
import { createPairingCode, pairDevice } from "@/server/services/devices";
import { API_VERSION } from "@avot/shared";

export const hasDb = !!process.env.IT_DATABASE_URL;

/** A throw-away organization with an admin, an editor, a photographer and a warehouse user. */
export async function makeOrg(tag: string) {
  const org = await db.organization.create({ data: { name: `IT ${tag}`, slug: `it-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}` } });
  const mk = async (role: "ADMIN" | "EDITOR" | "PHOTOGRAPHER" | "WAREHOUSE" | "VIEWER") => {
    const u = await db.user.create({ data: { organizationId: org.id, email: `${role.toLowerCase()}-${org.slug}@example.test`, name: role, role } });
    return { kind: "user", userId: u.id, organizationId: org.id, role, name: role, email: u.email, houseIds: null } as unknown as UserPrincipal;
  };
  const house = await db.auctionHouse.create({ data: { organizationId: org.id, slug: "avot", name: "אבות" } });
  const house2 = await db.auctionHouse.create({ data: { organizationId: org.id, slug: "tavin", name: "טבין", sortOrder: 1 } });
  return { org, house, house2, admin: await mk("ADMIN"), editor: await mk("EDITOR"), photographer: await mk("PHOTOGRAPHER"), warehouse: await mk("WAREHOUSE"), viewer: await mk("VIEWER") };
}

/** Pairs a device of the given kind the way the real agent does. */
export async function pairAgent(admin: UserPrincipal, kind: "CAPTURE" | "PRINT", name = "agent"): Promise<DevicePrincipal> {
  const { code } = await createPairingCode(admin, name, undefined, kind);
  const paired = await pairDevice({ code, name, machineName: "IT-PC", agentVersion: "0.0.0-it", apiVersion: API_VERSION });
  return { kind: "device", deviceId: paired.deviceId, organizationId: paired.organizationId, deviceName: paired.name };
}
