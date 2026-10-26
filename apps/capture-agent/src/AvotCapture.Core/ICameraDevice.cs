namespace AvotCapture.Core;

/// <summary>
/// Camera provider interface. Implemented by the Canon EDSDK adapter, the
/// digiCamControl adapter and the simulator; the coordinator, storage, sync and
/// local API never depend on a specific provider, so the implementation behind
/// the capture screen can be swapped without touching the UI.
/// </summary>
public interface ICameraDevice : IAsyncDisposable
{
    string Kind { get; } // CANON | DIGICAM | SIMULATOR

    /// <summary>Opens the session. Throws <see cref="CameraException"/> with a user-facing Hebrew message.</summary>
    Task ConnectAsync(CancellationToken ct);
    Task DisconnectAsync();
    CameraStatus GetStatus();

    /// <summary>Fires the shutter. Completes when the camera accepted the command, not when the file arrives.</summary>
    Task TriggerShutterAsync(CancellationToken ct);

    /// <summary>How many files one shutter release produces with the current settings (2 for RAW+JPEG).</summary>
    int FilesPerShot { get; }

    Task SetControlAsync(string id, string value, CancellationToken ct);
    Task AutofocusAsync(CancellationToken ct);

    /// <summary>Latest live view frame as JPEG, or null if live view is not running.</summary>
    byte[]? LatestLiveViewFrame { get; }
    Task StartLiveViewAsync(CancellationToken ct);
    Task StopLiveViewAsync();

    /// <summary>Raised (on any thread) when a file from the camera is fully written to its staging path.</summary>
    event Action<CameraFileReady>? FileReady;

    /// <summary>Raised when the camera disconnects, shuts down or reports a fatal error.</summary>
    event Action<string>? Disconnected;

    event Action? StatusChanged;
}

public sealed class CameraException(string message, Exception? inner = null) : Exception(message, inner);
