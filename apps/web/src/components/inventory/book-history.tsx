import { actionLabel, describeData } from "@/server/services/activity";
import type { getItemDetail } from "@/server/services/inventory";
import { Panel } from "@/components/ui/misc";
import { fmt, t } from "@/i18n";

type Detail = NonNullable<Awaited<ReturnType<typeof getItemDetail>>>;

const MOVE_KIND: Record<string, string> = {
  STORE: "אוחסן",
  TRANSFER: "הועבר",
  PICK: "לוקט מהמדף",
  RETURN: "הוחזר למדף",
  COUNT_ADJUST: "תוקן בספירת מלאי",
  MANUAL: "תיקון ידני",
};
const DIMENSION: Record<string, string> = { PHOTO: "צילום", PHYSICAL: "מחסן", COMMERCIAL: "מסחרי", REVIEW: "פרטי הפריט" };
const statusName = (dim: string, s: string | null) =>
  !s ? "—" : dim === "REVIEW" ? (t.reviewStatus as Record<string, string>)[s] ?? s : dim === "PHOTO" ? (t.photoStatus as Record<string, string>)[s] ?? s : dim === "PHYSICAL" ? (t.physicalStatus as Record<string, string>)[s] ?? s : (t.commercialStatus as Record<string, string>)[s] ?? s;
// already shown through the status / movement rows of the timeline
const SKIP_AUDIT = new Set(["lot.status_changed", "inventory.photo_status", "lot.commercial_status", "warehouse.item_moved"]);

type Entry = { at: Date; text: string; detail?: string | null; who?: string | null; tone?: "move" | "status" | "audit" };

/** The book's full history (status changes, moves, edits, AI, notes): one component for the inventory page and the lot page. */
export function BookHistory({ detail }: { detail: Pick<Detail, "events" | "moves" | "audit"> }) {
  const { events, moves, audit } = detail;
  const timeline: Entry[] = [
    ...events.map((e) => ({
      at: e.createdAt,
      tone: "status" as const,
      text: `${DIMENSION[e.dimension]}: ${e.fromStatus ? `${statusName(e.dimension, e.fromStatus)} ← ` : ""}${statusName(e.dimension, e.toStatus)}`,
      detail: e.reason,
      who: e.userName,
    })),
    ...moves.map((m) => ({
      at: m.occurredAt,
      tone: "move" as const,
      text: `${MOVE_KIND[m.kind] ?? m.kind}: ${m.fromLabel ?? "—"} ← ${m.toLabel ?? "מחוץ למדף"}`,
      detail: m.note ?? (m.occurredAt.getTime() < m.createdAt.getTime() - 60_000 ? `סונכרן ב-${fmt.dateTime(m.createdAt)}` : null),
      who: m.userName,
    })),
  ];
  // consecutive captures collapse into one row
  for (const a of audit.filter((x) => !SKIP_AUDIT.has(x.action))) {
    const last = timeline[timeline.length - 1];
    if (a.action === "photo.captured" && last?.text.startsWith("צילם") && last.who === (a.user?.name ?? null) && Math.abs(last.at.getTime() - a.createdAt.getTime()) < 30 * 60_000) {
      const n = Number(last.text.match(/\d+/)?.[0] ?? 1) + 1;
      last.text = `צילם ${n} תמונות`;
      continue;
    }
    timeline.push({ at: a.createdAt, tone: "audit", text: a.action === "photo.captured" ? "צילם 1 תמונות" : actionLabel(a.action), detail: describeData(a.action, a.data), who: a.user?.name ?? null });
  }
  timeline.sort((x, y) => y.at.getTime() - x.at.getTime());
  return (
    <div id="item-history" className="scroll-mt-20">
      <Panel title="היסטוריה">
        <ol className="max-h-[560px] divide-y divide-rule overflow-y-auto text-[13px]">
          {timeline.map((e, i) => (
            <li key={i} className="flex gap-3 px-5 py-2.5">
              <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${e.tone === "move" ? "bg-info" : e.tone === "status" ? "bg-accent" : "bg-faint"}`} aria-hidden />
              <div className="min-w-0">
                <div>{e.text}</div>
                {e.detail && <div className="text-[12px] text-muted">{e.detail}</div>}
                <div className="text-[11.5px] text-faint">
                  {fmt.dateTime(e.at)}
                  {e.who && <> · {e.who}</>}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}
