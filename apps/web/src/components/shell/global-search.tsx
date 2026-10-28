"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BookOpen, CornerDownLeft, Loader2, MapPin, Search } from "lucide-react";
import type { CatalogStatus, LotStatus } from "@avot/shared";
import { LotStatusBadge, PhotoStatusBadge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/misc";
import { cn } from "@/lib/cn";

interface Result {
  directLotId: string | null;
  directItemId: string | null;
  directLocationId: string | null;
  directLocation?: { id: string; label: string } | null;
  items: { id: string; inventoryNumber: string; title: string; author: string | null; photoStatus: LotStatus }[];
  lots: { id: string; lotNumber: number; title: string; subtitle: string | null; status: LotStatus; photoCount: number; catalog: { id: string; number: string; house: string } }[];
  catalogs: { id: string; number: string; name: string; status: CatalogStatus; house: string }[];
}

type Row = { key: string; href: string; node: React.ReactNode };

async function fetchResults(needle: string, signal?: AbortSignal): Promise<Result | null> {
  const r = await fetch(`/api/search?q=${encodeURIComponent(needle)}`, { signal, credentials: "same-origin" });
  return r.ok ? ((await r.json()) as Result) : null;
}

/** where Enter goes for a result: a scanned/typed exact code opens its target, otherwise the highlighted row */
function directHref(r: Result | null): string | null {
  if (!r) return null;
  if (r.directItemId) return `/inventory/${r.directItemId}`;
  if (r.directLotId) return `/lots/${r.directLotId}`;
  if (r.directLocationId) return `/warehouse/locations/${r.directLocationId}`;
  return null;
}

/**
 * Global search with instant results. Typing shows matches right under the
 * field; Enter opens the highlighted one. A USB barcode scanner "types" the
 * label code and presses Enter, which opens the book directly.
 */
export function GlobalSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLFormElement>(null);
  const listId = useId();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  /** the query the shown result belongs to — Enter must never act on the answer to an older query */
  const [resultFor, setResultFor] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    setOpen(false);
    setQ("");
    setResult(null);
  }, [pathname]);

  // Ctrl+K / "/" focuses the search (also receives USB barcode scanners)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable=true]");
      if ((e.ctrlKey && e.key.toLowerCase() === "k") || (e.key === "/" && !typing)) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    const needle = q.trim();
    if (!needle) {
      setResult(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      try {
        const r = await fetchResults(needle, ctrl.signal);
        if (r) {
          setResult(r);
          setResultFor(needle);
          setActive(0);
        }
      } catch {
        /* aborted or offline — the full search page still works */
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 160);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [q]);

  const rows: Row[] = [];
  if (result) {
    if (result.directLocation) {
      rows.push({
        key: `loc-${result.directLocation.id}`,
        href: `/warehouse/locations/${result.directLocation.id}`,
        node: (
          <>
            <MapPin className="size-4 shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate font-medium">{result.directLocation.label}</span>
          </>
        ),
      });
    }
    for (const i of result.items.slice(0, 5)) {
      rows.push({
        key: `i-${i.id}`,
        href: `/inventory/${i.id}`,
        node: (
          <>
            <span className="num w-24 shrink-0 font-mono text-[12px] text-muted">{i.inventoryNumber}</span>
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{i.title}</span>
              {i.author && <span className="text-muted"> · {i.author}</span>}
            </span>
            <PhotoStatusBadge status={i.photoStatus} className="hidden sm:inline-flex" />
          </>
        ),
      });
    }
    for (const l of result.lots.slice(0, 6)) {
      rows.push({
        key: `l-${l.id}`,
        href: `/lots/${l.id}`,
        node: (
          <>
            <span className="num w-24 shrink-0 truncate text-[12px] text-muted" title={l.catalog.house}>
              {l.catalog.house} {l.catalog.number}/<span className="font-semibold text-ink">{l.lotNumber}</span>
            </span>
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{l.title}</span>
              {l.subtitle && <span className="text-muted"> · {l.subtitle}</span>}
            </span>
            <LotStatusBadge status={l.status} className="hidden sm:inline-flex" />
          </>
        ),
      });
    }
    for (const c of result.catalogs.slice(0, 3)) {
      rows.push({
        key: `c-${c.id}`,
        href: `/catalogs/${c.id}`,
        node: (
          <>
            <BookOpen className="size-4 shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate">
              {c.house} · קטלוג <span className="num font-medium">{c.number}</span> · {c.name}
            </span>
          </>
        ),
      });
    }
  }
  const total = rows.length === 0 ? 0 : (result?.items.length ?? 0) + (result?.lots.length ?? 0) + (result?.catalogs.length ?? 0) + (result?.directLocation ? 1 : 0);

  function go(href: string) {
    setOpen(false);
    inputRef.current?.blur();
    router.push(href);
  }

  return (
    <form
      ref={rootRef}
      role="search"
      className="relative w-full max-w-xl"
      onSubmit={async (e) => {
        e.preventDefault();
        const needle = q.trim();
        if (!needle) return;
        // A USB scanner sends Enter right after the last digit, usually before the debounced request has even
        // started: resolve the code now instead of acting on the previous (or no) answer.
        let r = result;
        if (resultFor !== needle) {
          setLoading(true);
          try {
            r = await fetchResults(needle);
          } catch {
            r = null;
          } finally {
            setLoading(false);
          }
        }
        // a scanned tag / label / shelf code opens its target directly
        const direct = directHref(r);
        if (direct) return go(direct);
        if (r && r === result && open && rows[active]) return go(rows[active]!.href);
        go(`/search?q=${encodeURIComponent(needle)}`);
      }}
    >
      <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
      <input
        ref={inputRef}
        type="search"
        name="q"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => q && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(rows.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
        placeholder="חיפוש ספר, מחבר, מספר פריט או סריקת תווית"
        className="h-10 w-full rounded-lg border border-rule bg-paper ps-9 pe-16 text-[13.5px] shadow-card transition-[border-color,box-shadow] placeholder:text-faint hover:border-rule-strong focus:border-ink/50 focus:outline-none focus:ring-[3px] focus:ring-ink/8 [&::-webkit-search-cancel-button]:hidden"
        aria-label="חיפוש גלובלי"
        aria-expanded={open && !!q}
        aria-controls={listId}
        autoComplete="off"
      />
      <span className="pointer-events-none absolute end-2.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 sm:flex">
        {loading ? (
          <Loader2 className="size-4 animate-spin text-faint" />
        ) : (
          <>
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </>
        )}
      </span>

      {open && q.trim() && (
        <div id={listId} className="animate-pop absolute inset-x-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-rule bg-paper shadow-pop">
          {result && resultFor === q.trim() && total === 0 && !loading ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted">לא נמצאו ספרים או קטלוגים עבור ״{q.trim()}״</p>
          ) : !result ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted">מחפש…</p>
          ) : (
            <>
              <ul role="listbox" aria-label="תוצאות חיפוש" className="max-h-[60vh] overflow-y-auto p-1.5">
                {rows.map((r, i) => (
                  <li key={r.key} role="option" aria-selected={i === active}>
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => go(r.href)}
                      className={cn("flex h-10 w-full items-center gap-3 rounded-lg px-3 text-start text-[13.5px]", i === active && "bg-stone")}
                    >
                      {r.node}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => go(`/search?q=${encodeURIComponent(q.trim())}`)}
                className="flex w-full items-center justify-between border-t border-rule bg-stone-2 px-4 py-2.5 text-[12.5px] text-muted hover:text-ink"
              >
                <span>
                  כל התוצאות ({total}
                  {result.lots.length === 50 ? "+" : ""})
                </span>
                <CornerDownLeft className="size-3.5" />
              </button>
            </>
          )}
        </div>
      )}
    </form>
  );
}
