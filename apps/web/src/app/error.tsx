"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-danger-soft text-danger">
        <AlertTriangle className="size-5.5" />
      </div>
      <h1 className="text-[18px] font-semibold">אירעה שגיאה בטעינת המסך</h1>
      <p className="mt-1.5 max-w-md text-[14px] text-muted">
        הפעולה לא הושלמה. צילומים שכבר נשמרו מקומית ממשיכים בתור ההעלאה.
        {error.digest && (
          <span className="mt-1 block font-mono text-[11px] text-faint" dir="ltr">
            ref: {error.digest}
          </span>
        )}
      </p>
      <Button onClick={reset} variant="primary" className="mt-5">
        ניסיון חוזר
      </Button>
    </main>
  );
}
