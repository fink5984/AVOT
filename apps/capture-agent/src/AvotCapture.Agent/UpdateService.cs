using System.Diagnostics;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using AvotCapture.Core;
using Microsoft.Extensions.Logging;

namespace AvotCapture.Agent;

public sealed record UpdateInfo(bool UpdateAvailable, string? Latest, bool Mandatory, string? Url, string? Sha256, long? SizeBytes, string? Notes, string? SignerThumbprint);

/// <summary>Pure decisions of the update flow (unit-tested without Windows).</summary>
public static class UpdateRules
{
    public static int Compare(string a, string b)
    {
        static int[] Parts(string v) => v.Split('.').Take(3).Select(p => int.TryParse(p, out var n) ? n : 0).Concat(Enumerable.Repeat(0, 3)).Take(3).ToArray();
        var pa = Parts(a);
        var pb = Parts(b);
        for (var i = 0; i < 3; i++)
            if (pa[i] != pb[i]) return pa[i] < pb[i] ? -1 : 1;
        return 0;
    }

    /// <summary>The installer may only come from HTTPS (or loopback, for tests).</summary>
    public static bool IsAllowedSource(Uri url) => url.Scheme == Uri.UriSchemeHttps || (url.Scheme == Uri.UriSchemeHttp && url.IsLoopback);

    /// <summary>Update only while the station is not shooting, not receiving a file from the camera and nobody is at the controls.</summary>
    public static bool IsIdle(bool leaseActive, bool shotInProgress, DateTimeOffset lastShutterAt, DateTimeOffset now) =>
        !leaseActive && !shotInProgress && now - lastShutterAt > TimeSpan.FromSeconds(60);

    public static bool HashMatches(string file, string expectedHex)
    {
        using var fs = File.OpenRead(file);
        var actual = Convert.ToHexStringLower(SHA256.HashData(fs));
        return string.Equals(actual, expectedHex.Trim(), StringComparison.OrdinalIgnoreCase);
    }
}

/// <summary>
/// Automatic updates of AVOT Capture Desktop.
///   check    GET /api/agent/update (device-authenticated) every 6 h and at start
///   download from the HTTPS URL in the manifest WITHOUT the device token; SHA-256 must match; when the manifest pins
///            a signer, the Authenticode signature must be valid and from that signer
///   apply    only when idle: back up the current program folder, run the installer silently, restart
///   recover  the new version must prove itself (3 clean minutes); after 2 failed starts the previous version is restored
/// Settings, pairing, the local database and every photo live outside the install folder and are never touched.
/// </summary>
public sealed class UpdateService : IDisposable
{
    private sealed class State
    {
        public string? FromVersion { get; set; }
        public string? ToVersion { get; set; }
        public string? RollbackDir { get; set; }
        public int Boots { get; set; }
        public string Status { get; set; } = "none"; // installing | confirmed | rolledBack | failed
        public DateTimeOffset? At { get; set; }
        public string? Error { get; set; }
    }

    private readonly AgentHost _host;
    private readonly ILogger _log;
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;
    private UpdateInfo? _available;
    private string? _readyInstaller;
    private DateTimeOffset _lastShutter = DateTimeOffset.MinValue;

    public string Status { get; private set; } = "לא נבדק";
    public UpdateInfo? Available => _available;
    public bool ReadyToInstall => _readyInstaller is not null;

    private static string StateFile => Path.Combine(AgentSettings.Folder, "update-state.json");
    private static string UpdatesDir => Path.Combine(AgentSettings.Folder, "updates");
    private static string RollbackRoot => Path.Combine(AgentSettings.Folder, "rollback");

    public event Action? Changed;

    public UpdateService(AgentHost host, ILogger log)
    {
        _host = host;
        _log = log;
    }

    public void NoteShutter() => _lastShutter = DateTimeOffset.UtcNow;

    public void Start()
    {
        _loop ??= Task.Run(() => RunAsync(_cts.Token));
    }

    private async Task RunAsync(CancellationToken ct)
    {
        try
        {
            ConfirmWhenHealthy(ct);
            await Task.Delay(TimeSpan.FromMinutes(2), ct);
            while (!ct.IsCancellationRequested)
            {
                if (_host.Settings.AutoUpdate)
                {
                    await CheckNowAsync(ct);
                    await TryApplyAsync(ct);
                }
                // a downloaded installer waits for a quiet moment: look again every few minutes
                await Task.Delay(_readyInstaller is null ? TimeSpan.FromHours(6) : TimeSpan.FromMinutes(5), ct);
            }
        }
        catch (OperationCanceledException)
        {
            /* shutting down */
        }
    }

    /// <summary>Asks the server for a newer version; downloads and verifies it when there is one.</summary>
    public async Task<UpdateInfo?> CheckNowAsync(CancellationToken ct)
    {
        var client = _host.ServerClientOrNull;
        if (client is null)
        {
            Status = "העמדה אינה מצומדת — אין בדיקת עדכונים";
            Changed?.Invoke();
            return null;
        }
        try
        {
            Status = "בודק עדכונים…";
            Changed?.Invoke();
            var info = await client.GetAsync<UpdateInfo>($"api/agent/update?version={AgentHost.Version}", ct);
            _available = info.UpdateAvailable ? info : null;
            if (!info.UpdateAvailable)
            {
                Status = $"התוכנה מעודכנת (גרסה {AgentHost.Version})";
            }
            else if (info.Url is null || info.Sha256 is null)
            {
                Status = "הודעת העדכון מהשרת חסרה פרטים — העדכון נדחה";
            }
            else if (_readyInstaller is null)
            {
                Status = $"גרסה {info.Latest} זמינה — מוריד…";
                Changed?.Invoke();
                await DownloadAsync(info, ct);
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            Status = "בדיקת העדכונים נכשלה: " + ex.Message;
            _log.LogWarning(ex, "update check failed");
        }
        Changed?.Invoke();
        return _available;
    }

    private async Task DownloadAsync(UpdateInfo info, CancellationToken ct)
    {
        var url = new Uri(info.Url!);
        if (!UpdateRules.IsAllowedSource(url)) throw new InvalidOperationException("כתובת ההורדה אינה מאובטחת (https) — העדכון נדחה");
        Directory.CreateDirectory(UpdatesDir);
        var final = Path.Combine(UpdatesDir, $"AvotCaptureDesktop-Setup-{info.Latest}.exe");
        if (File.Exists(final) && UpdateRules.HashMatches(final, info.Sha256!))
        {
            _readyInstaller = final;
            Status = $"גרסה {info.Latest} הורדה ותאומת — תותקן כשהעמדה לא תצלם";
            return;
        }
        var partial = final + ".partial";
        // a third-party host never receives the station's bearer token
        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
        http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("AvotCaptureDesktop", AgentHost.Version));
        await using (var src = await http.GetStreamAsync(url, ct))
        await using (var dst = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20, FileOptions.WriteThrough))
        {
            await src.CopyToAsync(dst, 1 << 20, ct);
            await dst.FlushAsync(ct);
        }
        if (info.SizeBytes is { } size && new FileInfo(partial).Length != size) throw new InvalidDataException("גודל הקובץ שהורד שונה מהמצופה");
        if (!UpdateRules.HashMatches(partial, info.Sha256!))
        {
            File.Delete(partial);
            throw new InvalidDataException("חתימת SHA-256 של הקובץ שהורד אינה תואמת — העדכון נדחה");
        }
        if (!string.IsNullOrEmpty(info.SignerThumbprint) && !Authenticode.IsValidFrom(partial, info.SignerThumbprint))
        {
            File.Delete(partial);
            throw new InvalidDataException("החתימה הדיגיטלית של המתקין אינה תקפה או אינה של AVOT — העדכון נדחה");
        }
        File.Move(partial, final, overwrite: true);
        _readyInstaller = final;
        Status = $"גרסה {info.Latest} הורדה ותאומת — תותקן כשהעמדה לא תצלם";
        _log.LogInformation("update {Version} downloaded and verified", info.Latest);
    }

    public bool IsIdle() => UpdateRules.IsIdle(_host.Leases.Active is not null, _host.Coordinator.HasShotInProgress, _lastShutter, DateTimeOffset.UtcNow);

    /// <summary>Installs the verified update if the station is idle. Returns true when the installer was started (this process then exits).</summary>
    public async Task<bool> TryApplyAsync(CancellationToken ct, bool force = false)
    {
        if (_readyInstaller is null || _available is null) return false;
        if (!force && !IsIdle())
        {
            Status = $"גרסה {_available.Latest} ממתינה — העדכון יתבצע כשהעמדה לא תצלם";
            Changed?.Invoke();
            return false;
        }
        if (force && !IsIdle()) throw new InvalidOperationException("העמדה בפעילות (צילום או קליטת קובץ). נסו שוב בעוד רגע.");
        try
        {
            Status = "מתקין עדכון…";
            Changed?.Invoke();
            // the previous program folder is the way back
            var backup = Path.Combine(RollbackRoot, AgentHost.Version);
            if (Directory.Exists(RollbackRoot)) Directory.Delete(RollbackRoot, recursive: true);
            CopyDirectory(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar), backup);
            Save(new State { FromVersion = AgentHost.Version, ToVersion = _available.Latest, RollbackDir = backup, Status = "installing", At = DateTimeOffset.UtcNow });
            var log = Path.Combine(AgentSettings.Folder, "logs", $"update-{DateTime.Now:yyyyMMdd-HHmmss}.log");
            Process.Start(new ProcessStartInfo(_readyInstaller, $"/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /LOG=\"{log}\"") { UseShellExecute = true });
            await Task.Delay(500, ct);
            Application.Exit();
            return true;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Status = "התקנת העדכון נכשלה: " + ex.Message;
            _log.LogError(ex, "update apply failed");
            Save(new State { Status = "failed", Error = ex.Message, At = DateTimeOffset.UtcNow });
            Changed?.Invoke();
            return false;
        }
    }

    /// <summary>
    /// Runs first thing at startup. After an update the new version must start cleanly; a crash loop restores the
    /// previous version. Returns true when a restore was started (the caller must exit at once).
    /// </summary>
    public static bool RecoverIfNeeded(ILogger log)
    {
        var st = Load();
        if (st is null || st.Status != "installing") return false;
        if (st.ToVersion != AgentHost.Version)
        {
            // the installer did not finish: the old version is running again — note it and move on
            st.Status = "failed";
            st.Error = "המתקין לא הושלם";
            Save(st);
            return false;
        }
        st.Boots++;
        Save(st);
        if (st.Boots <= 2 || st.RollbackDir is null || !Directory.Exists(st.RollbackDir)) return false;
        log.LogCritical("update {To} failed to run {Boots} times — restoring {From}", st.ToVersion, st.Boots, st.FromVersion);
        st.Status = "rolledBack";
        Save(st);
        var install = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        var exe = Path.Combine(install, "AvotCaptureAgent.exe");
        // wait for this process to exit, mirror the backup over the install folder, start the old version
        var cmd = $"/c timeout /t 4 /nobreak >nul & robocopy \"{st.RollbackDir}\" \"{install}\" /MIR /R:3 /W:2 >nul & start \"\" \"{exe}\" --tray";
        Process.Start(new ProcessStartInfo("cmd.exe", cmd) { CreateNoWindow = true, UseShellExecute = false });
        return true;
    }

    private void ConfirmWhenHealthy(CancellationToken ct)
    {
        var st = Load();
        if (st is null || st.Status != "installing" || st.ToVersion != AgentHost.Version) return;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromMinutes(3), ct);
                var s = Load();
                if (s is { Status: "installing" })
                {
                    s.Status = "confirmed";
                    s.Boots = 0;
                    Save(s);
                    _log.LogInformation("update {Version} confirmed healthy", s.ToVersion);
                }
            }
            catch (OperationCanceledException)
            {
                /* shutting down before confirmation: the next start counts again */
            }
        }, ct);
    }

    private static State? Load()
    {
        try
        {
            return File.Exists(StateFile) ? JsonSerializer.Deserialize<State>(File.ReadAllText(StateFile)) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static void Save(State s)
    {
        Directory.CreateDirectory(AgentSettings.Folder);
        var tmp = StateFile + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(s));
        File.Move(tmp, StateFile, overwrite: true);
    }

    private static void CopyDirectory(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.EnumerateFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)), overwrite: true);
        foreach (var d in Directory.EnumerateDirectories(from)) CopyDirectory(d, Path.Combine(to, Path.GetFileName(d)));
    }

    public void Dispose() => _cts.Cancel();
}

/// <summary>Authenticode check through WinVerifyTrust (chain + file hash), plus the signer's thumbprint.</summary>
internal static class Authenticode
{
    private static readonly Guid GenericVerifyV2 = new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustFileInfo
    {
        public uint cbStruct;
        [MarshalAs(UnmanagedType.LPWStr)] public string pcwszFilePath;
        public IntPtr hFile;
        public IntPtr pgKnownSubject;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WinTrustData
    {
        public uint cbStruct;
        public IntPtr pPolicyCallbackData;
        public IntPtr pSIPClientData;
        public uint dwUIChoice;
        public uint fdwRevocationChecks;
        public uint dwUnionChoice;
        public IntPtr pFile;
        public uint dwStateAction;
        public IntPtr hWVTStateData;
        public IntPtr pwszURLReference;
        public uint dwProvFlags;
        public uint dwUIContext;
        public IntPtr pSignatureSettings;
    }

    [DllImport("wintrust.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern uint WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid action, ref WinTrustData data);

    public static bool IsValidFrom(string path, string thumbprint)
    {
        var fileInfo = new WinTrustFileInfo { cbStruct = (uint)Marshal.SizeOf<WinTrustFileInfo>(), pcwszFilePath = path };
        var pFile = Marshal.AllocHGlobal(Marshal.SizeOf<WinTrustFileInfo>());
        try
        {
            Marshal.StructureToPtr(fileInfo, pFile, false);
            var data = new WinTrustData
            {
                cbStruct = (uint)Marshal.SizeOf<WinTrustData>(),
                dwUIChoice = 2, // WTD_UI_NONE
                fdwRevocationChecks = 0, // WTD_REVOKE_NONE (offline stations)
                dwUnionChoice = 1, // WTD_CHOICE_FILE
                pFile = pFile,
                dwStateAction = 1, // WTD_STATEACTION_VERIFY
                dwProvFlags = 0x00000010, // WTD_CACHE_ONLY_URL_RETRIEVAL
            };
            var rc = WinVerifyTrust(IntPtr.Zero, GenericVerifyV2, ref data);
            data.dwStateAction = 2; // WTD_STATEACTION_CLOSE
            WinVerifyTrust(IntPtr.Zero, GenericVerifyV2, ref data);
            if (rc != 0) return false;
            using var signer = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
            return string.Equals(signer.Thumbprint, thumbprint.Replace(" ", ""), StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            Marshal.FreeHGlobal(pFile);
        }
    }
}
