"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Info, X } from "lucide-react";
import { cn } from "@/lib/cn";

type Tone = "success" | "error" | "info" | "warning";
interface ToastItem {
  id: number;
  tone: Tone;
  message: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  success: (message: string, opts?: Partial<ToastItem>) => void;
  error: (message: string, opts?: Partial<ToastItem>) => void;
  info: (message: string, opts?: Partial<ToastItem>) => void;
  warning: (message: string, opts?: Partial<ToastItem>) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx;
}

const ICON = { success: Check, error: AlertTriangle, warning: AlertTriangle, info: Info };
const TONE = {
  success: "[&_.toast-icon]:bg-green",
  error: "[&_.toast-icon]:bg-danger",
  warning: "[&_.toast-icon]:bg-warn",
  info: "[&_.toast-icon]:bg-ink-2",
};

/** Small, bottom-start, non-blocking notifications. Errors stay longer. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const push = useCallback(
    (tone: Tone, message: string, opts?: Partial<ToastItem>) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { id, tone, message, ...opts }]);
      setTimeout(() => dismiss(id), tone === "error" ? 9000 : 3800);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m, o) => push("success", m, o),
      error: (m, o) => push("error", m, o),
      info: (m, o) => push("info", m, o),
      warning: (m, o) => push("warning", m, o),
    }),
    [push],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-5 start-5 z-[100] flex w-[min(400px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {items.map((t) => {
          const Icon = ICON[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === "error" ? "alert" : "status"}
              className={cn(
                "animate-pop pointer-events-auto flex items-start gap-3 rounded-xl bg-ink px-3.5 py-3 text-[13px] text-paper shadow-pop ring-1 ring-white/10",
                TONE[t.tone],
              )}
            >
              <span className="toast-icon mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-white" aria-hidden>
                <Icon className="size-3" strokeWidth={2.5} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t.message}</p>
                {t.detail && <p className="mt-0.5 text-[12.5px] text-white/65">{t.detail}</p>}
              </div>
              {t.action && (
                <button
                  type="button"
                  className="-my-1 shrink-0 rounded-md bg-white/12 px-2.5 py-1 text-[12.5px] font-medium text-white hover:bg-white/20"
                  onClick={() => {
                    t.action!.onClick();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button type="button" onClick={() => dismiss(t.id)} className="shrink-0 text-white/45 hover:text-white" aria-label="סגירה">
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}
