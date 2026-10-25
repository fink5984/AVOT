import { pairDeviceSchema } from "@avot/shared";
import { clientIp, json, parseJson, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { pairDevice } from "@/server/services/devices";

/** Agent → server: exchange a one-time pairing code for a device token + secret. */
export const POST = route(async (req) => {
  rateLimit(`pair:${clientIp(req)}`, 10, 15 * 60 * 1000);
  return json(await pairDevice(await parseJson(req, pairDeviceSchema)), { status: 201 });
});
