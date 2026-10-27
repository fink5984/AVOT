using System.Diagnostics;
using System.IO.Compression;
using AvotCapture.Core;

namespace AvotCapture.Agent;

public sealed record SdkInfo(bool Installed, string? Folder, string? Version, bool? Is64Bit, string? Problem);

public sealed record SdkImportResult(bool Ok, string Message, SdkInfo? Sdk);

/// <summary>
/// Canon EDSDK is proprietary: it is never downloaded or redistributed by this software. The worker downloads the
/// official ZIP from Canon's developer portal once, and this class validates it (Windows x64, EDSDK.dll + EdsImage.dll)
/// and unpacks it next to the station's data — outside the install folder, so program updates never need it again.
/// </summary>
public static class SdkImporter
{
    /// <summary>The version the station was specified and tested against; others are accepted with a warning.</summary>
    public const string ExpectedVersion = "13.20.21";

    public static string TargetFolder => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "AvotCapture", "EDSDK");

    /// <summary>Looks for an installed SDK in the places the camera adapter will look.</summary>
    public static SdkInfo Detect(AgentSettings settings)
    {
        foreach (var dir in new[] { settings.EdsdkPath, TargetFolder, Path.Combine(AppContext.BaseDirectory, "EDSDK"), AppContext.BaseDirectory })
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            var dll = Path.Combine(dir, "EDSDK.dll");
            if (!File.Exists(dll)) continue;
            var is64 = ReadMachine(dll) switch { 0x8664 => true, 0x014c => false, _ => (bool?)null };
            var version = FileVersion(dll);
            var problem = !File.Exists(Path.Combine(dir, "EdsImage.dll")) ? "EdsImage.dll חסר לצד EDSDK.dll"
                : is64 == false ? "זו חבילת 32 סיביות — נדרשת גרסת Windows x64"
                : null;
            return new SdkInfo(problem is null, dir, version, is64, problem);
        }
        return new SdkInfo(false, null, null, null, "Canon EDSDK לא מותקן בעמדה");
    }

    public static SdkImportResult Import(string zipPath, AgentSettings settings)
    {
        if (!File.Exists(zipPath)) return new SdkImportResult(false, "הקובץ לא נמצא", null);
        try
        {
            using var zip = ZipFile.OpenRead(zipPath);
            // every EDSDK.dll in the package; choose the 64-bit one
            var candidates = zip.Entries.Where(e => e.Name.Equals("EDSDK.dll", StringComparison.OrdinalIgnoreCase)).ToList();
            if (candidates.Count == 0) return new SdkImportResult(false, "זו אינה חבילת Canon EDSDK: הקובץ EDSDK.dll לא נמצא בתוכה.", null);
            var chosen = candidates.FirstOrDefault(e => MachineOf(e) == 0x8664);
            if (chosen is null) return new SdkImportResult(false, "החבילה אינה כוללת EDSDK.dll ל-Windows x64 (נמצאה גרסת 32 סיביות בלבד). הורידו את חבילת ה-Windows הנכונה מפורטל Canon.", null);

            var prefix = chosen.FullName[..^chosen.Name.Length]; // folder inside the zip that holds the DLL
            var siblings = zip.Entries.Where(e => e.FullName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && e.Name.Length > 0).ToList();
            if (!siblings.Any(e => e.Name.Equals("EdsImage.dll", StringComparison.OrdinalIgnoreCase)))
                return new SdkImportResult(false, "בחבילה חסר EdsImage.dll לצד EDSDK.dll.", null);

            var staging = TargetFolder + ".new";
            if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
            Directory.CreateDirectory(staging);
            var root = Path.GetFullPath(staging) + Path.DirectorySeparatorChar;
            foreach (var e in siblings)
            {
                var rel = e.FullName[prefix.Length..];
                var dest = Path.GetFullPath(Path.Combine(staging, rel));
                if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("נתיב לא חוקי בתוך החבילה"); // zip-slip guard
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                e.ExtractToFile(dest, overwrite: true);
            }

            var version = FileVersion(Path.Combine(staging, "EDSDK.dll"));
            if (Directory.Exists(TargetFolder)) Directory.Delete(TargetFolder, recursive: true);
            Directory.CreateDirectory(Path.GetDirectoryName(TargetFolder)!);
            Directory.Move(staging, TargetFolder);
            settings.EdsdkPath = TargetFolder;
            settings.Save();

            var warn = version is not null && !version.StartsWith("13.20", StringComparison.Ordinal)
                ? $" שימו לב: הגרסה שהותקנה ({version}) שונה מ-{ExpectedVersion}. ודאו בהערות הגרסה של Canon שהיא תומכת ב-EOS R7."
                : "";
            return new SdkImportResult(true, $"Canon EDSDK {version ?? ""} הותקן בהצלחה.{warn}", Detect(settings));
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException or UnauthorizedAccessException)
        {
            return new SdkImportResult(false, "ייבוא החבילה נכשל: " + ex.Message, null);
        }
    }

    private static string? FileVersion(string dll)
    {
        var v = FileVersionInfo.GetVersionInfo(dll);
        var s = v.FileVersion ?? v.ProductVersion;
        return s?.Replace(", ", ".").Trim();
    }

    /// <summary>PE "Machine" field: 0x8664 = x64, 0x014c = x86; null when the file is not a PE image.</summary>
    private static int? ReadMachine(string path)
    {
        using var fs = File.OpenRead(path);
        return MachineOf(fs);
    }

    private static int? MachineOf(ZipArchiveEntry e)
    {
        using var s = e.Open();
        using var ms = new MemoryStream();
        var buf = new byte[4096];
        // the PE header sits in the first few KB; do not unpack a whole DLL just to read it
        var read = s.Read(buf, 0, buf.Length);
        ms.Write(buf, 0, read);
        ms.Position = 0;
        return MachineOf(ms);
    }

    private static int? MachineOf(Stream s)
    {
        var br = new BinaryReader(s);
        if (s.Length < 0x40 || br.ReadUInt16() != 0x5A4D) return null; // "MZ"
        s.Position = 0x3C;
        var pe = br.ReadInt32();
        if (pe <= 0 || pe + 6 > s.Length) return null;
        s.Position = pe;
        if (br.ReadUInt32() != 0x00004550) return null; // "PE\0\0"
        return br.ReadUInt16();
    }
}
