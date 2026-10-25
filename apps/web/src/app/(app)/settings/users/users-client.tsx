"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, KeyRound, UserPlus } from "lucide-react";
import { ROLES, type Role } from "@avot/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { fmt, t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";

const ROLE_HELP: Record<Role, string> = {
  ADMIN: "כל המערכת: שני בתי המכירות, מלאי, מחסן, משתמשים, עמדות, הגדרות ויומן פעילות",
  EDITOR: "ניהול בית מכירות: קטלוגים, שיוך ספרים, תיאורים, מצב מסחרי, ארגון תמונות וייצוא",
  PHOTOGRAPHER: "צילום בלבד: קליטת ספרים, צילום, ארגון תמונות וסימון התקדמות",
  WAREHOUSE: "מחסן בלבד: מסופון — אחסון, העברה, איתור, ליקוט, ספירת מלאי, אריזה ומשלוח",
  VIEWER: "צפייה בלבד, כולל הורדת תמונות",
};

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: "ACTIVE" | "INVITED" | "DISABLED";
  lastActiveAt: string | null;
  /** [] = all auction houses */
  houseIds: string[];
}

export function UsersAdmin({
  currentUserId,
  activeCount,
  users,
  invites,
  houses,
}: {
  currentUserId: string;
  activeCount: number;
  houses: { id: string; name: string }[];
  users: UserRow[];
  invites: { id: string; name: string; email: string; role: Role; expiresAt: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [link, setLink] = useState<{ title: string; url: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const r = await api<{ url: string }>("/api/users/invite", { method: "POST", json: { name: f.get("name"), email: f.get("email"), role: f.get("role") } });
      setInviteOpen(false);
      setLink({ title: "קישור הזמנה", url: r.url, note: "שלחו את הקישור למשתמש. הוא תקף 7 ימים ולשימוש אחד. אין שליחת אימייל אוטומטית במערכת." });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function update(id: string, body: Partial<Pick<UserRow, "role" | "status" | "houseIds">>) {
    try {
      await api(`/api/users/${id}`, { method: "PATCH", json: body });
      toast.success("המשתמש עודכן");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function reset(u: UserRow) {
    try {
      const r = await api<{ url: string }>(`/api/users/${u.id}/reset-link`, { method: "POST" });
      setLink({ title: `קישור איפוס סיסמה — ${u.name}`, url: r.url, note: "הקישור תקף לשעתיים ולשימוש אחד. מסרו אותו למשתמש באופן אישי." });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13.5px] text-muted">
          <span className="num font-medium text-ink">{activeCount}</span> משתמשים פעילים
        </p>
        <Button variant="primary" icon={<UserPlus />} onClick={() => setInviteOpen(true)}>
          הזמנת משתמש
        </Button>
      </div>
      <Panel>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13.5px]">
            <thead>
              <tr className="border-b border-rule text-[12.5px] text-muted">
                <th className="px-5 py-3 text-start font-medium">שם</th>
                <th className="px-3 py-3 text-start font-medium">אימייל</th>
                <th className="w-44 px-3 py-3 text-start font-medium">תפקיד</th>
                <th className="w-40 px-3 py-3 text-start font-medium">בתי מכירות</th>
                <th className="w-24 px-3 py-3 text-start font-medium">מצב</th>
                <th className="w-32 px-3 py-3 text-start font-medium">פעילות אחרונה</th>
                <th className="w-48 px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="px-5 py-2.5 font-medium">
                    {u.name}
                    {u.id === currentUserId && <span className="ms-1.5 text-[11.5px] font-normal text-muted">(את/ה)</span>}
                  </td>
                  <td className="px-3 py-2 text-muted" dir="ltr">
                    <span className="block text-end">{u.email}</span>
                  </td>
                  <td className="px-3 py-2">
                    <Select value={u.role} onChange={(e) => update(u.id, { role: e.target.value as Role })} disabled={u.id === currentUserId} className="h-8" aria-label={`תפקיד ${u.name}`} title={ROLE_HELP[u.role]}>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {t.role[r]}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-3 py-2">
                    {u.role === "ADMIN" ? (
                      <span className="text-[12.5px] text-muted">כולם</span>
                    ) : (
                      <Select
                        value={u.houseIds.length === 1 ? u.houseIds[0] : ""}
                        onChange={(e) => update(u.id, { houseIds: e.target.value ? [e.target.value] : [] })}
                        className="h-8"
                        aria-label={`בתי מכירות של ${u.name}`}
                        title="הגבלה לבית מכירות מסוים חלה על קטלוגים ונתונים מסחריים. המלאי המרכזי משותף."
                      >
                        <option value="">כל בתי המכירות</option>
                        {houses.map((h) => (
                          <option key={h.id} value={h.id}>
                            {h.name} בלבד
                          </option>
                        ))}
                      </Select>
                    )}
                  </td>
                  <td className="px-3 py-2">{u.status === "ACTIVE" ? <Badge tone="green">פעיל</Badge> : <Badge tone="neutral">מושבת</Badge>}</td>
                  <td className="px-3 py-2 text-muted">{fmt.relative(u.lastActiveAt)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="ghost" icon={<KeyRound />} onClick={() => reset(u)}>
                        איפוס סיסמה
                      </Button>
                      {u.id !== currentUserId &&
                        (u.status === "ACTIVE" ? (
                          <Button size="sm" variant="danger" onClick={() => update(u.id, { status: "DISABLED" })}>
                            השבתה
                          </Button>
                        ) : (
                          <Button size="sm" onClick={() => update(u.id, { status: "ACTIVE" })}>
                            הפעלה
                          </Button>
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {invites.length > 0 && (
        <Panel title="הזמנות ממתינות">
          <ul className="divide-y divide-rule text-[13px]">
            {invites.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-5 py-3">
                <span className="font-medium">{i.name}</span>
                <span className="text-muted" dir="ltr">
                  {i.email}
                </span>
                <Badge tone="accent">{t.role[i.role]}</Badge>
                <span className="ms-auto text-[12px] text-muted">בתוקף עד {fmt.date(i.expiresAt)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="הרשאות לפי תפקיד">
        <dl className="grid gap-x-8 gap-y-3 px-5 py-4 text-[13.5px] sm:grid-cols-2">
          {ROLES.map((r) => (
            <div key={r}>
              <dt className="font-medium">{t.role[r]}</dt>
              <dd className="text-muted">{ROLE_HELP[r]}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <Dialog open={inviteOpen} onClose={() => setInviteOpen(false)} title="הזמנת משתמש" width="sm">
        <form id="invite-form" onSubmit={invite} className="space-y-4">
          <Field label="שם מלא" required>
            {(p) => <Input {...p} name="name" required autoFocus maxLength={100} />}
          </Field>
          <Field label="אימייל" required>
            {(p) => <Input {...p} name="email" type="email" required dir="ltr" />}
          </Field>
          <Field label="תפקיד">
            {(p) => (
              <Select {...p} name="role" defaultValue="PHOTOGRAPHER">
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t.role[r]} — {ROLE_HELP[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </form>
        <div className="mt-6 flex gap-2">
          <Button type="submit" form="invite-form" variant="primary" loading={busy}>
            יצירת קישור הזמנה
          </Button>
          <Button onClick={() => setInviteOpen(false)}>ביטול</Button>
        </div>
      </Dialog>

      <Dialog open={!!link} onClose={() => setLink(null)} title={link?.title ?? ""} description={link?.note}>
        <div className="flex gap-2">
          <Input readOnly value={link?.url ?? ""} dir="ltr" onFocus={(e) => e.currentTarget.select()} aria-label="קישור" />
          <Button
            icon={<Copy />}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link?.url ?? "");
                toast.success("הקישור הועתק");
              } catch {
                toast.warning("ההעתקה נחסמה — סמנו את הקישור והעתיקו ידנית");
              }
            }}
          >
            העתקה
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
