namespace AvotCapture.Core;

/// <summary>
/// Code 128 (subset B, subset C for digit runs of four or more) — the same encoder as the web app (code128.ts), so a label
/// drawn through a Windows driver carries exactly the symbol the thermal-printer path would print. Checksum is the
/// standard modulo-103 sum.
/// </summary>
public static class Code128
{
    private static readonly string[] Patterns =
    [
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
        "114131", "311141", "411131", "211412", "211214", "211232", "2331112"
    ];

    private const int StartB = 104, StartC = 105, CodeB = 100, CodeC = 99, Stop = 106;

    /// <summary>Symbol values including start, checksum and stop. Printable ASCII only.</summary>
    public static int[] Encode(string text)
    {
        if (string.IsNullOrEmpty(text) || text.Any(c => c < 32 || c > 126)) throw new ArgumentException("Code 128: printable ASCII only", nameof(text));
        var values = new List<int>();
        char set = ' ';
        var i = 0;
        int DigitRun(int from)
        {
            var n = 0;
            while (from + n < text.Length && char.IsAsciiDigit(text[from + n])) n++;
            return n;
        }
        while (i < text.Length)
        {
            var run = DigitRun(i);
            if (run >= 4)
            {
                var even = run - (run % 2);
                if (set != 'C')
                {
                    values.Add(set == ' ' ? StartC : CodeC);
                    set = 'C';
                }
                for (var k = 0; k < even; k += 2) values.Add(int.Parse(text.AsSpan(i + k, 2)));
                i += even;
                continue;
            }
            if (set != 'B')
            {
                values.Add(set == ' ' ? StartB : CodeB);
                set = 'B';
            }
            values.Add(text[i] - 32);
            i++;
        }
        var sum = values[0];
        for (var k = 1; k < values.Count; k++) sum += values[k] * k;
        values.Add(sum % 103);
        values.Add(Stop);
        return [.. values];
    }

    /// <summary>Alternating bar / space widths in modules, starting with a bar.</summary>
    public static int[] Modules(string text) => Encode(text).SelectMany(v => Patterns[v].Select(c => c - '0')).ToArray();

    public static int TotalModules(string text) => Modules(text).Sum();
}
