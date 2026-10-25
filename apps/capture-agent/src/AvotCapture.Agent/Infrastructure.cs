using System.Security.Cryptography;
using System.Text;
using AvotCapture.Core;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;

namespace AvotCapture.Agent;

/// <summary>Windows DPAPI (current user) for the device token and HMAC secret at rest.</summary>
public sealed class DpapiProtector : ISecretProtector
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("AVOT Capture Agent v1");

    public string Protect(string plain) =>
        Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), Entropy, DataProtectionScope.CurrentUser));

    public string Unprotect(string protectedValue) =>
        Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(protectedValue), Entropy, DataProtectionScope.CurrentUser));
}

/// <summary>Start with Windows via HKCU\...\Run (per user, no admin rights).</summary>
public static class AutoStart
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string Name = "AVOT Capture Agent";

    public static bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return key?.GetValue(Name) is string;
    }

    public static void Set(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (enabled) key.SetValue(Name, $"\"{Environment.ProcessPath}\" --tray");
        else key.DeleteValue(Name, throwOnMissingValue: false);
    }
}

/// <summary>Daily rolling plain-text log in %LOCALAPPDATA%\AvotCapture\logs.</summary>
public sealed class FileLoggerProvider : ILoggerProvider
{
    private readonly string _dir;
    private readonly Lock _gate = new();

    public FileLoggerProvider(string dir)
    {
        _dir = dir;
        Directory.CreateDirectory(dir);
        foreach (var old in Directory.EnumerateFiles(dir, "agent-*.log").Where(f => File.GetLastWriteTimeUtc(f) < DateTime.UtcNow.AddDays(-30)))
            File.Delete(old);
    }

    public ILogger CreateLogger(string category) => new FileLogger(this, category);

    internal void Write(string line)
    {
        lock (_gate) File.AppendAllText(Path.Combine(_dir, $"agent-{DateTime.Now:yyyyMMdd}.log"), line + Environment.NewLine);
    }

    public void Dispose() { }

    private sealed class FileLogger(FileLoggerProvider p, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => level >= LogLevel.Information;

        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? ex, Func<TState, Exception?, string> fmt)
        {
            if (!IsEnabled(level)) return;
            p.Write($"{DateTime.Now:O} [{level}] {category}: {fmt(state, ex)}{(ex is null ? "" : " | " + ex)}");
        }
    }
}
