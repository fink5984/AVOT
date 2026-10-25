import "server-only";
import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    APP_URL: z.string().url().default("http://localhost:3000"),
    APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters"),
    APP_ENV: z.enum(["development", "staging", "production", "test"]).default("development"),
    STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
    STORAGE_LOCAL_DIR: z.string().default(".data/storage"),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default("auto"),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool,
    ENABLE_SIMULATOR: bool,
    JOB_WORKER_ENABLED: z
      .string()
      .optional()
      .transform((v) => v !== "false"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === "s3") {
      for (const key of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
        if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required for STORAGE_DRIVER=s3` });
      }
    }
    if (env.APP_ENV === "production" && env.STORAGE_DRIVER === "local") {
      ctx.addIssue({
        code: "custom",
        path: ["STORAGE_DRIVER"],
        message: "Production must use S3-compatible storage — the app server disk is not durable",
      });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated environment. Throws a readable error listing every bad variable. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  cached = parsed.data;
  return cached;
}

export const isProduction = () => env().APP_ENV === "production";
