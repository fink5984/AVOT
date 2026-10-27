using AvotCapture.Core;
using Microsoft.Extensions.Logging;

namespace AvotCapture.Agent;

/// <summary>
/// AvotCaptureAgent.exe [options]
///   --tray                      start minimised to the tray (used by autostart)
///   --headless                  no tray UI (services / automated tests); stops on Ctrl+C or when killed
///   --data &lt;dir&gt;                 settings + local DB + logs folder (default %LOCALAPPDATA%\AvotCapture)
///   --storage &lt;dir&gt;              photo storage root (persisted in settings)
///   --port &lt;n&gt;                   local API port (default 47800, persisted)
///   --camera AUTO|CANON|DIGICAM|SIMULATOR   camera mode (persisted; AUTO = Canon EDSDK if installed, else digiCamControl)
///   --pair &lt;serverUrl&gt; &lt;code&gt; [name]   pair with AVOT Studio and exit
/// </summary>
internal static class Program
{
    private static string? Arg(string[] args, string name) => args.SkipWhile(a => a != name).Skip(1).FirstOrDefault();

    [STAThread]
    private static int Main(string[] args)
    {
        if (Arg(args, "--data") is { } data) AgentSettings.Folder = Path.GetFullPath(data);
        var headless = args.Contains("--headless");
        using var logs = LoggerFactory.Create(b => b.AddProvider(new FileLoggerProvider(Path.Combine(AgentSettings.Folder, "logs"))));
        var log = logs.CreateLogger("Program");
        AppDomain.CurrentDomain.UnhandledException += (_, e) => log.LogCritical(e.ExceptionObject as Exception, "unhandled");

        // a freshly installed update that keeps crashing is rolled back to the previous version before anything else starts
        if (UpdateService.RecoverIfNeeded(log)) return 0;

        var settings = AgentSettings.Load();

        if (Arg(args, "--storage") is { } storage) settings.StorageRoot = Path.GetFullPath(storage);
        if (Arg(args, "--port") is { } port) settings.Port = int.Parse(port);
        if (Arg(args, "--camera") is { } cam) settings.CameraMode = cam.ToUpperInvariant() is "SIMULATOR" or "DIGICAM" or "AUTO" ? cam.ToUpperInvariant() : "CANON";
        settings.Save();

        if (args.Contains("--version"))
        {
            Console.WriteLine(AgentHost.Version);
            return 0;
        }
        if (Arg(args, "--import-sdk") is { } sdkZip)
        {
            var r = SdkImporter.Import(sdkZip, settings);
            Console.WriteLine(r.Message);
            return r.Ok ? 0 : 1;
        }
        if (args.Contains("--check"))
        {
            // used by the installer wizard: one JSON document, exit code 0 only when every line is OK
            var lines = SystemCheck.RunAsync(settings, null, logs, CancellationToken.None).GetAwaiter().GetResult();
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            // --brief: "key=OK|FAIL" lines the installer reads without a JSON parser
            Console.WriteLine(args.Contains("--brief") ? string.Join(Environment.NewLine, lines.Select(l => $"{l.Key}={(l.Ok ? "OK" : "FAIL")}")) : SystemCheck.ToJson(lines));
            return lines.All(l => l.Ok) ? 0 : 3;
        }

        var pairIdx = Array.IndexOf(args, "--pair");
        if (pairIdx >= 0)
        {
            var url = args.ElementAtOrDefault(pairIdx + 1);
            var code = args.ElementAtOrDefault(pairIdx + 2);
            if (url is null || code is null)
            {
                Console.Error.WriteLine("usage: --pair <serverUrl> <code> [name]");
                return 64;
            }
            var name = args.ElementAtOrDefault(pairIdx + 3) is { } n && !n.StartsWith("--") ? n : Environment.MachineName;
            var pairHost = new AgentHost(settings, new DpapiProtector(), logs);
            try
            {
                pairHost.PairAsync(url, code, name, CancellationToken.None).GetAwaiter().GetResult();
                Console.WriteLine($"paired as {settings.DeviceName} ({settings.DeviceId})");
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("pairing failed: " + ex.Message);
                return 1;
            }
            finally
            {
                pairHost.DisposeAsync().AsTask().GetAwaiter().GetResult();
            }
        }

        // one agent per data folder: two processes must never drive the same camera or queue
        var mutexName = @"Local\AvotCaptureAgent-" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(AgentSettings.Folder.ToLowerInvariant())))[..16];
        using var single = new Mutex(initiallyOwned: true, mutexName, out var isFirst);
        if (!isFirst)
        {
            if (!headless && !args.Contains("--tray"))
                MessageBox.Show("AVOT Capture Agent כבר פועל במחשב זה (סמל במגש המערכת).", "AVOT Capture Agent", MessageBoxButtons.OK, MessageBoxIcon.Information, MessageBoxDefaultButton.Button1, MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign);
            return 1;
        }

        var host = new AgentHost(settings, new DpapiProtector(), logs);
        var api = new LocalApi(host, logs.CreateLogger("LocalApi"));
        try
        {
            api.StartAsync().GetAwaiter().GetResult();
        }
        catch (IOException ex)
        {
            log.LogError(ex, "port in use");
            if (!headless)
                MessageBox.Show($"הפורט {settings.Port} תפוס על ידי תוכנה אחרת. שנו את הפורט בקובץ ההגדרות:\n{AgentSettings.FilePath}", "AVOT Capture Agent", MessageBoxButtons.OK, MessageBoxIcon.Error, MessageBoxDefaultButton.Button1, MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign);
            return 2;
        }
        host.Start();
        log.LogInformation("AVOT Capture Agent {Version} started; data {Data}; storage {Root}; camera {Mode}", AgentHost.Version, AgentSettings.Folder, settings.StorageRoot, settings.CameraMode);

        if (headless)
        {
            using var stop = new ManualResetEventSlim();
            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                stop.Set();
            };
            AppDomain.CurrentDomain.ProcessExit += (_, _) => stop.Set();
            stop.Wait();
        }
        else
        {
            ApplicationConfiguration.Initialize();
            Application.ThreadException += (_, e) => log.LogError(e.Exception, "UI thread exception");
            using var tray = new TrayApp(host, logs);
            if (!settings.IsPaired) tray.ShowPairing();
            if (!args.Contains("--tray")) tray.ShowWindow();
            Application.Run();
        }

        api.DisposeAsync().AsTask().GetAwaiter().GetResult();
        host.DisposeAsync().AsTask().GetAwaiter().GetResult();
        return 0;
    }
}
