using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AvotCapture.Core;

public sealed class ServerException(string message, HttpStatusCode? status, string? code) : Exception(message)
{
    public HttpStatusCode? Status { get; } = status;
    public string? Code { get; } = code;
    /// <summary>True when retrying the same request cannot succeed without human action.</summary>
    public bool Permanent => Status is HttpStatusCode.BadRequest or HttpStatusCode.Conflict or HttpStatusCode.NotFound or HttpStatusCode.Forbidden;
}

public sealed record RegisteredFile(
    [property: JsonPropertyName("fileId")] string FileId,
    [property: JsonPropertyName("role")] string Role,
    [property: JsonPropertyName("uploadStatus")] string UploadStatus,
    [property: JsonPropertyName("uploadUrl")] string UploadUrl);

public sealed record RegisterResponse(
    [property: JsonPropertyName("assetId")] string AssetId,
    [property: JsonPropertyName("captureId")] string CaptureId,
    [property: JsonPropertyName("sequence")] int Sequence,
    [property: JsonPropertyName("files")] List<RegisteredFile> Files);

public sealed record PairResponse(
    [property: JsonPropertyName("deviceId")] string DeviceId,
    [property: JsonPropertyName("organizationId")] string OrganizationId,
    [property: JsonPropertyName("deviceToken")] string DeviceToken,
    [property: JsonPropertyName("deviceSecret")] string DeviceSecret,
    [property: JsonPropertyName("name")] string Name);

/// <summary>HTTPS client for the AVOT Studio server API (contract: docs/api-contracts.md).</summary>
public sealed class ServerClient : IDisposable
{
    public const int ApiVersion = 1;
    private readonly HttpClient _http;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

    public ServerClient(Uri baseUrl, string? deviceToken, HttpMessageHandler? handler = null)
    {
        _http = handler is null ? new HttpClient() : new HttpClient(handler);
        _http.BaseAddress = baseUrl;
        _http.Timeout = TimeSpan.FromMinutes(10);
        _http.DefaultRequestHeaders.UserAgent.ParseAdd($"AvotCaptureAgent/{typeof(ServerClient).Assembly.GetName().Version}");
        if (deviceToken is not null) _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", deviceToken);
    }

    private static async Task<T> Read<T>(HttpResponseMessage res, CancellationToken ct)
    {
        if (res.IsSuccessStatusCode) return (await res.Content.ReadFromJsonAsync<T>(Json, ct))!;
        string? message = null, code = null;
        try
        {
            using var doc = await JsonDocument.ParseAsync(await res.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
            if (doc.RootElement.TryGetProperty("error", out var e))
            {
                message = e.TryGetProperty("message", out var m) ? m.GetString() : null;
                code = e.TryGetProperty("code", out var c) ? c.GetString() : null;
            }
        }
        catch (JsonException)
        {
            /* not JSON */
        }
        throw new ServerException(message ?? $"HTTP {(int)res.StatusCode}", res.StatusCode, code);
    }

    public async Task<PairResponse> PairAsync(string code, string name, string machineName, string agentVersion, CancellationToken ct)
    {
        using var res = await _http.PostAsJsonAsync("api/agent/pair", new { code, name, machineName, agentVersion, apiVersion = ApiVersion }, Json, ct);
        return await Read<PairResponse>(res, ct);
    }

    public async Task<JsonElement> HeartbeatAsync(object body, CancellationToken ct)
    {
        using var res = await _http.PostAsJsonAsync("api/agent/heartbeat", body, Json, ct);
        return await Read<JsonElement>(res, ct);
    }

    public async Task<RegisterResponse> RegisterAsync(CaptureRecord rec, CancellationToken ct)
    {
        var body = new
        {
            captureId = rec.CaptureId,
            lotId = rec.Context.LotId,
            category = rec.Context.Category,
            source = rec.Source,
            capturedAt = rec.CreatedAt.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
            sessionId = rec.Context.SessionId,
            cameraName = rec.CameraName,
            controlToken = rec.ControlToken,
            exif = new { external = rec.External, agent = true },
            files = rec.Files.Select(f => new
            {
                role = f.Role,
                originalFilename = f.OriginalFilename,
                mimeType = f.MimeType,
                sizeBytes = f.SizeBytes,
                sha256 = f.Sha256,
                width = f.Width,
                height = f.Height,
            }),
        };
        using var res = await _http.PostAsJsonAsync("api/captures", body, Json, ct);
        return await Read<RegisterResponse>(res, ct);
    }

    /// <summary>Streams the original from disk; the server re-hashes and rejects any mismatch.</summary>
    public async Task UploadAsync(string uploadUrl, CaptureFile file, CancellationToken ct)
    {
        await using var fs = new FileStream(file.Path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, FileOptions.SequentialScan | FileOptions.Asynchronous);
        using var content = new StreamContent(fs, 1 << 20);
        content.Headers.ContentType = new MediaTypeHeaderValue(file.MimeType);
        content.Headers.ContentLength = file.SizeBytes;
        using var res = await _http.PutAsync(uploadUrl.TrimStart('/'), content, ct);
        await Read<JsonElement>(res, ct);
    }

    public void Dispose() => _http.Dispose();
}
