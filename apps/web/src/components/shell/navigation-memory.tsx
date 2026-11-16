"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { anchorFor, clearFresh, getScroller, isFresh, markFresh, patchRecord, restoreScroll, restoreWanted, type NavAnchor } from "@/lib/nav-memory";

/*
 * The shell part of the working-position memory (see src/lib/nav-memory.ts for what is remembered and when it is applied).
 *
 *  - while a page is shown: its scroll offset and query string are tracked;
 *  - when a link of the content is clicked: the row it belongs to is identified (address + offset + neighbours);
 *  - when the page is left (any way: a link, the browser's back / forward, router.push): a record is written, unless the
 *    sidebar was used - that is a NEW entry and forgets everything;
 *  - when a page is entered and a record exists for it (a return): the query string is put back if the entry was bare,
 *    and the row is brought back once the data is on screen.
 */

let historyPatched = false;

export function NavigationMemory() {
  const pathname = usePathname();
  const router = useRouter();
  /** what the page that is on screen looks like now */
  const snap = useRef({ path: pathname, search: "", top: 0 });
  const clicked = useRef<{ path: string; anchor: NavAnchor | null } | null>(null);
  const popAt = useRef(0);

  // listeners for the lifetime of the shell
  useEffect(() => {
    snap.current = { path: window.location.pathname, search: window.location.search, top: getScroller().top() };
    const onScroll = () => {
      // a scroll event after the next page has been drawn belongs to that page
      if (window.location.pathname === snap.current.path) {
        snap.current.top = getScroller().top();
        snap.current.search = window.location.search;
      }
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.<HTMLAnchorElement>("a[href]");
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      // the menu is a NEW entry: nothing of any list is applied on the way
      if (a.closest("#app-sidebar")) {
        markFresh();
        return;
      }
      let url: URL;
      try {
        url = new URL(a.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      snap.current.top = getScroller().top();
      snap.current.search = window.location.search;
      clicked.current = { path: window.location.pathname, anchor: anchorFor(a) };
    };
    const onPop = () => {
      popAt.current = Date.now();
    };
    const inner = document.querySelector<HTMLElement>("[data-app-scroll]");
    const targets: (Window | HTMLElement)[] = [window, ...(inner ? [inner] : [])];
    for (const t of targets) t.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop, true);
    // the query string changes inside a page (page, filters, search) without a new page: keep it current
    if (!historyPatched) {
      historyPatched = true;
      for (const m of ["pushState", "replaceState"] as const) {
        const orig = window.history[m].bind(window.history);
        window.history[m] = (...args: Parameters<History["pushState"]>) => {
          const samePage = window.location.pathname;
          const r = orig(...args);
          if (window.location.pathname === samePage) snap.current.search = window.location.search;
          return r;
        };
      }
    }
    return () => {
      for (const t of targets) t.removeEventListener("scroll", onScroll);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop, true);
    };
    // once for the lifetime of the shell: what the page that is on screen looks like survives the page change until the entry effect below has read it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a page was entered
  useEffect(() => {
    const left = snap.current;
    if (left.path !== pathname) {
      const anchor = clicked.current && clicked.current.path === left.path ? clicked.current.anchor : null;
      // opened: false after a sidebar click (a new entry); the record only keeps what was left
      patchRecord(left.path, (r) => ({ ...r, search: left.search, top: left.top, anchor, opened: !isFresh() }));
    }
    clicked.current = null;
    snap.current = { path: pathname, search: window.location.search, top: 0 };

    const rec = restoreWanted(pathname);
    clearFresh();
    if (!rec) return;
    const here = window.location.search;
    const viaPop = Date.now() - popAt.current < 2000;
    let wait = 0;
    if (!here && rec.search && !viaPop) {
      // entered bare (a breadcrumb, a back button of the page): the page, size, search, filters and sort come back
      router.replace(`${pathname}${rec.search}`, { scroll: false });
      wait = 1200;
    } else if (here !== rec.search) {
      // a different view of the page on purpose: the old position does not apply
      patchRecord(pathname, (r) => ({ ...r, opened: false }));
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void restoreScroll(rec).then(() => {
        if (!cancelled) patchRecord(pathname, (r) => ({ ...r, opened: false }));
      });
    }, wait);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return null;
}
