namespace AvotCapture.Core;

/// <summary>Stable keys shared with the web app (packages/shared/src/domain.ts). Never rename.</summary>
public static class Categories
{
    public static readonly string[] All = ["COVER", "TITLE_PAGE", "INTERIOR", "EXTERIOR"];

    public static readonly IReadOnlyDictionary<string, string> Slug = new Dictionary<string, string>
    {
        ["COVER"] = "cover",
        ["TITLE_PAGE"] = "title-page",
        ["INTERIOR"] = "interior",
        ["EXTERIOR"] = "exterior",
    };

    public static bool IsValid(string? c) => c is not null && Slug.ContainsKey(c);
}

/// <summary>Lifecycle of one shot inside the agent. Mirrors CAPTURE_STAGES in the web app.</summary>
public enum CaptureStage
{
    CAPTURING,
    SAVED_LOCAL,
    QUEUED,
    UPLOADING,
    VERIFIED,
    FAILED,
    NEEDS_ATTENTION,
}

/// <summary>The association frozen when the shutter is pressed: lot, catalog, category and the processing settings of the active profile.</summary>
public sealed record CaptureContext(
    string LotId,
    string CatalogId,
    string Category,
    int LotNumber,
    string CatalogNumber,
    string? SessionId,
    /// <summary>JSON of the green-screen processing settings (opaque to the agent; validated by the server).</summary>
    string? ProcessingJson = null);

/// <summary>Maps a camera provider kind to the capture source value of the server contract.</summary>
public static class CaptureSources
{
    public static string For(string? cameraKind) => cameraKind switch
    {
        "SIMULATOR" => "SIMULATOR",
        "DIGICAM" => "DIGICAMCONTROL",
        _ => "CANON_EDSDK",
    };
}

public sealed record CaptureRequest(
    string CaptureId,
    CaptureContext Context,
    string? UserId,
    string? UserName,
    string? ControlToken);

public sealed class CaptureFile
{
    public required string CaptureId { get; init; }
    public required string Role { get; init; } // PRIMARY | RAW
    public required string Path { get; init; }
    public required string OriginalFilename { get; init; }
    public required string MimeType { get; init; }
    public required long SizeBytes { get; init; }
    public required string Sha256 { get; init; }
    public int? Width { get; init; }
    public int? Height { get; init; }
    public bool Uploaded { get; set; }
}

public sealed class CaptureRecord
{
    public required string CaptureId { get; init; }
    public required CaptureContext Context { get; init; }
    public string? UserId { get; init; }
    public string? UserName { get; init; }
    public string? ControlToken { get; init; }
    public bool External { get; init; }
    public string Source { get; init; } = "CANON_EDSDK";
    public string? CameraName { get; init; }
    public CaptureStage Stage { get; set; }
    public int Attempts { get; set; }
    public DateTimeOffset NextAttemptAt { get; set; }
    public string? LastError { get; set; }
    public string? AssetId { get; set; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? SavedAt { get; set; }
    public DateTimeOffset? VerifiedAt { get; set; }
    public List<CaptureFile> Files { get; init; } = [];
}

public sealed record CameraControl(
    string Id,
    string Label,
    string Type, // range | select | toggle | action
    object? Value,
    IReadOnlyList<ControlOption>? Options = null,
    double? Min = null,
    double? Max = null,
    double? Step = null,
    string? Display = null,
    bool ReadOnly = false);

public sealed record ControlOption(string Value, string Label);

public sealed record Readout(string Label, string Value);

public sealed class CameraStatus
{
    public string Kind { get; init; } = "NONE"; // CANON | DIGICAM | SIMULATOR | NONE
    public string? Model { get; init; }
    public bool Connected { get; init; }
    public bool Busy { get; init; }
    public int? Battery { get; init; }
    public bool LiveView { get; init; }
    public Resolution? Resolution { get; init; }
    public IReadOnlyList<string> Formats { get; init; } = [];
    public bool CanAutofocus { get; init; }
    public bool HardwareShutter { get; init; }
    public IReadOnlyList<CameraControl> Controls { get; init; } = [];
    public IReadOnlyList<Readout> Readouts { get; init; } = [];
    public string? LastError { get; init; }
}

public sealed record Resolution(int Width, int Height);

/// <summary>A file the camera handed over, already written to a staging path by the camera adapter.</summary>
public sealed record CameraFileReady(string StagingPath, string CameraFilename, long SizeBytes, int? Width = null, int? Height = null);
