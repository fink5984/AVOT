import { he } from "./he";

/** Active dictionary. Hebrew only for now; swap by locale when English is added. */
export const t = he;

const dateFmt = new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const numFmt = new Intl.NumberFormat("he-IL");

export const fmt = {
  date: (d: Date | string | null | undefined) => (d ? dateFmt.format(new Date(d)) : "—"),
  dateTime: (d: Date | string | null | undefined) => (d ? dateTimeFmt.format(new Date(d)) : "—"),
  time: (d: Date | string | null | undefined) => (d ? timeFmt.format(new Date(d)) : "—"),
  num: (n: number) => numFmt.format(n),
  bytes: (n: number | bigint | null | undefined) => {
    if (n === null || n === undefined) return "—";
    let v = Number(n);
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  },
  relative: (d: Date | string | null | undefined) => {
    if (!d) return "—";
    const diff = (Date.now() - new Date(d).getTime()) / 1000;
    if (diff < 60) return "לפני רגע";
    if (diff < 3600) return `לפני ${Math.floor(diff / 60)} דק׳`;
    if (diff < 86400) return `לפני ${Math.floor(diff / 3600)} שע׳`;
    if (diff < 86400 * 7) return `לפני ${Math.floor(diff / 86400)} ימים`;
    return dateFmt.format(new Date(d));
  },
};
