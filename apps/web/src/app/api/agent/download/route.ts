import { authenticateUser } from "@/server/auth/principal";
import { AppError } from "@/server/errors";
import { route } from "@/server/http";
import { loadRelease } from "@/server/services/agent-release";

/** Settings → Capture stations → "הורדת תוכנת צילום": sends the admin to the current installer. */
export const GET = route(async (req) => {
  await authenticateUser(req, "device.manage");
  const release = await loadRelease();
  if (!release) throw new AppError("NOT_FOUND", "קובץ ההתקנה עדיין לא פורסם. בנו אותו עם build-installer.ps1 -Publish (ראו docs/capture-agent.md).");
  return Response.redirect(release.url, 302);
});
