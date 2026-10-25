using System.Reflection;
using System.Runtime.InteropServices;

namespace AvotCapture.Canon;

/// <summary>
/// P/Invoke surface of the official Canon EDSDK (Windows x64, EDSDK 13.x —
/// the EOS R7 requires a 13.x release). Signatures follow EDSDK.h /
/// EDSDKTypes.h; 64-bit builds use EdsUInt64 for sizes (download length,
/// memory streams, directory item size).
///
/// HARDWARE STATUS: compiled and loaded, but NOT yet exercised against a
/// physical EOS R7 — see docs/hardware-acceptance.md.
/// </summary>
internal static class Eds
{
    public const string Dll = "EDSDK.dll";

    private static string? _searchDir;

    /// <summary>Points the loader at the folder containing EDSDK.dll (+ EdsImage.dll). Must run before the first call.</summary>
    public static bool TryConfigure(string? folder, out string? error)
    {
        error = null;
        var candidates = new[]
        {
            folder,
            Path.Combine(AppContext.BaseDirectory, "EDSDK"),
            AppContext.BaseDirectory,
        }.Where(p => !string.IsNullOrWhiteSpace(p)).Select(p => p!).ToList();
        _searchDir = candidates.FirstOrDefault(d => File.Exists(Path.Combine(d, Dll)));
        if (_searchDir is null)
        {
            error = "Canon EDSDK לא הותקן בעמדה זו (EDSDK.dll לא נמצא). ראו docs/canon-edsdk.md.";
            return false;
        }
        try
        {
            NativeLibrary.SetDllImportResolver(typeof(Eds).Assembly, Resolve);
        }
        catch (InvalidOperationException)
        {
            /* resolver already set */
        }
        // EDSDK.dll loads EdsImage.dll from its own folder
        NativeLibrary.Load(Path.Combine(_searchDir, Dll));
        return true;
    }

    private static IntPtr Resolve(string name, Assembly asm, DllImportSearchPath? path)
    {
        if (_searchDir is not null && name.Equals(Dll, StringComparison.OrdinalIgnoreCase))
            return NativeLibrary.Load(Path.Combine(_searchDir, Dll));
        return IntPtr.Zero;
    }

    // ── errors ───────────────────────────────────────────────────
    public const uint EDS_ERR_OK = 0x00000000;
    public const uint EDS_ERR_DEVICE_BUSY = 0x00000081;
    public const uint EDS_ERR_DEVICE_NOT_FOUND = 0x00000080;
    public const uint EDS_ERR_SESSION_NOT_OPEN = 0x00002003;
    public const uint EDS_ERR_TAKE_PICTURE_AF_NG = 0x00008D01;
    public const uint EDS_ERR_TAKE_PICTURE_CARD_NG = 0x00008D07;
    public const uint EDS_ERR_OBJECT_NOTREADY = 0x0000A102;
    public const uint EDS_ERR_COMM_PORT_IS_IN_USE = 0x000000C0;
    public const uint EDS_ERR_COMM_DISCONNECTED = 0x000000C1;

    // ── property ids ─────────────────────────────────────────────
    public const uint PropID_ProductName = 0x00000002;
    public const uint PropID_BatteryLevel = 0x00000008;
    public const uint PropID_SaveTo = 0x0000000B;
    public const uint PropID_ImageQuality = 0x00000100;
    public const uint PropID_AEMode = 0x00000400;
    public const uint PropID_ISOSpeed = 0x00000402;
    public const uint PropID_Av = 0x00000405;
    public const uint PropID_Tv = 0x00000406;
    public const uint PropID_ExposureCompensation = 0x00000407;
    public const uint PropID_AvailableShots = 0x0000040A;
    public const uint PropID_Evf_OutputDevice = 0x00000500;
    public const uint PropID_Evf_Mode = 0x00000501;

    public const uint SaveTo_Camera = 1;
    public const uint SaveTo_Host = 2;
    public const uint SaveTo_Both = 3;
    public const uint EvfOutputDevice_TFT = 1;
    public const uint EvfOutputDevice_PC = 2;

    // ── commands ─────────────────────────────────────────────────
    public const uint CameraCommand_TakePicture = 0x00000000;
    public const uint CameraCommand_ExtendShutDownTimer = 0x00000001;
    public const uint CameraCommand_PressShutterButton = 0x00000004;
    public const uint CameraCommand_DoEvfAf = 0x00000102;
    public const int ShutterButton_OFF = 0x00000000;
    public const int ShutterButton_Halfway = 0x00000001;
    public const int ShutterButton_Completely = 0x00000003;
    public const int ShutterButton_Halfway_NonAF = 0x00010001;
    public const int ShutterButton_Completely_NonAF = 0x00010003;
    public const int EvfAf_OFF = 0;
    public const int EvfAf_ON = 1;

    // ── events ───────────────────────────────────────────────────
    public const uint PropertyEvent_All = 0x00000100;
    public const uint PropertyEvent_PropertyChanged = 0x00000101;
    public const uint ObjectEvent_All = 0x00000200;
    public const uint ObjectEvent_DirItemRequestTransfer = 0x00000208;
    public const uint StateEvent_All = 0x00000300;
    public const uint StateEvent_Shutdown = 0x00000301;
    public const uint StateEvent_WillSoonShutDown = 0x00000303;
    public const uint StateEvent_InternalError = 0x00000306;

    public enum FileCreateDisposition : uint { CreateNew = 0, CreateAlways = 1, OpenExisting = 2, OpenAlways = 3, TruncateExisting = 4 }
    public enum Access : uint { Read = 0, Write = 1, ReadWrite = 2, Error = 0xFFFFFFFF }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public struct DeviceInfo
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szPortName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szDeviceDescription;
        public uint DeviceSubType;
        public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public struct DirectoryItemInfo
    {
        public ulong Size;
        public int IsFolder;
        public uint GroupID;
        public uint Option;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szFileName;
        public uint Format;
        public uint DateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Capacity
    {
        public int NumberOfFreeClusters;
        public int BytesPerSector;
        public int Reset;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PropertyDesc
    {
        public int Form;
        public int Access;
        public int NumElements;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 128)] public int[] PropDesc;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate uint ObjectEventHandler(uint inEvent, IntPtr inRef, IntPtr inContext);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate uint PropertyEventHandler(uint inEvent, uint inPropertyID, uint inParam, IntPtr inContext);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate uint StateEventHandler(uint inEvent, uint inParameter, IntPtr inContext);

    [DllImport(Dll)] public static extern uint EdsInitializeSDK();
    [DllImport(Dll)] public static extern uint EdsTerminateSDK();
    [DllImport(Dll)] public static extern uint EdsRelease(IntPtr inRef);
    [DllImport(Dll)] public static extern uint EdsGetCameraList(out IntPtr outCameraListRef);
    [DllImport(Dll)] public static extern uint EdsGetChildCount(IntPtr inRef, out int outCount);
    [DllImport(Dll)] public static extern uint EdsGetChildAtIndex(IntPtr inRef, int inIndex, out IntPtr outRef);
    [DllImport(Dll)] public static extern uint EdsGetDeviceInfo(IntPtr inCameraRef, out DeviceInfo outDeviceInfo);
    [DllImport(Dll)] public static extern uint EdsOpenSession(IntPtr inCameraRef);
    [DllImport(Dll)] public static extern uint EdsCloseSession(IntPtr inCameraRef);
    [DllImport(Dll)] public static extern uint EdsSendCommand(IntPtr inCameraRef, uint inCommand, int inParam);
    [DllImport(Dll)] public static extern uint EdsSetCapacity(IntPtr inCameraRef, Capacity inCapacity);
    [DllImport(Dll)] public static extern uint EdsGetPropertySize(IntPtr inRef, uint inPropertyID, int inParam, out uint outDataType, out int outSize);
    [DllImport(Dll)] public static extern uint EdsGetPropertyData(IntPtr inRef, uint inPropertyID, int inParam, int inPropertySize, out uint outPropertyData);
    [DllImport(Dll)] public static extern uint EdsGetPropertyData(IntPtr inRef, uint inPropertyID, int inParam, int inPropertySize, IntPtr outPropertyData);
    [DllImport(Dll)] public static extern uint EdsSetPropertyData(IntPtr inRef, uint inPropertyID, int inParam, int inPropertySize, ref uint inPropertyData);
    [DllImport(Dll)] public static extern uint EdsGetPropertyDesc(IntPtr inRef, uint inPropertyID, out PropertyDesc outPropertyDesc);
    [DllImport(Dll)] public static extern uint EdsSetObjectEventHandler(IntPtr inCameraRef, uint inEvent, ObjectEventHandler inHandler, IntPtr inContext);
    [DllImport(Dll)] public static extern uint EdsSetPropertyEventHandler(IntPtr inCameraRef, uint inEvent, PropertyEventHandler inHandler, IntPtr inContext);
    [DllImport(Dll)] public static extern uint EdsSetCameraStateEventHandler(IntPtr inCameraRef, uint inEvent, StateEventHandler inHandler, IntPtr inContext);
    [DllImport(Dll)] public static extern uint EdsGetDirectoryItemInfo(IntPtr inDirItemRef, out DirectoryItemInfo outDirItemInfo);
    [DllImport(Dll, CharSet = CharSet.Ansi)] public static extern uint EdsCreateFileStream(string inFileName, FileCreateDisposition inCreateDisposition, Access inDesiredAccess, out IntPtr outStream);
    [DllImport(Dll)] public static extern uint EdsCreateMemoryStream(ulong inBufferSize, out IntPtr outStream);
    [DllImport(Dll)] public static extern uint EdsGetPointer(IntPtr inStreamRef, out IntPtr outPointer);
    [DllImport(Dll)] public static extern uint EdsGetLength(IntPtr inStreamRef, out ulong outLength);
    [DllImport(Dll)] public static extern uint EdsDownload(IntPtr inDirItemRef, ulong inReadSize, IntPtr outStream);
    [DllImport(Dll)] public static extern uint EdsDownloadComplete(IntPtr inDirItemRef);
    [DllImport(Dll)] public static extern uint EdsDownloadCancel(IntPtr inDirItemRef);
    [DllImport(Dll)] public static extern uint EdsCreateEvfImageRef(IntPtr inStreamRef, out IntPtr outEvfImageRef);
    [DllImport(Dll)] public static extern uint EdsDownloadEvfImage(IntPtr inCameraRef, IntPtr inEvfImageRef);
    [DllImport(Dll)] public static extern uint EdsGetEvent();

    public static string Hex(uint err) => $"0x{err:X8}";
}
