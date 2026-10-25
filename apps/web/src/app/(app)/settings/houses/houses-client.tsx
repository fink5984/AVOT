"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";

interface House {
  id: string;
  slug: string;
  name: string;
  nameEn: string | null;
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
  settings: { lotNumberWidth?: number; descriptionFooter?: string; publishCurrency?: string };
}

/** Brand settings per auction house: name, logo, colours, publishing defaults. */
export function HousesEditor({ houses }: { houses: House[] }) {
  return (
    <div className="space-y-5">
      {houses.map((h) => (
        <HouseForm key={h.id} house={h} />
      ))}
    </div>
  );
}

function HouseForm({ house }: { house: House }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    setBusy(true);
    try {
      await api(`/api/houses/${house.id}`, {
        method: "PATCH",
        json: {
          name: s("name"),
          nameEn: s("nameEn") || null,
          logoUrl: s("logoUrl") || null,
          primaryColor: s("primaryColor"),
          accentColor: s("accentColor"),
          settings: { lotNumberWidth: Number(s("lotNumberWidth") || 3), descriptionFooter: s("descriptionFooter"), publishCurrency: s("publishCurrency") },
        },
      });
      toast.success(`${s("name")} עודכן`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title={`${house.name} (${house.slug})`}>
      <form onSubmit={submit} className="grid grid-cols-2 gap-x-3 gap-y-4 px-5 py-4 sm:grid-cols-4">
        <Field label="שם">
          {(p) => <Input {...p} name="name" required defaultValue={house.name} maxLength={100} />}
        </Field>
        <Field label="שם באנגלית">
          {(p) => <Input {...p} name="nameEn" defaultValue={house.nameEn ?? ""} dir="ltr" maxLength={100} />}
        </Field>
        <Field label="צבע ראשי">
          {(p) => <Input {...p} name="primaryColor" type="color" defaultValue={house.primaryColor} className="h-9 w-full p-1" />}
        </Field>
        <Field label="צבע הדגשה">
          {(p) => <Input {...p} name="accentColor" type="color" defaultValue={house.accentColor} className="h-9 w-full p-1" />}
        </Field>
        <Field label="כתובת לוגו (URL)" className="col-span-2">
          {(p) => <Input {...p} name="logoUrl" type="url" defaultValue={house.logoUrl ?? ""} dir="ltr" maxLength={500} />}
        </Field>
        <Field label="ספרות במספר פריט">
          {(p) => <Input {...p} name="lotNumberWidth" type="number" min={1} max={6} defaultValue={house.settings.lotNumberWidth ?? 3} className="num" />}
        </Field>
        <Field label="מטבע לפרסום">
          {(p) => <Input {...p} name="publishCurrency" defaultValue={house.settings.publishCurrency ?? "USD"} dir="ltr" maxLength={10} />}
        </Field>
        <Field label="נוסח קבוע בסוף תיאור" className="col-span-2 sm:col-span-4">
          {(p) => <Textarea {...p} name="descriptionFooter" rows={2} defaultValue={house.settings.descriptionFooter ?? ""} maxLength={2000} />}
        </Field>
        <div className="col-span-2 sm:col-span-4">
          <Button type="submit" variant="primary" loading={busy}>
            שמירה
          </Button>
        </div>
      </form>
    </Panel>
  );
}
