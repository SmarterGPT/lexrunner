using System.Runtime.InteropServices;

// Instantiated only by the guarded manual disposable-runner calibration route.
// Ordinary capture and all product execution authority remain disabled.
internal sealed class NativeTraceAdapter : ITraceAdapter
{
    // Observed hosted terminal profile only, not a universal ETW guarantee.
    internal const uint ExpectedTerminalFlags = 0;
    private const uint EventTraceControlQuery = 0;
    private const uint EventTraceControlStop = 1;
    private const uint WnodeFlagTracedGuid = 0x00020000;
    private const int MaximumNameChars = 1024;
    private const uint BufferSizeKib = 64;
    private const uint MinimumBuffers = 64;
    private const uint MaximumBuffers = 128;
    private const uint MaximumFileSizeMib = 128;

    private readonly TraceIdentity _expected;
    private readonly OwnedHandleGate _gate;

    internal NativeTraceAdapter(TraceIdentity expected)
    {
        _expected = expected;
        _gate = new OwnedHandleGate(expected);
    }

    internal static bool IdentityIsBounded(TraceIdentity expected) =>
        expected.Guid != Guid.Empty &&
        expected.Name is "LexRunner Windows Git Loader Qualification" &&
        expected.Name.Length < MaximumNameChars &&
        expected.EtlPath.Length > 0 &&
        expected.EtlPath.Length < MaximumNameChars &&
        !expected.EtlPath.Contains('\0') &&
        Path.IsPathFullyQualified(expected.EtlPath) &&
        expected.Mode == 0x02400001 && expected.Flags == 0x06000307;

    internal static bool LayoutIsExpected() =>
        OperatingSystem.IsWindows() &&
        RuntimeInformation.ProcessArchitecture == Architecture.X64 &&
        Marshal.SizeOf<WnodeHeader>() == 48 &&
        Marshal.SizeOf<EventTraceProperties>() == 120 &&
        Marshal.OffsetOf<EventTraceProperties>(nameof(EventTraceProperties.EventsLost)).ToInt32() == 88 &&
        Marshal.OffsetOf<EventTraceProperties>(nameof(EventTraceProperties.LogBuffersLost)).ToInt32() == 96 &&
        Marshal.OffsetOf<EventTraceProperties>(nameof(EventTraceProperties.RealTimeBuffersLost)).ToInt32() == 100 &&
        Marshal.OffsetOf<EventTraceProperties>(nameof(EventTraceProperties.LogFileNameOffset)).ToInt32() == 112 &&
        Marshal.OffsetOf<EventTraceProperties>(nameof(EventTraceProperties.LoggerNameOffset)).ToInt32() == 116;

    internal static bool SyntheticObservationReadback()
    {
        var expected = new TraceIdentity("LexRunner Windows Git Loader Qualification",
            Guid.Parse("f6a585fc-57f8-4805-8599-d671282184f5"),
            @"C:\private\fresh\git-loader.etl", 0x02400001, 0x06000307);
        var buffer = Allocate(expected.Guid);
        try
        {
            var props = Marshal.PtrToStructure<EventTraceProperties>(buffer);
            props.LogFileMode = expected.Mode;
            props.EnableFlags = expected.Flags;
            props.EventsLost = 1;
            props.LogBuffersLost = 2;
            props.RealTimeBuffersLost = 3;
            Marshal.StructureToPtr(props, buffer, false);
            WriteString(buffer, props.LoggerNameOffset, expected.Name);
            WriteString(buffer, props.LogFileNameOffset, expected.EtlPath);
            var matched = TryReadObservation(buffer, out var observed) &&
                observed is not null && observed.Name == expected.Name &&
                observed.Guid == expected.Guid &&
                observed.EtlPath == expected.EtlPath &&
                observed.Mode == expected.Mode && observed.Flags == expected.Flags &&
                observed.EventsLost == 1 && observed.LogBuffersLost == 2 &&
                observed.RealTimeBuffersLost == 3;
            props.LoggerNameOffset = checked((uint)Capacity);
            Marshal.StructureToPtr(props, buffer, false);
            return matched && !TryReadObservation(buffer, out _);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    internal static bool SyntheticParseFailure(string expectedFailure)
    {
        var buffer = Allocate(Guid.Empty);
        try
        {
            var props = Marshal.PtrToStructure<EventTraceProperties>(buffer);
            WriteString(buffer, props.LoggerNameOffset, "logger");
            WriteString(buffer, props.LogFileNameOffset, "file");
            var logger = expectedFailure.StartsWith("logger_", StringComparison.Ordinal);
            var target = logger ? props.LoggerNameOffset : props.LogFileNameOffset;
            var failure = expectedFailure[(expectedFailure.IndexOf('_') + 1)..];
            if (expectedFailure == "capacity_low") props.Wnode.BufferSize = 119;
            else if (expectedFailure == "capacity_high") props.Wnode.BufferSize = (uint)Capacity + 1;
            else if (failure == "offset")
            { if (logger) props.LoggerNameOffset = 1; else props.LogFileNameOffset = 1; }
            else if (failure == "bounds")
            {
                target = (uint)Capacity - 2;
                if (logger) props.LoggerNameOffset = target; else props.LogFileNameOffset = target;
                Marshal.WriteInt16(buffer, (int)target, (short)'x');
            }
            else if (failure == "empty") Marshal.WriteInt16(buffer, (int)target, 0);
            else if (failure == "termination")
                for (var i = 0; i < MaximumNameChars; i++)
                    Marshal.WriteInt16(buffer, (int)target + i * 2, (short)'x');
            else return false;
            Marshal.StructureToPtr(props, buffer, false);
            return !TryReadObservation(buffer, out _, out var actual) &&
                actual == (expectedFailure.StartsWith("capacity_", StringComparison.Ordinal) ? "capacity" : expectedFailure);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    public StartResult Start(TraceIdentity expected)
    {
        if (!_gate.BeginStart() || !LayoutIsExpected() ||
            expected != _expected || !IdentityIsBounded(expected))
            return new StartResult(87, 0); // ERROR_INVALID_PARAMETER

        var buffer = Allocate(expected.Guid);
        try
        {
            var props = Marshal.PtrToStructure<EventTraceProperties>(buffer);
            props.BufferSize = BufferSizeKib;
            props.MinimumBuffers = MinimumBuffers;
            props.MaximumBuffers = MaximumBuffers;
            props.MaximumFileSize = MaximumFileSizeMib;
            props.LogFileMode = expected.Mode;
            props.EnableFlags = expected.Flags;
            props.Wnode.ClientContext = 1; // QPC; no system-time clock request
            Marshal.StructureToPtr(props, buffer, false);
            WriteString(buffer, props.LogFileNameOffset, expected.EtlPath);
            uint code;
            ulong handle;
            try { code = StartTraceW(out handle, expected.Name, buffer); }
            catch (DllNotFoundException) { return new StartResult(127, 0); }
            catch (EntryPointNotFoundException) { return new StartResult(127, 0); }
            var result = new StartResult(code, code == 0 ? handle : 0);
            _gate.CompleteStart(result);
            return result;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    public QueryResult Query(ulong returnedHandle)
    {
        if (!LayoutIsExpected() || !_gate.BeginQuery(returnedHandle))
            return new QueryResult(87, null, new NativeActionDiagnostic(null, "precheck"));
        var buffer = Allocate(_expected.Guid);
        try
        {
            uint code;
            try { code = ControlTraceW(returnedHandle, null, buffer, EventTraceControlQuery); }
            catch (DllNotFoundException)
            {
                var missing = new QueryResult(127, null, new NativeActionDiagnostic(null, "import"));
                _gate.CompleteQuery(returnedHandle, missing);
                return missing;
            }
            catch (EntryPointNotFoundException)
            {
                var missing = new QueryResult(127, null, new NativeActionDiagnostic(null, "import"));
                _gate.CompleteQuery(returnedHandle, missing);
                return missing;
            }
            return CompleteNativeQuery(returnedHandle, code, buffer);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private QueryResult CompleteNativeQuery(ulong returnedHandle, uint code, IntPtr buffer)
    {
        if (code != 0)
        {
            var failed = new QueryResult(code, null, new NativeActionDiagnostic(code, "native"));
            _gate.CompleteQuery(returnedHandle, failed);
            return failed;
        }

        if (!TryReadObservation(buffer, out var observation, out var parseFailure))
        {
            var invalid = new QueryResult(13, null, new NativeActionDiagnostic(0, "parse", parseFailure)); // synthetic ERROR_INVALID_DATA
            _gate.CompleteQuery(returnedHandle, invalid);
            return invalid;
        }
        var result = new QueryResult(0, observation);
        return _gate.CompleteQuery(returnedHandle, result, out var mismatch, out var gateMatched) ?
            result : new QueryResult(13, null, new NativeActionDiagnostic(0,
                gateMatched ? "identity" : "gate", IdentityMismatchMask: mismatch,
                ObservedMode: observation!.Mode, ObservedFlags: observation.Flags));
    }

    internal static QueryResult SyntheticQueryResult(uint code, string scenario)
    {
        var expected = new TraceIdentity("LexRunner Windows Git Loader Qualification",
            Guid.Parse("f6a585fc-57f8-4805-8599-d671282184f5"), @"C:\private\file.etl", 0x02400001, 0x06000307);
        var adapter = new NativeTraceAdapter(expected);
        adapter._gate.BeginStart(); adapter._gate.CompleteStart(new(0,42));
        if (scenario != "gate") adapter._gate.BeginQuery(42);
        var buffer = Allocate(expected.Guid);
        try
        {
            var props = Marshal.PtrToStructure<EventTraceProperties>(buffer);
            props.LogFileMode = expected.Mode; props.EnableFlags = expected.Flags;
            if (scenario == "parse") props.Wnode.BufferSize = (uint)Capacity + 1;
            Marshal.StructureToPtr(props, buffer, false);
            WriteString(buffer, props.LoggerNameOffset, scenario == "identity" ? "other" : expected.Name);
            WriteString(buffer, props.LogFileNameOffset, expected.EtlPath);
            return adapter.CompleteNativeQuery(42, code, buffer);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    public StopResult Stop(ulong returnedHandle)
    {
        if (!LayoutIsExpected() || !_gate.BeginStop(returnedHandle))
            return new StopResult(87, Diagnostic: new NativeActionDiagnostic(null, "precheck"));
        var buffer = Allocate(_expected.Guid);
        try
        {
            // Only the StartTraceW-returned handle, never a name. Even
            // ERROR_MORE_DATA may mean the session has already stopped.
            try
            {
                var code = ControlTraceW(returnedHandle, null, buffer, EventTraceControlStop);
                return CompleteNativeStop(code, buffer);
            }
            catch (DllNotFoundException) { return new StopResult(127, Diagnostic: new NativeActionDiagnostic(null, "import")); }
            catch (EntryPointNotFoundException) { return new StopResult(127, Diagnostic: new NativeActionDiagnostic(null, "import")); }
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    // STOP may have taken effect even if its returned properties are rejected.
    // Name/GUID/path/mode remain exact; this hosted terminal profile requires exactly flags0.
    private StopResult CompleteNativeStop(uint code, IntPtr buffer)
    {
        if (code != 0) return new StopResult(code, Diagnostic: new NativeActionDiagnostic(code, "native"));
        if (!TryReadObservation(buffer, out var observation, out var parseFailure))
            return new StopResult(13, Diagnostic: new NativeActionDiagnostic(0, "parse", parseFailure));
        uint mismatch = 0;
        if (observation!.Name != _expected.Name) mismatch |= 1;
        if (observation.Guid != _expected.Guid) mismatch |= 2;
        if (observation.EtlPath != _expected.EtlPath) mismatch |= 4;
        if (observation.Mode != _expected.Mode) mismatch |= 8;
        if (observation.Flags != ExpectedTerminalFlags) mismatch |= 16;
        return mismatch == 0 ? new StopResult(0, observation) : new StopResult(13,
            Diagnostic: new NativeActionDiagnostic(0, "identity", IdentityMismatchMask: mismatch,
                ObservedMode: observation.Mode, ObservedFlags: observation.Flags));
    }

    internal static (StopResult Result, bool OneShot, int MatchedQueries) SyntheticStopResult(
        uint code, uint mask = 0, string? parseFailure = null, uint? terminalFlags = null)
    {
        var expected = new TraceIdentity("LexRunner Windows Git Loader Qualification",
            Guid.Parse("f6a585fc-57f8-4805-8599-d671282184f5"), @"C:\private\file.etl", 0x02400001, 0x06000307);
        var adapter = new NativeTraceAdapter(expected);
        var observation = new TraceObservation(expected.Name, expected.Guid, expected.EtlPath,
            expected.Mode, expected.Flags, 0, 0, 0);
        adapter._gate.BeginStart(); adapter._gate.CompleteStart(new(0,42));
        var queries = 0;
        for (var i = 0; i < 2; i++)
            if (adapter._gate.BeginQuery(42) && adapter._gate.CompleteQuery(42, new(0, observation))) queries++;
        if (!adapter._gate.BeginStop(42)) throw new InvalidOperationException("synthetic_stop_gate");
        var buffer = Allocate((mask & 2) == 0 ? expected.Guid : Guid.Empty);
        try
        {
            var props = Marshal.PtrToStructure<EventTraceProperties>(buffer);
            props.LogFileMode = (mask & 8) == 0 ? expected.Mode : 0;
            props.EnableFlags = terminalFlags ?? ((mask & 16) == 0 ? ExpectedTerminalFlags : 1u);
            Marshal.StructureToPtr(props, buffer, false);
            WriteString(buffer, props.LoggerNameOffset, (mask & 1) == 0 ? expected.Name : "other");
            WriteString(buffer, props.LogFileNameOffset, (mask & 4) == 0 ? expected.EtlPath : "other");
            if (parseFailure is not null)
            {
                var logger = parseFailure.StartsWith("logger_", StringComparison.Ordinal);
                var target = logger ? props.LoggerNameOffset : props.LogFileNameOffset;
                var failure = parseFailure[(parseFailure.IndexOf('_') + 1)..];
                if (parseFailure == "capacity") props.Wnode.BufferSize = (uint)Capacity + 1;
                else if (failure == "offset")
                { if (logger) props.LoggerNameOffset = 1; else props.LogFileNameOffset = 1; }
                else if (failure == "bounds")
                {
                    target = (uint)Capacity - 2;
                    if (logger) props.LoggerNameOffset = target; else props.LogFileNameOffset = target;
                    Marshal.WriteInt16(buffer, (int)target, (short)'x');
                }
                else if (failure == "empty") Marshal.WriteInt16(buffer, (int)target, 0);
                else if (failure == "termination")
                    for (var i = 0; i < MaximumNameChars; i++) Marshal.WriteInt16(buffer, (int)target + i * 2, (short)'x');
                else throw new InvalidOperationException("synthetic_stop_parse_case");
                Marshal.StructureToPtr(props, buffer, false);
            }
            var result = adapter.CompleteNativeStop(code, buffer);
            return (result, !adapter._gate.BeginStop(42) && !adapter._gate.BeginQuery(42), queries);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static int Capacity => checked(Marshal.SizeOf<EventTraceProperties>() +
        2 * (MaximumNameChars + 1) * sizeof(char));

    private static IntPtr Allocate(Guid guid)
    {
        var buffer = Marshal.AllocHGlobal(Capacity);
        Marshal.Copy(new byte[Capacity], 0, buffer, Capacity);
        var props = new EventTraceProperties
        {
            Wnode = new WnodeHeader
            {
                BufferSize = checked((uint)Capacity),
                Guid = guid,
                Flags = WnodeFlagTracedGuid,
            },
            LoggerNameOffset = checked((uint)Marshal.SizeOf<EventTraceProperties>()),
            LogFileNameOffset = checked((uint)(Marshal.SizeOf<EventTraceProperties>() +
                (MaximumNameChars + 1) * sizeof(char))),
        };
        Marshal.StructureToPtr(props, buffer, false);
        return buffer;
    }

    private static void WriteString(IntPtr buffer, uint offset, string text)
    {
        for (var i = 0; i < text.Length; i++)
            Marshal.WriteInt16(buffer, checked((int)offset + i * sizeof(char)), unchecked((short)text[i]));
    }

    private static bool TryReadObservation(IntPtr buffer, out TraceObservation? observation) =>
        TryReadObservation(buffer, out observation, out _);

    private static bool TryReadObservation(IntPtr buffer, out TraceObservation? observation,
        out string? parseFailure)
    {
        observation = null;
        var props = Marshal.PtrToStructure<EventTraceProperties>(buffer);
        var capacity = Marshal.ReadInt32(buffer);
        parseFailure = null;
        if (capacity < Marshal.SizeOf<EventTraceProperties>() || capacity > Capacity)
        { parseFailure = "capacity"; return false; }
        if (!TryReadString(buffer, props.LoggerNameOffset, capacity, out var name, out var failure))
        { parseFailure = "logger_" + failure; return false; }
        if (!TryReadString(buffer, props.LogFileNameOffset, capacity, out var path, out failure))
        { parseFailure = "file_" + failure; return false; }
        observation = new TraceObservation(name!, props.Wnode.Guid, path!,
            props.LogFileMode, props.EnableFlags, props.EventsLost,
            props.LogBuffersLost, props.RealTimeBuffersLost);
        return true;
    }

    private static bool TryReadString(IntPtr buffer, uint offset, int capacity, out string? text,
        out string? failure)
    {
        text = null;
        failure = null;
        var min = Marshal.SizeOf<EventTraceProperties>();
        if (offset < min || offset >= capacity || (offset & 1) != 0)
        { failure = "offset"; return false; }
        var chars = new char[MaximumNameChars];
        for (var i = 0; i < chars.Length; i++)
        {
            var position = checked((int)offset + i * sizeof(char));
            if (position + sizeof(char) > capacity) { failure = "bounds"; return false; }
            var value = unchecked((char)Marshal.ReadInt16(buffer, position));
            if (value == '\0')
            {
                text = new string(chars, 0, i);
                if (i == 0) failure = "empty";
                return i != 0;
            }
            chars[i] = value;
        }
        failure = "termination";
        return false;
    }

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("Sechost.dll", EntryPoint = "StartTraceW", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern uint StartTraceW(out ulong sessionHandle,
        [MarshalAs(UnmanagedType.LPWStr)] string instanceName, IntPtr properties);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("Sechost.dll", EntryPoint = "ControlTraceW", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern uint ControlTraceW(ulong traceId,
        [MarshalAs(UnmanagedType.LPWStr)] string? instanceName, IntPtr properties, uint controlCode);

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

// One adapter instance owns at most one StartTraceW result. A successful
// matching query is needed before the single STOP attempt. Query begins by
// invalidating any prior match, so a later failed query cannot reuse it.
internal sealed class OwnedHandleGate(TraceIdentity expected)
{
    private enum State { Unused, StartAttempted, Owned, QueryInFlight, QueryMatched, StopAttempted, Uncertain }
    private readonly object _sync = new();
    private State _state;
    private ulong _handle;

    internal bool BeginStart()
    {
        lock (_sync)
        {
            if (_state != State.Unused) return false;
            _state = State.StartAttempted;
            return true;
        }
    }

    internal void CompleteStart(StartResult result)
    {
        lock (_sync)
        {
            if (_state != State.StartAttempted)
                throw new InvalidOperationException("start_state_invalid");
            if (result.Code == 0 && result.Handle is not (0 or ulong.MaxValue))
            {
                _handle = result.Handle;
                _state = State.Owned;
            }
        }
    }

    internal bool BeginQuery(ulong handle)
    {
        lock (_sync)
        {
            if (_state != State.Owned && _state != State.QueryMatched)
                return false;
            if (handle != _handle)
            {
                _state = State.Uncertain;
                return false;
            }
            _state = State.QueryInFlight;
            return true;
        }
    }

    internal bool CompleteQuery(ulong handle, QueryResult result) =>
        CompleteQuery(handle, result, out _, out _);

    internal bool CompleteQuery(ulong handle, QueryResult result, out uint mismatch,
        out bool gateMatched)
    {
        lock (_sync)
        {
            mismatch = 0;
            gateMatched = _state == State.QueryInFlight && handle == _handle;
            if (!gateMatched) return false;
            if (result.Observation is { } observed)
            {
                if (observed.Name != expected.Name) mismatch |= 1;
                if (observed.Guid != expected.Guid) mismatch |= 2;
                if (observed.EtlPath != expected.EtlPath) mismatch |= 4;
                if (observed.Mode != expected.Mode) mismatch |= 8;
                if (observed.Flags != expected.Flags) mismatch |= 16;
            }
            if (result.Code != 0 || result.Observation is null || mismatch != 0)
            {
                _state = State.Uncertain;
                return false;
            }
            _state = State.QueryMatched;
            return true;
        }
    }

    internal bool BeginStop(ulong handle)
    {
        lock (_sync)
        {
            if (_state != State.QueryMatched) return false;
            if (handle != _handle)
            {
                _state = State.Uncertain;
                return false;
            }
            _state = State.StopAttempted;
            return true;
        }
    }
}
