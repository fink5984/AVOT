"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bold, RemoveFormatting, Underline } from "lucide-react";
import { applyStyle, mergeSegments, plainText, sameSegments, rangeHas, replaceRange, TEXT_COLORS, wordAt, type Segment, type StylePatch } from "@/lib/rich-text";
import { cn } from "@/lib/cn";

/*
 * A small editor for character formatting: select words or letters and make them bold, underlined or colored.
 * The model is a list of segments (see lib/rich-text). The DOM of the editable area is always rebuilt from that
 * model in one canonical shape (text nodes and styled spans), so whatever the browser does while typing,
 * the text that is saved is exactly what the person sees. Paste is plain text only; undo is our own.
 */

type Style = Omit<Segment, "t">;

/** The inline style of a formatted segment - shared by the editor and by the read-only view. */
export function segmentStyle(s: Style): React.CSSProperties | undefined {
  if (!s.b && !s.u && !s.c) return undefined;
  return {
    fontWeight: s.b ? 700 : undefined,
    textDecorationLine: s.u ? "underline" : undefined,
    textUnderlineOffset: s.u ? "0.2em" : undefined,
    color: s.c,
  };
}

/** Read-only view of formatted text (whitespace and line breaks are the caller's className, e.g. whitespace-pre-line). */
export function FormattedText({ segments, className }: { segments: Segment[]; className?: string }) {
  return (
    <p className={className}>
      {segments.map((s, i) => {
        const style = segmentStyle(s);
        return style ? (
          <span key={i} style={style}>
            {s.t}
          </span>
        ) : (
          <span key={i}>{s.t}</span>
        );
      })}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// DOM <-> model

interface Item {
  node: Node;
  start: number;
  len: number;
  /** a text node (offsets inside it are characters); otherwise a <br> or the start of a block */
  text: boolean;
}

function toHex(color: string): string | undefined {
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  const m = c.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return undefined;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}

function styleOf(el: HTMLElement, parent: Style, baseColor: string | undefined): Style {
  const s: Style = { ...parent };
  const tag = el.tagName;
  if (tag === "B" || tag === "STRONG") s.b = true;
  if (tag === "U") s.u = true;
  const fw = el.style.fontWeight;
  if (fw) {
    if (fw === "bold" || fw === "bolder" || Number(fw) >= 600) s.b = true;
    else delete s.b;
  }
  const td = el.style.textDecorationLine || el.style.textDecoration;
  if (td) {
    if (td.includes("underline")) s.u = true;
    else if (td.includes("none")) delete s.u;
  }
  const raw = el.style.color || (tag === "FONT" ? (el.getAttribute("color") ?? "") : "");
  if (raw) {
    const hex = toHex(raw);
    // the browser sometimes copies the editor's own text color into a span: that is not a chosen color
    if (hex && hex !== baseColor) s.c = hex;
    else delete s.c;
  }
  return s;
}

function scan(root: HTMLElement): { segs: Segment[]; items: Item[]; length: number } {
  const segs: Segment[] = [];
  const items: Item[] = [];
  let pos = 0;
  let lastChar = "";
  const baseColor = toHex(getComputedStyle(root).color);
  const push = (node: Node, t: string, style: Style, text: boolean) => {
    segs.push({ t, ...style });
    items.push({ node, start: pos, len: t.length, text });
    pos += t.length;
    lastChar = t[t.length - 1] ?? lastChar;
  };
  const visit = (node: Node, style: Style) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.nodeValue ?? "").replace(/ /g, " ").replace(/\r/g, "");
      if (t) push(node, t, style, true);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") return push(node, "\n", style, false);
    // a block the browser created (e.g. after an undo of its own): it starts a new line
    if (/^(DIV|P|LI|H[1-6]|BLOCKQUOTE)$/.test(node.tagName) && pos > 0 && lastChar !== "\n") push(node, "\n", style, false);
    const next = styleOf(node, style, baseColor);
    node.childNodes.forEach((c) => visit(c, next));
  };
  root.childNodes.forEach((c) => visit(c, {}));
  // a trailing <br> is the browser's placeholder for the last line, not a character
  const last = items[items.length - 1];
  if (last && !last.text && last.node.nodeName === "BR") {
    items.pop();
    segs.pop();
    pos -= 1;
  }
  return { segs: mergeSegments(segs), items, length: pos };
}

function buildDom(segs: Segment[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const s of segs) {
    const text = document.createTextNode(s.t);
    const style = segmentStyle(s);
    if (style) {
      const span = document.createElement("span");
      if (s.b) span.style.fontWeight = "700";
      if (s.u) {
        span.style.textDecorationLine = "underline";
        span.style.textUnderlineOffset = "0.2em";
      }
      if (s.c) span.style.color = s.c;
      span.appendChild(text);
      frag.appendChild(span);
    } else frag.appendChild(text);
  }
  // without it a last empty line (text ending in a line break) would not show
  if (plainText(segs).endsWith("\n")) frag.appendChild(document.createElement("br"));
  return frag;
}

function pointToOffset(items: Item[], total: number, container: Node, offset: number): number {
  if (container.nodeType === Node.TEXT_NODE) {
    const it = items.find((i) => i.node === container);
    if (it) return it.start + Math.min(offset, it.len);
  }
  const child = container.nodeType === Node.TEXT_NODE ? container : container.childNodes[offset];
  if (child) {
    for (const it of items) if (it.node === child || child.contains(it.node) || child.compareDocumentPosition(it.node) & Node.DOCUMENT_POSITION_FOLLOWING) return it.start;
    return total;
  }
  for (const it of items) if (!container.contains(it.node) && container.compareDocumentPosition(it.node) & Node.DOCUMENT_POSITION_FOLLOWING) return it.start;
  return total;
}

function offsetToPoint(root: HTMLElement, items: Item[], off: number): [Node, number] {
  for (const it of items) if (it.text && off >= it.start && off <= it.start + it.len) return [it.node, off - it.start];
  return [root, root.childNodes.length > 0 && off > 0 ? root.childNodes.length : 0];
}

function readSelection(root: HTMLElement): [number, number] | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
  const { items, length } = scan(root);
  const a = pointToOffset(items, length, r.startContainer, r.startOffset);
  const b = pointToOffset(items, length, r.endContainer, r.endOffset);
  return [Math.min(a, b), Math.max(a, b)];
}

function writeSelection(root: HTMLElement, [a, b]: [number, number]) {
  const sel = window.getSelection();
  if (!sel) return;
  const { items } = scan(root);
  const range = document.createRange();
  const [sn, so] = offsetToPoint(root, items, a);
  const [en, eo] = offsetToPoint(root, items, b);
  range.setStart(sn, so);
  range.setEnd(en, eo);
  sel.removeAllRanges();
  sel.addRange(range);
}

function canonicalHtml(segs: Segment[]): string {
  const probe = document.createElement("div");
  probe.appendChild(buildDom(segs));
  return probe.innerHTML;
}

// ---------------------------------------------------------------------------------------------------------------
// The editor

interface Snapshot {
  segs: Segment[];
  sel: [number, number];
}

export function RichTextEditor({
  id,
  value,
  onChange,
  rows = 3,
  maxLength,
  placeholder,
  disabled,
  className,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  id?: string;
  value: Segment[];
  onChange: (segs: Segment[]) => void;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const model = useRef<Segment[]>(value);
  const emitted = useRef<Segment[] | null>(null);
  const built = useRef(false);
  const history = useRef<Snapshot[]>([]);
  const at = useRef(0);
  const lastTyping = useRef(0);
  const lastSel = useRef<[number, number] | null>(null);
  const composing = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [active, setActive] = useState<{ b: boolean; u: boolean; range: boolean }>({ b: false, u: false, range: false });

  const render = useCallback((segs: Segment[], sel?: [number, number] | null) => {
    const root = ref.current;
    if (!root) return;
    root.replaceChildren(buildDom(segs));
    if (sel && document.activeElement === root) writeSelection(root, sel);
  }, []);

  // a value that did not come from this editor (first render, a reset by the parent) replaces the content
  useLayoutEffect(() => {
    // the parent may hand back an equal copy of what this editor emitted: rebuilding the DOM would lose the caret
    // (the first run always builds the content)
    if (built.current && (value === emitted.current || sameSegments(value, model.current))) return;
    built.current = true;
    model.current = value;
    render(value);
    history.current = [{ segs: value, sel: [plainText(value).length, plainText(value).length] }];
    at.current = 0;
  }, [value, render]);

  const commit = useCallback((segs: Segment[], sel: [number, number], typing = false) => {
    model.current = segs;
    emitted.current = segs;
    const now = Date.now();
    const h = history.current.slice(0, at.current + 1);
    if (typing && now - lastTyping.current < 1200 && h.length > 1) h[h.length - 1] = { segs, sel };
    else h.push({ segs, sel });
    lastTyping.current = typing ? now : 0;
    history.current = h.slice(-200);
    at.current = history.current.length - 1;
    onChangeRef.current(segs);
  }, []);

  const refreshActive = useCallback(() => {
    const root = ref.current;
    if (!root) return;
    const sel = readSelection(root);
    if (!sel) return;
    lastSel.current = sel;
    let [a, b] = sel;
    if (a === b) [a, b] = wordAt(plainText(model.current), a);
    setActive({ b: rangeHas(model.current, a, b, "b"), u: rangeHas(model.current, a, b, "u"), range: sel[0] !== sel[1] });
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", refreshActive);
    return () => document.removeEventListener("selectionchange", refreshActive);
  }, [refreshActive]);

  const currentSelection = (): [number, number] => {
    const root = ref.current!;
    return readSelection(root) ?? lastSel.current ?? [plainText(model.current).length, plainText(model.current).length];
  };

  const insertText = useCallback(
    (raw: string) => {
      const root = ref.current;
      if (!root || disabled) return;
      const segs = scan(root).segs;
      const [a, b] = readSelection(root) ?? [plainText(segs).length, plainText(segs).length];
      let text = raw;
      if (maxLength !== undefined) text = text.slice(0, Math.max(0, maxLength - (plainText(segs).length - (b - a))));
      if (!text && a === b) return;
      const next = replaceRange(segs, a, b, text);
      const caret: [number, number] = [a + text.length, a + text.length];
      render(next, caret);
      commit(next, caret);
    },
    [commit, disabled, maxLength, render],
  );

  const format = useCallback(
    (patch: StylePatch | "b" | "u") => {
      const root = ref.current;
      if (!root || disabled) return;
      const sel = currentSelection();
      let [a, b] = sel;
      if (a === b) [a, b] = wordAt(plainText(model.current), a);
      if (a === b) return;
      const p: StylePatch = patch === "b" || patch === "u" ? { [patch]: !rangeHas(model.current, a, b, patch) } : patch;
      const next = applyStyle(model.current, a, b, p);
      root.focus();
      render(next, sel);
      commit(next, sel);
      refreshActive();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commit, disabled, render, refreshActive],
  );

  const travel = useCallback(
    (dir: -1 | 1) => {
      const i = at.current + dir;
      const snap = history.current[i];
      if (!snap) return;
      at.current = i;
      lastTyping.current = 0;
      model.current = snap.segs;
      emitted.current = snap.segs;
      render(snap.segs, snap.sel);
      onChangeRef.current(snap.segs);
    },
    [render],
  );

  // beforeinput carries the kind of edit (React does not expose it): line breaks, undo and the browser's own
  // formatting commands are handled here, on the model, instead of letting the browser restructure the DOM
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onBeforeInput = (e: InputEvent) => {
      const kind = e.inputType;
      if (kind === "insertParagraph" || kind === "insertLineBreak") {
        e.preventDefault();
        insertText("\n");
      } else if (kind === "historyUndo" || kind === "historyRedo") {
        e.preventDefault();
        travel(kind === "historyUndo" ? -1 : 1);
      } else if (kind === "formatBold" || kind === "formatUnderline") {
        e.preventDefault();
        format(kind === "formatBold" ? "b" : "u");
      } else if (kind.startsWith("format") || kind === "insertFromDrop" || kind === "deleteByDrag") {
        e.preventDefault();
      } else if (kind === "insertText" && maxLength !== undefined && e.data) {
        const sel = readSelection(root);
        const len = plainText(model.current).length;
        if (sel && len - (sel[1] - sel[0]) + e.data.length > maxLength) e.preventDefault();
      }
    };
    root.addEventListener("beforeinput", onBeforeInput);
    return () => root.removeEventListener("beforeinput", onBeforeInput);
  }, [format, insertText, maxLength, travel]);

  function onInput() {
    const root = ref.current;
    if (!root || composing.current) return;
    const { segs } = scan(root);
    const sel = readSelection(root) ?? [plainText(segs).length, plainText(segs).length];
    // the browser may have left its own markup (spans with computed styles, <br>, <div>): back to the canonical shape
    if (root.innerHTML !== canonicalHtml(segs)) render(segs, sel);
    commit(segs, sel, true);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    // physical keys as well, so the shortcuts also work on a Hebrew keyboard layout
    const code = e.code;
    if (k === "b" || code === "KeyB") {
      e.preventDefault();
      format("b");
    } else if (k === "u" || code === "KeyU") {
      e.preventDefault();
      format("u");
    } else if (k === "i" || code === "KeyI") {
      e.preventDefault();
    } else if ((k === "z" || code === "KeyZ") && !e.shiftKey) {
      e.preventDefault();
      travel(-1);
    } else if (k === "y" || code === "KeyY" || ((k === "z" || code === "KeyZ") && e.shiftKey)) {
      e.preventDefault();
      travel(1);
    }
  }

  const keep = (e: React.MouseEvent) => e.preventDefault(); // toolbar clicks keep the selection in the text
  const tool = "inline-flex size-7 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-stone hover:text-ink disabled:opacity-40 [&_svg]:size-3.5";
  const empty = plainText(value).length === 0;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-rule-strong bg-paper shadow-card transition-[border-color,box-shadow] focus-within:border-ink/60 focus-within:ring-[3px] focus-within:ring-ink/8",
        ariaInvalid && "border-danger",
        disabled && "bg-stone-2",
        className,
      )}
    >
      <div role="toolbar" aria-label="עיצוב טקסט" className="flex flex-wrap items-center gap-0.5 border-b border-rule bg-stone-2 px-1.5 py-1">
        <button type="button" className={cn(tool, active.b && "bg-stone text-ink")} aria-pressed={active.b} title="הדגשה (Ctrl+B)" aria-label="הדגשה" disabled={disabled} onMouseDown={keep} onClick={() => format("b")}>
          <Bold strokeWidth={2.75} />
        </button>
        <button type="button" className={cn(tool, active.u && "bg-stone text-ink")} aria-pressed={active.u} title="קו תחתון (Ctrl+U)" aria-label="קו תחתון" disabled={disabled} onMouseDown={keep} onClick={() => format("u")}>
          <Underline />
        </button>
        <span className="mx-1 h-4 w-px bg-rule-strong" aria-hidden />
        {TEXT_COLORS.map((c) => (
          <button key={c.value} type="button" className={tool} title={`צבע: ${c.label}`} aria-label={`צבע ${c.label}`} disabled={disabled} onMouseDown={keep} onClick={() => format({ c: c.value })}>
            <span className="size-3.5 rounded-full ring-1 ring-black/10" style={{ background: c.value }} />
          </button>
        ))}
        <button type="button" className={tool} title="ללא צבע" aria-label="ללא צבע" disabled={disabled} onMouseDown={keep} onClick={() => format({ c: null })}>
          <span className="relative size-3.5 overflow-hidden rounded-full bg-paper ring-1 ring-rule-strong">
            <span className="absolute inset-x-[-2px] top-1/2 h-px -rotate-45 bg-danger" />
          </span>
        </button>
        <span className="mx-1 h-4 w-px bg-rule-strong" aria-hidden />
        <button type="button" className={tool} title="ניקוי העיצוב מהטקסט המסומן" aria-label="ניקוי עיצוב" disabled={disabled} onMouseDown={keep} onClick={() => format({ b: false, u: false, c: null })}>
          <RemoveFormatting />
        </button>
        <span className="ms-auto hidden px-1.5 text-[11.5px] text-faint sm:inline">{active.range ? "העיצוב יחול על הטקסט המסומן" : "סמנו מילים או אותיות כדי לעצב"}</span>
      </div>
      <div
        ref={ref}
        id={id}
        role="textbox"
        aria-multiline
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        aria-disabled={disabled || undefined}
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck
        data-placeholder={placeholder}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onFocus={refreshActive}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => {
          composing.current = false;
          onInput();
        }}
        onPaste={(e) => {
          e.preventDefault();
          insertText(e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
        }}
        onDrop={(e) => e.preventDefault()}
        className={cn(
          "max-h-[60vh] resize-y overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-[13.5px] leading-relaxed text-ink outline-none",
          empty && "before:pointer-events-none before:text-faint before:content-[attr(data-placeholder)]",
        )}
        style={{ minHeight: `calc(${rows} * 1.625em + 1rem)` }}
      />
    </div>
  );
}
