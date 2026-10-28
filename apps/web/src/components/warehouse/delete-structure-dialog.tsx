"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { ShelfPicker } from "@/components/warehouse/shelf-picker";
import { api, errorMessage } from "@/lib/api";

export type DeleteTarget =
  | { kind: "shelves"; ids: string[]; title: string }
  | { kind: "column"; id: string; name: string; shelfIds: string[] }
  | { kind: "empty-shelves"; id: string; name: string };

interface Plan {
  shelves: { id: string; label: string; books: number; physical: boolean; blocked: string | null }[];
  books: number;
  blocked: string | null;
}
interface EmptyPlan {
  count: number;
  removed: string[];
}

/**
 * One dialog for every deletion in the warehouse structure: a shelf, several shelves, the empty shelves of a column,
 * a whole column. It first asks the server what would happen (books on the shelves, history) and only then deletes.
 * Books are never deleted — when there are any, the manager picks the shelf they move to.
 */
export function DeleteStructureDialog({ target, onClose, onDone }: { target: DeleteTarget | null; onClose: () => void; onDone?: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [empty, setEmpty] = useState<EmptyPlan | null>(null);
  const [moveTo, setMoveTo] = useState<{ id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPlan(null);
    setEmpty(null);
    setMoveTo(null);
    setError(null);
    if (!target) return;
    const load = async () => {
      if (target.kind === "shelves") setPlan((await api<{ plan: Plan }>("/api/warehouse/shelves/delete", { method: "POST", json: { shelfIds: target.ids, dryRun: true } })).plan);
      else if (target.kind === "column") setPlan((await api<{ plan: Plan }>(`/api/warehouse/columns/${target.id}/delete`, { method: "POST", json: { mode: "plan" } })).plan);
      else setEmpty((await api<{ result: EmptyPlan }>(`/api/warehouse/columns/${target.id}/delete`, { method: "POST", json: { mode: "empty-shelves", dryRun: true } })).result);
    };
    load().catch((e) => setError(errorMessage(e)));
  }, [target]);

  const excluded = new Set(target?.kind === "shelves" ? target.ids : target?.kind === "column" ? target.shelfIds : []);
  const needsTarget = !!plan && plan.books > 0;
  const physical = plan?.shelves.filter((s) => s.physical).length ?? 0;
  const logical = (plan?.shelves.length ?? 0) - physical;
  const ready = !!target && !busy && !error && (plan ? !plan.blocked && (!needsTarget || !!moveTo) : !!empty && empty.count > 0);

  async function confirm() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      if (target.kind === "shelves") await api("/api/warehouse/shelves/delete", { method: "POST", json: { shelfIds: target.ids, moveToLocationId: moveTo?.id ?? null } });
      else if (target.kind === "column") await api(`/api/warehouse/columns/${target.id}/delete`, { method: "POST", json: { mode: "column", moveToLocationId: moveTo?.id ?? null } });
      else await api(`/api/warehouse/columns/${target.id}/delete`, { method: "POST", json: { mode: "empty-shelves" } });
      toast.success(target.kind === "column" ? "העמודה הוסרה" : target.kind === "empty-shelves" ? `${empty?.count ?? 0} מדפים ריקים נמחקו` : "המדפים הוסרו");
      onDone?.();
      onClose();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const title = !target ? "" : target.kind === "column" ? `מחיקת ${target.name}` : target.kind === "empty-shelves" ? `מחיקת מדפים ריקים · ${target.name}` : target.title;

  return (
    <Dialog open={!!target} onClose={onClose} title={title} width="sm">
      <div className="space-y-3.5 text-[13.5px]">
        {!plan && !empty && !error && <p className="py-4 text-center text-muted">בודק מה יושפע…</p>}

        {plan && (
          <>
            <p>
              {target?.kind === "column" ? "העמודה, " : ""}
              <b className="num">{plan.shelves.length}</b> מדפים · <b className="num">{plan.books}</b> ספרים עליהם.
            </p>
            {plan.blocked && <p className="rounded-md bg-danger-soft px-3 py-2 text-danger">לא ניתן למחוק כרגע: {plan.blocked}.</p>}
            {needsTarget && !plan.blocked && (
              <div className="space-y-2">
                <p className="rounded-md bg-warn-soft px-3 py-2 text-warn">על המדפים יש ספרים. הם לא נמחקים — בחרו לאן להעביר אותם.</p>
                <ShelfPicker excludeShelfIds={excluded} onChange={(l) => setMoveTo(l ? { id: l.id } : null)} />
                {moveTo && <p className="text-[12.5px] text-muted">כל {plan.books} הספרים יועברו, וההעברה תירשם בהיסטוריה של כל ספר.</p>}
              </div>
            )}
            <p className="text-[12.5px] text-muted">
              {physical > 0 && <>מדפים ללא היסטוריה ({physical}) יימחקו לגמרי. </>}
              {logical > 0 && <>מדפים שהחזיקו ספרים או נספרו ({logical}) יוצאים מהמבנה וההיסטוריה שלהם נשמרת. </>}
              קודי הברקוד של מדפים שהוסרו לא ישמשו שוב.
            </p>
          </>
        )}

        {empty && (
          <>
            <p>{empty.count === 0 ? "אין בעמודה מדפים ריקים למחיקה." : <>יימחקו <b className="num">{empty.count}</b> מדפים ללא ספרים. מדפים עם ספרים לא ייפגעו.</>}</p>
          </>
        )}

        {error && (
          <p className="rounded-md bg-danger-soft px-3 py-2 text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2 pt-1">
          <Button variant="danger" loading={busy} disabled={!ready} onClick={() => void confirm()}>
            {target?.kind === "column" ? "מחיקת העמודה" : target?.kind === "empty-shelves" ? "מחיקת המדפים הריקים" : "מחיקה"}
          </Button>
          <Button onClick={onClose}>ביטול</Button>
        </div>
      </div>
    </Dialog>
  );
}
