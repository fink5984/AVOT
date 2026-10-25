"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { api, errorMessage } from "@/lib/api";

export function SetPasswordForm({ endpoint, submitLabel, redirectTo }: { endpoint: string; submitLabel: string; redirectTo: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password") ?? "");
    if (password !== String(f.get("confirm") ?? "")) {
      setError("הסיסמאות אינן תואמות");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api(endpoint, { method: "POST", json: { password } });
      router.replace(redirectTo);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-5">
      <Field label="סיסמה חדשה" hint="לפחות 10 תווים">
        {(p) => <Input {...p} name="password" type="password" autoComplete="new-password" dir="ltr" required minLength={10} autoFocus />}
      </Field>
      <Field label="אימות סיסמה">
        {(p) => <Input {...p} name="confirm" type="password" autoComplete="new-password" dir="ltr" required />}
      </Field>
      {error && (
        <p className="rounded-md bg-danger-soft px-3 py-2.5 text-[13px] text-danger" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full">
        {submitLabel}
      </Button>
    </form>
  );
}
