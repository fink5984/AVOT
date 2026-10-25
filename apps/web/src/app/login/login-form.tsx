"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { api, errorMessage } from "@/lib/api";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setLoading(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", json: { email: form.get("email"), password: form.get("password") } });
      // return to the page that required the login (same-origin paths only — e.g. the handheld /scanner)
      const next = new URLSearchParams(window.location.search).get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-5" noValidate>
      <Field label="אימייל">
        {(p) => <Input {...p} name="email" type="email" autoComplete="username" dir="ltr" className="h-11 text-start" required autoFocus />}
      </Field>
      <Field label="סיסמה">
        {(p) => <Input {...p} name="password" type="password" autoComplete="current-password" dir="ltr" required className="h-11" />}
      </Field>
      {error && (
        <p className="rounded-md bg-danger-soft px-3 py-2.5 text-[13px] text-danger" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" loading={loading} className="mt-1 w-full">
        כניסה
      </Button>
    </form>
  );
}
