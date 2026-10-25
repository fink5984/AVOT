import { authenticateUser } from "@/server/auth/principal";
import { AppError } from "@/server/errors";
import { json, route } from "@/server/http";
import { audit } from "@/server/audit";
import { issueControlToken } from "@/server/services/control-token";

/**
 * Issues a short-lived token that lets *this browser tab* drive the given
 * station's camera through the agent on 127.0.0.1. The agent verifies it with
 * the device secret and also checks the request Origin matches.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await authenticateUser(req, "photo.capture");
  const { id } = await params;
  const origin = req.headers.get("origin");
  if (!origin) throw new AppError("BAD_ORIGIN", "חסר Origin");
  try {
    const t = await issueControlToken({ deviceId: id, orgId: user.organizationId, userId: user.userId, userName: user.name, origin });
    await audit(user, { action: "device.control_token_issued", entityType: "device", entityId: id });
    return json(t);
  } catch {
    throw new AppError("NOT_FOUND", "עמדת הצילום לא נמצאה או בוטלה");
  }
});
