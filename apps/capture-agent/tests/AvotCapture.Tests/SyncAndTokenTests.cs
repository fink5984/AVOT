using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AvotCapture.Core;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AvotCapture.Tests;

/// <summary>In-memory stand-in for the AVOT Studio server upload protocol (register + PUT + verify).</summary>
public sealed class FakeServer : HttpMessageHandler
{
    public readonly Dictionary<string, (string sha, long size, bool verified, string assetId)> Files = [];
    public readonly Dictionary<string, string> CaptureToAsset = [];
    public int FailNextRequests { get; set; }
    public bool DropResponseAfterUpload { get; set; }
    public int Registers;
    public int Uploads;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        if (FailNextRequests > 0)
        {
            FailNextRequests--;
            throw new HttpRequestException("network down (simulated)");
        }
        var path = req.RequestUri!.AbsolutePath;
        if (path == "/api/captures" && req.Method == HttpMethod.Post)
        {
            Registers++;
            using var doc = JsonDocument.Parse(await req.Content!.ReadAsStringAsync(ct));
            var captureId = doc.RootElement.GetProperty("captureId").GetString()!;
            var assetId = CaptureToAsset.TryGetValue(captureId, out var a) ? a : CaptureToAsset[captureId] = Guid.NewGuid().ToString();
            var files = doc.RootElement.GetProperty("files").EnumerateArray().Select(f =>
            {
                var role = f.GetProperty("role").GetString()!;
                var fileId = $"{assetId}-{role}";
                if (!Files.ContainsKey(fileId)) Files[fileId] = (f.GetProperty("sha256").GetString()!, f.GetProperty("sizeBytes").GetInt64(), false, assetId);
                return new { fileId, role, uploadStatus = Files[fileId].verified ? "VERIFIED" : "PENDING", uploadUrl = $"/api/files/{fileId}/content" };
            }).ToList();
            return Json(new { assetId, captureId, sequence = 1, files });
        }
        if (path.StartsWith("/api/files/") && req.Method == HttpMethod.Put)
        {
            Uploads++;
            var fileId = path.Split('/')[3];
            var bytes = await req.Content!.ReadAsByteArrayAsync(ct);
            var sha = Convert.ToHexStringLower(SHA256.HashData(bytes));
            var f = Files[fileId];
            if (sha != f.sha || bytes.Length != f.size) return new HttpResponseMessage(HttpStatusCode.UnprocessableContent) { Content = new StringContent("{\"error\":{\"code\":\"CHECKSUM_MISMATCH\",\"message\":\"mismatch\"}}") };
            Files[fileId] = f with { verified = true };
            if (DropResponseAfterUpload)
            {
                DropResponseAfterUpload = false;
                throw new HttpRequestException("connection reset after server stored the file (simulated)");
            }
            return Json(new { fileId, uploadStatus = "VERIFIED" });
        }
        return new HttpResponseMessage(HttpStatusCode.NotFound);
    }

    private static HttpResponseMessage Json(object o) => new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(o), Encoding.UTF8, "application/json") };
}

public class SyncTests
{
    private static async Task<(TestRig rig, CaptureRecord rec)> SavedShot(bool raw = false)
    {
        var rig = new TestRig();
        rig.Camera.RawPlusJpeg = raw;
        var req = rig.Req("INTERIOR");
        await rig.Coordinator.RequestCaptureAsync(req, default);
        return (rig, await rig.WaitStage(req.CaptureId, CaptureStage.SAVED_LOCAL));
    }

    [Fact]
    public async Task Upload_verifies_and_marks_capture_verified_keeping_the_local_original()
    {
        var (rig, rec) = await SavedShot(raw: true);
        using var _ = rig;
        var server = new FakeServer();
        using var client = new ServerClient(new Uri("http://avot.test/"), "device-token", server);
        var q = new UploadQueue(rig.Store, rig.Feed, () => client, NullLogger.Instance);
        await q.UploadOneAsync(client, rig.Store.Get(rec.CaptureId)!, default);
        var after = rig.Store.Get(rec.CaptureId)!;
        Assert.Equal(CaptureStage.VERIFIED, after.Stage);
        Assert.Equal(2, server.Files.Values.Count(f => f.verified));
        Assert.All(after.Files, f => Assert.True(File.Exists(f.Path))); // no deletion right after upload
    }

    [Fact]
    public async Task Network_failure_backs_off_and_keeps_the_file_queued()
    {
        var (rig, rec) = await SavedShot();
        using var _ = rig;
        var server = new FakeServer { FailNextRequests = 1 };
        using var client = new ServerClient(new Uri("http://avot.test/"), "t", server);
        var q = new UploadQueue(rig.Store, rig.Feed, () => client, NullLogger.Instance);
        await q.UploadOneAsync(client, rig.Store.Get(rec.CaptureId)!, default);
        var failed = rig.Store.Get(rec.CaptureId)!;
        Assert.Equal(CaptureStage.QUEUED, failed.Stage);
        Assert.Equal(1, failed.Attempts);
        Assert.True(failed.NextAttemptAt > DateTimeOffset.UtcNow);
        await q.UploadOneAsync(client, failed, default);
        Assert.Equal(CaptureStage.VERIFIED, rig.Store.Get(rec.CaptureId)!.Stage);
    }

    [Fact]
    public async Task Lost_response_after_server_stored_the_file_does_not_duplicate()
    {
        var (rig, rec) = await SavedShot();
        using var _ = rig;
        var server = new FakeServer { DropResponseAfterUpload = true };
        using var client = new ServerClient(new Uri("http://avot.test/"), "t", server);
        var q = new UploadQueue(rig.Store, rig.Feed, () => client, NullLogger.Instance);
        await q.UploadOneAsync(client, rig.Store.Get(rec.CaptureId)!, default);
        Assert.Equal(CaptureStage.QUEUED, rig.Store.Get(rec.CaptureId)!.Stage);
        await q.UploadOneAsync(client, rig.Store.Get(rec.CaptureId)!, default);
        Assert.Equal(CaptureStage.VERIFIED, rig.Store.Get(rec.CaptureId)!.Stage);
        Assert.Single(server.CaptureToAsset); // one asset on the server
        Assert.Equal(1, server.Uploads); // the retry saw VERIFIED and skipped the PUT
    }

    [Fact]
    public async Task Corrupted_local_file_is_rejected_by_server_checksum_and_needs_attention()
    {
        var (rig, rec) = await SavedShot();
        using var _ = rig;
        var path = rec.Files[0].Path;
        var bytes = await File.ReadAllBytesAsync(path);
        bytes[^20] ^= 0xFF;
        await File.WriteAllBytesAsync(path, bytes);
        var server = new FakeServer();
        using var client = new ServerClient(new Uri("http://avot.test/"), "t", server);
        var q = new UploadQueue(rig.Store, rig.Feed, () => client, NullLogger.Instance);
        await q.UploadOneAsync(client, rig.Store.Get(rec.CaptureId)!, default);
        var after = rig.Store.Get(rec.CaptureId)!;
        Assert.NotEqual(CaptureStage.VERIFIED, after.Stage);
        Assert.False(server.Files.Values.Single().verified);
    }

    [Fact]
    public async Task Missing_original_is_flagged_for_a_human()
    {
        var (rig, rec) = await SavedShot();
        using var _ = rig;
        File.Delete(rec.Files[0].Path);
        var server = new FakeServer();
        using var client = new ServerClient(new Uri("http://avot.test/"), "t", server);
        var q = new UploadQueue(rig.Store, rig.Feed, () => client, NullLogger.Instance);
        await q.UploadOneAsync(client, rig.Store.Get(rec.CaptureId)!, default);
        Assert.Equal(CaptureStage.NEEDS_ATTENTION, rig.Store.Get(rec.CaptureId)!.Stage);
    }
}

public class ControlTokenTests
{
    private const string Secret = "device-secret-abc";
    private static ControlTokenPayload P(long exp, string origin = "https://studio.avot.test") =>
        new(1, "dev-1", "org-1", "user-1", "צלם", origin, exp, "n1");

    [Fact]
    public void Valid_token_is_accepted()
    {
        var t = ControlToken.Sign(Secret, P(DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds()));
        var (p, err) = ControlToken.Verify(t, Secret, "dev-1", "https://studio.avot.test", DateTimeOffset.UtcNow);
        Assert.Null(err);
        Assert.Equal("user-1", p!.UserId);
    }

    [Theory]
    [InlineData("wrong-secret", "dev-1", "https://studio.avot.test", 5)]
    [InlineData(Secret, "dev-2", "https://studio.avot.test", 5)]
    [InlineData(Secret, "dev-1", "https://evil.example", 5)]
    [InlineData(Secret, "dev-1", "https://studio.avot.test", -5)]
    public void Invalid_tokens_are_rejected(string secret, string deviceId, string origin, int minutes)
    {
        var t = ControlToken.Sign(Secret, P(DateTimeOffset.UtcNow.AddMinutes(minutes).ToUnixTimeSeconds()));
        var (p, err) = ControlToken.Verify(t, secret, deviceId, origin, DateTimeOffset.UtcNow);
        Assert.Null(p);
        Assert.NotNull(err);
    }

    [Fact]
    public void Tampered_payload_is_rejected()
    {
        var t = ControlToken.Sign(Secret, P(DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds()));
        var forged = ControlToken.Sign("x", P(DateTimeOffset.UtcNow.AddDays(9).ToUnixTimeSeconds())).Split('.')[0] + "." + t.Split('.')[1];
        Assert.Null(ControlToken.Verify(forged, Secret, "dev-1", null, DateTimeOffset.UtcNow).payload);
    }

    /// <summary>Token minted by the Node server code (same algorithm) must verify here.</summary>
    [Fact]
    public void Node_compatible_encoding()
    {
        var body = Convert.ToBase64String(Encoding.UTF8.GetBytes("{\"v\":1,\"deviceId\":\"dev-1\",\"orgId\":\"o\",\"userId\":\"u\",\"userName\":\"n\",\"origin\":\"http://localhost:3000\",\"exp\":4102444800,\"nonce\":\"x\"}"))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var sig = Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Secret), Encoding.UTF8.GetBytes(body))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        Assert.NotNull(ControlToken.Verify($"{body}.{sig}", Secret, "dev-1", "http://localhost:3000", DateTimeOffset.UtcNow).payload);
    }
}
