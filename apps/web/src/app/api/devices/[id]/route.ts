import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { deleteDevice, deviceUpdateSchema, revokeDevice, updateDevice } from "@/server/services/devices";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, { params }) => {
  const admin = await authenticateUser(req, "device.manage");
  const { id } = await params;
  const d = await updateDevice(admin, id, await parseJson(req, deviceUpdateSchema));
  return json({ device: { id: d.id, name: d.name, assignedUserId: d.assignedUserId } });
});

/** Revokes the station (its token stops working immediately) or, with ?purge=1, removes it entirely. */
export const DELETE = route<Ctx>(async (req, { params }) => {
  const admin = await authenticateUser(req, "device.manage");
  const { id } = await params;
  if (new URL(req.url).searchParams.get("purge") === "1") await deleteDevice(admin, id);
  else await revokeDevice(admin, id);
  return json({ ok: true });
});
