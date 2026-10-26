import { cameraProfileInputSchema } from "@avot/shared";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { deleteProfile, updateProfile } from "@/server/services/camera-profiles";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "photo.capture");
  const { id } = await params;
  return json({ profile: await updateProfile(user, id, await parseJson(req, cameraProfileInputSchema.partial())) });
});

export const DELETE = route<Ctx>(async (req, { params }) => {
  const user = await authenticateUser(req, "photo.capture");
  const { id } = await params;
  await deleteProfile(user, id);
  return json({ ok: true });
});
