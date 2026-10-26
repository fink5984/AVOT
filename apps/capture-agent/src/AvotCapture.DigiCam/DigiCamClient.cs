using System.Net;
using AvotCapture.Core;

namespace AvotCapture.DigiCam;

public sealed class DigiCamOptions
{
    /// <summary>digiCamControl web server (Settings → Webserver). Must be a loopback address.</summary>
    public string BaseUrl { get; init; } = "http://127.0.0.1:5513";

    /// <summary>Folder digiCamControl is told to save into. Dedicated to this agent: files appearing here are shots.</summary>
    public required string SessionFolder { get; init; }

    /// <summary>CameraControl.exe, started when the web server is not reachable. Null → autodetected.</summary>
    public string? ExePath { get; init; }

    public bool AutoLaunch { get; init; } = true;

    /// <summary>Save_to_PC_only | Save_to_camera_only | Save_to_PC_and_camera</summary>
    public string TransferMode { get; init; } = "Save_to_PC_only";

    public TimeSpan MonitorInterval { get; init; } = TimeSpan.FromSeconds(2);
    public TimeSpan FilePollInterval { get; init; } = TimeSpan.FromMilliseconds(250);
    public TimeSpan LiveViewInterval { get; init; } = TimeSpan.FromMilliseconds(100);

    /// <summary>How long a file must keep its size before it is considered fully written.</summary>
    public TimeSpan FileStableFor { get; init; } = TimeSpan.FromMilliseconds(500);

    public static readonly string[] DefaultExePaths =
    [
        @"C:\Program Files (x86)\digiCamControl\CameraControl.exe",
        @"C:\Program Files\digiCamControl\CameraControl.exe",
    ];
}

/// <summary>
/// Thin client for digiCamControl's built-in web server
/// (https://www.digicamcontrol.com/doc/userguide/web, …/singlecmd).
/// The server is never reachable from outside this PC through the agent: the
/// base address is validated to be loopback, and only the agent talks to it.
/// </summary>
public sealed class DigiCamClient : IDisposable
{
    private readonly HttpClient _http;
    public Uri BaseAddress { get; }

    public DigiCamClient(string baseUrl, HttpMessageHandler? handler = null)
    {
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttp || !uri.IsLoopback)
            throw new CameraException("כתובת digiCamControl חייבת להיות מקומית (http://127.0.0.1:<פורט>) — השרת שלו אינו נחשף החוצה.");
        BaseAddress = uri;
        _http = handler is null ? new HttpClient() : new HttpClient(handler);
        _http.BaseAddress = uri;
        _http.Timeout = TimeSpan.FromSeconds(20);
    }

    private static string Esc(string s) => Uri.EscapeDataString(s);

    private async Task<string> GetTextAsync(string pathAndQuery, CancellationToken ct)
    {
        try
        {
            using var res = await _http.GetAsync(pathAndQuery, ct);
            var body = (await res.Content.ReadAsStringAsync(ct)).Trim();
            if (!res.IsSuccessStatusCode) throw new CameraException($"digiCamControl החזיר שגיאה ({(int)res.StatusCode}). {body}".Trim());
            return body;
        }
        catch (HttpRequestException ex)
        {
            throw new CameraException("אין תקשורת עם digiCamControl. ודאו שהתוכנה פועלת ושבהגדרות שלה (Settings → Webserver) שרת האינטרנט מופעל.", ex);
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            throw new CameraException("digiCamControl לא הגיב בזמן.", ex);
        }
    }

    /// <summary>Single command system: ?slc=&lt;cmd&gt;&amp;param1=&amp;param2=</summary>
    public Task<string> SlcAsync(string command, string param1 = "", string param2 = "", CancellationToken ct = default) =>
        GetTextAsync($"/?slc={Esc(command)}&param1={Esc(param1)}&param2={Esc(param2)}", ct);

    /// <summary>Window command: ?CMD=&lt;name&gt; (e.g. LiveViewWnd_Show)</summary>
    public Task<string> WindowCommandAsync(string name, CancellationToken ct = default) => GetTextAsync($"/?CMD={Esc(name)}", ct);

    public static bool IsOk(string body) => body.Equals("OK", StringComparison.OrdinalIgnoreCase);

    public async Task SetAsync(string property, string value, CancellationToken ct = default)
    {
        var res = await SlcAsync("set", property, value, ct);
        if (!IsOk(res)) throw new CameraException(string.IsNullOrWhiteSpace(res) ? $"digiCamControl דחה את ההגדרה {property}" : $"digiCamControl: {res}");
    }

    public async Task<string?> GetAsync(string property, CancellationToken ct = default)
    {
        var res = await SlcAsync("get", property, "", ct);
        return string.IsNullOrWhiteSpace(res) || res.StartsWith("error", StringComparison.OrdinalIgnoreCase) ? null : res;
    }

    /// <summary>`list &lt;what&gt;` → entries (one per line; a single comma-separated line is split too).</summary>
    public async Task<IReadOnlyList<string>> ListAsync(string what, CancellationToken ct = default)
    {
        var res = await SlcAsync("list", what, "", ct);
        return ParseList(res);
    }

    public static IReadOnlyList<string> ParseList(string body)
    {
        if (string.IsNullOrWhiteSpace(body) || body.StartsWith("error", StringComparison.OrdinalIgnoreCase)) return [];
        var lines = body.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (lines.Length == 1 && lines[0].Contains(',')) lines = lines[0].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return lines.Where(l => !l.Equals("OK", StringComparison.OrdinalIgnoreCase)).Distinct().ToList();
    }

    /// <summary>Current live view frame (JPEG) or null when live view is not running.</summary>
    public async Task<byte[]?> LiveViewFrameAsync(CancellationToken ct = default)
    {
        try
        {
            using var res = await _http.GetAsync("/liveview.jpg", ct);
            if (!res.IsSuccessStatusCode) return null;
            var bytes = await res.Content.ReadAsByteArrayAsync(ct);
            return bytes.Length > 4 && bytes[0] == 0xFF && bytes[1] == 0xD8 ? bytes : null;
        }
        catch (HttpRequestException)
        {
            return null;
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return null;
        }
    }

    public void Dispose() => _http.Dispose();
}
