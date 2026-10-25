export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "BAD_ORIGIN"
  | "CHECKSUM_MISMATCH"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  BAD_ORIGIN: 403,
  CHECKSUM_MISMATCH: 422,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
};

/** Error with a user-facing Hebrew message and a stable machine code. */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const notFound = (what = "הפריט") => new AppError("NOT_FOUND", `${what} לא נמצא`);
export const forbidden = () => new AppError("FORBIDDEN", "אין לך הרשאה לבצע פעולה זו");
