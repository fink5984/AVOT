import { z } from "zod";
import { authenticateUser } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { getSettingsScreen, restoreAiSettingsVersion } from "@/server/ai/settings";

/** Puts an earlier settings version back as a NEW version. */
export const POST = route(async (req) => {
  const user = await authenticateUser(req, "ai.settings");
  const { version } = await parseJson(req, z.object({ version: z.number().int().min(1) }));
  const saved = await restoreAiSettingsVersion(user, version);
  return json({ ...saved, screen: await getSettingsScreen(user.organizationId) });
});
