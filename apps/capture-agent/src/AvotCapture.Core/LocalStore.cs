using System.Globalization;
using Microsoft.Data.Sqlite;

namespace AvotCapture.Core;

/// <summary>
/// Durable local record of every capture and its files (SQLite, WAL,
/// synchronous=FULL). The upload queue is derived from this table, so it
/// survives crashes, power loss and reboots.
/// </summary>
public sealed class LocalStore : IDisposable
{
    private readonly SqliteConnection _db;
    private readonly Lock _gate = new();

    public LocalStore(string dbPath)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(dbPath)!);
        _db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = dbPath, Pooling = false }.ToString());
        _db.Open();
        Exec("PRAGMA journal_mode=WAL;");
        Exec("PRAGMA synchronous=FULL;");
        Exec("""
            CREATE TABLE IF NOT EXISTS captures (
              capture_id TEXT PRIMARY KEY,
              lot_id TEXT NOT NULL, catalog_id TEXT NOT NULL, category TEXT NOT NULL,
              lot_number INTEGER NOT NULL, catalog_number TEXT NOT NULL, session_id TEXT,
              user_id TEXT, user_name TEXT, control_token TEXT,
              external INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, camera_name TEXT,
              stage TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
              last_error TEXT, asset_id TEXT,
              created_at TEXT NOT NULL, saved_at TEXT, verified_at TEXT
            );
            CREATE INDEX IF NOT EXISTS ix_captures_stage ON captures(stage, next_attempt_at);
            CREATE TABLE IF NOT EXISTS files (
              capture_id TEXT NOT NULL REFERENCES captures(capture_id),
              role TEXT NOT NULL, path TEXT NOT NULL, original_filename TEXT NOT NULL,
              mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
              width INTEGER, height INTEGER, uploaded INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (capture_id, role)
            );
            """);
    }

    private void Exec(string sql)
    {
        using var cmd = _db.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private static string Ts(DateTimeOffset t) => t.UtcDateTime.ToString("O", CultureInfo.InvariantCulture);
    private static DateTimeOffset? ParseTs(object v) => v is string s ? DateTimeOffset.Parse(s, CultureInfo.InvariantCulture) : null;

    public void Insert(CaptureRecord r)
    {
        lock (_gate)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = """
                INSERT INTO captures (capture_id, lot_id, catalog_id, category, lot_number, catalog_number, session_id,
                  user_id, user_name, control_token, external, source, camera_name, stage, attempts, next_attempt_at, created_at)
                VALUES ($id, $lot, $cat, $category, $lotNo, $catNo, $session, $user, $userName, $token, $ext, $source, $camera, $stage, 0, $next, $created)
                """;
            cmd.Parameters.AddWithValue("$id", r.CaptureId);
            cmd.Parameters.AddWithValue("$lot", r.Context.LotId);
            cmd.Parameters.AddWithValue("$cat", r.Context.CatalogId);
            cmd.Parameters.AddWithValue("$category", r.Context.Category);
            cmd.Parameters.AddWithValue("$lotNo", r.Context.LotNumber);
            cmd.Parameters.AddWithValue("$catNo", r.Context.CatalogNumber);
            cmd.Parameters.AddWithValue("$session", (object?)r.Context.SessionId ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$user", (object?)r.UserId ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$userName", (object?)r.UserName ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$token", (object?)r.ControlToken ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$ext", r.External ? 1 : 0);
            cmd.Parameters.AddWithValue("$source", r.Source);
            cmd.Parameters.AddWithValue("$camera", (object?)r.CameraName ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$stage", r.Stage.ToString());
            cmd.Parameters.AddWithValue("$next", Ts(r.NextAttemptAt));
            cmd.Parameters.AddWithValue("$created", Ts(r.CreatedAt));
            cmd.ExecuteNonQuery();
        }
    }

    /// <summary>Adds a finalised file and (optionally) moves the capture to SAVED_LOCAL in one transaction.</summary>
    public void AddFile(CaptureFile f, bool completesCapture)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            using (var cmd = _db.CreateCommand())
            {
                cmd.Transaction = tx;
                cmd.CommandText = """
                    INSERT INTO files (capture_id, role, path, original_filename, mime, size, sha256, width, height)
                    VALUES ($id, $role, $path, $name, $mime, $size, $sha, $w, $h)
                    """;
                cmd.Parameters.AddWithValue("$id", f.CaptureId);
                cmd.Parameters.AddWithValue("$role", f.Role);
                cmd.Parameters.AddWithValue("$path", f.Path);
                cmd.Parameters.AddWithValue("$name", f.OriginalFilename);
                cmd.Parameters.AddWithValue("$mime", f.MimeType);
                cmd.Parameters.AddWithValue("$size", f.SizeBytes);
                cmd.Parameters.AddWithValue("$sha", f.Sha256);
                cmd.Parameters.AddWithValue("$w", (object?)f.Width ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$h", (object?)f.Height ?? DBNull.Value);
                cmd.ExecuteNonQuery();
            }
            if (completesCapture)
            {
                using var up = _db.CreateCommand();
                up.Transaction = tx;
                up.CommandText = "UPDATE captures SET stage='SAVED_LOCAL', saved_at=$t, next_attempt_at=$t WHERE capture_id=$id";
                up.Parameters.AddWithValue("$t", Ts(DateTimeOffset.UtcNow));
                up.Parameters.AddWithValue("$id", f.CaptureId);
                up.ExecuteNonQuery();
            }
            tx.Commit();
        }
    }

    public void Update(string captureId, CaptureStage stage, string? error = null, int? attempts = null, DateTimeOffset? nextAttempt = null, string? assetId = null)
    {
        lock (_gate)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = """
                UPDATE captures SET stage=$stage, last_error=$err,
                  attempts=COALESCE($attempts, attempts), next_attempt_at=COALESCE($next, next_attempt_at),
                  asset_id=COALESCE($asset, asset_id),
                  verified_at=CASE WHEN $stage='VERIFIED' THEN $now ELSE verified_at END,
                  saved_at=CASE WHEN $stage='SAVED_LOCAL' AND saved_at IS NULL THEN $now ELSE saved_at END
                WHERE capture_id=$id
                """;
            cmd.Parameters.AddWithValue("$stage", stage.ToString());
            cmd.Parameters.AddWithValue("$err", (object?)error ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$attempts", (object?)attempts ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$next", nextAttempt is null ? DBNull.Value : Ts(nextAttempt.Value));
            cmd.Parameters.AddWithValue("$asset", (object?)assetId ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$now", Ts(DateTimeOffset.UtcNow));
            cmd.Parameters.AddWithValue("$id", captureId);
            cmd.ExecuteNonQuery();
        }
    }

    public void MarkFileUploaded(string captureId, string role)
    {
        lock (_gate)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = "UPDATE files SET uploaded=1 WHERE capture_id=$id AND role=$role";
            cmd.Parameters.AddWithValue("$id", captureId);
            cmd.Parameters.AddWithValue("$role", role);
            cmd.ExecuteNonQuery();
        }
    }

    public CaptureRecord? Get(string captureId) => Query("WHERE c.capture_id=$id", ("$id", captureId)).FirstOrDefault();

    /// <summary>Captures that must still reach the server (oldest first).</summary>
    public List<CaptureRecord> DueForUpload(DateTimeOffset now, int limit = 20) =>
        Query("WHERE c.stage IN ('SAVED_LOCAL','QUEUED','UPLOADING','NEEDS_ATTENTION') AND c.next_attempt_at <= $now ORDER BY c.created_at LIMIT $limit",
            ("$now", Ts(now)), ("$limit", limit));

    public List<CaptureRecord> WithStage(params CaptureStage[] stages)
    {
        var list = string.Join(",", stages.Select(s => $"'{s}'"));
        return Query($"WHERE c.stage IN ({list}) ORDER BY c.created_at");
    }

    public (int pending, int failed, DateTimeOffset? lastSync) QueueStats()
    {
        lock (_gate)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = """
                SELECT
                  SUM(CASE WHEN stage IN ('SAVED_LOCAL','QUEUED','UPLOADING') THEN 1 ELSE 0 END),
                  SUM(CASE WHEN stage = 'NEEDS_ATTENTION' THEN 1 ELSE 0 END),
                  MAX(verified_at)
                FROM captures
                """;
            using var r = cmd.ExecuteReader();
            r.Read();
            return (r.IsDBNull(0) ? 0 : r.GetInt32(0), r.IsDBNull(1) ? 0 : r.GetInt32(1), r.IsDBNull(2) ? null : ParseTs(r.GetString(2)));
        }
    }

    /// <summary>Verified captures older than the retention window, eligible for local clean-up.</summary>
    public List<CaptureRecord> VerifiedBefore(DateTimeOffset cutoff) =>
        Query("WHERE c.stage='VERIFIED' AND c.verified_at < $cutoff ORDER BY c.verified_at LIMIT 200", ("$cutoff", Ts(cutoff)));

    public void Forget(string captureId)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            foreach (var sql in new[] { "DELETE FROM files WHERE capture_id=$id", "DELETE FROM captures WHERE capture_id=$id" })
            {
                using var cmd = _db.CreateCommand();
                cmd.Transaction = tx;
                cmd.CommandText = sql;
                cmd.Parameters.AddWithValue("$id", captureId);
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
        }
    }

    private List<CaptureRecord> Query(string where, params (string, object)[] args)
    {
        lock (_gate)
        {
            var map = new Dictionary<string, CaptureRecord>();
            using (var cmd = _db.CreateCommand())
            {
                cmd.CommandText = $"SELECT c.* FROM captures c {where}";
                foreach (var (k, v) in args) cmd.Parameters.AddWithValue(k, v);
                using var r = cmd.ExecuteReader();
                while (r.Read())
                {
                    string S(string col) => r.IsDBNull(r.GetOrdinal(col)) ? null! : r.GetString(r.GetOrdinal(col));
                    var rec = new CaptureRecord
                    {
                        CaptureId = S("capture_id"),
                        Context = new CaptureContext(S("lot_id"), S("catalog_id"), S("category"), r.GetInt32(r.GetOrdinal("lot_number")), S("catalog_number"), S("session_id")),
                        UserId = S("user_id"),
                        UserName = S("user_name"),
                        ControlToken = S("control_token"),
                        External = r.GetInt32(r.GetOrdinal("external")) == 1,
                        Source = S("source"),
                        CameraName = S("camera_name"),
                        Stage = Enum.Parse<CaptureStage>(S("stage")),
                        Attempts = r.GetInt32(r.GetOrdinal("attempts")),
                        NextAttemptAt = ParseTs(S("next_attempt_at")) ?? DateTimeOffset.UtcNow,
                        LastError = S("last_error"),
                        AssetId = S("asset_id"),
                        CreatedAt = ParseTs(S("created_at")) ?? DateTimeOffset.UtcNow,
                        SavedAt = S("saved_at") is { } sa ? ParseTs(sa) : null,
                        VerifiedAt = S("verified_at") is { } va ? ParseTs(va) : null,
                    };
                    map[rec.CaptureId] = rec;
                }
            }
            if (map.Count == 0) return [];
            using (var cmd = _db.CreateCommand())
            {
                var ids = map.Keys.Select((_, i) => $"$f{i}").ToArray();
                cmd.CommandText = $"SELECT * FROM files WHERE capture_id IN ({string.Join(",", ids)})";
                var n = 0;
                foreach (var id in map.Keys) cmd.Parameters.AddWithValue($"$f{n++}", id);
                using var r = cmd.ExecuteReader();
                while (r.Read())
                {
                    var f = new CaptureFile
                    {
                        CaptureId = r.GetString(0),
                        Role = r.GetString(1),
                        Path = r.GetString(2),
                        OriginalFilename = r.GetString(3),
                        MimeType = r.GetString(4),
                        SizeBytes = r.GetInt64(5),
                        Sha256 = r.GetString(6),
                        Width = r.IsDBNull(7) ? null : r.GetInt32(7),
                        Height = r.IsDBNull(8) ? null : r.GetInt32(8),
                        Uploaded = r.GetInt32(9) == 1,
                    };
                    map[f.CaptureId].Files.Add(f);
                }
            }
            return [.. map.Values];
        }
    }

    public void Dispose() => _db.Dispose();
}
