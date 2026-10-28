"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

const GAP = 6;
const EDGE = 8;

interface Placed {
  top: number;
  left: number;
  maxHeight: number;
  side: "below" | "above";
}

/**
 * Where the panel goes: next to the trigger, flipped above when there is no room below, shifted back inside the
 * viewport horizontally, and given a maximum height (the list scrolls inside) when neither side fits it whole.
 * Pure so it can be tested without a browser.
 */
export function placeMenu(
  trigger: { top: number; bottom: number; left: number; right: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  align: "start" | "end",
  rtl: boolean,
): Placed {
  const below = viewport.height - trigger.bottom - GAP - EDGE;
  const above = trigger.top - GAP - EDGE;
  // below unless it does not fit and the other side has more room
  const side: Placed["side"] = panel.height <= below || below >= above ? "below" : "above";
  const room = side === "below" ? below : above;
  const height = Math.min(panel.height, Math.max(room, 120));
  const top = side === "below" ? trigger.bottom + GAP : Math.max(EDGE, trigger.top - GAP - height);

  // "end" is the inline end: the left edge in RTL, the right edge in LTR
  const alignRight = align === "end" ? !rtl : rtl;
  let left = alignRight ? trigger.right - panel.width : trigger.left;
  left = Math.min(Math.max(EDGE, left), Math.max(EDGE, viewport.width - panel.width - EDGE));
  return { top, left, maxHeight: Math.max(120, room), side };
}

/** Dropdown menu in a portal (never clipped by an `overflow-hidden` card) with roving focus (↑/↓, Home/End, Esc). */
export function Menu({
  trigger,
  items,
  align = "end",
}: {
  trigger: (props: { onClick: () => void; "aria-expanded": boolean; "aria-haspopup": "menu"; "aria-controls": string }) => React.ReactNode;
  items: (MenuItem | "separator")[];
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    const t = root.current?.getBoundingClientRect();
    const p = panel.current;
    if (!t || !p) return;
    // measure the natural size, not the size it had under the previous maxHeight
    const natural = { width: p.offsetWidth, height: p.scrollHeight };
    const rtl = getComputedStyle(root.current!).direction === "rtl";
    setPlaced(placeMenu(t, natural, { width: window.innerWidth, height: window.innerHeight }, align, rtl));
  }, [align]);

  useLayoutEffect(() => {
    if (!open) {
      setPlaced(null);
      return;
    }
    reposition();
  }, [open, reposition, items.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const el = e.target as Node;
      if (!root.current?.contains(el) && !panel.current?.contains(el)) setOpen(false);
    };
    const onMove = () => reposition();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, { passive: true });
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true); // any scrolling ancestor
    requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus());
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, reposition]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("button, [href]")?.focus());
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) return;
    const els = [...(panel.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") els[(i + 1) % els.length]?.focus();
    else if (e.key === "ArrowUp") els[(i - 1 + els.length) % els.length]?.focus();
    else if (e.key === "Home") els[0]?.focus();
    else if (e.key === "End") els[els.length - 1]?.focus();
    else if (e.key === "Tab") return close(false);
    else if (e.key === "Escape") close(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div ref={root} className="relative inline-block" onKeyDown={onKey}>
      {trigger({ onClick: () => setOpen((o) => !o), "aria-expanded": open, "aria-haspopup": "menu", "aria-controls": id })}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="menu"
            data-menu-side={placed?.side}
            onKeyDown={onKey}
            style={{
              position: "fixed",
              top: placed?.top ?? 0,
              left: placed?.left ?? 0,
              maxHeight: placed?.maxHeight,
              // measured first, shown once placed — no flash in the wrong corner
              visibility: placed ? "visible" : "hidden",
            }}
            className="animate-pop z-[100] w-max min-w-52 max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-lg border border-rule bg-paper p-1 shadow-pop"
          >
            {items.map((item, i) =>
              item === "separator" ? (
                <div key={i} className="-mx-1 my-1 border-t border-rule" role="separator" />
              ) : (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  className={cn(
                    "flex h-8.5 w-full items-center gap-2.5 rounded-md px-2.5 text-start text-[13.5px] hover:bg-stone focus:bg-stone focus:outline-none disabled:opacity-40 [@media(pointer:coarse)]:h-11",
                    item.danger ? "text-danger [&_.menu-icon]:text-danger" : "text-ink",
                  )}
                >
                  <span className="menu-icon size-4 shrink-0 text-muted [&>svg]:size-4">{item.icon}</span>
                  <span className="flex-1 whitespace-nowrap">{item.label}</span>
                  {item.hint && <span className="text-[11px] text-faint">{item.hint}</span>}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
