import "server-only";
import { Prisma } from "@prisma/client";
import { ZodError, type z, type ZodTypeAny } from "zod";
import { env } from "./env";
import { AppError } from "./errors";
import { SESSION_COOKIE } from "./auth/session";
import { log } from "./log";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function json(data: unknown, init?: ResponseInit): Response {
  const body = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
  return new Response(body, {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...init?.headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return json({ error: { code: err.code, message: err.message, details: err.details } }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return json(
      {
        error: {
          code: "VALIDATION",
          message: "הנתונים שנשלחו אינם תקינים",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
      { status: 400 },
    );
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return json({ error: { code: "CONFLICT", message: "קיימת כבר רשומה עם ערכים אלו" } }, { status: 409 });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
    return json({ error: { code: "NOT_FOUND", message: "הרשומה לא נמצאה" } }, { status: 404 });
  }
  log.error("unhandled api error", { err });
  return json({ error: { code: "INTERNAL", message: "אירעה שגיאה בשרת. הפעולה לא בוצעה." } }, { status: 500 });
}

/**
 * CSRF defence for cookie-authenticated requests: session cookies are
 * SameSite=Lax and every state-changing request must carry an Origin header
 * matching this app. Bearer-token (agent) requests are not cookie based and skip it.
 */
export function assertSameOrigin(req: Request) {
  if (!MUTATING.has(req.method)) return;
  if (req.headers.get("authorization")?.startsWith("Bearer ")) return;
  // CSRF needs the victim's session cookie; cookie-less callers (the agent pairing call) are not affected
  if (!req.headers.get("cookie")?.includes(`${SESSION_COOKIE}=`)) return;
  const origin = req.headers.get("origin");
  if (!origin) throw new AppError("BAD_ORIGIN", "בקשה נדחתה: חסר Origin");
  const allowed = new URL(env().APP_URL).origin;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AppError("BAD_ORIGIN", "בקשה נדחתה: Origin לא תקין");
  }
  if (origin !== allowed && originHost !== host) throw new AppError("BAD_ORIGIN", "בקשה נדחתה: מקור לא מורשה");
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** Wraps a route handler with origin checks and uniform error responses. */
export function route<C = { params: Promise<Record<string, string>> }>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      assertSameOrigin(req);
      return await handler(req, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function parseJson<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError("VALIDATION", "גוף הבקשה אינו JSON תקין");
  }
  return schema.parse(body);
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "local";
}

/** RFC 6266 / 5987 Content-Disposition that survives Hebrew filenames. */
export function contentDisposition(filename: string, inline = false): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
