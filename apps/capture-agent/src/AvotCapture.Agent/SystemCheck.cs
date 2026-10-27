using System.Text.Json;
using AvotCapture.Canon;
using AvotCapture.Core;
using Microsoft.Extensions.Logging;

namespace AvotCapture.Agent;

public sealed record CheckLine(string Key, string Title, bool Ok, string Detail);

/// <summary>
/// The installer wizard and the "בדיקת מערכת" button run the same checks: software, Canon EDSDK, EOS R7 detection,
/// pairing, storage folder and free space, server reachability. Every line says what is wrong in plain Hebrew.
/// </summary>
public static class SystemCheck
{
    public const long MinFreeBytes = 20L * 1024 * 1024 * 1024;

    public static async Task<List<CheckLine>> RunAsync(AgentSettings settings, AgentHost? running, ILoggerFactory logs, CancellationToken ct)
    {
        var lines = new List<CheckLine> { new("app", "תוכנת AVOT Capture Desktop", true, $"גרסה {AgentHost.Version}") };

        var sdk = SdkImporter.Detect(settings);
        lines.Add(sdk.Installed
            ? new("edsdk", "Canon EDSDK", true, $"גרסה {sdk.Version ?? "?"} · {sdk.Folder}" + (sdk.Version is { } v && !v.StartsWith("13.20", StringComparison.Ordinal) ? $" (נבדקה גרסה {SdkImporter.ExpectedVersion})" : ""))
            : new("edsdk", "Canon EDSDK", false, sdk.Problem ?? "לא מותקן. בחרו את חבילת ה-ZIP הרשמית שהורדתם מפורטל Canon."));

        string? model = null;
        string? cameraProblem = null;
        if (running?.Camera?.GetStatus() is { Connected: true } live)
        {
            model = live.Model;
        }
        else if (sdk.Installed && running is null && CanonCamera.IsAvailable(sdk.Folder, out _))
        {
            // standalone check (installer): open a session briefly, then release the camera for the real agent
            await using var probe = new CanonCamera(logs.CreateLogger("Check"), name => Path.Combine(Path.GetTempPath(), "avot-check-" + name));
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(12));
                await probe.ConnectAsync(timeout.Token);
                model = probe.GetStatus().Model;
                await probe.DisconnectAsync();
            }
            catch (CameraException ex)
            {
                cameraProblem = ex.Message;
            }
            catch (OperationCanceledException)
            {
                cameraProblem = "המצלמה לא הגיבה בזמן";
            }
        }
        else
        {
            cameraProblem = running?.CameraError ?? (sdk.Installed ? "לא זוהתה מצלמה" : "אי אפשר לזהות מצלמת Canon בלי EDSDK");
        }
        var isR7 = model?.Contains("R7", StringComparison.OrdinalIgnoreCase) == true;
        lines.Add(model is not null
            ? new("camera", "מצלמת Canon EOS R7", isR7, isR7 ? $"זוהתה: {model}" : $"זוהתה מצלמה {model} — לא EOS R7")
            : new("camera", "מצלמת Canon EOS R7", false, cameraProblem ?? "לא זוהתה"));

        lines.Add(settings.IsPaired
            ? new("pair", "צימוד למערכת אבות", true, $"{settings.DeviceName} ← {settings.ServerUrl}")
            : new("pair", "צימוד למערכת אבות", false, "העמדה אינה מצומדת. הזינו את הקוד בן 8 הספרות מההגדרות באתר."));

        try
        {
            Directory.CreateDirectory(settings.StorageRoot);
            var free = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(settings.StorageRoot))!).AvailableFreeSpace;
            var ok = free >= MinFreeBytes;
            lines.Add(new("storage", "תיקיית אחסון ושטח דיסק", ok, $"{settings.StorageRoot} · פנוי {free / (1024.0 * 1024 * 1024):0.#} GB" + (ok ? "" : $" (מומלץ לפחות {MinFreeBytes / (1024 * 1024 * 1024)} GB)")));
            var probe = Path.Combine(settings.StorageRoot, ".write-test");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            lines.Add(new("storage", "תיקיית אחסון ושטח דיסק", false, "אין הרשאת כתיבה לתיקייה: " + ex.Message));
        }

        if (settings.IsPaired)
        {
            // reachability AND a device-authenticated call: proves the station's credentials are accepted (what uploads need)
            using var client = new ServerClient(new Uri(settings.ServerUrl!.TrimEnd('/') + "/"), new DpapiProtector().Unprotect(settings.DeviceTokenProtected!));
            var reach = await client.PingAsync(ct);
            var authOk = false;
            string? authError = null;
            if (reach)
            {
                try
                {
                    await client.GetAsync<System.Text.Json.JsonElement>("api/agent/update?version=" + AgentHost.Version, ct);
                    authOk = true;
                }
                catch (ServerException ex)
                {
                    authError = ex.Message;
                }
            }
            lines.Add(new("server", "חיבור והעלאה לשרת", reach && authOk, !reach ? "אין תקשורת עם השרת. בדקו חיבור אינטרנט." : authOk ? "השרת מגיב וההרשאה של העמדה תקינה" : "השרת מגיב אך דחה את העמדה: " + authError));
        }
        else
        {
            lines.Add(new("server", "חיבור והעלאה לשרת", false, "יש לבצע צימוד קודם"));
        }
        return lines;
    }

    /// <summary>Machine-readable output for the installer wizard (<c>AvotCaptureAgent.exe --check</c>).</summary>
    public static string ToJson(IEnumerable<CheckLine> lines) =>
        JsonSerializer.Serialize(lines, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
}
