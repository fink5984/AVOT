using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;

namespace AvotCapture.Core;

public sealed class CaptureRejectedException(string message, int status) : Exception(message)
{
    public int Status { get; } = status;
}

public sealed class CoordinatorOptions
{
    public required string StorageRoot { get; init; }
    /// <summary>Capture is refused when free space on the storage volume is below this.</summary>
    public long MinFreeBytes { get; init; } = 2L * 1024 * 1024 * 1024;
    public long WarnFreeBytes { get; init; } = 20L * 1024 * 1024 * 1024;
    /// <summary>How long to wait for all files of a shot (e.g. RAW after JPEG) before closing it.</summary>
    public TimeSpan ShotCompletionTimeout { get; init; } = TimeSpan.FromSeconds(20);
    public Func<string, long>? FreeSpaceProbe { get; init; }
}

/// <summary>
/// Turns shutter requests into durable, correctly-associated local captures.
///
/// Invariants:
///  1. The lot/catalog/category of a shot is frozen when the request arrives
///     (or, for the camera's own shutter button, when the file arrives) and
///     never re-read.
///  2. A shot is reported SAVED_LOCAL only after every file it produced is
///     fsync'ed, hashed and atomically renamed into the permanent folder, and
///     the database transaction recording it has committed.
///  3. Files are matched to requests in shutter order (FIFO); one shutter
///     release may yield several files (RAW+JPEG) which form one shot.
///  4. A capture id is processed once; repeating a request is idempotent.
/// </summary>
public sealed class CaptureCoordinator : IDisposable
{
    private readonly LocalStore _store;
    private readonly EventFeed _feed;
    private readonly CoordinatorOptions _opt;
    private readonly ILogger _log;
    private readonly ConcurrentQueue<PendingShot> _pending = new();
    private readonly SemaphoreSlim _shutterGate = new(1, 1);
    private readonly SemaphoreSlim _fileGate = new(1, 1);
    private readonly Timer _sweeper;
    private ICameraDevice? _camera;
    private volatile CaptureContext? _active;
    private (string? userId, string? userName, string? token) _activeUser;
    private TaskCompletionSource<string>? _testShot;
    private long _testWindowUntilTicks;
    private int _testExtraFiles;

    private sealed class PendingShot
    {
        public required string CaptureId { get; init; }
        public required int ExpectedFiles { get; init; }
        public int ReceivedFiles;
        public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;
        public HashSet<string> Roles { get; } = [];
    }

    public CaptureCoordinator(LocalStore store, EventFeed feed, CoordinatorOptions options, ILogger logger)
    {
        _store = store;
        _feed = feed;
        _opt = options;
        _log = logger;
        Directory.CreateDirectory(StagingDir);
        _sweeper = new Timer(_ => SweepTimedOut(), null, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));
    }

    public string StagingDir => Path.Combine(_opt.StorageRoot, ".staging");
    public CaptureContext? ActiveContext => _active;

    /// <summary>True while a shot is being received from the camera (the station must not restart or update meanwhile).</summary>
    public bool HasShotInProgress => !_pending.IsEmpty || (Directory.Exists(StagingDir) && Directory.EnumerateFiles(StagingDir).Any());

    /// <summary>
    /// Fires one test shot through <paramref name="trigger"/>. The resulting file(s) are kept under
    /// &lt;storage&gt;	est-shots and are never associated with a book, never queued for upload.
    /// </summary>
    public async Task<string> TestShotAsync(Func<CancellationToken, Task> trigger, TimeSpan timeout, CancellationToken ct)
    {
        if (!_pending.IsEmpty) throw new CaptureRejectedException("צילום אחר בתהליך — המתינו לסיומו", 409);
        var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (Interlocked.CompareExchange(ref _testShot, tcs, null) is not null) throw new CaptureRejectedException("צילום ניסיון כבר מתבצע", 409);
        try
        {
            await trigger(ct);
            var path = await tcs.Task.WaitAsync(timeout, ct);
            // a RAW+JPEG shot delivers a second file a moment later: it belongs to the test as well
            Interlocked.Exchange(ref _testExtraFiles, Math.Max(0, (_camera?.FilesPerShot ?? 1) - 1));
            Interlocked.Exchange(ref _testWindowUntilTicks, DateTime.UtcNow.AddSeconds(8).Ticks);
            return path;
        }
        catch (TimeoutException)
        {
            throw new CameraException("המצלמה לא החזירה תמונה. בדקו שהיא במצב צילום ושהכרטיס/המיקוד תקינים.");
        }
        finally
        {
            Interlocked.Exchange(ref _testShot, null);
        }
    }

    private bool TryTakeAsTestFile(CameraFileReady file)
    {
        var waiting = Volatile.Read(ref _testShot);
        if (waiting is null)
        {
            // only the remaining file(s) of the SAME test shot (e.g. the JPEG after the RAW) — never a real shot's file
            if (!_pending.IsEmpty || DateTime.UtcNow.Ticks > Interlocked.Read(ref _testWindowUntilTicks) || Volatile.Read(ref _testExtraFiles) <= 0) return false;
            Interlocked.Decrement(ref _testExtraFiles);
        }
        var dir = Path.Combine(_opt.StorageRoot, "test-shots");
        Directory.CreateDirectory(dir);
        var dest = Path.Combine(dir, $"test-{DateTime.Now:yyyyMMdd-HHmmss-fff}{Path.GetExtension(file.CameraFilename).ToLowerInvariant()}");
        File.Move(file.StagingPath, dest, overwrite: true);
        waiting?.TrySetResult(dest);
        return true;
    }

    public event Action<string>? CaptureSaved;

    public void AttachCamera(ICameraDevice? camera)
    {
        if (_camera is not null) _camera.FileReady -= OnFileReady;
        _camera = camera;
        if (camera is not null) camera.FileReady += OnFileReady;
    }

    /// <summary>Context for shots from the camera's own shutter button.</summary>
    public void SetActiveContext(CaptureContext ctx, string? userId, string? userName, string? token)
    {
        _active = ctx;
        _activeUser = (userId, userName, token);
    }

    public long FreeBytes() => _opt.FreeSpaceProbe?.Invoke(_opt.StorageRoot) ?? new DriveInfo(Path.GetPathRoot(Path.GetFullPath(_opt.StorageRoot))!).AvailableFreeSpace;

    public string DiskLevel()
    {
        var free = FreeBytes();
        return free < _opt.MinFreeBytes ? "critical" : free < _opt.WarnFreeBytes ? "low" : "ok";
    }

    /// <summary>Fires the shutter for a browser request. Returns once the camera accepted the command.</summary>
    public async Task<CaptureRecord> RequestCaptureAsync(CaptureRequest req, CancellationToken ct)
    {
        if (!Categories.IsValid(req.Context.Category)) throw new CaptureRejectedException("קטגוריה לא תקינה", 400);
        var existing = _store.Get(req.CaptureId);
        if (existing is not null) return existing; // idempotent retry

        var camera = _camera ?? throw new CaptureRejectedException("לא מחוברת מצלמה לעמדה", 503);
        if (!camera.GetStatus().Connected) throw new CaptureRejectedException("המצלמה מנותקת", 503);
        if (FreeBytes() < _opt.MinFreeBytes)
            throw new CaptureRejectedException("אין מספיק מקום פנוי בדיסק של העמדה — הצילום נחסם כדי לא לאבד תמונות", 507);

        // one shutter at a time keeps the FIFO pairing of files to requests exact
        if (!await _shutterGate.WaitAsync(TimeSpan.FromSeconds(10), ct))
            throw new CaptureRejectedException("המצלמה עסוקה בצילום הקודם", 409);
        try
        {
            var record = new CaptureRecord
            {
                CaptureId = req.CaptureId,
                Context = req.Context,
                UserId = req.UserId,
                UserName = req.UserName,
                ControlToken = req.ControlToken,
                Source = CaptureSources.For(camera.Kind),
                CameraName = camera.GetStatus().Model,
                Stage = CaptureStage.CAPTURING,
                CreatedAt = DateTimeOffset.UtcNow,
                NextAttemptAt = DateTimeOffset.MaxValue,
            };
            _store.Insert(record);
            Publish(record.CaptureId, CaptureStage.CAPTURING, record.Context);
            var pending = new PendingShot { CaptureId = record.CaptureId, ExpectedFiles = Math.Max(1, camera.FilesPerShot) };
            _pending.Enqueue(pending);
            try
            {
                await camera.TriggerShutterAsync(ct);
            }
            catch (Exception ex)
            {
                RemovePending(pending);
                _store.Update(record.CaptureId, CaptureStage.FAILED, ex.Message);
                Publish(record.CaptureId, CaptureStage.FAILED, record.Context, ex.Message);
                _log.LogWarning(ex, "shutter failed for {CaptureId}", record.CaptureId);
                throw new CaptureRejectedException(ex is CameraException ? ex.Message : "המצלמה לא ביצעה את הצילום", 502);
            }
            return record;
        }
        finally
        {
            _shutterGate.Release();
        }
    }

    private void RemovePending(PendingShot shot)
    {
        var keep = _pending.Where(p => p != shot).ToList();
        _pending.Clear();
        foreach (var p in keep) _pending.Enqueue(p);
    }

    private void OnFileReady(CameraFileReady file) => _ = HandleFileAsync(file);

    internal async Task HandleFileAsync(CameraFileReady file)
    {
        await _fileGate.WaitAsync();
        try
        {
            if (TryTakeAsTestFile(file)) return;
            var ext = Path.GetExtension(file.CameraFilename);
            var role = DurableFiles.RoleFor(ext);
            PendingShot? shot = null;
            while (_pending.TryPeek(out var head))
            {
                if (!head.Roles.Contains(role))
                {
                    shot = head;
                    break;
                }
                // the head already holds a file of this role, so this file belongs to the next
                // shutter release: the head produced fewer files than expected — close it as is
                _pending.TryDequeue(out _);
                CompletePartial(head);
            }

            CaptureRecord record;
            if (shot is null)
            {
                var external = CreateExternalCapture();
                if (external is null)
                {
                    QuarantineOrphan(file, "קובץ ממצלמה ללא פריט פעיל");
                    return;
                }
                record = external;
                shot = new PendingShot { CaptureId = record.CaptureId, ExpectedFiles = Math.Max(1, _camera?.FilesPerShot ?? 1) };
                _pending.Enqueue(shot);
            }
            else
            {
                record = _store.Get(shot.CaptureId)!;
            }

            var ctx = record.Context;
            var dir = Path.Combine(
                _opt.StorageRoot,
                $"Catalog-{DurableFiles.SafeSegment(ctx.CatalogNumber)}",
                $"Lot-{ctx.LotNumber:000}",
                Categories.Slug[ctx.Category]);
            var finalName = $"{DateTime.Now:yyyyMMdd-HHmmss}_{record.CaptureId[..8]}_{role.ToLowerInvariant()}{ext.ToLowerInvariant()}";
            var (finalPath, sha, size) = await DurableFiles.FinaliseAsync(file.StagingPath, Path.Combine(dir, finalName));

            shot.Roles.Add(role);
            shot.ReceivedFiles++;
            var complete = shot.ReceivedFiles >= shot.ExpectedFiles;
            _store.AddFile(
                new CaptureFile
                {
                    CaptureId = record.CaptureId,
                    Role = role,
                    Path = finalPath,
                    OriginalFilename = file.CameraFilename,
                    MimeType = DurableFiles.MimeFor(ext),
                    SizeBytes = size,
                    Sha256 = sha,
                    Width = file.Width,
                    Height = file.Height,
                },
                completesCapture: complete);
            if (complete)
            {
                _pending.TryDequeue(out _);
                Publish(record.CaptureId, CaptureStage.SAVED_LOCAL, ctx, external: record.External, hasThumb: shot.Roles.Contains("PRIMARY"));
                CaptureSaved?.Invoke(record.CaptureId);
            }
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "failed to persist camera file {File}", file.CameraFilename);
            QuarantineOrphan(file, ex.Message);
            if (_pending.TryDequeue(out var failed))
            {
                _store.Update(failed.CaptureId, CaptureStage.NEEDS_ATTENTION, "שמירת הקובץ נכשלה: " + ex.Message);
                Publish(failed.CaptureId, CaptureStage.NEEDS_ATTENTION, null, ex.Message);
            }
        }
        finally
        {
            _fileGate.Release();
        }
    }

    private CaptureRecord? CreateExternalCapture()
    {
        var ctx = _active;
        if (ctx is null) return null;
        var record = new CaptureRecord
        {
            CaptureId = Guid.NewGuid().ToString(),
            Context = ctx,
            UserId = _activeUser.userId,
            UserName = _activeUser.userName,
            ControlToken = _activeUser.token,
            External = true,
            Source = CaptureSources.For(_camera?.Kind),
            CameraName = _camera?.GetStatus().Model,
            Stage = CaptureStage.CAPTURING,
            CreatedAt = DateTimeOffset.UtcNow,
            NextAttemptAt = DateTimeOffset.MaxValue,
        };
        _store.Insert(record);
        Publish(record.CaptureId, CaptureStage.CAPTURING, ctx, external: true);
        return record;
    }

    /// <summary>Never deletes an unassignable original: it is moved aside for a human to review.</summary>
    private void QuarantineOrphan(CameraFileReady file, string reason)
    {
        try
        {
            if (!File.Exists(file.StagingPath)) return;
            var dir = Path.Combine(_opt.StorageRoot, "_unassigned");
            Directory.CreateDirectory(dir);
            var target = Path.Combine(dir, $"{DateTime.Now:yyyyMMdd-HHmmss}_{Path.GetFileName(file.CameraFilename)}");
            File.Move(file.StagingPath, target, overwrite: false);
            File.WriteAllText(target + ".txt", reason);
            _log.LogWarning("orphan camera file kept at {Path}: {Reason}", target, reason);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "could not quarantine {File}", file.StagingPath);
        }
    }

    /// <summary>Closes shots whose remaining files never arrived (e.g. RAW disabled mid-session).</summary>
    private void SweepTimedOut()
    {
        if (!_pending.TryPeek(out var head)) return;
        if (DateTimeOffset.UtcNow - head.StartedAt < _opt.ShotCompletionTimeout) return;
        if (!_fileGate.Wait(0)) return;
        try
        {
            if (!_pending.TryPeek(out head) || DateTimeOffset.UtcNow - head.StartedAt < _opt.ShotCompletionTimeout) return;
            _pending.TryDequeue(out _);
            CompletePartial(head);
        }
        finally
        {
            _fileGate.Release();
        }
    }

    /// <summary>Closes a shot with the files it has (SAVED_LOCAL), or as FAILED when none arrived.</summary>
    private void CompletePartial(PendingShot shot)
    {
        var rec = _store.Get(shot.CaptureId);
        if (rec is null) return;
        if (shot.ReceivedFiles > 0)
        {
            _store.Update(rec.CaptureId, CaptureStage.SAVED_LOCAL);
            Publish(rec.CaptureId, CaptureStage.SAVED_LOCAL, rec.Context, external: rec.External, hasThumb: shot.Roles.Contains("PRIMARY"));
            CaptureSaved?.Invoke(rec.CaptureId);
        }
        else
        {
            const string msg = "לא התקבל קובץ מהמצלמה. ייתכן שהמצלמה לא הצליחה למקד או שהכרטיס/החיבור עסוק.";
            _store.Update(rec.CaptureId, CaptureStage.FAILED, msg);
            Publish(rec.CaptureId, CaptureStage.FAILED, rec.Context, msg);
        }
    }

    /// <summary>
    /// Startup recovery after a crash / power loss: captures stuck in CAPTURING are
    /// resolved from what is on disk; staging leftovers are moved aside, never deleted.
    /// </summary>
    public void RecoverAfterRestart()
    {
        foreach (var rec in _store.WithStage(CaptureStage.CAPTURING))
        {
            if (rec.Files.Count > 0 && rec.Files.All(f => File.Exists(f.Path))) _store.Update(rec.CaptureId, CaptureStage.SAVED_LOCAL);
            else _store.Update(rec.CaptureId, CaptureStage.FAILED, "התוכנה נסגרה לפני שהקובץ התקבל מהמצלמה");
        }
        foreach (var rec in _store.WithStage(CaptureStage.UPLOADING)) _store.Update(rec.CaptureId, CaptureStage.QUEUED, nextAttempt: DateTimeOffset.UtcNow);
        foreach (var leftover in Directory.EnumerateFiles(StagingDir))
        {
            QuarantineOrphan(new CameraFileReady(leftover, Path.GetFileName(leftover), new FileInfo(leftover).Length), "נמצא בתיקיית ההמתנה לאחר הפעלה מחדש");
        }
    }

    public string NewStagingPath(string cameraFilename) =>
        Path.Combine(StagingDir, $"{Guid.NewGuid():N}{Path.GetExtension(cameraFilename).ToLowerInvariant()}.part");

    private void Publish(string captureId, CaptureStage stage, CaptureContext? ctx, string? error = null, bool external = false, bool hasThumb = false) =>
        _feed.Publish(seq => new AgentEvent(seq, "capture", captureId, stage.ToString(), ctx?.LotId, ctx?.Category, error, external, hasThumb));

    public void Dispose()
    {
        _sweeper.Dispose();
        AttachCamera(null);
    }
}
