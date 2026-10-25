/** Thin fetch wrapper for the app's JSON API. Errors carry the server's Hebrew message. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      credentials: "same-origin",
      headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError("אין חיבור לשרת. בדקו את חיבור האינטרנט.", 0, "NETWORK");
  }
  const text = await res.text();
  const data = text ? safeParse(text) : null;
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string; details?: unknown } } | null)?.error;
    if (res.status === 401 && typeof window !== "undefined" && !url.includes("/api/auth/")) {
      // come back to the same screen after signing in (the handheld keeps its queued scans in IndexedDB)
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    }
    throw new ApiError(err?.message ?? `שגיאה (${res.status})`, res.status, err?.code ?? "HTTP", err?.details);
  }
  return data as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "אירעה שגיאה");
