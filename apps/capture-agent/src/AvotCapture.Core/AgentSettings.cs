using System.Text.Json;

namespace AvotCapture.Core;

public interface ISecretProtector
{
    string Protect(string plain);
    string Unprotect(string protectedValue);
}

/// <summary>Agent configuration persisted in %LOCALAPPDATA%\AvotCapture\settings.json.</summary>
public sealed class AgentSettings
{
    public string? ServerUrl { get; set; }
    public string? DeviceId { get; set; }
    public string? DeviceName { get; set; }
    public string? OrganizationId { get; set; }
    /// <summary>DPAPI-protected (current Windows user) device bearer token.</summary>
    public string? DeviceTokenProtected { get; set; }
    /// <summary>DPAPI-protected HMAC secret used to verify browser control tokens.</summary>
    public string? DeviceSecretProtected { get; set; }
    public string StorageRoot { get; set; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), "AVOT Studio");
    public int Port { get; set; } = 47800;
    /// <summary>CANON or SIMULATOR. The simulator must be chosen explicitly at the station.</summary>
    public string CameraMode { get; set; } = "CANON";
    public string? EdsdkPath { get; set; }
    public bool AutoStart { get; set; } = true;
    /// <summary>0 = keep verified originals forever.</summary>
    public int LocalRetentionDays { get; set; }
    public bool RawPlusJpegSimulation { get; set; }

    public bool IsPaired => DeviceId is not null && DeviceTokenProtected is not null && DeviceSecretProtected is not null && ServerUrl is not null;

    /// <summary>Origin of the paired web app ("https://studio.example.com").</summary>
    public string? ServerOrigin => ServerUrl is null ? null : new Uri(ServerUrl).GetLeftPart(UriPartial.Authority);

    /// <summary>Data folder (settings, local DB, logs). Overridable with --data for tests / portable installs.</summary>
    public static string Folder { get; set; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AvotCapture");
    public static string FilePath => Path.Combine(Folder, "settings.json");

    private static readonly JsonSerializerOptions Opts = new() { WriteIndented = true };

    public static AgentSettings Load(string? path = null)
    {
        path ??= FilePath;
        if (!File.Exists(path)) return new AgentSettings();
        return JsonSerializer.Deserialize<AgentSettings>(File.ReadAllText(path)) ?? new AgentSettings();
    }

    /// <summary>Atomic save: temp file + replace, so a crash never leaves a truncated config.</summary>
    public void Save(string? path = null)
    {
        path ??= FilePath;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(this, Opts));
        File.Move(tmp, path, overwrite: true);
    }
}
