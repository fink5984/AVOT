import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Ways to put ZPL on a printer.
 *   NETWORK  raw TCP (port 9100) — the printer's own LAN address; the cloud never needs to reach it.
 *   WINDOWS  the Windows spooler in RAW mode (a USB printer attached to this PC), no driver rendering.
 * Both return once the bytes were handed over; whether the label really came out is a separate question
 * (see queryHostStatus), and the caller must not claim "printed" without evidence.
 */

const STX = "\x02";
const ETX = "\x03";

export function sendTcp({ host, port = 9100, data, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };
    socket.setTimeout(timeoutMs, () => done(new Error(`המדפסת ${host}:${port} לא מגיבה (פסק זמן)`)));
    socket.on("error", (e) => done(new Error(e.code === "ECONNREFUSED" ? `המדפסת ${host}:${port} דחתה את החיבור` : e.code === "EHOSTUNREACH" || e.code === "ENETUNREACH" ? `אין מסלול למדפסת ${host} (כבויה או מנותקת?)` : `שגיאת חיבור למדפסת: ${e.message}`)));
    socket.on("connect", () => {
      socket.end(Buffer.from(data, "utf8"), () => setTimeout(() => done(), 150));
    });
  });
}

/**
 * Zebra-style "~HS" host status. Returns null when the printer does not answer (many clones / non-Zebra
 * models) — the job then stays "sent to printer" and is never reported as completed.
 */
export function queryHostStatus({ host, port = 9100, timeoutMs = 2500 }) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let buf = "";
    const finish = (v) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs, () => finish(parseHostStatus(buf)));
    socket.on("error", () => finish(null));
    socket.on("connect", () => socket.write("~HS"));
    socket.on("data", (d) => {
      buf += d.toString("latin1");
      if ((buf.match(new RegExp(ETX, "g")) ?? []).length >= 3) finish(parseHostStatus(buf));
    });
  });
}

/** ~HS reply: three STX…ETX strings; see the ZPL programming guide. Only the documented flags are read. */
export function parseHostStatus(raw) {
  const strings = [...raw.matchAll(new RegExp(`${STX}([^${ETX}]*)${ETX}`, "g"))].map((m) => m[1].trim().split(","));
  if (strings.length < 2 || strings[0].length < 5 || strings[1].length < 2) return null;
  const [s1, s2] = strings;
  const paperOut = s1[1] === "1";
  const paused = s1[2] === "1";
  const formatsInBuffer = Number(s1[4]);
  const headUp = s2[1] === "1";
  const ribbonOut = s2[2] === "1";
  const labelWaiting = s2[6] === "1";
  const labelsRemaining = Number(s2[7] ?? 0);
  return { paperOut, paused, formatsInBuffer: Number.isFinite(formatsInBuffer) ? formatsInBuffer : null, headUp, ribbonOut, labelWaiting, labelsRemaining: Number.isFinite(labelsRemaining) ? labelsRemaining : 0 };
}

export function stateOf(status) {
  if (!status) return null;
  if (status.paperOut) return { state: "PAPER_OUT", detail: "נגמרו המדבקות" };
  if (status.headUp) return { state: "HEAD_OPEN", detail: "מכסה המדפסת פתוח" };
  if (status.paused) return { state: "PAUSED", detail: "המדפסת מושהית" };
  return { state: "OK", detail: null };
}

const WINDOWS_RAW_SCRIPT = `
param([string]$PrinterName, [string]$File)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);
  public static void Send(string name, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(name, out h, IntPtr.Zero)) throw new Exception("OpenPrinter failed (" + Marshal.GetLastWin32Error() + ")");
    try {
      var di = new DOCINFO { pDocName = "AVOT label", pDataType = "RAW" };
      if (!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");
      StartPagePrinter(h);
      int written;
      if (!WritePrinter(h, bytes, bytes.Length, out written) || written != bytes.Length) throw new Exception("WritePrinter failed (" + Marshal.GetLastWin32Error() + ")");
      EndPagePrinter(h);
      EndDocPrinter(h);
    } finally { ClosePrinter(h); }
  }
}
"@
[RawPrinter]::Send($PrinterName, [System.IO.File]::ReadAllBytes($File))
`;

export async function sendWindowsRaw({ printerName, data }) {
  if (process.platform !== "win32") throw new Error("חיבור Windows זמין רק במחשב Windows");
  const dir = await mkdtemp(path.join(tmpdir(), "avot-print-"));
  try {
    const file = path.join(dir, "label.zpl");
    const script = path.join(dir, "raw.ps1");
    await writeFile(file, Buffer.from(data, "utf8"));
    await writeFile(script, WINDOWS_RAW_SCRIPT, "utf8");
    await new Promise((resolve, reject) => {
      const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-PrinterName", printerName, "-File", file], { windowsHide: true });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split("\n")[0] || `הדפסה דרך Windows נכשלה (קוד ${code})`))));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
