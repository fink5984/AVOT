import { extendTailwindMerge } from "tailwind-merge";

// later classes win on conflicts (e.g. a caller's w-56 overrides a component's w-full)
const merge = extendTailwindMerge({
  extend: { theme: { text: ["2xs"], radius: ["xs"] } },
});

export function cn(...parts: (string | false | null | undefined)[]): string {
  return merge(parts.filter(Boolean).join(" "));
}
