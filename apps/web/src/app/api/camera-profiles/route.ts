import { cameraProfileInputSchema } from "@avot/shared";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { createProfile, listProfiles } from "@/server/services/camera-profiles";

export const GET = route(async (req) => {
  const user = await authenticateUser(req, "photo.capture");
  return json({ profiles: await listProfiles(user.organizationId) });
});

export const POST = route(async (req) => {
  const user = await authenticateUser(req, "photo.capture");
  return json({ profile: await createProfile(user, await parseJson(req, cameraProfileInputSchema)) }, { status: 201 });
});
