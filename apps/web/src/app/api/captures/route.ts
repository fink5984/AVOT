import { registerCaptureSchema } from "@avot/shared";
import { authenticate } from "@/server/auth/principal";
import { json, parseJson, route } from "@/server/http";
import { registerCapture } from "@/server/services/captures";

/** Step 1 of the capture upload protocol (browser session or paired agent). */
export const POST = route(async (req) => {
  const principal = await authenticate(req, { allowDevice: true });
  const input = await parseJson(req, registerCaptureSchema);
  return json(await registerCapture(principal, input));
});
