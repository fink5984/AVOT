import { cn } from "@/lib/cn";

/** Small brand marker of an auction house: its accent colour + name. */
export function HouseMark({ name, color, className }: { name: string; color: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-2", className)}>
      <span className="size-2.5 rounded-[3px]" style={{ background: color }} aria-hidden />
      {name}
    </span>
  );
}
