"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Archive, ArchiveRestore, Copy, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Menu } from "@/components/ui/menu";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";

export interface CatalogFormValue {
  id?: string;
  number: string;
  name: string;
  description: string | null;
  saleDate: string | null;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
}

export function CatalogsToolbar({ q, status, sort }: { q: string; status: string; sort: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [text, setText] = useState(q);

  const set = (key: string, value: string) => {
    const p = new URLSearchParams(params.toString());
    if (value) p.set(key, value);
    else p.delete(key);
    p.delete("new");
    router.replace(`${pathname}?${p.toString()}`);
  };

  useEffect(() => {
    const id = setTimeout(() => text !== q && set("q", text.trim()), 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs
        variant="pill"
        label="סינון לפי סטטוס"
        value={status}
        onChange={(v) => set("status", v === "OPEN" ? "" : v)}
        items={[
          { value: "OPEN", label: "פתוחים" },
          { value: "ACTIVE", label: "פעילים" },
          { value: "DRAFT", label: "בהכנה" },
          { value: "ARCHIVED", label: "ארכיון" },
          { value: "ALL", label: "הכול" },
        ]}
      />
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="חיפוש לפי שם או מספר" className="w-full sm:ms-auto sm:w-64" aria-label="חיפוש קטלוגים" type="search" />
      <Select value={sort} onChange={(e) => set("sort", e.target.value)} className="w-full sm:w-48" aria-label="מיון">
        <option value="updated">מיון: עודכן לאחרונה</option>
        <option value="number">מיון: מספר קטלוג</option>
        <option value="name">מיון: שם</option>
      </Select>
    </div>
  );
}

export function CatalogFormDialog({ open, onClose, initial, houseId, houseName }: { open: boolean; onClose: () => void; initial?: CatalogFormValue; houseId?: string; houseName?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = !!initial?.id;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      number: String(f.get("number") ?? "").trim(),
      name: String(f.get("name") ?? "").trim(),
      description: String(f.get("description") ?? "").trim() || null,
      saleDate: String(f.get("saleDate") ?? "") || null,
      status: String(f.get("status")) as CatalogFormValue["status"],
      ...(editing ? {} : { auctionHouseId: houseId }),
    };
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await api(`/api/catalogs/${initial!.id}`, { method: "PATCH", json: body });
        toast.success("הקטלוג עודכן");
        onClose();
        router.refresh();
      } else {
        const r = await api<{ catalog: { id: string } }>("/api/catalogs", { method: "POST", json: body });
        toast.success("הקטלוג נוצר");
        onClose();
        router.push(`/catalogs/${r.catalog.id}`);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={editing ? "עריכת קטלוג" : "קטלוג חדש"} description={!editing && houseName ? `בית מכירות: ${houseName}` : undefined}>
      <form id="catalog-form" onSubmit={submit} className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-4">
        <Field label="מספר" required>
          {(p) => <Input {...p} name="number" defaultValue={initial?.number} required maxLength={30} autoFocus className="num text-start" />}
        </Field>
        <Field label="שם הקטלוג" required>
          {(p) => <Input {...p} name="name" defaultValue={initial?.name} required maxLength={200} />}
        </Field>
        <Field label="תיאור" className="col-span-2">
          {(p) => <Textarea {...p} name="description" defaultValue={initial?.description ?? ""} rows={2} maxLength={5000} />}
        </Field>
        <Field label="תאריך מכירה">
          {(p) => <Input {...p} name="saleDate" type="date" defaultValue={initial?.saleDate ?? ""} />}
        </Field>
        <Field label="סטטוס">
          {(p) => (
            <Select {...p} name="status" defaultValue={initial?.status ?? "ACTIVE"}>
              <option value="DRAFT">בהכנה</option>
              <option value="ACTIVE">פעיל</option>
              <option value="ARCHIVED">בארכיון</option>
            </Select>
          )}
        </Field>
        {error && (
          <p className="col-span-2 rounded-md bg-danger-soft px-3 py-2.5 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
      </form>
      <div className="mt-5 flex gap-2">
        <Button type="submit" form="catalog-form" variant="primary" loading={saving}>
          {editing ? "שמירה" : "יצירת קטלוג"}
        </Button>
        <Button onClick={onClose}>ביטול</Button>
      </div>
    </Dialog>
  );
}

export function NewCatalogButton({ autoOpen, houseId, houseName }: { autoOpen?: boolean; houseId?: string; houseName?: string }) {
  const [open, setOpen] = useState(!!autoOpen);
  return (
    <>
      <Button variant="primary" icon={<Plus />} onClick={() => setOpen(true)}>
        קטלוג חדש
      </Button>
      <CatalogFormDialog open={open} onClose={() => setOpen(false)} houseId={houseId} houseName={houseName} />
    </>
  );
}

export function CatalogActions({ catalog, canDelete }: { catalog: CatalogFormValue & { id: string; photoCount: number }; canDelete: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [dup, setDup] = useState(false);
  const [del, setDel] = useState(false);
  const [busy, setBusy] = useState(false);

  async function setStatus(status: CatalogFormValue["status"]) {
    try {
      await api(`/api/catalogs/${catalog.id}`, { method: "PATCH", json: { status } });
      toast.success(status === "ARCHIVED" ? "הקטלוג הועבר לארכיון" : "הקטלוג הוחזר מהארכיון");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function duplicate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const r = await api<{ catalog: { id: string } }>(`/api/catalogs/${catalog.id}/duplicate`, {
        method: "POST",
        json: { number: f.get("number"), name: f.get("name") },
      });
      toast.success("נוצר קטלוג חדש עם אותן הגדרות");
      router.push(`/catalogs/${r.catalog.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`/api/catalogs/${catalog.id}`, { method: "DELETE" });
      toast.success("הקטלוג נמחק");
      setDel(false);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Menu
        trigger={(p) => (
          <IconButton label="פעולות לקטלוג" size="sm" {...p}>
            <MoreHorizontal className="size-4" />
          </IconButton>
        )}
        items={[
          { label: "עריכת פרטים", icon: <Pencil />, onSelect: () => setEdit(true) },
          { label: "קטלוג חדש באותן הגדרות", icon: <Copy />, onSelect: () => setDup(true) },
          catalog.status === "ARCHIVED"
            ? { label: "החזרה מהארכיון", icon: <ArchiveRestore />, onSelect: () => setStatus("ACTIVE") }
            : { label: "העברה לארכיון", icon: <Archive />, onSelect: () => setStatus("ARCHIVED") },
          ...(canDelete ? (["separator", { label: "מחיקת קטלוג", icon: <Trash2 />, danger: true, onSelect: () => setDel(true) }] as const) : []),
        ]}
      />
      <CatalogFormDialog open={edit} onClose={() => setEdit(false)} initial={catalog} />
      <Dialog open={dup} onClose={() => setDup(false)} title="קטלוג חדש באותן הגדרות" description="נוצר קטלוג ריק באותו בית מכירות, עם אותו תיאור ודרישות צילום. ספרים עוברים לקטלוג החדש בשיוך ממסך המלאי (כולל ספרים שלא נמכרו).">
        <form id="dup-form" onSubmit={duplicate} className="grid grid-cols-[120px_1fr] gap-3">
          <Field label="מספר חדש" required>
            {(p) => <Input {...p} name="number" required autoFocus />}
          </Field>
          <Field label="שם" required>
            {(p) => <Input {...p} name="name" required defaultValue={`${catalog.name} (עותק)`} />}
          </Field>
        </form>
        <div className="mt-5 flex gap-2">
          <Button type="submit" form="dup-form" variant="primary" loading={busy}>
            שכפול
          </Button>
          <Button onClick={() => setDup(false)}>ביטול</Button>
        </div>
      </Dialog>
      <Dialog open={del} onClose={() => setDel(false)} title={`מחיקת קטלוג ${catalog.number}`} width="sm">
        {catalog.photoCount > 0 ? (
          <p className="text-[13px] text-ink-2">
            בקטלוג יש <span className="num">{catalog.photoCount}</span> תמונות. כדי להגן על התמונות המקוריות לא ניתן למחוק אותו — ניתן להעביר אותו לארכיון.
          </p>
        ) : (
          <p className="text-[13px] text-ink-2">הקטלוג וכל הפריטים שבו יימחקו. אין בו תמונות. לא ניתן לבטל פעולה זו.</p>
        )}
        <div className="mt-5 flex gap-2">
          {catalog.photoCount === 0 && (
            <Button variant="danger" loading={busy} onClick={remove}>
              מחיקה סופית
            </Button>
          )}
          <Button onClick={() => setDel(false)}>{catalog.photoCount ? "סגירה" : "ביטול"}</Button>
        </div>
      </Dialog>
    </>
  );
}
