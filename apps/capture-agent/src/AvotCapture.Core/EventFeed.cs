namespace AvotCapture.Core;

public sealed record AgentEvent(
    long Seq,
    string Type, // capture | camera
    string? CaptureId = null,
    string? Stage = null,
    string? LotId = null,
    string? Category = null,
    string? Error = null,
    bool External = false,
    bool HasThumb = false,
    string? AssetId = null);

/// <summary>Bounded, sequenced event log the browser polls (/v1/events?since=n).</summary>
public sealed class EventFeed
{
    private readonly LinkedList<AgentEvent> _events = new();
    private readonly Lock _gate = new();
    private long _seq;
    private const int Capacity = 2000;

    public long Cursor
    {
        get
        {
            lock (_gate) return _seq;
        }
    }

    public AgentEvent Publish(Func<long, AgentEvent> make)
    {
        lock (_gate)
        {
            var e = make(++_seq);
            _events.AddLast(e);
            while (_events.Count > Capacity) _events.RemoveFirst();
            return e;
        }
    }

    public (long cursor, List<AgentEvent> events) Since(long since)
    {
        lock (_gate)
        {
            if (since < 0) return (_seq, []);
            return (_seq, _events.Where(e => e.Seq > since).ToList());
        }
    }
}
