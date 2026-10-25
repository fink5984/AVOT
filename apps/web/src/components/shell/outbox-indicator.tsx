"use client";

import { useEffect, useState } from "react";
import { CloudOff, CloudUpload, TriangleAlert } from "lucide-react";
import { outboxCounts, uploader } from "@/lib/capture/uploader";
import { requestPersistentStorage } from "@/lib/capture/outbox";
import { fmt } from "@/i18n";
import { cn } from "@/lib/cn";

/**
 * Runs the browser upload queue for the signed-in user on every page (not only
 * the capture screen) and shows how many locally-saved photos still wait for
 * cloud verification. Warns before closing the tab while uploads are pending.
 */
export function OutboxIndicator({ userId, tone = "light" }: { userId: string; tone?: "light" | "studio" }) {
  const [counts, setCounts] = useState({ pending: 0, attention: 0, bytes: 0 });
  const [online, setOnline] = useState(true);

  useEffect(() => {
    uploader.start(userId);
    void requestPersistentStorage();
    let alive = true;
    const refresh = () =>
      outboxCounts(userId)
        .then((c) => alive && setCounts(c))
        .catch(() => undefined);
    void refresh();
    const unsub = uploader.subscribe(() => void refresh());
    const timer = setInterval(refresh, 4000);
    const onNet = () => setOnline(navigator.onLine);
    onNet();
    window.addEventListener("online", onNet);
    window.addEventListener("offline", onNet);
    return () => {
      alive = false;
      unsub();
      clearInterval(timer);
      window.removeEventListener("online", onNet);
      window.removeEventListener("offline", onNet);
    };
  }, [userId]);

  useEffect(() => {
    if (!counts.pending) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [counts.pending]);

  if (!counts.pending && online) return null;

  const studio = tone === "studio";
  return (
    <div
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium",
        counts.attention
          ? studio
            ? "bg-[#4a1d1a] text-[#f6c3bb]"
            : "bg-danger-soft text-danger"
          : studio
            ? "bg-studio-3 text-studio-text"
            : "bg-warn-soft text-warn",
      )}
      role="status"
      title={counts.pending ? `${counts.pending} צילומים (${fmt.bytes(counts.bytes)}) שמורים בדפדפן וממתינים לאימות בענן` : undefined}
    >
      {!online ? <CloudOff className="size-3.5" /> : counts.attention ? <TriangleAlert className="size-3.5" /> : <CloudUpload className="size-3.5" />}
      {!online && <span>לא מקוון</span>}
      {counts.pending > 0 && (
        <span>
          <span className="num">{counts.pending}</span> ממתינות להעלאה
          {counts.attention > 0 && (
            <>
              {" · "}
              <span className="num">{counts.attention}</span> דורשות טיפול
            </>
          )}
        </span>
      )}
    </div>
  );
}
