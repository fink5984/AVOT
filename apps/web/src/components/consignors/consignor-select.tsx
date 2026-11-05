"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import type { ConsignorDto } from "@/server/services/consignors";
import { ConsignorDialog, type ConsignorLite } from "./consignor-dialog";

const LAST_KEY = "avot.lastConsignor";

/** The consignor chosen last on this computer: only ever offered as a starting point in rapid-intake dialogs. */
export function lastConsignor(): ConsignorLite | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null") as ConsignorLite | null;
    return v?.id && v.name ? v : null;
  } catch {
    return null;
  }
}
function rememberConsignor(c: ConsignorLite) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ id: c.id, name: c.name }));
  } catch {
    /* private mode: just no default */
  }
}

/**
 * The one consignor picker of the whole system (full book form, quick add, capture dialogs, duplicate, edit).
 * Type to search by name or phone, arrows + Enter to choose, "+ מפקיד חדש" creates one in place — the new consignor
 * is selected at once and nothing else in the surrounding form is touched.
 */
export function ConsignorSelect({
  value,
  onChange,
  autoFocus,
  invalid,
  disabled,
  onCommit,
  id,
  className,
}: {
  value: ConsignorLite | null;
  onChange: (c: ConsignorLite) => void;
  autoFocus?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  /** Enter on an already chosen consignor (with the list closed): the host form may submit */
  onCommit?: () => void;
  id?: string;
  className?: string;
}) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConsignorDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  // after a consignor was created the focus returns to the field without reopening the list
  const skipOpen = useRef(false);

  const load = useCallback((q: string) => {
    const mine = ++seq.current;
    setLoading(true);
    setFailed(false);
    api<{ consignors: ConsignorDto[] }>(`/api/consignors?limit=30&q=${encodeURIComponent(q)}`)
      .then((r) => {
        if (mine === seq.current) setResults(r.consignors);
      })
      .catch(() => mine === seq.current && setFailed(true))
      .finally(() => mine === seq.current && setLoading(false));
  }, []);

  // search while typing (a late answer to an older query is ignored)
  useEffect(() => {
    if (!open) return;
    const h = setTimeout(() => load(query), query ? 200 : 0);
    return () => clearTimeout(h);
  }, [open, query, load]);
  // the highlighted row starts on the chosen consignor, so Enter right after opening keeps it
  useEffect(() => setActive(Math.max(0, results.findIndex((r) => r.id === value?.id))), [results, value?.id]);
  useEffect(() => {
    if (!autoFocus) return;
    // focused on arrival with the list closed (it would cover the dialog's buttons): typing, a click or the arrows open it;
    // with a consignor already chosen Enter confirms it
    skipOpen.current = true;
    input.current?.focus();
    skipOpen.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const newRow = results.length; // the last option is "+ מפקיד חדש"
  function choose(c: ConsignorLite) {
    rememberConsignor(c);
    onChange({ id: c.id, name: c.name });
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      const n = results.length + 1;
      setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a - 1 + n) % n));
    } else if (e.key === "Enter") {
      // never lets Enter submit the surrounding form by accident
      e.preventDefault();
      e.stopPropagation();
      if (open) {
        if (active === newRow) setCreating(true);
        else if (results[active]) choose(results[active]!);
      } else if (value) onCommit?.();
      else setOpen(true);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div className={cn("relative", className)}>
      <div className="flex gap-2">
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-invalid={invalid || undefined}
          aria-activedescendant={open ? `${uid}-o${active}` : undefined}
          disabled={disabled}
          autoComplete="off"
          value={open ? query : (value?.name ?? "")}
          placeholder={open || !value ? "חיפוש לפי שם או טלפון…" : undefined}
          onFocus={(e) => {
            if (skipOpen.current) {
              skipOpen.current = false;
              return;
            }
            setOpen(true);
            e.currentTarget.select?.();
          }}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onBlur={() => {
            setOpen(false);
            setQuery("");
          }}
          onKeyDown={onKeyDown}
          className={cn(
            "h-9 w-full min-w-0 rounded-md border bg-paper px-3 text-[13.5px] text-ink shadow-card placeholder:text-faint hover:border-[#c6c2b8] focus:border-ink/60 focus:outline-none focus:ring-[3px] focus:ring-ink/8 disabled:bg-stone-2",
            invalid ? "border-danger" : "border-rule-strong",
          )}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => setCreating(true)}
          className="flex h-9 shrink-0 items-center gap-1 rounded-md border border-rule-strong bg-paper px-2.5 text-[13px] font-medium text-ink-2 shadow-card hover:bg-stone disabled:opacity-50"
        >
          <Plus className="size-3.5" aria-hidden />
          מפקיד חדש
        </button>
      </div>

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-md border border-rule-strong bg-paper py-1 text-[13.5px] shadow-pop"
          onMouseDown={(e) => e.preventDefault()}
        >
          {results.map((c, i) => (
            <li
              key={c.id}
              id={`${uid}-o${i}`}
              role="option"
              aria-selected={c.id === value?.id}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(c)}
              className={cn("flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5", i === active && "bg-stone", c.id === value?.id && "font-semibold")}
            >
              <span className="truncate">{c.name}</span>
              {c.phone && (
                <span dir="ltr" className="num shrink-0 text-[12px] text-muted">
                  {c.phone}
                </span>
              )}
            </li>
          ))}
          {!loading && !failed && results.length === 0 && <li className="px-3 py-1.5 text-muted">{query ? "לא נמצא מפקיד כזה" : "אין עדיין מפקידים"}</li>}
          {loading && <li className="px-3 py-1.5 text-muted">מחפש…</li>}
          {failed && <li className="px-3 py-1.5 text-danger">החיפוש נכשל — בדקו את החיבור</li>}
          <li
            id={`${uid}-o${newRow}`}
            role="option"
            aria-selected={false}
            onMouseEnter={() => setActive(newRow)}
            onClick={() => setCreating(true)}
            className={cn("flex cursor-pointer items-center gap-1.5 border-t border-rule px-3 py-1.5 font-medium text-accent", active === newRow && "bg-stone")}
          >
            <Plus className="size-3.5" aria-hidden />
            מפקיד חדש{query.trim() ? ` ״${query.trim()}״` : ""}
          </li>
        </ul>
      )}

      <ConsignorDialog
        open={creating}
        onClose={() => {
          setCreating(false);
          requestAnimationFrame(() => {
            input.current?.focus();
            skipOpen.current = false;
          });
        }}
        defaultName={query.trim()}
        onSaved={(c) => {
          skipOpen.current = true;
          choose(c);
        }}
      />
    </div>
  );
}
