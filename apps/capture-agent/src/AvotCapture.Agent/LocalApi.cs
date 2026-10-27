using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Net;
using System.Text.Json;
using AvotCapture.Core;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace AvotCapture.Agent;

/// <summary>
/// Browser ↔ agent API, bound to 127.0.0.1 only (never the LAN).
/// Defences: Host-header allow-list (DNS rebinding), CORS restricted to the
/// paired web origin, Private Network Access preflight, HMAC control tokens
/// issued by the server for a specific user + origin, and a single-user lease.
/// Contract: docs/api-contracts.md ("Local agent API").
/// </summary>
public sealed class LocalApi : IAsyncDisposable
{
    private readonly AgentHost _host;
    private readonly ILogger _log;
    private WebApplication? _app;
    private readonly ConcurrentDictionary<string, byte[]> _thumbs = new();
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public LocalApi(AgentHost host, ILogger logger)
    {
        _host = host;
        _log = logger;
    }

    public async Task StartAsync()
    {
        var port = _host.Settings.Port;
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel(o =>
        {
            o.Listen(IPAddress.Loopback, port);
            o.Limits.MaxRequestBodySize = 64 * 1024;
        });
        builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);
        var app = builder.Build();

        app.Use(async (ctx, next) =>
        {
            var host = ctx.Request.Host.Host;
            if (host is not ("127.0.0.1" or "localhost") || ctx.Request.Host.Port != port)
            {
                ctx.Response.StatusCode = 421;
                return;
            }
            var origin = ctx.Request.Headers.Origin.ToString();
            var path = ctx.Request.Path.Value ?? "";
            var allowed = _host.Settings.ServerOrigin;
            var isHello = path == "/v1/hello";
            if (!string.IsNullOrEmpty(origin))
            {
                var ok = string.Equals(origin, allowed, StringComparison.OrdinalIgnoreCase) || (isHello && !_host.Settings.IsPaired);
                if (!ok)
                {
                    ctx.Response.StatusCode = 403;
                    await ctx.Response.WriteAsJsonAsync(new { error = new { code = "BAD_ORIGIN", message = "מקור לא מורשה עבור עמדה זו" } });
                    return;
                }
                ctx.Response.Headers.AccessControlAllowOrigin = origin;
                ctx.Response.Headers.Vary = "Origin";
                ctx.Response.Headers.AccessControlAllowHeaders = "authorization, content-type, x-avot-lease";
                ctx.Response.Headers.AccessControlAllowMethods = "GET, POST, OPTIONS";
                ctx.Response.Headers.AccessControlMaxAge = "600";
                if (ctx.Request.Headers.ContainsKey("Access-Control-Request-Private-Network"))
                    ctx.Response.Headers["Access-Control-Allow-Private-Network"] = "true";
            }
            if (HttpMethods.IsOptions(ctx.Request.Method))
            {
                ctx.Response.StatusCode = 204;
                return;
            }
            ctx.Response.Headers.CacheControl = "no-store";
            await next();
        });

        app.MapGet("/v1/hello", () =>
        {
            var s = _host.Camera?.GetStatus();
            return Results.Json(new
            {
                product = "avot-capture-agent",
                version = AgentHost.Version,
                apiVersion = ServerClient.ApiVersion,
                paired = _host.Settings.IsPaired && !_host.RevokedByServer,
                deviceId = _host.Settings.DeviceId,
                deviceName = _host.Settings.DeviceName,
                serverOrigin = _host.Settings.ServerOrigin,
                camera = new { kind = s?.Kind ?? "NONE", model = s?.Model, connected = s?.Connected ?? false },
            });
        });

        app.MapPost("/v1/session", async (HttpContext ctx) =>
        {
            var body = await ctx.Request.ReadFromJsonAsync<JsonElement>();
            var token = body.TryGetProperty("token", out var t) ? t.GetString() : null;
            var (payload, error) = VerifyToken(token, ctx.Request.Headers.Origin.ToString());
            if (payload is null) return Error(403, "FORBIDDEN", error!);
            var (lease, conflict) = _host.Leases.Acquire(payload, token!);
            if (lease is null) return Error(409, "IN_USE", conflict!);
            if (_host.Camera is { } cam && cam.GetStatus().Connected) await cam.StartLiveViewAsync(CancellationToken.None);
            _log.LogInformation("lease acquired by {User}", payload.UserName);
            return Results.Json(new { leaseId = lease.Id, expiresInSeconds = (int)LeaseManager.IdleTimeout.TotalSeconds });
        });

        app.MapPost("/v1/release", (HttpContext ctx) => Authorized(ctx, payload =>
        {
            _host.Leases.Release(ctx.Request.Headers["x-avot-lease"]);
            if (_host.Camera is { } cam) cam.StopLiveViewAsync().ContinueWith(static _ => { });
            return Results.Json(new { ok = true });
        }));

        app.MapGet("/v1/status", (HttpContext ctx) => Authorized(ctx, _ =>
        {
            var s = _host.Camera?.GetStatus() ?? new CameraStatus { Kind = "NONE", LastError = _host.CameraError };
            var (pending, failed, lastSync) = _host.Store.QueueStats();
            return Results.Json(new
            {
                camera = new
                {
                    kind = s.Kind,
                    model = s.Model,
                    connected = s.Connected,
                    busy = s.Busy,
                    battery = s.Battery,
                    liveView = s.LiveView,
                    resolution = s.Resolution,
                    formats = s.Formats,
                    canAutofocus = s.CanAutofocus,
                    hardwareShutter = s.HardwareShutter,
                    controls = s.Controls.Select(c => new { id = c.Id, label = c.Label, type = c.Type, value = c.Value, options = c.Options?.Select(o => new { value = o.Value, label = o.Label }), min = c.Min, max = c.Max, step = c.Step, display = c.Display, readOnly = c.ReadOnly }),
                    readouts = s.Readouts.Select(r => new { label = r.Label, value = r.Value }),
                    lastError = s.Connected ? s.LastError : (s.LastError ?? _host.CameraError),
                },
                queue = new { pending, failed, lastSyncAt = lastSync },
                disk = new { freeBytes = _host.Coordinator.FreeBytes(), level = _host.Coordinator.DiskLevel() },
            }, Json);
        }));

        app.MapGet("/v1/events", (HttpContext ctx, long since) => Authorized(ctx, _ =>
        {
            var (cursor, events) = _host.Feed.Since(since);
            return Results.Json(new { cursor, events }, Json);
        }));

        app.MapPost("/v1/context", async (HttpContext ctx) => await AuthorizedAsync(ctx, async p =>
        {
            var b = await ctx.Request.ReadFromJsonAsync<JsonElement>();
            var context = ReadContext(b);
            if (context is null) return Error(400, "VALIDATION", "הקשר צילום לא תקין");
            _host.Coordinator.SetActiveContext(context, p.UserId, p.UserName, ctx.Request.Headers.Authorization.ToString()[7..]);
            return Results.Json(new { ok = true });
        }));

        app.MapPost("/v1/capture", async (HttpContext ctx) => await AuthorizedAsync(ctx, async p =>
        {
            var b = await ctx.Request.ReadFromJsonAsync<JsonElement>();
            var context = ReadContext(b);
            var captureId = b.TryGetProperty("captureId", out var c) ? c.GetString() : null;
            if (context is null || !Guid.TryParse(captureId, out _)) return Error(400, "VALIDATION", "בקשת צילום לא תקינה");
            try
            {
                _host.Updates.NoteShutter();
                var rec = await _host.Coordinator.RequestCaptureAsync(
                    new CaptureRequest(captureId!, context, p.UserId, p.UserName, ctx.Request.Headers.Authorization.ToString()[7..]), ctx.RequestAborted);
                return Results.Json(new { captureId = rec.CaptureId, stage = rec.Stage.ToString() }, statusCode: 202);
            }
            catch (CaptureRejectedException ex)
            {
                return Error(ex.Status, "REJECTED", ex.Message);
            }
        }));

        app.MapPost("/v1/settings", async (HttpContext ctx) => await AuthorizedAsync(ctx, async _ =>
        {
            var b = await ctx.Request.ReadFromJsonAsync<JsonElement>();
            var id = b.GetProperty("id").GetString()!;
            var v = b.GetProperty("value");
            var value = v.ValueKind switch { JsonValueKind.True => "true", JsonValueKind.False => "false", _ => v.ToString() };
            if (_host.Camera is null) return Error(503, "NO_CAMERA", "אין מצלמה");
            try
            {
                await _host.Camera.SetControlAsync(id, value, ctx.RequestAborted);
            }
            catch (CameraException ex)
            {
                return Error(400, "CAMERA", ex.Message);
            }
            return Results.Json(new { ok = true });
        }));

        app.MapPost("/v1/autofocus", async (HttpContext ctx) => await AuthorizedAsync(ctx, async _ =>
        {
            if (_host.Camera is null) return Error(503, "NO_CAMERA", "אין מצלמה");
            try
            {
                await _host.Camera.AutofocusAsync(ctx.RequestAborted);
            }
            catch (CameraException ex)
            {
                return Error(400, "CAMERA", ex.Message);
            }
            return Results.Json(new { ok = true });
        }));

        // <img> requests carry no custom headers: authorised by the unguessable lease id
        app.MapGet("/v1/liveview.mjpg", async (HttpContext ctx, string k) =>
        {
            if (!_host.Leases.IsActive(k))
            {
                ctx.Response.StatusCode = 401;
                return;
            }
            ctx.Response.ContentType = "multipart/x-mixed-replace; boundary=avotframe";
            byte[]? last = null;
            while (!ctx.RequestAborted.IsCancellationRequested && _host.Leases.IsActive(k))
            {
                var frame = _host.Camera?.LatestLiveViewFrame;
                if (frame is not null && !ReferenceEquals(frame, last))
                {
                    last = frame;
                    await ctx.Response.WriteAsync($"--avotframe\r\nContent-Type: image/jpeg\r\nContent-Length: {frame.Length}\r\n\r\n");
                    await ctx.Response.Body.WriteAsync(frame);
                    await ctx.Response.WriteAsync("\r\n");
                    await ctx.Response.Body.FlushAsync();
                }
                await Task.Delay(66).ContinueWith(_ => { });
            }
        });

        app.MapGet("/v1/captures/{id}/thumb", (string id, string k) =>
        {
            if (!_host.Leases.IsActive(k)) return Results.StatusCode(401);
            var bytes = _thumbs.GetOrAdd(id, MakeThumb);
            return bytes.Length == 0 ? Results.NotFound() : Results.Bytes(bytes, "image/jpeg");
        });

        _app = app;
        await app.StartAsync();
        _log.LogInformation("local API listening on http://127.0.0.1:{Port}", port);
    }

    private byte[] MakeThumb(string captureId)
    {
        var rec = _host.Store.Get(captureId);
        var primary = rec?.Files.FirstOrDefault(f => f.Role == "PRIMARY");
        if (primary is null || !File.Exists(primary.Path)) return [];
        try
        {
            using var src = Image.FromFile(primary.Path);
            var scale = Math.Min(480.0 / src.Width, 480.0 / src.Height);
            using var bmp = new Bitmap(Math.Max(1, (int)(src.Width * scale)), Math.Max(1, (int)(src.Height * scale)));
            using (var g = Graphics.FromImage(bmp))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.DrawImage(src, 0, 0, bmp.Width, bmp.Height);
            }
            using var ms = new MemoryStream();
            bmp.Save(ms, ImageFormat.Jpeg);
            return ms.ToArray();
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "thumbnail failed for {CaptureId}", captureId);
            return [];
        }
    }

    private (ControlTokenPayload? payload, string? error) VerifyToken(string? token, string origin)
    {
        if (!_host.Settings.IsPaired || _host.DeviceSecret is null) return (null, "העמדה אינה מצומדת לשרת");
        if (string.IsNullOrEmpty(token)) return (null, "חסרה הרשאה");
        return ControlToken.Verify(token, _host.DeviceSecret, _host.Settings.DeviceId!, string.IsNullOrEmpty(origin) ? null : origin, DateTimeOffset.UtcNow);
    }

    private IResult Authorized(HttpContext ctx, Func<ControlTokenPayload, IResult> handler)
    {
        var (p, err) = CheckRequest(ctx);
        return p is null ? err! : handler(p);
    }

    private async Task<IResult> AuthorizedAsync(HttpContext ctx, Func<ControlTokenPayload, Task<IResult>> handler)
    {
        var (p, err) = CheckRequest(ctx);
        return p is null ? err! : await handler(p);
    }

    private (ControlTokenPayload?, IResult?) CheckRequest(HttpContext ctx)
    {
        var auth = ctx.Request.Headers.Authorization.ToString();
        if (!auth.StartsWith("Bearer ", StringComparison.Ordinal)) return (null, Error(401, "UNAUTHENTICATED", "חסרה הרשאה"));
        var (p, error) = VerifyToken(auth[7..], ctx.Request.Headers.Origin.ToString());
        if (p is null) return (null, Error(401, "UNAUTHENTICATED", error!));
        return _host.Leases.Touch(ctx.Request.Headers["x-avot-lease"]) switch
        {
            LeaseManager.Check.Ok => (p, null),
            LeaseManager.Check.Superseded => (null, Error(409, "TAKEN_OVER", "השליטה במצלמה עברה ללשונית אחרת")),
            _ => (null, Error(401, "LEASE", "החיבור לעמדה פג — מתחבר מחדש")),
        };
    }

    private static CaptureContext? ReadContext(JsonElement b)
    {
        string? S(string n) => b.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var lotId = S("lotId");
        var catalogId = S("catalogId");
        var category = S("category");
        if (!Guid.TryParse(lotId, out _) || !Guid.TryParse(catalogId, out _) || !Categories.IsValid(category)) return null;
        if (!b.TryGetProperty("lotNumber", out var ln) || !ln.TryGetInt32(out var lotNumber)) return null;
        // processing settings of the active profile are frozen with the shot and forwarded to the server unchanged
        string? processing = null;
        if (b.TryGetProperty("processing", out var pr) && pr.ValueKind == JsonValueKind.Object)
        {
            var raw = pr.GetRawText();
            if (raw.Length <= 4096) processing = raw;
        }
        return new CaptureContext(lotId!, catalogId!, category!, lotNumber, S("catalogNumber") ?? "", S("sessionId"), processing);
    }

    private static IResult Error(int status, string code, string message) =>
        Results.Json(new { error = new { code, message } }, statusCode: status);

    public async ValueTask DisposeAsync()
    {
        if (_app is not null) await _app.DisposeAsync();
    }
}
