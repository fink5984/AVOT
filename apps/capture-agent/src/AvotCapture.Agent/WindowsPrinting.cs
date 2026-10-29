using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Printing;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using AvotCapture.Core;

namespace AvotCapture.Agent;

public sealed class PrintException(string message) : Exception(message);

/// <summary>The Windows side of label printing: the list of printers, their state, raw bytes through the spooler, and GDI drawing.</summary>
public static class WindowsPrinting
{
    public static IReadOnlyList<string> InstalledPrinters() => PrinterSettings.InstalledPrinters.Cast<string>().OrderBy(n => n, StringComparer.CurrentCultureIgnoreCase).ToList();

    public static string? DefaultOfWindows() => new PrinterSettings().PrinterName;

    // ── state (winspool GetPrinter level 6 = PRINTER_INFO_6: dwStatus) ──
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError = true)] private static extern bool ClosePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)] private static extern bool GetPrinter(IntPtr handle, int level, IntPtr buffer, int size, out int needed);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private sealed class DocInfo
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName = "AVOT label";
        [MarshalAs(UnmanagedType.LPWStr)] public string? pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType = "RAW";
    }

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool StartDocPrinter(IntPtr handle, int level, [In] DocInfo di);
    [DllImport("winspool.drv", SetLastError = true)] private static extern bool EndDocPrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)] private static extern bool StartPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)] private static extern bool EndPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)] private static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);

    /// <summary>(state, detail): OK | OFFLINE | PAPER_OUT | PAUSED | ERROR — from the spooler's view of the printer.</summary>
    public static (string State, string? Detail) StateOf(string printerName)
    {
        if (!OpenPrinter(printerName, out var h, IntPtr.Zero)) return ("OFFLINE", "המדפסת לא נמצאה ב-Windows");
        try
        {
            GetPrinter(h, 6, IntPtr.Zero, 0, out var needed);
            if (needed <= 0) return ("OK", null);
            var buf = Marshal.AllocHGlobal(needed);
            try
            {
                if (!GetPrinter(h, 6, buf, needed, out _)) return ("OK", null);
                var status = (uint)Marshal.ReadInt32(buf);
                if ((status & 0x80) != 0) return ("OFFLINE", "המדפסת כבויה או מנותקת");
                if ((status & 0x10) != 0) return ("PAPER_OUT", "נגמרו המדבקות");
                if ((status & 0x1) != 0) return ("PAUSED", "המדפסת מושהית");
                if ((status & (0x2 | 0x8 | 0x40 | 0x100000)) != 0) return ("ERROR", "המדפסת מדווחת על תקלה");
                return ("OK", null);
            }
            finally
            {
                Marshal.FreeHGlobal(buf);
            }
        }
        finally
        {
            ClosePrinter(h);
        }
    }

    /// <summary>Raw bytes (ZPL, …) through the Windows spooler, bypassing the driver's rendering.</summary>
    public static void SendRaw(string printerName, byte[] data)
    {
        if (!OpenPrinter(printerName, out var h, IntPtr.Zero)) throw new PrintException($"המדפסת \"{printerName}\" לא נמצאה ב-Windows (כבויה או מנותקת?)");
        try
        {
            if (!StartDocPrinter(h, 1, new DocInfo())) throw new PrintException("Windows לא קיבל את משימת ההדפסה (StartDoc)");
            try
            {
                if (!StartPagePrinter(h)) throw new PrintException("Windows לא קיבל את משימת ההדפסה (StartPage)");
                if (!WritePrinter(h, data, data.Length, out var written) || written != data.Length) throw new PrintException("הכתיבה למדפסת נכשלה");
                EndPagePrinter(h);
            }
            finally
            {
                EndDocPrinter(h);
            }
        }
        finally
        {
            ClosePrinter(h);
        }
    }

    /// <summary>Raw bytes to a network printer on the station's LAN (TCP 9100).</summary>
    public static void SendTcp(string host, int port, byte[] data)
    {
        try
        {
            using var c = new TcpClient();
            if (!c.ConnectAsync(host, port).Wait(TimeSpan.FromSeconds(6))) throw new PrintException($"המדפסת {host}:{port} לא מגיבה");
            using var s = c.GetStream();
            s.Write(data, 0, data.Length);
            s.Flush();
        }
        catch (Exception ex) when (ex is SocketException or AggregateException or IOException)
        {
            throw new PrintException($"אין חיבור למדפסת {host}:{port} (כבויה או מנותקת?)");
        }
    }

    /// <summary>
    /// Windows-driver mode: the label is drawn here and printed through the printer's own driver — works with any printer
    /// that has one (Hebrew included, Code 128 drawn as bars). One page per label, paper = the label stock.
    /// </summary>
    public static void PrintLabels(string printerName, PrintStock stock, int copies, IReadOnlyList<LabelLayoutDto> labels, PrintAssets? assets = null)
    {
        var pages = labels.SelectMany(l => Enumerable.Repeat(l, Math.Clamp(copies, 1, 50))).ToList();
        var index = 0;
        using var doc = new PrintDocument { PrintController = new StandardPrintController() }; // no progress dialogs on a station
        doc.PrinterSettings.PrinterName = printerName;
        if (!doc.PrinterSettings.IsValid) throw new PrintException($"המדפסת \"{printerName}\" לא זמינה ב-Windows");
        doc.DefaultPageSettings.PaperSize = new PaperSize("AVOT", (int)Math.Round(stock.WidthMm / 25.4 * 100), (int)Math.Round(stock.HeightMm / 25.4 * 100));
        doc.DefaultPageSettings.Margins = new Margins(0, 0, 0, 0);
        doc.OriginAtMargins = false;
        Exception? failure = null;
        doc.PrintPage += (_, e) =>
        {
            try
            {
                var g = e.Graphics!;
                // device pixels, origin at the physical top-left of the label (the printable area starts a hard margin in)
                g.PageUnit = GraphicsUnit.Pixel;
                g.ResetTransform();
                g.TranslateTransform((float)(-e.PageSettings.HardMarginX / 100.0 * g.DpiX), (float)(-e.PageSettings.HardMarginY / 100.0 * g.DpiY));
                LabelDrawer.Draw(g, pages[index], assets);
                index++;
                e.HasMorePages = index < pages.Count;
            }
            catch (Exception ex)
            {
                failure = ex;
                e.HasMorePages = false;
            }
        };
        try
        {
            if (pages.Count > 0) doc.Print();
        }
        catch (InvalidPrinterException)
        {
            throw new PrintException($"המדפסת \"{printerName}\" לא זמינה ב-Windows");
        }
        if (failure is not null) throw new PrintException("ציור התווית נכשל: " + failure.Message);
    }
}

/// <summary>
/// Draws a label layout received from the server. There is no design here: every box (text, barcode) has its position, size,
/// alignment and line limit in the layout; this class only fits the text into its box with the Windows fonts and draws the
/// Code 128 in whole device dots with the same module rule as the server's ZPL and preview.
/// </summary>
public static class LabelDrawer
{
    private static readonly StringFormat RtlFormat = new(StringFormatFlags.DirectionRightToLeft | StringFormatFlags.NoClip) { Trimming = StringTrimming.EllipsisWord };

    public static void Draw(Graphics g, LabelLayoutDto layout, PrintAssets? assets = null)
    {
        g.Clear(Color.White);
        g.SmoothingMode = SmoothingMode.None; // crisp bars
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        var pxMm = g.DpiX / 25.4f;
        foreach (var item in layout.Items)
        {
            var box = new RectangleF((float)item.X * pxMm, (float)item.Y * pxMm, (float)item.W * pxMm, (float)item.H * pxMm);
            if (item.Kind == "barcode") DrawBarcode(g, item, box, pxMm);
            else if (item.Kind == "image") DrawImage(g, box, assets);
            else DrawText(g, item, box, pxMm);
        }
    }

    /// <summary>The AVOT logo (PNG from the server) scaled into its box, black on white, with the best resampling the driver DPI allows.</summary>
    private static void DrawImage(Graphics g, RectangleF box, PrintAssets? assets)
    {
        if (string.IsNullOrEmpty(assets?.Logo)) return;
        using var ms = new MemoryStream(Convert.FromBase64String(assets.Logo));
        using var img = Image.FromStream(ms);
        var old = g.InterpolationMode;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
        // contain: keep the artwork's proportions inside the box
        var scale = Math.Min(box.Width / img.Width, box.Height / img.Height);
        var w = img.Width * scale;
        var h = img.Height * scale;
        g.DrawImage(img, box.Left + (box.Width - w) / 2f, box.Top + (box.Height - h) / 2f, w, h);
        g.InterpolationMode = old;
    }

    private static void DrawText(Graphics g, LayoutItemDto item, RectangleF box, float pxMm)
    {
        var text = item.Text ?? "";
        if (string.IsNullOrWhiteSpace(text)) return;
        var hebrew = text.Any(c => c is >= '֐' and <= '׿');
        var fmt = hebrew ? (StringFormat)RtlFormat.Clone() : new StringFormat(StringFormatFlags.NoClip) { Trimming = StringTrimming.EllipsisWord };
        // RightToLeft flips Near/Far, so the alignment is expressed for the text direction
        fmt.Alignment = item.Align switch
        {
            "center" => StringAlignment.Center,
            "right" => hebrew ? StringAlignment.Near : StringAlignment.Far,
            _ => hebrew ? StringAlignment.Far : StringAlignment.Near,
        };
        var size = (float)item.SizeMm * pxMm;
        // like the server's text fitting: below the nominal minimum the font may still shrink to 80 % before any word is cut
        var min = Math.Max(8f, (float)item.MinSizeMm * pxMm * 0.8f);
        while (true)
        {
            using var font = LabelFonts.Create(item.Font, item.Bold, size);
            var one = g.MeasureString(text, font, 100_000, fmt).Height; // one line of this text at this size
            var m = g.MeasureString(text, font, (int)box.Width, fmt);
            var lines = Math.Max(1, (int)Math.Round(m.Height / Math.Max(1f, one)));
            if ((m.Height <= box.Height + 0.5f && lines <= Math.Max(1, item.MaxLines)) || size <= min)
            {
                var drawH = m.Height;
                if (lines > Math.Max(1, item.MaxLines))
                {
                    // still too long at the smallest size: keep the line limit and cut with an ellipsis (never more lines than the layout allows)
                    drawH = one * Math.Max(1, item.MaxLines);
                    fmt.FormatFlags |= StringFormatFlags.LineLimit;
                    fmt.Trimming = StringTrimming.EllipsisWord;
                }
                var free = Math.Max(0, box.Height - drawH);
                var top = item.VAlign switch { "middle" => box.Top + free / 2, "bottom" => box.Top + free, _ => box.Top };
                g.DrawString(text, font, Brushes.Black, new RectangleF(box.Left, top, box.Width, Math.Min(box.Height, drawH + 1)), fmt);
                return;
            }
            size = Math.Max(min, size * 0.9f);
        }
    }

    /// <summary>Whole dots per module, as wide as allowed; the symbol plus its quiet zones must fit (same rule as barcodeModuleDots in the shared package).</summary>
    public static (int Dots, int WidthPx, bool Fits) ModuleDots(int modules, float availPx, float pxPerMm, double minMm, double maxMm, int quiet)
    {
        var lo = Math.Max(1, (int)Math.Ceiling(minMm * pxPerMm - 1e-9));
        var hi = Math.Max(lo, (int)Math.Floor(maxMm * pxPerMm + 1e-9));
        var fitting = (int)Math.Floor(availPx / (modules + 2 * quiet));
        if (fitting >= lo)
        {
            var d = Math.Min(hi, fitting);
            return (d, d * modules, true);
        }
        var dots = Math.Max(1, (int)Math.Floor(availPx / modules));
        return (dots, dots * modules, false);
    }

    private static void DrawBarcode(Graphics g, LayoutItemDto item, RectangleF box, float pxMm)
    {
        var modules = Code128.Modules(item.Code ?? "");
        var (dots, width, _) = ModuleDots(modules.Sum(), box.Width, pxMm, item.ModuleMmMin, item.ModuleMmMax, item.QuietModules);
        var x = box.Left + (float)Math.Round((box.Width - width) / 2f);
        var isBar = true;
        foreach (var m in modules)
        {
            if (isBar) g.FillRectangle(Brushes.Black, (float)Math.Round(x), (float)Math.Round(box.Top), m * dots, (float)Math.Round(box.Height));
            x += m * dots;
            isBar = !isBar;
        }
    }
}

/// <summary>
/// The bundled label typefaces, loaded privately from the Fonts folder next to the program (never from what is installed on
/// the PC). One file per typeface and weight, each a one-word family: "AvotClassicBold". Falls back to Arial only if a file is missing.
/// </summary>
public static class LabelFonts
{
    private static readonly Lazy<System.Drawing.Text.PrivateFontCollection> Collection = new(() =>
    {
        var pfc = new System.Drawing.Text.PrivateFontCollection();
        var dir = Path.Combine(AppContext.BaseDirectory, "Fonts");
        if (Directory.Exists(dir))
            foreach (var f in Directory.GetFiles(dir, "Avot*.ttf")) pfc.AddFontFile(f);
        return pfc;
    });

    public static string FamilyName(string? style, bool bold)
    {
        var s = style switch { "traditional" => "AvotTraditional", "modern" => "AvotModern", _ => "AvotClassic" };
        return s + (bold ? "Bold" : "Regular");
    }

    public static bool Available(string? style, bool bold) => Collection.Value.Families.Any(f => f.Name == FamilyName(style, bold));

    public static Font Create(string? style, bool bold, float sizePx)
    {
        var name = FamilyName(style, bold);
        var family = Collection.Value.Families.FirstOrDefault(f => f.Name == name);
        // the weight is in the outlines of the file; no synthetic bold
        return family is null
            ? new Font("Arial", sizePx, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel)
            : new Font(family, sizePx, FontStyle.Regular, GraphicsUnit.Pixel);
    }
}
