import { scanBatchSchema } from "@avot/shared";
import { authenticateUser } from "@/server/auth/principal";
import { AppError } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { processScan } from "@/server/services/scanning";
import { rateLimit } from "@/server/rate-limit";

/**
 * Offline-queue flush: ops are applied in the order given (scan order on the
 * device), each independently. A refused op (403 / validation) is reported
 * per op instead of failing the batch, so the device can mark exactly which
 * scans need attention.
 */
export const POST = route(async (req) => {
  const user = await authenticateUser(req);
  rateLimit(`scan:${user.userId}`, 600, 60_000);
  const { ops } = await parseJson(req, scanBatchSchema);
  const results = [];
  for (const op of ops) {
    try {
      results.push(await processScan(user, op));
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      results.push({ opId: op.opId, result: "ERROR" as const, message: err.message, codeType: "UNKNOWN" as const, httpStatus: err.status });
    }
  }
  return json({ results });
});
