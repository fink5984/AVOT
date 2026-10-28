using System.Text;
using System.Text.Json;
using AvotCapture.Core;
using Microsoft.Extensions.Logging;

namespace AvotCapture.Agent;

/// <summary>
/// The label-printing service of AVOT Capture Desktop. It runs in this process but is INDEPENDENT of the camera:
/// its own loop, its own error handling, its own durable journal. A disconnected camera does not stop it; a printer
/// error never reaches the capture engine; closing the management window stops neither.
///
///   server ──(outbound HTTPS, station credentials)──▶ claim → draw/format → Windows spooler / printer → report
///
/// Status vocabulary (server side): PENDING (server has it) → CLAIMED (this station has it) → SENT (handed to the spooler
/// or printer) → DONE only when a printer confirms (not available through the Windows spooler — so it stays SENT, honestly).
/// </summary>
public sealed class PrintService : IDisposable
{
    public sealed record LocalJob(string JobId, string State, DateTimeOffset At, string? Error);

    private readonly AgentHost _host;
    private readonly ILogger _log;
    private readonly PrintJournal _journal;
    private readonly CancellationTokenSource _cts = new();
    private readonly SemaphoreSlim _wake = new(0, 1);
    private Task? _loop;
    private DateTimeOffset _lastBeat = DateTimeOffset.MinValue;

    public string Status { get; private set; } = "שירות ההדפסה לא הופעל";
    public string? PrinterState { get; private set; }
    public string? PrinterDetail { get; private set; }
    public PrintQueueInfo Queue { get; private set; } = new(0, 0);
    public DateTimeOffset? LastJobAt { get; private set; }
    public event Action? Changed;

    public PrintService(AgentHost host, ILogger log)
    {
        _host = host;
        _log = log;
        _journal = new PrintJournal(Path.Combine(AgentSettings.Folder, "print-journal.json"));
    }

    public IReadOnlyList<LocalJob> RecentJobs() => _journal.Recent(12).Select(r => new LocalJob(r.JobId, r.Entry.State, r.Entry.At, r.Entry.Error)).ToList();

    public void Start() => _loop ??= Task.Run(() => RunAsync(_cts.Token));

    /// <summary>Retry right now (after "חיבור מחדש" or a settings change).</summary>
    public void Poke()
    {
        _lastBeat = DateTimeOffset.MinValue;
        try { _wake.Release(); } catch (SemaphoreFullException) { /* already pending */ }
    }

    private async Task RunAsync(CancellationToken ct)
    {
        var delay = 1500;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var worked = await StepAsync(ct);
                delay = worked ? 150 : 1500;
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                // nothing that goes wrong here may leave this loop — printing must survive every error
                Status = "שגיאה בשירות ההדפסה: " + ex.Message;
                _log.LogError(ex, "print loop");
                Changed?.Invoke();
                delay = Math.Min(delay * 2, 20_000);
            }
            try { await _wake.WaitAsync(TimeSpan.FromMilliseconds(delay), ct); } catch (OperationCanceledException) { break; }
        }
    }

    private async Task<bool> StepAsync(CancellationToken ct)
    {
        var s = _host.Settings;
        var client = _host.ServerClientOrNull;
        if (client is null) { Status = "העמדה אינה מצומדת — אין הדפסה"; return false; }
        if (!s.PrintEnabled) { Status = "ההדפסה כבויה בהגדרות העמדה"; return false; }

        if (DateTimeOffset.UtcNow - _lastBeat > TimeSpan.FromSeconds(15))
        {
            await HeartbeatAsync(client, ct);
            _lastBeat = DateTimeOffset.UtcNow;
        }
        var claim = await client.PostAsync<PrintClaimResponse>("api/print/agent/claim", new { }, ct);
        if (claim.Job is null)
        {
            Status = PrinterState is null or "OK" ? "מוכן — אין משימות" : $"מחובר לשרת · המדפסת: {PrinterDetail ?? PrinterState}";
            Changed?.Invoke();
            return false;
        }
        await ProcessAsync(client, claim.Job, ct);
        return true;
    }

    private async Task HeartbeatAsync(ServerClient client, CancellationToken ct)
    {
        var printers = new List<object>();
        var name = _host.Settings.PrinterWindowsName;
        var id = _host.Settings.PrinterId;
        if (!string.IsNullOrEmpty(name) && !string.IsNullOrEmpty(id))
        {
            var (state, detail) = WindowsPrinting.StateOf(name);
            PrinterState = state;
            PrinterDetail = detail;
            printers.Add(new { printerId = id, state, detail });
        }
        var hello = await client.PostAsync<PrintHeartbeatResponse>("api/print/agent/heartbeat", new { agentVersion = AgentHost.Version, machineName = Environment.MachineName, printers }, ct);
        if (hello.Queue is not null) Queue = hello.Queue;
        Changed?.Invoke();
    }

    /// <summary>One job, end to end. Never prints the same job twice.</summary>
    private async Task ProcessAsync(ServerClient client, ClaimedPrintJob job, CancellationToken ct)
    {
        switch (_journal.Decide(job.JobId))
        {
            case PrintDecision.ReportSentOnly:
                _log.LogInformation("print job {Job} was already sent — reporting only", job.JobId);
                await ReportAsync(client, job.JobId, "SENT", null, ct);
                return;
            case PrintDecision.FailUncertain:
                _journal.Mark(job.JobId, "failed", "uncertain");
                await ReportAsync(client, job.JobId, "FAILED", "העמדה הופסקה באמצע ההדפסה. בדקו אם התווית יצאה והדפיסו מחדש במידת הצורך.", ct);
                return;
        }
        _journal.Mark(job.JobId, "sending");
        try
        {
            Status = $"מדפיס {job.LabelCount} תוויות…";
            Changed?.Invoke();
            Deliver(job);
        }
        catch (Exception ex) when (ex is PrintException or InvalidOperationException or IOException)
        {
            _journal.Mark(job.JobId, "failed", ex.Message);
            _log.LogWarning("print job {Job} failed: {Message}", job.JobId, ex.Message);
            Status = "ההדפסה נכשלה: " + ex.Message;
            await ReportAsync(client, job.JobId, "FAILED", ex.Message, ct);
            Changed?.Invoke();
            return;
        }
        _journal.Mark(job.JobId, "sent");
        LastJobAt = DateTimeOffset.UtcNow;
        Status = $"הועברו למדפסת {job.LabelCount} תוויות";
        await ReportAsync(client, job.JobId, "SENT", null, ct);
        Changed?.Invoke();
    }

    private static void Deliver(ClaimedPrintJob job)
    {
        var p = job.Printer;
        if (job.Format == "GDI")
        {
            if (job.Labels is null || p.WindowsName is null) throw new PrintException("המשימה אינה כוללת תוויות או שם מדפסת Windows");
            WindowsPrinting.PrintLabels(p.WindowsName, job.Stock, job.Copies, job.Labels);
            return;
        }
        var bytes = Encoding.UTF8.GetBytes(job.Zpl ?? throw new PrintException("המשימה אינה כוללת תוכן להדפסה"));
        if (p.Connection == "NETWORK" && p.Host is not null) WindowsPrinting.SendTcp(p.Host, p.Port, bytes);
        else WindowsPrinting.SendRaw(p.WindowsName ?? throw new PrintException("לא הוגדרה מדפסת Windows"), bytes);
    }

    private async Task ReportAsync(ServerClient client, string jobId, string status, string? error, CancellationToken ct)
    {
        for (var attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                await client.PostAsync<JsonElement>($"api/print/agent/jobs/{jobId}/report", new { status, error }, ct);
                return;
            }
            catch (ServerException ex) when (ex.Permanent) { return; }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                await Task.Delay(1000 * (attempt + 1), ct);
            }
        }
        _log.LogError("could not report print job {Job} ({Status})", jobId, status);
    }

    /// <summary>"בוחרים את המדפסת מתוך המדפסות הזמינות ב-Windows": registers it with the server as the primary label printer.</summary>
    public async Task ConfigureAsync(string windowsName, string labelSize, string language, CancellationToken ct)
    {
        var client = _host.ServerClientOrNull ?? throw new InvalidOperationException("העמדה אינה מצומדת");
        var r = await client.PostAsync<AgentPrinterResponse>("api/print/agent/printers", new { windowsName, name = windowsName, labelSize, language, primary = true }, ct);
        var s = _host.Settings;
        s.PrinterId = r.Printer.Id;
        s.PrinterWindowsName = windowsName;
        s.PrinterLabelSize = labelSize;
        s.PrinterLanguage = language;
        s.PrintEnabled = true;
        s.Save();
        Poke();
    }

    /// <summary>Test label through exactly the same queue and path as every other job.</summary>
    public async Task TestPrintAsync(CancellationToken ct)
    {
        var client = _host.ServerClientOrNull ?? throw new InvalidOperationException("העמדה אינה מצומדת");
        var id = _host.Settings.PrinterId ?? throw new InvalidOperationException("קודם בוחרים מדפסת");
        await client.PostAsync<IdResponse>("api/print/agent/test", new { printerId = id }, ct);
        Poke();
    }

    public void Dispose() => _cts.Cancel();
}
