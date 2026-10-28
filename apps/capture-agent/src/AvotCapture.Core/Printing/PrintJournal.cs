using System.Text.Json;
using System.Text.Json.Serialization;

namespace AvotCapture.Core;

/// <summary>What to do with a print job that the server hands to the station.</summary>
public enum PrintDecision
{
    /// <summary>Never seen: print it.</summary>
    Print,
    /// <summary>Already written to the printer / spooler by an earlier run: only the report to the server was missing. NEVER print again.</summary>
    ReportSentOnly,
    /// <summary>The station stopped in the middle of sending: the label may or may not exist. Do not guess — fail it so a person decides.</summary>
    FailUncertain,
    /// <summary>A previous attempt failed before anything reached the printer: safe to try again.</summary>
    Retry,
}

/// <summary>
/// The station's durable memory of what it already sent to the printer. It is what prevents duplicate labels after a
/// crash, a restart or a re-delivered job: exactly-once cannot be promised by a printer, so the rule is "never resend
/// blindly". Written atomically; survives app updates (lives in the data folder).
/// </summary>
public sealed class PrintJournal
{
    public sealed record Entry([property: JsonPropertyName("state")] string State, [property: JsonPropertyName("at")] DateTimeOffset At, [property: JsonPropertyName("error")] string? Error = null);

    private readonly string _path;
    private readonly Lock _gate = new();
    private Dictionary<string, Entry> _entries;
    private static readonly JsonSerializerOptions Opts = new() { WriteIndented = false };

    public PrintJournal(string path)
    {
        _path = path;
        _entries = Load(path);
    }

    private static Dictionary<string, Entry> Load(string path)
    {
        try
        {
            return File.Exists(path) ? JsonSerializer.Deserialize<Dictionary<string, Entry>>(File.ReadAllText(path)) ?? [] : [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    public Entry? Get(string jobId)
    {
        lock (_gate) return _entries.GetValueOrDefault(jobId);
    }

    public IReadOnlyList<(string JobId, Entry Entry)> Recent(int take = 20)
    {
        lock (_gate) return _entries.OrderByDescending(e => e.Value.At).Take(take).Select(e => (e.Key, e.Value)).ToList();
    }

    public PrintDecision Decide(string jobId) => Get(jobId)?.State switch
    {
        "sent" => PrintDecision.ReportSentOnly,
        "sending" => PrintDecision.FailUncertain,
        "failed" => PrintDecision.Retry,
        _ => PrintDecision.Print,
    };

    public void Mark(string jobId, string state, string? error = null)
    {
        lock (_gate)
        {
            _entries[jobId] = new Entry(state, DateTimeOffset.UtcNow, error);
            if (_entries.Count > 500)
                foreach (var k in _entries.OrderBy(e => e.Value.At).Take(_entries.Count - 500).Select(e => e.Key).ToList()) _entries.Remove(k);
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(_path))!);
            var tmp = _path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(_entries, Opts));
            File.Move(tmp, _path, overwrite: true);
        }
    }
}
