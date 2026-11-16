import { ClipboardList } from "lucide-react";
import { cn } from "@/lib/cn";

/** Compact "N הערות לבדיקה" for lists (inventory, catalog lots): which books have open questions, at a glance. */
export function OpenNotesBadge({ n, className }: { n: number; className?: string }) {
  if (n <= 0) return null;
  return (
    <span
      className={cn("relative z-10 inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-warn-soft px-2 py-0.5 text-[11.5px] font-medium text-warn", className)}
      title="הערות לבדיקה פתוחות (פנימי, לא נשלח ל-AI)"
      data-testid="open-notes-badge"
    >
      <ClipboardList className="size-3" aria-hidden />
      {n === 1 ? "הערה לבדיקה" : `${n} הערות לבדיקה`}
    </span>
  );
}
