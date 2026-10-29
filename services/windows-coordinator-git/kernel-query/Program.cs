using System.Runtime.InteropServices;
using System.Text.Json;

// Disposable query-only fixture. No StartTrace, StopTrace, or alternate
// ControlTrace control code is reachable from this image.
internal static class Program
{
    private const string KernelLoggerName = "NT Kernel Logger";
    private const uint EventTraceControlQuery = 0;
    private const uint ErrorSuccess = 0;
    private const uint ErrorWmiInstanceNotFound = 4201;
    private const uint WnodeFlagTracedGuid = 0x00020000;
    private const int MaximumNameChars = 1024;
    private static readonly Guid SystemTraceControlGuid =
        new("9e814aad-3204-11d2-9a82-006008a86939");

    private static int Main(string[] args)
    {
        try { return Run(args); }
        catch (Exception)
        {
            // Never leak a native exception, logger path, or host detail.
            return Emit("refused", "native_query_exception", null, null, 3);
        }
    }

    private static int Run(string[] args)
    {
        if (args is ["--selftest"])
            return SelfTest();
        if (args is not ["--query"] || !OperatingSystem.IsWindows() ||
            RuntimeInformation.ProcessArchitecture != Architecture.X64)
            return Emit("refused", "explicit_windows_x64_query_required", null, null, 3);
        if (!LayoutIsExpected())
            return Emit("refused", "native_layout_unavailable", null, null, 3);

        var structureSize = Marshal.SizeOf<EventTraceProperties>();
        var loggerOffset = structureSize;
        var logFileOffset = checked(loggerOffset + (MaximumNameChars + 1) * sizeof(char));
        var capacity = checked(logFileOffset + (MaximumNameChars + 1) * sizeof(char));
        var buffer = Marshal.AllocHGlobal(capacity);
        try
        {
            Marshal.Copy(new byte[capacity], 0, buffer, capacity);
            var properties = new EventTraceProperties
            {
                Wnode = new WnodeHeader
                {
                    BufferSize = checked((uint)capacity),
                    Guid = SystemTraceControlGuid,
                    Flags = WnodeFlagTracedGuid,
                },
                LoggerNameOffset = checked((uint)loggerOffset),
                LogFileNameOffset = checked((uint)logFileOffset),
            };
            Marshal.StructureToPtr(properties, buffer, false);

            // TraceId 0 and one fixed name select only the NT Kernel Logger.
            // Control code 0 is EVENT_TRACE_CONTROL_QUERY, never STOP/UPDATE.
            uint code;
            try
            {
                code = ControlTraceW(0, KernelLoggerName, buffer, EventTraceControlQuery);
            }
            catch (DllNotFoundException)
            {
                return Emit("refused", "native_query_unavailable", null, null, 3);
            }
            catch (EntryPointNotFoundException)
            {
                return Emit("refused", "native_query_unavailable", null, null, 3);
            }

            if (code == ErrorWmiInstanceNotFound)
                return Emit("absent", "kernel_logger_not_running", code, null, 0);
            if (code != ErrorSuccess)
                return Emit("refused", "native_query_failed", code, null, 3);

            var observed = Marshal.PtrToStructure<EventTraceProperties>(buffer);
            if (observed.Wnode.BufferSize < structureSize ||
                observed.Wnode.BufferSize > capacity ||
                observed.Wnode.Guid != SystemTraceControlGuid ||
                observed.LoggerNameOffset < structureSize ||
                observed.LoggerNameOffset >= capacity ||
                observed.LogFileNameOffset < structureSize ||
                observed.LogFileNameOffset >= capacity)
                return Emit("refused", "native_query_readback_invalid", code, null, 3);

            var counters = new Counters(
                observed.EventsLost,
                observed.LogBuffersLost,
                observed.RealTimeBuffersLost);
            // An existing logger is foreign until a later trace transaction
            // proves it owns the session. Never stop or reuse it here.
            return Emit("occupied", "kernel_logger_already_running", code, counters, 3);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static int SelfTest()
    {
        var supportedHost = OperatingSystem.IsWindows() &&
            RuntimeInformation.ProcessArchitecture == Architecture.X64;
        var layout = supportedHost && LayoutIsExpected();
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            schemaVersion = "lexrunner-windows-kernel-logger-query/1",
            result = layout ? "source_fixture_pass" : "source_fixture_refused",
            reasonCode = !supportedHost ? "windows_x64_required" :
                layout ? "layout_verified" : "native_layout_unavailable",
            structureSize = Marshal.SizeOf<EventTraceProperties>(),
            controlCode = EventTraceControlQuery,
            nativeQueryInvoked = false,
            traceStarted = false,
            traceStopped = false,
            authorizesLoaderClosure = false,
            authorizesExecution = false,
        }));
        return layout ? 0 : 3;
    }

    private static bool LayoutIsExpected() =>
        Marshal.SizeOf<WnodeHeader>() == 48 &&
        Marshal.SizeOf<EventTraceProperties>() == 120 &&
        Marshal.OffsetOf<EventTraceProperties>(nameof(EventTraceProperties.EventsLost)).ToInt32() == 88 &&
        Marshal.OffsetOf<EventTraceProperties>(nameof(EventTraceProperties.LogBuffersLost)).ToInt32() == 96 &&
        Marshal.OffsetOf<EventTraceProperties>(nameof(EventTraceProperties.RealTimeBuffersLost)).ToInt32() == 100 &&
        Marshal.OffsetOf<EventTraceProperties>(nameof(EventTraceProperties.LogFileNameOffset)).ToInt32() == 112 &&
        Marshal.OffsetOf<EventTraceProperties>(nameof(EventTraceProperties.LoggerNameOffset)).ToInt32() == 116;

    private static int Emit(string result, string reasonCode, uint? errorCode, Counters? counters, int exit)
    {
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            schemaVersion = "lexrunner-windows-kernel-logger-query/1",
            result,
            reasonCode,
            errorCode,
            counters,
            queryOnly = true,
            traceStarted = false,
            traceStopped = false,
            authorizesLoaderClosure = false,
            authorizesExecution = false,
        }));
        return exit;
    }

    private sealed record Counters(uint EventsLost, uint LogBuffersLost, uint RealTimeBuffersLost);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("Sechost.dll", EntryPoint = "ControlTraceW", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern uint ControlTraceW(ulong traceId, [MarshalAs(UnmanagedType.LPWStr)] string instanceName,
        IntPtr properties, uint controlCode);

    [StructLayout(LayoutKind.Sequential)]
    private struct WnodeHeader
    {
        public uint BufferSize;
        public uint ProviderId;
        public ulong HistoricalContext;
        public long TimeStamp;
        public Guid Guid;
        public uint ClientContext;
        public uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EventTraceProperties
    {
        public WnodeHeader Wnode;
        public uint BufferSize;
        public uint MinimumBuffers;
        public uint MaximumBuffers;
        public uint MaximumFileSize;
        public uint LogFileMode;
        public uint FlushTimer;
        public uint EnableFlags;
        public int AgeLimit;
        public uint NumberOfBuffers;
        public uint FreeBuffers;
        public uint EventsLost;
        public uint BuffersWritten;
        public uint LogBuffersLost;
        public uint RealTimeBuffersLost;
        public IntPtr LoggerThreadId;
        public uint LogFileNameOffset;
        public uint LoggerNameOffset;
    }
}
