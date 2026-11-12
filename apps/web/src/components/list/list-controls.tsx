"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { matchesTokens, parseList } from "@/lib/search-text";

/**
 * Filtering of a list. The address of the page is the single source of truth (?q=…&photo=A,B&sort=…): the list is
 * produced by the server from it, so every result is a real database result (all pages, not only the one on screen),
 * the browser's back button returns to the same search, and a link can be shared.
 *
 *  - the search box filters while typing (short pause, no Enter, no button, no suggestions to pick from)
 *  - "סינון" opens one window with the filters in groups; several values in a group = any of them, groups = all of them
 *  - the active filters show as chips under the box, each removable alone; "איפוס הכול" clears search and filters
 */

export interface FilterOption {
  value: string;
  label: string;
}

interface GroupBase {
  /** URL parameter */
  key: string;
  label: string;
  /** heading inside the window */
  section: string;
}
export type FilterGroup =
  | (GroupBase & { kind: "multi"; options: FilterOption[]; /** a find-as-you-type box above a long list */ searchable?: boolean })
  /** exactly one value (or none) */
  | (GroupBase & { kind: "choice"; options: FilterOption[] })
  | (GroupBase & { kind: "text"; placeholder?: string })
  /** two parameters: <key>From and <key>To */
  | (GroupBase & { kind: "range"; type: "number" | "date" })
  /** an on/off condition ("?key=1") */
  | (GroupBase & { kind: "flag" });

/* ── while the server prepares a new result, the list can show it is being replaced (without a layout jump) ── */
let pending = false;
const listeners = new Set<() => void>();
const setPending = (v: boolean) => {
  if (pending === v) return;
  pending = v;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useListPending = () =>
  useSyncExternalStore(
    subscribe,
    () => pending,
    () => false,
  );

/** Wrap the results: they fade a little while a newer search is on its way. */
export function ListResults({ children, className }: { children: React.ReactNode; className?: string }) {
  const busy = useListPending();
  return (
    <div aria-busy={busy || undefined} className={cn("transition-opacity duration-150", busy && "opacity-55", className)} data-testid="list-results">
      {children}
    </div>
  );
}

const DEBOUNCE_MS = 250;

function chipsOf(groups: FilterGroup[], sp: URLSearchParams) {
  const chips: { id: string; label: string; clear: Record<string, string | null> }[] = [];
  for (const g of groups) {
    if (g.kind === "multi") {
      const sel = parseList(sp.get(g.key));
      for (const v of sel) {
        const label = g.options.find((o) => o.value === v)?.label ?? v;
        const rest = sel.filter((x) => x !== v);
        chips.push({ id: `${g.key}:${v}`, label: `${g.label}: ${label}`, clear: { [g.key]: rest.length ? rest.join(",") : null } });
      }
    } else if (g.kind === "choice") {
      const v = sp.get(g.key);
      if (v) chips.push({ id: g.key, label: `${g.label}: ${g.options.find((o) => o.value === v)?.label ?? v}`, clear: { [g.key]: null } });
    } else if (g.kind === "text") {
      const v = sp.get(g.key);
      if (v) chips.push({ id: g.key, label: `${g.label}: ${v}`, clear: { [g.key]: null } });
    } else if (g.kind === "range") {
      const from = sp.get(`${g.key}From`);
      const to = sp.get(`${g.key}To`);
      if (from || to) chips.push({ id: g.key, label: `${g.label}: ${from || "…"} – ${to || "…"}`, clear: { [`${g.key}From`]: null, [`${g.key}To`]: null } });
    } else if (sp.get(g.key)) {
      chips.push({ id: g.key, label: g.label, clear: { [g.key]: null } });
    }
  }
  return chips;
}

const paramsOf = (g: FilterGroup) => (g.kind === "range" ? [`${g.key}From`, `${g.key}To`] : [g.key]);

export function ListControls({
  placeholder,
  searchLabel,
  groups = [],
  sort,
  resetKeys = [],
  children,
  className,
}: {
  placeholder: string;
  searchLabel: string;
  groups?: FilterGroup[];
  /** a sort selector next to the search (value goes to ?sort=) */
  sort?: { options: FilterOption[]; defaultValue: string };
  /** other parameters that "reset all" also clears (a view tab, for example) */
  resetKeys?: string[];
  /** extra buttons at the end of the row */
  children?: React.ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const urlQ = sp.get("q") ?? "";
  const [text, setText] = useState(urlQ);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const sent = useRef(urlQ); // the last value this box pushed to the address
  const history = useRef(new Set([urlQ])); // everything this box pushed (the address catches up with them one by one)
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    busy.current = isPending;
    setPending(isPending);
  }, [isPending]);
  useEffect(() => () => setPending(false), []);

  // the address changed from somewhere else (back button, reset all, a link): the box follows it
  useEffect(() => {
    if (urlQ === sent.current) return;
    // an older value of our own arriving while a newer one is on its way must not overwrite what is being typed
    if (busy.current && history.current.has(urlQ)) return;
    sent.current = urlQ;
    setText(urlQ);
  }, [urlQ]);

  const go = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      next.delete("page"); // a changed search starts at its first page
      const qs = next.toString();
      startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
    },
    [router, pathname],
  );

  function typed(v: string) {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const clean = v.replace(/\s+/g, " ").trim();
      if (clean === sent.current) return;
      sent.current = clean;
      history.current.add(clean);
      go({ q: clean || null });
    }, DEBOUNCE_MS);
  }
  useEffect(() => () => clearTimeout(timer.current), []);

  function flush(v: string) {
    clearTimeout(timer.current);
    const clean = v.replace(/\s+/g, " ").trim();
    sent.current = clean;
    history.current.add(clean);
    setText(v);
    go({ q: clean || null });
  }

  const chips = useMemo(() => chipsOf(groups, new URLSearchParams(sp.toString())), [groups, sp]);
  const anyActive = chips.length > 0 || !!urlQ || text.trim() !== "" || resetKeys.some((k) => sp.get(k));

  function resetAll() {
    clearTimeout(timer.current);
    sent.current = "";
    setText("");
    const patch: Record<string, string | null> = { q: null };
    for (const g of groups) for (const k of paramsOf(g)) patch[k] = null;
    for (const k of resetKeys) patch[k] = null;
    go(patch);
  }

  function openPanel() {
    const d: Record<string, string> = {};
    for (const g of groups) for (const k of paramsOf(g)) d[k] = sp.get(k) ?? "";
    setDraft(d);
    setOpen(true);
  }
  function applyPanel() {
    setOpen(false);
    go(Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v || null])));
  }

  const sections = useMemo(() => {
    const out: { name: string; groups: FilterGroup[] }[] = [];
    for (const g of groups) {
      let s = out.find((x) => x.name === g.section);
      if (!s) out.push((s = { name: g.section, groups: [] }));
      s.groups.push(g);
    }
    return out;
  }, [groups]);

  const sortValue = sp.get("sort") ?? sort?.defaultValue ?? "";

  return (
    <div className={cn("space-y-2", className)} data-testid="list-controls">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56 sm:max-w-lg">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <input
            type="search"
            value={text}
            onChange={(e) => typed(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (!e.nativeEvent.isComposing) flush(text);
              } else if (e.key === "Escape" && text) {
                e.preventDefault();
                flush("");
              }
            }}
            placeholder={placeholder}
            aria-label={searchLabel}
            autoComplete="off"
            enterKeyHint="search"
            maxLength={200}
            data-testid="list-search"
            className="h-9 w-full rounded-md border border-rule-strong bg-paper ps-9 pe-16 text-[13.5px] shadow-card placeholder:text-faint hover:border-[#c6c2b8] focus:border-ink/50 focus:outline-none focus:ring-[3px] focus:ring-ink/8 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
          />
          <div className="absolute end-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            {isPending && <Loader2 className="size-3.5 animate-spin text-muted" aria-label="מחפש" role="status" />}
            {text && (
              <button type="button" onClick={() => flush("")} aria-label="ניקוי החיפוש" title="ניקוי החיפוש" data-testid="list-search-clear" className="rounded p-1 text-muted hover:bg-stone hover:text-ink">
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        {groups.length > 0 && (
          <Button icon={<SlidersHorizontal />} onClick={openPanel} aria-haspopup="dialog" data-testid="list-filter-button">
            סינון
            {chips.length > 0 && <span className="num ms-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-ink px-1.5 text-[11.5px] leading-5 text-paper">{chips.length}</span>}
          </Button>
        )}
        {sort && (
          <select
            value={sortValue}
            onChange={(e) => go({ sort: e.target.value === sort.defaultValue ? null : e.target.value })}
            aria-label="מיון"
            className="h-9 rounded-md border border-rule-strong bg-paper px-2 text-[13px] shadow-card"
          >
            {sort.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        {children}
      </div>

      {(chips.length > 0 || anyActive) && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="active-filters" aria-label="סינונים פעילים">
          {chips.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1 rounded-full bg-stone py-0.5 pe-1 ps-2.5 text-[12.5px] text-ink-2 ring-1 ring-rule">
              {c.label}
              <button type="button" onClick={() => go(c.clear)} aria-label={`הסרת הסינון: ${c.label}`} className="rounded-full p-0.5 text-muted hover:bg-rule hover:text-ink">
                <X className="size-3" />
              </button>
            </span>
          ))}
          {anyActive && (
            <button type="button" onClick={resetAll} data-testid="list-reset" className="rounded-md px-2 py-0.5 text-[12.5px] font-medium text-accent-2 hover:bg-accent-soft">
              איפוס הכול
            </button>
          )}
        </div>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="סינון"
        description="בתוך קבוצה — מספיק שאחד מהערכים מתאים. בין קבוצות — כל התנאים חייבים להתקיים."
        width="lg"
        footer={
          <>
            <Button variant="primary" onClick={applyPanel} data-testid="filter-apply">
              הצגת תוצאות
            </Button>
            <Button variant="ghost" onClick={() => setDraft((d) => Object.fromEntries(Object.keys(d).map((k) => [k, ""])))}>
              ניקוי הבחירות
            </Button>
          </>
        }
      >
        <div className="space-y-6">
          {sections.map((s) => (
            <section key={s.name} aria-label={s.name}>
              <h3 className="mb-2.5 border-b border-rule pb-1.5 text-[13px] font-semibold text-ink">{s.name}</h3>
              <div className="space-y-4">
                {s.groups.map((g) => (
                  <GroupEditor key={g.key} group={g} draft={draft} setDraft={setDraft} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </Dialog>
    </div>
  );
}

function GroupEditor({ group: g, draft, setDraft }: { group: FilterGroup; draft: Record<string, string>; setDraft: React.Dispatch<React.SetStateAction<Record<string, string>>> }) {
  const [find, setFind] = useState("");
  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  if (g.kind === "flag") {
    return (
      <label className="flex cursor-pointer items-center gap-2 text-[13.5px] text-ink-2">
        <input type="checkbox" checked={!!draft[g.key]} onChange={(e) => set(g.key, e.target.checked ? "1" : "")} className="size-4 accent-[var(--color-ink)]" />
        {g.label}
      </label>
    );
  }
  if (g.kind === "text") {
    return (
      <label className="block">
        <span className="mb-1 block text-[12.5px] font-medium text-ink-2">{g.label}</span>
        <input value={draft[g.key] ?? ""} onChange={(e) => set(g.key, e.target.value)} placeholder={g.placeholder} className="h-9 w-full rounded-md border border-rule-strong bg-paper px-3 text-[13.5px] shadow-card focus:border-ink/50 focus:outline-none focus:ring-[3px] focus:ring-ink/8" />
      </label>
    );
  }
  if (g.kind === "range") {
    const from = `${g.key}From`;
    const to = `${g.key}To`;
    const cls = "num h-9 w-full rounded-md border border-rule-strong bg-paper px-3 text-[13.5px] shadow-card focus:border-ink/50 focus:outline-none focus:ring-[3px] focus:ring-ink/8";
    return (
      <fieldset>
        <legend className="mb-1 text-[12.5px] font-medium text-ink-2">{g.label}</legend>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-0.5 block text-[12px] text-muted">מ־</span>
            <input type={g.type} inputMode={g.type === "number" ? "numeric" : undefined} value={draft[from] ?? ""} onChange={(e) => set(from, e.target.value)} className={cls} />
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[12px] text-muted">עד</span>
            <input type={g.type} inputMode={g.type === "number" ? "numeric" : undefined} value={draft[to] ?? ""} onChange={(e) => set(to, e.target.value)} className={cls} />
          </label>
        </div>
      </fieldset>
    );
  }

  const multi = g.kind === "multi";
  const selected = multi ? parseList(draft[g.key]) : draft[g.key] ? [draft[g.key]!] : [];
  const toggle = (v: string) => {
    if (!multi) return set(g.key, selected[0] === v ? "" : v);
    set(g.key, (selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]).join(","));
  };
  const long = g.options.length > 9;
  const shown = long && find.trim() ? g.options.filter((o) => matchesTokens([o.label], find)) : g.options;

  return (
    <fieldset>
      <legend className="mb-1.5 text-[12.5px] font-medium text-ink-2">
        {g.label}
        {selected.length > 0 && <span className="num ms-1.5 text-muted">({selected.length})</span>}
      </legend>
      {long ? (
        <div className="rounded-md border border-rule">
          {g.kind === "multi" && g.searchable !== false && (
            <input value={find} onChange={(e) => setFind(e.target.value)} placeholder={`חיפוש ב${g.label}…`} aria-label={`חיפוש ב${g.label}`} className="h-8 w-full rounded-t-md border-b border-rule bg-stone-2 px-3 text-[13px] focus:outline-none" />
          )}
          <ul className="max-h-44 overflow-y-auto overscroll-contain p-1">
            {shown.length === 0 && <li className="px-2 py-2 text-[12.5px] text-muted">אין התאמות</li>}
            {shown.map((o) => (
              <li key={o.value}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13.5px] hover:bg-stone-2">
                  <input type={multi ? "checkbox" : "radio"} checked={selected.includes(o.value)} onChange={() => toggle(o.value)} className="size-4 accent-[var(--color-ink)]" />
                  <span className="truncate">{o.label}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={g.label}>
          {g.options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(o.value)}
                className={cn("h-8 rounded-full border px-3 text-[13px] transition-colors", on ? "border-ink bg-ink text-paper" : "border-rule-strong bg-paper text-ink-2 hover:bg-stone-2")}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
