using System.Security.Cryptography;

namespace AvotCapture.Core;

/// <summary>Crash-safe file finalisation: hash, flush to disk, atomic rename. Never overwrites.</summary>
public static class DurableFiles
{
    public static async Task<string> Sha256Async(string path, CancellationToken ct = default)
    {
        await using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, FileOptions.SequentialScan | FileOptions.Asynchronous);
        var hash = await SHA256.HashDataAsync(fs, ct);
        return Convert.ToHexStringLower(hash);
    }

    /// <summary>Forces the file's contents to stable storage (FlushFileBuffers).</summary>
    public static void Fsync(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read);
        fs.Flush(flushToDisk: true);
    }

    /// <summary>
    /// Moves a fully written staging file to its final location. Verifies size
    /// and hash before and after the move (a move inside one volume is a
    /// rename; across volumes it is a copy — both are re-verified).
    /// </summary>
    public static async Task<(string finalPath, string sha256, long size)> FinaliseAsync(string stagingPath, string finalPath, CancellationToken ct = default)
    {
        var info = new FileInfo(stagingPath);
        if (!info.Exists) throw new IOException($"Staging file missing: {stagingPath}");
        if (info.Length == 0) throw new IOException("הקובץ שהתקבל מהמצלמה ריק");
        Fsync(stagingPath);
        var sha = await Sha256Async(stagingPath, ct);

        Directory.CreateDirectory(Path.GetDirectoryName(finalPath)!);
        if (File.Exists(finalPath)) throw new IOException($"Refusing to overwrite existing original: {finalPath}");
        File.Move(stagingPath, finalPath, overwrite: false);

        var after = await Sha256Async(finalPath, ct);
        if (after != sha) throw new IOException("בדיקת השלמות נכשלה לאחר העברת הקובץ לתיקייה הקבועה");
        return (finalPath, sha, info.Length);
    }

    public static string SafeSegment(string input)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var cleaned = new string(input.Select(c => invalid.Contains(c) ? '_' : c).ToArray()).Trim().TrimEnd('.');
        return string.IsNullOrEmpty(cleaned) ? "_" : cleaned;
    }

    public static string MimeFor(string ext) => ext.ToLowerInvariant() switch
    {
        ".jpg" or ".jpeg" => "image/jpeg",
        ".cr3" => "image/x-canon-cr3",
        ".cr2" => "image/x-canon-cr2",
        ".dng" => "image/x-adobe-dng",
        ".heif" or ".hif" => "image/heif",
        ".tif" or ".tiff" => "image/tiff",
        _ => "application/octet-stream",
    };

    public static string RoleFor(string ext) => ext.ToLowerInvariant() is ".cr3" or ".cr2" or ".dng" ? "RAW" : "PRIMARY";
}
