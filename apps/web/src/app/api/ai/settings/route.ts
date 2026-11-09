import { authenticateUser } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { getSettingsScreen, saveAiSettings } from "@/server/ai/settings";

/** The "הגדרות AI" tab: stored + effective values, defaults, versions. Admin only. API keys are never returned. */
export const GET = route(async (req) => {
  const user = await authenticateUser(req, "ai.settings");
  return json(await getSettingsScreen(user.organizationId));
});

/** Saves a new settings version (provider, model, reasoning, prompts, examples). Applies to NEW runs only. */
export const PUT = route(async (req) => {
  const user = await authenticateUser(req, "ai.settings");
  const saved = await saveAiSettings(user, await req.json().catch(() => ({})));
  return json({ ...saved, screen: await getSettingsScreen(user.organizationId) });
});
