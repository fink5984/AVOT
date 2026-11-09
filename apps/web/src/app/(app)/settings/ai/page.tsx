import { requirePageUser } from "@/server/auth/principal";
import { getSettingsScreen } from "@/server/ai/settings";
import { AiSettingsClient } from "./ai-settings-client";

export const metadata = { title: "הגדרות AI" };

/** The "הגדרות AI" tab: the one active provider + model, reasoning, prompts and style examples. Admin only. */
export default async function AiSettingsPage() {
  const admin = await requirePageUser("ai.settings");
  return <AiSettingsClient initial={await getSettingsScreen(admin.organizationId)} />;
}
