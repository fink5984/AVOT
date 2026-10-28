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
    public static void PrintLabels(string printerName, PrintStock stock, int copies, IReadOnlyList<PrintLabelDto> labels)
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
                LabelDrawer.Draw(g, stock, pages[index]);
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

/// <summary>Draws one label (book / shelf / column / test) the way the thermal layout does: Hebrew title, Code 128, readable number.</summary>
public static class LabelDrawer
{
    private static readonly StringFormat Rtl = new(StringFormatFlags.DirectionRightToLeft | StringFormatFlags.NoClip) { Alignment = StringAlignment.Near, Trimming = StringTrimming.EllipsisWord };
    private static readonly StringFormat Center = new() { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter };

    public static void Draw(Graphics g, PrintStock stock, PrintLabelDto l)
    {
        g.Clear(Color.White);
        g.SmoothingMode = SmoothingMode.None; // crisp bars
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        var pxMm = g.DpiX / 25.4f;
        var w = (float)stock.WidthMm * pxMm;
        var h = (float)stock.HeightMm * pxMm;
        var m = 2f * pxMm;
        var area = new RectangleF(m, m, w - 2 * m, h - 2 * m);

        switch (l.Type)
        {
            case "BOOK":
                Stack(g, area, pxMm, (l.Title ?? "", 3.8f, true, 0.38f), l.Code ?? l.InventoryNumber ?? "", l.InventoryNumber, rtl: true);
                break;
            case "LOCATION":
                Stack(g, area, pxMm, (l.Shelf ?? "", 6f, true, 0.30f), l.Code ?? "", l.Code, rtl: true, secondLine: (l.Path ?? "", 3f, false, 0.18f));
                break;
            case "ZONE":
                Stack(g, area, pxMm, (l.Name ?? "", 9f, true, 0.42f), l.Code ?? "", l.Code, rtl: true, secondLine: (l.Warehouse ?? "", 3.4f, false, 0.16f));
                break;
            default:
                Stack(g, area, pxMm, (l.Text ?? "AVOT · בדיקת הדפסה", 4.5f, true, 0.45f), "AVOT-TEST", null, rtl: true);
                break;
        }
    }

    /// <summary>top text(s) → barcode → readable code, all inside <paramref name="area"/>.</summary>
    private static void Stack(Graphics g, RectangleF area, float pxMm, (string Text, float SizeMm, bool Bold, float MaxHeightFraction) title, string code, string? readable, bool rtl, (string Text, float SizeMm, bool Bold, float MaxHeightFraction)? secondLine = null)
    {
        var y = area.Top;
        y += DrawFitted(g, title.Text, new RectangleF(area.Left, y, area.Width, area.Height * title.MaxHeightFraction), title.SizeMm * pxMm, title.Bold, rtl);
        if (secondLine is { } s)
            y += DrawFitted(g, s.Text, new RectangleF(area.Left, y + 0.5f * pxMm, area.Width, area.Height * s.MaxHeightFraction), s.SizeMm * pxMm, s.Bold, rtl) + 0.5f * pxMm;
        y += 1.2f * pxMm;

        var readableH = readable is null ? 0f : 3.4f * pxMm;
        var barH = Math.Max(5f * pxMm, area.Bottom - y - readableH - 1f * pxMm);
        DrawBarcode(g, code, new RectangleF(area.Left, y, area.Width, barH), g.DpiX);
        if (readable is not null)
        {
            using var f = new Font("Arial", 3f * pxMm, FontStyle.Regular, GraphicsUnit.Pixel);
            g.DrawString(readable, f, Brushes.Black, new RectangleF(area.Left, y + barH + 0.6f * pxMm, area.Width, readableH), Center);
        }
    }

    /// <summary>Largest font ≤ size that fits the box (shrinks, then trims with an ellipsis); returns the height used.</summary>
    private static float DrawFitted(Graphics g, string text, RectangleF box, float sizePx, bool bold, bool rtl)
    {
        if (string.IsNullOrWhiteSpace(text)) return 0;
        var fmt = rtl && text.Any(c => c is >= '֐' and <= '׿') ? Rtl : new StringFormat(StringFormatFlags.NoClip) { Trimming = StringTrimming.EllipsisWord };
        var size = sizePx;
        var min = Math.Max(10f, sizePx * 0.55f);
        while (true)
        {
            using var font = new Font("Arial", size, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel);
            var measured = g.MeasureString(text, font, (int)box.Width, fmt);
            if (measured.Height <= box.Height || size <= min)
            {
                var drawBox = new RectangleF(box.X, box.Y, box.Width, Math.Min(box.Height, measured.Height + 1));
                g.DrawString(text, font, Brushes.Black, drawBox, fmt);
                return Math.Min(box.Height, measured.Height);
            }
            size = Math.Max(min, size * 0.9f);
        }
    }

    /// <summary>Bars in whole printer dots (never anti-aliased), centred, as wide as fits (1–4 dots per module).</summary>
    public static void DrawBarcode(Graphics g, string code, RectangleF box, float dpi)
    {
        var modules = Code128.Modules(code);
        var total = modules.Sum();
        var quiet = 10; // modules of quiet zone each side
        var dots = (int)Math.Clamp(Math.Floor(box.Width / (total + 2 * quiet)), 1, 4);
        var width = total * dots;
        var x = box.Left + (box.Width - width) / 2f;
        var isBar = true;
        foreach (var m in modules)
        {
            if (isBar) g.FillRectangle(Brushes.Black, (float)Math.Round(x), box.Top, m * dots, box.Height);
            x += m * dots;
            isBar = !isBar;
        }
    }
}
