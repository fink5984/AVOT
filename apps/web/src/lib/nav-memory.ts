"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/*
 * Working-position memory for lists. The editor goes page 3 → scrolls → opens a book → comes back, and must land on the
 * same page, with the same search / filters / sort, on the same row - even though the list changed meanwhile (other users,
 * background jobs) and even though only the app's inner content area scrolls.
 *
 * What is remembered, per page path (sessionStorage = per tab, gone when the tab closes):
 *   - search: the URL's query string (page, size, search text, filters, sort of server-driven lists)
 *   - state:  the screen state of client-side lists (useRememberedState)
 *   - top:    the scroll offset of the content area (a fallback only)
 *   - anchor: the STABLE identity of the row the person left from: the address of the item that was opened, the row's
 *             distance from the top of the area, and the addresses of its neighbours. It is found again in the rebuilt
 *             list by that identity - never by pixels alone. If the row is gone (moved, filtered out) the nearest
 *             remembered neighbour that is still listed is used; only without any of them does the offset apply.
 *
 * When it is applied: only on a RETURN - the page was left by opening something (a link in the content, the browser's
 * back / forward, a programmatic navigation) and is entered again. A click in the sidebar is a NEW entry: everything is
 * forgotten and the list opens clean. A record older than a few hours is never applied.
 *
 * The record is applied once, after the data is on screen: the restorer waits for the row to appear (server data, a
 * filter being re-applied, late images) and aligns it; it stops at the first scroll gesture of the person, so a late
 * refresh of the data never fights them. The shell's own "start at the top on a page change" is skipped while a record
 * is being applied.
 */

const PREFIX = "avot.nav.v1:";
const TTL_MS = 4 * 60 * 60 * 1000;

export interface NavAnchor {
  /** address (path) of the item that was opened from the list */
  href: string;
  /** the row's top, measured from the top of the scrolling area */
  offset: number;
  /** addresses of the items around it, nearest first (the way back when the row itself is gone) */
  neighbors: string[];
}
export interface NavRecord {
  path: string;
  search: string;
  top: number;
  anchor: NavAnchor | null;
  /** the page was left through an item / link: a return may restore it */
  opened: boolean;
  ts: number;
  state: Record<string, unknown>;
}

const ok = () => typeof window !== "undefined";

export function readRecord(path: string): NavRecord | null {
  if (!ok()) return null;
  try {
    const r = JSON.parse(window.sessionStorage.getItem(PREFIX + path) ?? "null") as NavRecord | null;
    if (!r || typeof r.ts !== "number" || Date.now() - r.ts > TTL_MS) return null;
    return r;
  } catch {
    return null;
  }
}
export function writeRecord(r: NavRecord) {
  if (!ok()) return;
  try {
    window.sessionStorage.setItem(PREFIX + r.path, JSON.stringify(r));
  } catch {
    /* storage full / blocked: lists still work, they just open clean */
  }
}
export function patchRecord(path: string, fn: (r: NavRecord) => NavRecord) {
  const base: NavRecord = readRecord(path) ?? { path, search: "", top: 0, anchor: null, opened: false, ts: Date.now(), state: {} };
  writeRecord({ ...fn(base), ts: Date.now() });
}
/** a new entry through the menu: nothing of any list is applied, and nothing old lingers */
export function forgetAll() {
  if (!ok()) return;
  try {
    for (const k of Object.keys(window.sessionStorage)) if (k.startsWith(PREFIX)) window.sessionStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** set by a sidebar click (a NEW entry), cleared when that navigation has settled */
let fresh = false;
export const markFresh = () => {
  fresh = true;
  forgetAll();
};
export const isFresh = () => fresh;
export const clearFresh = () => {
  fresh = false;
};
/** the record that should be applied on arrival at `path` (a return), or null (a new entry) */
export function restoreWanted(path: string): NavRecord | null {
  if (fresh) return null;
  const r = readRecord(path);
  return r && r.opened ? r : null;
}

/* ───────────── the scrolling area ───────────── */

/** the app's inner content area on a computer, the window on a phone */
export function getScroller(): { el: HTMLElement | null; top: () => number; set: (y: number) => void; by: (dy: number) => void; box: () => number } {
  const m = ok() ? document.querySelector<HTMLElement>("[data-app-scroll]") : null;
  const inner = !!m && ["auto", "scroll"].includes(getComputedStyle(m).overflowY);
  if (inner && m) return { el: m, top: () => m.scrollTop, set: (y) => m.scrollTo({ top: y }), by: (dy) => m.scrollBy({ top: dy }), box: () => m.getBoundingClientRect().top };
  return { el: null, top: () => window.scrollY, set: (y) => window.scrollTo({ top: y }), by: (dy) => window.scrollBy({ top: dy }), box: () => 0 };
}

const pathOf = (a: HTMLAnchorElement) => {
  try {
    const u = new URL(a.href, window.location.href);
    return u.origin === window.location.origin ? u.pathname : null;
  } catch {
    return null;
  }
};

/** the identity of the row a link belongs to: the link's address, the row's offset, the neighbours' addresses */
export function anchorFor(link: HTMLAnchorElement): NavAnchor | null {
  const href = pathOf(link);
  if (!href) return null;
  const sc = getScroller();
  const row = link.closest<HTMLElement>("tr, li, article, [data-row-id]") ?? link;
  const prefix = `/${href.split("/")[1] ?? ""}/`;
  const main = document.querySelector("[data-app-scroll]") ?? document.body;
  const hrefs: string[] = [];
  for (const a of main.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const p = pathOf(a);
    if (p && p.startsWith(prefix) && p !== prefix && !hrefs.includes(p)) hrefs.push(p);
  }
  const i = hrefs.indexOf(href);
  const neighbors: string[] = [];
  for (let d = 1; d <= 8; d++) {
    if (i + d < hrefs.length) neighbors.push(hrefs[i + d]!);
    if (i - d >= 0) neighbors.push(hrefs[i - d]!);
  }
  return { href, offset: Math.round(row.getBoundingClientRect().top - sc.box()), neighbors };
}

/**
 * Brings the remembered row back. Resolves when it is placed, the person scrolled, or it could not be found in time.
 * `loaded` = the list has rows again (so a missing row means "gone", not "not drawn yet").
 */
export function restoreScroll(rec: NavRecord): Promise<"anchor" | "neighbor" | "offset" | "stopped" | "timeout"> {
  return new Promise((resolve) => {
    const sc = getScroller();
    const started = performance.now();
    let stopped = false;
    let placedAt = 0;
    let how: "anchor" | "neighbor" | "offset" = "offset";
    const stop = () => {
      stopped = true;
    };
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const e of events) window.addEventListener(e, stop, { passive: true, once: true });
    const done = (r: "anchor" | "neighbor" | "offset" | "stopped" | "timeout") => {
      for (const e of events) window.removeEventListener(e, stop);
      resolve(r);
    };
    const find = (href: string) => {
      const main = document.querySelector("[data-app-scroll]") ?? document.body;
      for (const a of main.querySelectorAll<HTMLAnchorElement>("a[href]")) if (pathOf(a) === href) return a.closest<HTMLElement>("tr, li, article, [data-row-id]") ?? a;
      return null;
    };
    const listed = () => {
      const prefix = rec.anchor ? `/${rec.anchor.href.split("/")[1] ?? ""}/` : null;
      if (!prefix) return document.body.scrollHeight > 0;
      const main = document.querySelector("[data-app-scroll]") ?? document.body;
      for (const a of main.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        const p = pathOf(a);
        if (p && p.startsWith(prefix) && p !== prefix) return true;
      }
      return false;
    };
    const place = (el: HTMLElement, offset: number) => {
      const delta = el.getBoundingClientRect().top - (sc.box() + offset);
      if (Math.abs(delta) > 1) sc.by(delta);
    };
    const tick = () => {
      if (stopped) return done("stopped");
      const elapsed = performance.now() - started;
      if (rec.anchor) {
        const el = find(rec.anchor.href);
        if (el) {
          how = "anchor";
          place(el, rec.anchor.offset);
          placedAt ||= performance.now();
          // keep it aligned while late images / rows change the layout, for a short while
          if (performance.now() - placedAt > 900) return done("anchor");
          return void requestAnimationFrame(tick);
        }
        if (listed() && elapsed > 400) {
          // the row is gone (moved, removed by a filter, sorted elsewhere): the nearest neighbour that is still listed
          for (const n of rec.anchor.neighbors) {
            const nel = find(n);
            if (nel) {
              how = "neighbor";
              place(nel, rec.anchor.offset);
              placedAt ||= performance.now();
              if (performance.now() - placedAt > 600) return done("neighbor");
              return void requestAnimationFrame(tick);
            }
          }
          // none of them: the remembered offset, clamped to what exists - never a reset to the top just because a row vanished
          sc.set(rec.top);
          return done("offset");
        }
      } else if (elapsed > 300 && document.body.scrollHeight > 0) {
        sc.set(rec.top);
        placedAt ||= performance.now();
        if (performance.now() - placedAt > 600) return done("offset");
      }
      if (elapsed > 5000) return done("timeout");
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    void how;
  });
}

/* ───────────── client-side list state ───────────── */

/**
 * useState for the screen state of a client-side list (search text, status filter, sort): remembered per page, and put
 * back on a RETURN to the page. A new entry (the sidebar) starts from `initial`.
 */
export function useRememberedState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const path = usePathname();
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const rec = restoreWanted(path);
    if (rec && key in rec.state) setValue(rec.state[key] as T);
    else patchRecord(path, (r) => ({ ...r, state: Object.fromEntries(Object.entries(r.state).filter(([k]) => k !== key)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        patchRecord(path, (r) => ({ ...r, state: { ...r.state, [key]: v } }));
        return v;
      });
    },
    [path, key],
  );
  return [value, set];
}
