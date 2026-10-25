using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AvotCapture.Core;

/// <summary>Payload signed by the web server (see apps/web/src/server/services/control-token.ts).</summary>
public sealed record ControlTokenPayload(
    [property: JsonPropertyName("v")] int V,
    [property: JsonPropertyName("deviceId")] string DeviceId,
    [property: JsonPropertyName("orgId")] string OrgId,
    [property: JsonPropertyName("userId")] string UserId,
    [property: JsonPropertyName("userName")] string UserName,
    [property: JsonPropertyName("origin")] string Origin,
    [property: JsonPropertyName("exp")] long Exp,
    [property: JsonPropertyName("nonce")] string Nonce);

public static class ControlToken
{
    /// <summary>
    /// Verifies HMAC-SHA256(deviceSecret, base64url(payload)), expiry, device id and the
    /// browser Origin. Returns null with a reason when invalid.
    /// </summary>
    public static (ControlTokenPayload? payload, string? error) Verify(string token, string deviceSecret, string deviceId, string? requestOrigin, DateTimeOffset now)
    {
        var dot = token.IndexOf('.');
        if (dot <= 0 || dot == token.Length - 1) return (null, "אסימון לא תקין");
        var body = token[..dot];
        var sig = token[(dot + 1)..];
        var expected = Base64Url(HMACSHA256.HashData(Encoding.UTF8.GetBytes(deviceSecret), Encoding.UTF8.GetBytes(body)));
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(sig), Encoding.ASCII.GetBytes(expected)))
            return (null, "חתימת האסימון שגויה");
        ControlTokenPayload? p;
        try
        {
            p = JsonSerializer.Deserialize<ControlTokenPayload>(FromBase64Url(body));
        }
        catch (JsonException)
        {
            return (null, "אסימון לא תקין");
        }
        if (p is null || p.V != 1) return (null, "גרסת אסימון לא נתמכת");
        if (p.DeviceId != deviceId) return (null, "האסימון שייך לעמדה אחרת");
        if (p.Exp < now.ToUnixTimeSeconds()) return (null, "פג תוקף ההרשאה — רעננו את מסך הצילום");
        if (requestOrigin is not null && !string.Equals(p.Origin, requestOrigin, StringComparison.OrdinalIgnoreCase))
            return (null, "מקור הבקשה אינו תואם להרשאה");
        return (p, null);
    }

    public static string Sign(string deviceSecret, ControlTokenPayload payload)
    {
        var body = Base64Url(JsonSerializer.SerializeToUtf8Bytes(payload));
        return $"{body}.{Base64Url(HMACSHA256.HashData(Encoding.UTF8.GetBytes(deviceSecret), Encoding.UTF8.GetBytes(body)))}";
    }

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] FromBase64Url(string s)
    {
        var b = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(b.PadRight(b.Length + (4 - b.Length % 4) % 4, '='));
    }
}
