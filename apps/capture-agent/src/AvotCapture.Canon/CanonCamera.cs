using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using AvotCapture.Core;
using Microsoft.Extensions.Logging;

namespace AvotCapture.Canon;

/// <summary>
/// Canon EOS camera over the official EDSDK. All SDK calls run on one
/// dedicated thread that also pumps SDK events (EdsGetEvent), as EDSDK
/// requires. Images are transferred straight to the PC ("save to host"):
/// each DirItemRequestTransfer event is downloaded into a staging file and
/// handed to the coordinator, which owns association and durability.
///
/// HARDWARE STATUS: not yet validated on a physical EOS R7. Every capability
/// shown to the user is read from the camera at runtime (property
/// descriptors), never assumed. See docs/hardware-acceptance.md.
/// </summary>
public sealed class CanonCamera : ICameraDevice
{
    private readonly ILogger _log;
    private readonly Func<string, string> _stagingPathFor;
    private readonly BlockingCollection<Action> _work = new();
    private readonly Thread _thread;
    private readonly CancellationTokenSource _cts = new();
    private static bool _sdkInitialized;

    private IntPtr _camera = IntPtr.Zero;
    private bool _sessionOpen;
    private string? _model;
    private string? _lastError;
    private volatile bool _liveView;
    private volatile byte[]? _frame;
    private bool _afOnShutter;
    private readonly Dictionary<uint, uint> _props = [];

    // keep delegates alive — the SDK holds raw function pointers
    private readonly Eds.ObjectEventHandler _onObject;
    private readonly Eds.PropertyEventHandler _onProperty;
    private readonly Eds.StateEventHandler _onState;

    public string Kind => "CANON";
    public event Action<CameraFileReady>? FileReady;
    public event Action<string>? Disconnected;
    public event Action? StatusChanged;

    public CanonCamera(ILogger logger, Func<string, string> stagingPathFor)
    {
        _log = logger;
        _stagingPathFor = stagingPathFor;
        _onObject = OnObjectEvent;
        _onProperty = OnPropertyEvent;
        _onState = OnStateEvent;
        _thread = new Thread(Pump) { IsBackground = true, Name = "EDSDK" };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
    }

    /// <summary>Loads EDSDK.dll from <paramref name="folder"/>; false (with a Hebrew reason) when it is not installed.</summary>
    public static bool IsAvailable(string? folder, out string? error) => Eds.TryConfigure(folder, out error);

    private void Pump()
    {
        var token = _cts.Token;
        while (!token.IsCancellationRequested)
        {
            try
            {
                while (_work.TryTake(out var action, 15, token)) action();
                if (_sdkInitialized) Eds.EdsGetEvent();
                if (_liveView && _sessionOpen) GrabLiveViewFrame();
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "EDSDK pump error");
            }
        }
    }

    private Task Run(Action action) => Run(() =>
    {
        action();
        return true;
    });

    private Task<T> Run<T>(Func<T> fn)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        _work.Add(() =>
        {
            try
            {
                tcs.SetResult(fn());
            }
            catch (Exception ex)
            {
                tcs.SetException(ex);
            }
        });
        return tcs.Task;
    }

    private static void Check(uint err, string what)
    {
        if (err == Eds.EDS_ERR_OK) return;
        var message = err switch
        {
            Eds.EDS_ERR_DEVICE_BUSY => "המצלמה עסוקה. נסו שוב בעוד רגע.",
            Eds.EDS_ERR_COMM_PORT_IS_IN_USE => "המצלמה בשימוש של תוכנה אחרת (למשל EOS Utility). סגרו אותה ונסו שוב.",
            Eds.EDS_ERR_COMM_DISCONNECTED => "החיבור למצלמה נותק.",
            Eds.EDS_ERR_SESSION_NOT_OPEN => "אין חיבור פעיל למצלמה.",
            Eds.EDS_ERR_TAKE_PICTURE_AF_NG => "המצלמה לא הצליחה למקד. בדקו תאורה ומיקוד ונסו שוב.",
            Eds.EDS_ERR_TAKE_PICTURE_CARD_NG => "בעיה בכרטיס הזיכרון של המצלמה.",
            _ => $"שגיאת מצלמה ({what}: {Eds.Hex(err)})",
        };
        throw new CameraException(message);
    }

    public Task ConnectAsync(CancellationToken ct) => Run(() =>
    {
        if (!_sdkInitialized)
        {
            Check(Eds.EdsInitializeSDK(), "InitializeSDK");
            _sdkInitialized = true;
        }
        CloseSessionInternal();
        Check(Eds.EdsGetCameraList(out var list), "GetCameraList");
        try
        {
            Check(Eds.EdsGetChildCount(list, out var count), "GetChildCount");
            if (count == 0)
                throw new CameraException("לא זוהתה מצלמת Canon. ודאו שהמצלמה מחוברת בכבל USB, דולקת, ושתוכנת EOS Utility סגורה.");
            Check(Eds.EdsGetChildAtIndex(list, 0, out _camera), "GetChildAtIndex");
        }
        finally
        {
            Eds.EdsRelease(list);
        }
        Check(Eds.EdsGetDeviceInfo(_camera, out var info), "GetDeviceInfo");
        _model = string.IsNullOrWhiteSpace(info.szDeviceDescription) ? "Canon EOS" : info.szDeviceDescription.Trim();

        Check(Eds.EdsSetObjectEventHandler(_camera, Eds.ObjectEvent_All, _onObject, IntPtr.Zero), "SetObjectEventHandler");
        Check(Eds.EdsSetPropertyEventHandler(_camera, Eds.PropertyEvent_All, _onProperty, IntPtr.Zero), "SetPropertyEventHandler");
        Check(Eds.EdsSetCameraStateEventHandler(_camera, Eds.StateEvent_All, _onState, IntPtr.Zero), "SetCameraStateEventHandler");
        Check(Eds.EdsOpenSession(_camera), "OpenSession");
        _sessionOpen = true;

        // transfer every image straight to this PC
        var saveTo = Eds.SaveTo_Host;
        Check(Eds.EdsSetPropertyData(_camera, Eds.PropID_SaveTo, 0, sizeof(uint), ref saveTo), "SetSaveTo");
        Check(Eds.EdsSetCapacity(_camera, new Eds.Capacity { NumberOfFreeClusters = 0x7FFFFFFF, BytesPerSector = 0x1000, Reset = 1 }), "SetCapacity");
        foreach (var id in new[] { Eds.PropID_BatteryLevel, Eds.PropID_ImageQuality, Eds.PropID_ISOSpeed, Eds.PropID_Av, Eds.PropID_Tv, Eds.PropID_ExposureCompensation, Eds.PropID_AEMode })
            ReadProp(id);
        RefreshDescriptors();
        _lastError = null;
        _log.LogInformation("Canon session opened: {Model}", _model);
        StatusChanged?.Invoke();
    });

    private void ReadProp(uint id)
    {
        if (Eds.EdsGetPropertyData(_camera, id, 0, sizeof(uint), out uint value) == Eds.EDS_ERR_OK) _props[id] = value;
    }

    private void CloseSessionInternal()
    {
        if (_camera == IntPtr.Zero) return;
        try
        {
            if (_liveView) SetEvfOutput(enable: false);
            if (_sessionOpen) Eds.EdsCloseSession(_camera);
        }
        finally
        {
            _sessionOpen = false;
            _liveView = false;
            Eds.EdsRelease(_camera);
            _camera = IntPtr.Zero;
        }
    }

    public Task DisconnectAsync() => Run(CloseSessionInternal);

    public int FilesPerShot
    {
        get
        {
            // EdsImageQuality: low 16 bits describe the secondary image; 0xFF0F = none
            if (!_props.TryGetValue(Eds.PropID_ImageQuality, out var q)) return 1;
            return (q & 0xFFFF) == 0xFF0F ? 1 : 2;
        }
    }

    private string QualityLabel()
    {
        if (!_props.TryGetValue(Eds.PropID_ImageQuality, out var q)) return "—";
        static bool IsRaw(uint formatByte) => (formatByte >> 4) is 0x2 or 0x4 or 0x6;
        var primaryRaw = IsRaw((q >> 16) & 0xFF);
        var hasSecondary = (q & 0xFFFF) != 0xFF0F;
        return (primaryRaw, hasSecondary) switch
        {
            (true, true) => "RAW + JPEG",
            (true, false) => "RAW",
            _ => "JPEG",
        };
    }

    public CameraStatus GetStatus()
    {
        var connected = _sessionOpen;
        var controls = new List<CameraControl>();
        if (connected)
        {
            foreach (var (id, label, table) in new[]
            {
                (Eds.PropID_ISOSpeed, "ISO", ExposureTables.Iso),
                (Eds.PropID_Tv, "מהירות תריס", ExposureTables.Tv),
                (Eds.PropID_Av, "צמצם", ExposureTables.Av),
                (Eds.PropID_ExposureCompensation, "פיצוי חשיפה", ExposureTables.Comp),
            })
            {
                var desc = _descCache.TryGetValue(id, out var d) ? d : null;
                if (desc is null || desc.Length == 0) continue; // only what the camera says is settable now
                _props.TryGetValue(id, out var cur);
                controls.Add(new CameraControl(
                    $"prop:{id:X}", label, "select", cur.ToString(),
                    desc.Select(v => new ControlOption(((uint)v).ToString(), ExposureTables.Label(table, (uint)v))).ToList()));
            }
            controls.Add(new CameraControl("afOnShutter", "מיקוד אוטומטי בכל צילום", "toggle", _afOnShutter));
        }
        _props.TryGetValue(Eds.PropID_BatteryLevel, out var battery);
        return new CameraStatus
        {
            Kind = "CANON",
            Model = _model,
            Connected = connected,
            Battery = connected && battery <= 100 ? (int)battery : null, // 0xFFFFFFFF = AC power
            LiveView = _liveView,
            Resolution = null, // known per file after transfer; the R7 setting is read from the camera menu
            Formats = connected ? [QualityLabel()] : [],
            CanAutofocus = connected,
            HardwareShutter = true,
            Controls = controls,
            Readouts = connected
                ?
                [
                    new Readout("ISO", ExposureTables.Label(ExposureTables.Iso, _props.GetValueOrDefault(Eds.PropID_ISOSpeed))),
                    new Readout("תריס", ExposureTables.Label(ExposureTables.Tv, _props.GetValueOrDefault(Eds.PropID_Tv))),
                    new Readout("צמצם", ExposureTables.Label(ExposureTables.Av, _props.GetValueOrDefault(Eds.PropID_Av))),
                    new Readout("פיצוי", ExposureTables.Label(ExposureTables.Comp, _props.GetValueOrDefault(Eds.PropID_ExposureCompensation))),
                ]
                : [],
            LastError = _lastError,
        };
    }

    private readonly ConcurrentDictionary<uint, int[]> _descCache = new();

    /// <summary>Refreshes allowed values of exposure properties (they change with the mode dial).</summary>
    private void RefreshDescriptors()
    {
        foreach (var id in new[] { Eds.PropID_ISOSpeed, Eds.PropID_Tv, Eds.PropID_Av, Eds.PropID_ExposureCompensation })
        {
            if (Eds.EdsGetPropertyDesc(_camera, id, out var desc) == Eds.EDS_ERR_OK && desc.NumElements > 0 && desc.PropDesc is not null)
                _descCache[id] = desc.PropDesc.Take(Math.Min(desc.NumElements, desc.PropDesc.Length)).ToArray();
            else
                _descCache.TryRemove(id, out _);
        }
    }

    public Task TriggerShutterAsync(CancellationToken ct) => Run(() =>
    {
        if (!_sessionOpen) throw new CameraException("המצלמה אינה מחוברת");
        var press = _afOnShutter ? Eds.ShutterButton_Completely : Eds.ShutterButton_Completely_NonAF;
        uint err = 0;
        for (var attempt = 0; attempt < 5; attempt++)
        {
            err = Eds.EdsSendCommand(_camera, Eds.CameraCommand_PressShutterButton, press);
            if (err != Eds.EDS_ERR_DEVICE_BUSY) break;
            Thread.Sleep(120);
        }
        Eds.EdsSendCommand(_camera, Eds.CameraCommand_PressShutterButton, Eds.ShutterButton_OFF);
        Check(err, "PressShutterButton");
    });

    public Task SetControlAsync(string id, string value, CancellationToken ct) => Run(() =>
    {
        if (id == "afOnShutter")
        {
            _afOnShutter = value is "true" or "True" or "1";
            return;
        }
        if (!id.StartsWith("prop:", StringComparison.Ordinal)) throw new CameraException("הגדרה לא נתמכת");
        var prop = Convert.ToUInt32(id[5..], 16);
        var v = uint.Parse(value);
        if (!_descCache.TryGetValue(prop, out var allowed) || !allowed.Contains((int)v))
            throw new CameraException("הערך אינו נתמך במצב הנוכחי של המצלמה (בדקו את חוגת המצבים)");
        Check(Eds.EdsSetPropertyData(_camera, prop, 0, sizeof(uint), ref v), "SetProperty");
        _props[prop] = v;
    });

    public Task AutofocusAsync(CancellationToken ct) => Run(() =>
    {
        if (!_sessionOpen) throw new CameraException("המצלמה אינה מחוברת");
        if (_liveView)
        {
            Check(Eds.EdsSendCommand(_camera, Eds.CameraCommand_DoEvfAf, Eds.EvfAf_ON), "DoEvfAf");
            Thread.Sleep(600);
            Eds.EdsSendCommand(_camera, Eds.CameraCommand_DoEvfAf, Eds.EvfAf_OFF);
        }
        else
        {
            Check(Eds.EdsSendCommand(_camera, Eds.CameraCommand_PressShutterButton, Eds.ShutterButton_Halfway), "AF");
            Thread.Sleep(600);
            Eds.EdsSendCommand(_camera, Eds.CameraCommand_PressShutterButton, Eds.ShutterButton_OFF);
        }
    });

    public byte[]? LatestLiveViewFrame => _liveView ? _frame : null;

    public Task StartLiveViewAsync(CancellationToken ct) => Run(() =>
    {
        if (!_sessionOpen) return;
        SetEvfOutput(enable: true);
        _liveView = true;
        RefreshDescriptors();
    });

    public Task StopLiveViewAsync() => Run(() =>
    {
        if (_sessionOpen) SetEvfOutput(enable: false);
        _liveView = false;
        _frame = null;
    });

    private void SetEvfOutput(bool enable)
    {
        if (Eds.EdsGetPropertyData(_camera, Eds.PropID_Evf_OutputDevice, 0, sizeof(uint), out uint device) != Eds.EDS_ERR_OK) device = 0;
        var next = enable ? device | Eds.EvfOutputDevice_PC : device & ~Eds.EvfOutputDevice_PC;
        Eds.EdsSetPropertyData(_camera, Eds.PropID_Evf_OutputDevice, 0, sizeof(uint), ref next);
    }

    private DateTime _lastFrame = DateTime.MinValue;

    /// <summary>Pulls one EVF JPEG (≤15 fps). Live view stays on this PC — it is never sent to the cloud.</summary>
    private void GrabLiveViewFrame()
    {
        if ((DateTime.UtcNow - _lastFrame).TotalMilliseconds < 66) return;
        _lastFrame = DateTime.UtcNow;
        IntPtr stream = IntPtr.Zero, evf = IntPtr.Zero;
        try
        {
            if (Eds.EdsCreateMemoryStream(0, out stream) != Eds.EDS_ERR_OK) return;
            if (Eds.EdsCreateEvfImageRef(stream, out evf) != Eds.EDS_ERR_OK) return;
            var err = Eds.EdsDownloadEvfImage(_camera, evf);
            if (err == Eds.EDS_ERR_OBJECT_NOTREADY) return; // first frames after enabling EVF
            if (err != Eds.EDS_ERR_OK) return;
            Eds.EdsGetPointer(stream, out var ptr);
            Eds.EdsGetLength(stream, out var len);
            if (len == 0 || len > 20_000_000) return;
            var bytes = new byte[(int)len];
            Marshal.Copy(ptr, bytes, 0, (int)len);
            _frame = bytes;
        }
        finally
        {
            if (evf != IntPtr.Zero) Eds.EdsRelease(evf);
            if (stream != IntPtr.Zero) Eds.EdsRelease(stream);
        }
    }

    // ── SDK callbacks (arrive on the pump thread during EdsGetEvent) ─────────
    private uint OnObjectEvent(uint inEvent, IntPtr inRef, IntPtr ctx)
    {
        if (inEvent == Eds.ObjectEvent_DirItemRequestTransfer)
        {
            Download(inRef);
            return Eds.EDS_ERR_OK;
        }
        if (inRef != IntPtr.Zero) Eds.EdsRelease(inRef);
        return Eds.EDS_ERR_OK;
    }

    private void Download(IntPtr dirItem)
    {
        IntPtr stream = IntPtr.Zero;
        string? staging = null;
        try
        {
            Check(Eds.EdsGetDirectoryItemInfo(dirItem, out var info), "GetDirectoryItemInfo");
            staging = _stagingPathFor(info.szFileName);
            Check(Eds.EdsCreateFileStream(staging, Eds.FileCreateDisposition.CreateAlways, Eds.Access.ReadWrite, out stream), "CreateFileStream");
            Check(Eds.EdsDownload(dirItem, info.Size, stream), "Download");
            Check(Eds.EdsDownloadComplete(dirItem), "DownloadComplete");
            Eds.EdsRelease(stream);
            stream = IntPtr.Zero;
            var size = new FileInfo(staging).Length;
            if ((ulong)size != info.Size) throw new CameraException($"הקובץ שהתקבל חלקי ({size}/{info.Size} בתים)");
            FileReady?.Invoke(new CameraFileReady(staging, info.szFileName, size));
        }
        catch (Exception ex)
        {
            _lastError = ex.Message;
            _log.LogError(ex, "image transfer failed");
            Eds.EdsDownloadCancel(dirItem);
            // a partial staging file is left in place; startup recovery quarantines it, never deletes it
            StatusChanged?.Invoke();
        }
        finally
        {
            if (stream != IntPtr.Zero) Eds.EdsRelease(stream);
            Eds.EdsRelease(dirItem);
        }
    }

    private uint OnPropertyEvent(uint inEvent, uint propId, uint param, IntPtr ctx)
    {
        if (inEvent == Eds.PropertyEvent_PropertyChanged)
        {
            ReadProp(propId);
            if (propId is Eds.PropID_AEMode or Eds.PropID_ISOSpeed or Eds.PropID_Tv or Eds.PropID_Av) RefreshDescriptors();
            StatusChanged?.Invoke();
        }
        return Eds.EDS_ERR_OK;
    }

    private uint OnStateEvent(uint inEvent, uint param, IntPtr ctx)
    {
        switch (inEvent)
        {
            case Eds.StateEvent_WillSoonShutDown:
                Eds.EdsSendCommand(_camera, Eds.CameraCommand_ExtendShutDownTimer, 0);
                break;
            case Eds.StateEvent_Shutdown:
            case Eds.StateEvent_InternalError:
                _lastError = inEvent == Eds.StateEvent_Shutdown ? "המצלמה נותקה או כובתה" : "שגיאה פנימית במצלמה";
                _sessionOpen = false;
                _liveView = false;
                if (_camera != IntPtr.Zero)
                {
                    Eds.EdsRelease(_camera);
                    _camera = IntPtr.Zero;
                }
                Disconnected?.Invoke(_lastError);
                break;
        }
        return Eds.EDS_ERR_OK;
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            await Run(() =>
            {
                CloseSessionInternal();
                if (_sdkInitialized)
                {
                    Eds.EdsTerminateSDK();
                    _sdkInitialized = false;
                }
            }).WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "EDSDK shutdown");
        }
        _cts.Cancel();
        _work.CompleteAdding();
    }
}
