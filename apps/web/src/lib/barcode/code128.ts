/**
 * Code 128 (subset B, with subset C for even digit runs) → bar widths.
 * Isomorphic: used to render SVG labels in the browser and in tests. Thermal
 * printers get ZPL instead and render the symbol themselves (^BC).
 */

// module patterns for symbol values 0..106 (bar, space, bar, … widths); 106 = STOP (7 elements)
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;
const STOP = 106;

/** Symbol values for `text` (printable ASCII 32–126). Digit runs of ≥4 use subset C. */
export function encodeCode128(text: string): number[] {
  if (!text || /[^\x20-\x7e]/.test(text)) throw new Error("Code 128: printable ASCII only");
  const values: number[] = [];
  let set: "B" | "C" | null = null;
  let i = 0;
  const digitRun = (from: number) => {
    let n = 0;
    while (from + n < text.length && /\d/.test(text[from + n]!)) n++;
    return n;
  };
  while (i < text.length) {
    const run = digitRun(i);
    if (run >= 4) {
      // pairs of digits in subset C; an odd trailing digit goes back to B
      const even = run - (run % 2);
      if (set !== "C") {
        values.push(set === null ? START_C : CODE_C);
        set = "C";
      }
      for (let k = 0; k < even; k += 2) values.push(Number(text.slice(i + k, i + k + 2)));
      i += even;
      continue;
    }
    if (set !== "B") {
      values.push(set === null ? START_B : CODE_B);
      set = "B";
    }
    values.push(text.charCodeAt(i) - 32);
    i++;
  }
  let sum = values[0]!;
  for (let k = 1; k < values.length; k++) sum += values[k]! * k;
  values.push(sum % 103, STOP);
  return values;
}

/** Alternating bar/space module widths, starting with a bar. */
export function code128Modules(text: string): number[] {
  return encodeCode128(text).flatMap((v) => PATTERNS[v]!.split("").map(Number));
}

/** Total width in modules, including the 10-module quiet zones on both sides. */
export function code128Width(text: string): number {
  return code128Modules(text).reduce((a, b) => a + b, 0) + 20;
}

/** SVG markup (viewBox in modules; scale with CSS width/height). */
export function code128Svg(text: string, opts: { height?: number } = {}): string {
  const mods = code128Modules(text);
  const h = opts.height ?? 40;
  let x = 10;
  const rects: string[] = [];
  mods.forEach((w, idx) => {
    if (idx % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${w}" height="${h}"/>`);
    x += w;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x + 10} ${h}" preserveAspectRatio="none" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}
