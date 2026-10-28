import { describe, expect, it } from "vitest";
import { placeMenu } from "@/components/ui/menu";

const vp = { width: 1200, height: 800 };
const box = (top: number, left: number, w = 28, h = 28) => ({ top, bottom: top + h, left, right: left + w });

describe("menu placement (portal, never clipped)", () => {
  it("opens below the button when there is room", () => {
    const p = placeMenu(box(100, 600), { width: 208, height: 180 }, vp, "end", true);
    expect(p.side).toBe("below");
    expect(p.top).toBeGreaterThan(128);
  });

  it("opens above when there is no room below", () => {
    const p = placeMenu(box(740, 600), { width: 208, height: 260 }, vp, "end", true);
    expect(p.side).toBe("above");
    expect(p.top + 260).toBeLessThanOrEqual(740);
  });

  it("a very long menu gets a maximum height and scrolls inside", () => {
    const p = placeMenu(box(300, 600), { width: 208, height: 1400 }, vp, "end", true);
    expect(p.maxHeight).toBeLessThanOrEqual(800);
    expect(p.maxHeight).toBeGreaterThanOrEqual(120);
  });

  it("is shifted back inside the viewport near either edge", () => {
    const left = placeMenu(box(100, 2), { width: 208, height: 180 }, vp, "end", true);
    expect(left.left).toBeGreaterThanOrEqual(8);
    const right = placeMenu(box(100, 1190, 8), { width: 208, height: 180 }, vp, "end", false);
    expect(right.left + 208).toBeLessThanOrEqual(1200 - 8);
  });

  it("RTL: the end edge is the left edge of the button; LTR: the right edge", () => {
    const rtl = placeMenu(box(100, 600), { width: 208, height: 180 }, vp, "end", true);
    expect(rtl.left).toBe(600);
    const ltr = placeMenu(box(100, 600), { width: 208, height: 180 }, vp, "end", false);
    expect(ltr.left).toBe(628 - 208);
  });

  it("a menu in a short column card (small trigger area) still fits whole", () => {
    const p = placeMenu(box(180, 400), { width: 208, height: 120 }, { width: 1200, height: 700 }, "end", true);
    expect(p.top + 120).toBeLessThanOrEqual(700);
  });
});
