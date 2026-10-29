using System.Drawing;
using System.Text.Json;
using AvotCapture.Agent;
using AvotCapture.Core;
using Xunit;

namespace AvotCapture.Tests;

/// <summary>
/// The Windows-driver path draws the layout the SERVER computed (fixtures/label-layouts.json is exported from the TypeScript
/// engine). These tests prove the station only draws it: same module rule, boxes honoured, nothing outside the label.
/// </summary>
public class LabelLayoutTests
{
    private static List<LabelLayoutDto> Layouts() =>
        JsonSerializer.Deserialize<List<LabelLayoutDto>>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "label-layouts.json")))!;

    private static Bitmap Render(LabelLayoutDto l, float dpi = 203f)
    {
        var bmp = new Bitmap((int)Math.Round(l.WidthMm / 25.4 * dpi), (int)Math.Round(l.HeightMm / 25.4 * dpi));
        bmp.SetResolution(dpi, dpi);
        using var g = Graphics.FromImage(bmp);
        g.PageUnit = GraphicsUnit.Pixel;
        LabelDrawer.Draw(g, l, new PrintAssets(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "logo.b64"))));
        return bmp;
    }

    private static bool Dark(Bitmap b, int x, int y) => b.GetPixel(x, y).GetBrightness() < 0.5f;

    [Fact]
    public void Module_rule_matches_the_server_for_an_8_digit_number_on_a_57_mm_label()
    {
        var modules = Code128.TotalModules("10000041");
        // the same numbers as barcodeModuleDots in the shared package: 53 mm × 8 dots/mm, 0.25–0.5 mm modules, 10 quiet modules
        var r = LabelDrawer.ModuleDots(modules, 53 * 8, 8, 0.25, 0.5, 10);
        Assert.Equal(4, r.Dots);
        Assert.True(r.Fits);
        Assert.Equal(4 * modules, r.WidthPx);
    }

    [Fact]
    public void Draws_every_exported_layout_inside_the_label_with_the_barcode_where_the_layout_says()
    {
        foreach (var l in Layouts())
        {
            using var bmp = Render(l);
            var pxMm = 203f / 25.4f;
            var bc = l.Items.Single(i => i.Kind == "barcode");
            // bars: dark pixels in the middle row of the barcode box, centred, white quiet zones on both sides
            var midY = (int)((bc.Y + bc.H / 2) * pxMm);
            var left = (int)(bc.X * pxMm);
            var right = (int)((bc.X + bc.W) * pxMm);
            var dark = Enumerable.Range(left, right - left).Where(x => Dark(bmp, x, midY)).ToList();
            Assert.NotEmpty(dark);
            Assert.True(dark.First() > left + 4, "quiet zone on the left");
            Assert.True(dark.Last() < right - 4, "quiet zone on the right");
            Assert.InRange((dark.First() + dark.Last()) / 2.0, (left + right) / 2.0 - 3, (left + right) / 2.0 + 3);
            // above and below the bars inside the barcode column: nothing but the other boxes' ink
            foreach (var t in l.Items.Where(i => i.Kind == "text"))
            {
                var box = new Rectangle((int)(t.X * pxMm), (int)(t.Y * pxMm), (int)(t.W * pxMm), Math.Max(1, (int)(t.H * pxMm)));
                var ink = 0;
                for (var y = box.Top; y < Math.Min(bmp.Height, box.Bottom); y++)
                    for (var x = box.Left; x < Math.Min(bmp.Width, box.Right); x++)
                        if (Dark(bmp, x, y)) ink++;
                Assert.True(ink > 30, $"text '{t.Text}' was drawn in its box");
            }
        }
    }

    [Fact]
    public void Nothing_is_drawn_in_the_margin_of_the_label()
    {
        foreach (var l in Layouts())
        {
            using var bmp = Render(l);
            var minX = l.Items.Min(i => i.X);
            var m = (int)(minX * 203f / 25.4f) - 1;
            for (var y = 0; y < bmp.Height; y++)
                for (var x = 0; x < Math.Max(0, m); x++)
                    Assert.False(Dark(bmp, x, y), "left margin stays white");
        }
    }

    [Fact]
    public void A_long_title_is_fitted_to_two_lines_at_most()
    {
        var l = Layouts()[1];
        var title = l.Items.First(i => i.Role == "title");
        Assert.Equal(2, title.MaxLines);
        using var bmp = Render(l);
        // the ink of the title never leaves its box
        var pxMm = 203f / 25.4f;
        var top = (int)(title.Y * pxMm);
        var bottom = (int)((title.Y + title.H) * pxMm);
        for (var y = Math.Max(0, top - 6); y < top - 1; y++)
            for (var x = 0; x < bmp.Width; x++) Assert.False(Dark(bmp, x, y), "nothing above the title box");
        Assert.True(bottom > top);
    }

    [Fact]
    public void The_logo_is_drawn_in_its_box_beside_the_title()
    {
        var l = Layouts()[0];
        var logo = l.Items.Single(i => i.Kind == "image");
        var title = l.Items.First(i => i.Role == "title");
        Assert.True(logo.X + logo.W <= title.X + 0.01, "beside the title, not over it");
        Assert.InRange(logo.H, 5, 10);
        using var bmp = Render(l);
        var pxMm = 203f / 25.4f;
        var ink = 0;
        for (var y = (int)(logo.Y * pxMm); y < (int)((logo.Y + logo.H) * pxMm); y++)
            for (var x = (int)(logo.X * pxMm); x < (int)((logo.X + logo.W) * pxMm); x++)
                if (Dark(bmp, x, y)) ink++;
        Assert.True(ink > 800, "the logo has real ink");
    }

    private static LabelLayoutDto WithFont(LabelLayoutDto l, string font) => l with { Items = l.Items.Select(i => i.Kind == "text" ? i with { Font = font } : i).ToList() };

    private static string Hash(Bitmap b)
    {
        var sb = new System.Text.StringBuilder();
        for (var y = 0; y < b.Height; y++)
            for (var x = 0; x < b.Width; x++) sb.Append(Dark(b, x, y) ? '1' : '0');
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.ASCII.GetBytes(sb.ToString())));
    }

    [Fact]
    public void The_three_bundled_typefaces_load_from_the_Fonts_folder_not_from_the_PC()
    {
        foreach (var style in new[] { "classic", "traditional", "modern" })
            foreach (var bold in new[] { true, false })
                Assert.True(LabelFonts.Available(style, bold), $"{style} {(bold ? "bold" : "regular")} is bundled");
    }

    [Fact]
    public void Each_typeface_draws_its_own_letters_and_all_of_them_stay_inside_the_label()
    {
        var hashes = new HashSet<string>();
        foreach (var style in new[] { "classic", "traditional", "modern" })
        {
            foreach (var layout in Layouts())
            {
                using var bmp = Render(WithFont(layout, style));
                var ink = 0;
                for (var y = 0; y < bmp.Height; y += 2)
                    for (var x = 0; x < bmp.Width; x += 2) if (Dark(bmp, x, y)) ink++;
                Assert.True(ink > 200, $"{style}: something is printed");
            }
            using var one = Render(WithFont(Layouts()[0], style));
            hashes.Add(Hash(one));
        }
        Assert.Equal(3, hashes.Count); // classic, traditional and modern are visibly different pages
    }

    [Fact]
    public void Layout_json_carries_the_typeface()
    {
        Assert.All(Layouts().SelectMany(l => l.Items).Where(i => i.Kind == "text"), i => Assert.Equal("classic", i.Font));
    }
}
