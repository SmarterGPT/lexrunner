using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;

// Diagnostic-only offline census. It never starts or stops an ETW session,
// reads event payloads, or returns host process names, command lines or paths.
// A successful result is schema discovery, not a Git loader graph or authority.
internal static class SchemaCensus
{
    private const int LogfileBytes = 448; // Windows SDK 10.0.26100 x64 ABI.
    private const int HeaderOffset = 120;
    private const int HeaderStartTimeOffset = HeaderOffset + 264;
    private const int HeaderEndTimeOffset = HeaderOffset + 16;
    private const int HeaderEventsLostOffset = HeaderOffset + 48;
    private const int HeaderBuffersLostOffset = HeaderOffset + 276;
    private const int HeaderModeOffset = HeaderOffset + 32;
    private const int HeaderMaximumFileSizeOffset = HeaderOffset + 28;
    private const int HeaderPointerSizeOffset = HeaderOffset + 44;
    private const int ModeOffset = 28;
    private const int BufferCallbackOffset = 400;
    private const int EventRecordCallbackOffset = 424;
    private const int RecordProviderOffset = 24;
    private const int RecordDescriptorIdOffset = 40;
    private const int RecordVersionOffset = 42;
    private const int RecordOpcodeOffset = 45;
    private const int RecordFlagsOffset = 4;
    private const int MetadataDecodingSourceOffset = 48;
    private const int MetadataPropertyCountOffset = 100;
    private const int MetadataPropertyArrayOffset = 112;
    private const int PropertyInfoBytes = 24;
    private const int PropertyNameOffset = 4;
    private const uint EventRecordMode = 0x10000000;
    private const uint ExpectedCaptureMode = 0x02000001;
    private const ushort ClassicHeader = 0x0100;
    private const uint ErrorInsufficientBuffer = 122;
    private const uint ErrorNotFound = 1168;
    private const long AbsoluteMaxEtlBytes = 128L * 1024 * 1024;
    private const uint AbsoluteMaxDurationSeconds = 30;
    private const int MaxEvents = 200_000;
    private const int MaxSchemas = 64;
    private const int MaxMetadataBytes = 64 * 1024;
    private const int MaxProperties = 64;
    private const int MaxPropertyNameChars = 96;
    private const int MaxTotalNameChars = 4096;

    internal static bool AbiIsExpected() => OperatingSystem.IsWindows() &&
        RuntimeInformation.ProcessArchitecture == Architecture.X64 &&
        IntPtr.Size == 8 &&
        Marshal.SizeOf<LogfileLayout>() == LogfileBytes &&
        Marshal.OffsetOf<LogfileLayout>(nameof(LogfileLayout.Header)).ToInt32() == HeaderOffset &&
        Marshal.OffsetOf<LogfileLayout>(nameof(LogfileLayout.BufferCallback)).ToInt32() == BufferCallbackOffset &&
        Marshal.OffsetOf<LogfileLayout>(nameof(LogfileLayout.EventRecordCallback)).ToInt32() == EventRecordCallbackOffset &&
        Marshal.OffsetOf<LogfileLayout>(nameof(LogfileLayout.Context)).ToInt32() == 440 &&
        Marshal.SizeOf<HeaderLayout>() == 280 &&
        Marshal.OffsetOf<HeaderLayout>(nameof(HeaderLayout.EndTime)).ToInt32() == 16 &&
        Marshal.OffsetOf<HeaderLayout>(nameof(HeaderLayout.EventsLost)).ToInt32() == 48 &&
        Marshal.OffsetOf<HeaderLayout>(nameof(HeaderLayout.BuffersLost)).ToInt32() == 276 &&
        Marshal.SizeOf<EventRecordLayout>() == 112 &&
        Marshal.OffsetOf<EventRecordLayout>(nameof(EventRecordLayout.ProviderId)).ToInt32() == RecordProviderOffset &&
        Marshal.OffsetOf<EventRecordLayout>(nameof(EventRecordLayout.Version)).ToInt32() == RecordVersionOffset &&
        Marshal.OffsetOf<EventRecordLayout>(nameof(EventRecordLayout.Opcode)).ToInt32() == RecordOpcodeOffset;

    internal static IReadOnlyList<SchemaCensusCheck> SelfTest()
    {
        var checks = new List<SchemaCensusCheck>();
        void Add(string name, bool passed) => checks.Add(new(name, passed));
        Add("x64_sdk_layout", AbiIsExpected());
        Add("empty_path_refuses_before_native_open",
            Parse(string.Empty, AbsoluteMaxEtlBytes,
                TimeSpan.FromSeconds(1)).ReasonCode == "census_input_invalid");
        Add("oversize_cap_refuses_before_native_open",
            Parse(@"C:\nonexistent\trace.etl", AbsoluteMaxEtlBytes + 1,
                TimeSpan.FromSeconds(1)).ReasonCode == "census_input_invalid");
        Add("unbounded_deadline_refuses_before_native_open",
            Parse(@"C:\nonexistent\trace.etl", AbsoluteMaxEtlBytes,
                TimeSpan.FromSeconds(31)).ReasonCode == "census_input_invalid");
        Add("missing_etl_refuses_without_open",
            Parse(Path.Combine(Path.GetTempPath(),
                "lexrunner-never-created-" + Guid.NewGuid().ToString("N") + ".etl"),
                AbsoluteMaxEtlBytes,
                TimeSpan.FromSeconds(1)).ReasonCode == "etl_file_bound_refused");
        var bytes = Marshal.AllocHGlobal(256);
        try
        {
            Marshal.Copy(new byte[256], 0, bytes, 256);
            const string property = "ProcessId";
            for (var i = 0; i < property.Length; i++)
                Marshal.WriteInt16(bytes, 160 + i * sizeof(char),
                    unchecked((short)property[i]));
            Add("bounded_property_name",
                TryReadPropertyName(bytes, 256, 160, out var name) &&
                name == property);
            Add("unaligned_property_offset_refuses",
                !TryReadPropertyName(bytes, 256, 161, out _));
            Marshal.WriteInt16(bytes, 160, unchecked((short)'/'));
            Add("path_character_in_property_refuses",
                !TryReadPropertyName(bytes, 256, 160, out _));
        }
        finally { Marshal.FreeHGlobal(bytes); }
        Add("result_never_authorizes_loader_or_execution",
            !Refuse("synthetic").AuthorizesLoaderClosure &&
            !Refuse("synthetic").AuthorizesExecution);
        return checks;
    }

    // The caller must also enforce an out-of-process deadline: a stalled
    // ProcessTrace call can block without invoking either callback.
    internal static SchemaCensusResult Parse(string etlPath,
        long maxEtlBytes, TimeSpan maxDuration)
    {
        if (!AbiIsExpected()) return Refuse("census_abi_unavailable");
        if (string.IsNullOrWhiteSpace(etlPath) || etlPath.IndexOf('\0') >= 0 ||
            !Path.IsPathFullyQualified(etlPath) || maxEtlBytes <= 0 ||
            maxEtlBytes > AbsoluteMaxEtlBytes ||
            maxDuration <= TimeSpan.Zero ||
            maxDuration > TimeSpan.FromSeconds(AbsoluteMaxDurationSeconds))
            return Refuse("census_input_invalid");

        FileInfo file;
        try
        {
            file = new FileInfo(etlPath);
            if (!file.Exists || file.Length <= 0 || file.Length >= maxEtlBytes ||
                (file.Attributes & FileAttributes.ReparsePoint) != 0)
                return Refuse("etl_file_bound_refused");
        }
        catch { return Refuse("etl_file_stat_failed"); }

        var state = new CensusState(maxDuration);
        EventRecordCallback eventCallback = state.OnEvent;
        TraceBufferCallback bufferCallback = state.OnBuffer;
        IntPtr pathPointer = IntPtr.Zero;
        IntPtr logfile = IntPtr.Zero;
        ulong traceHandle = ulong.MaxValue;
        uint processCode = uint.MaxValue;
        uint closeCode = uint.MaxValue;
        long headerStart = 0;
        long headerEnd = 0;
        uint headerEventsLost = uint.MaxValue;
        uint headerBuffersLost = uint.MaxValue;
        uint headerMode = 0;
        uint headerMaxFileSize = 0;
        uint headerPointerSize = 0;

        try
        {
            pathPointer = Marshal.StringToHGlobalUni(etlPath);
            logfile = Marshal.AllocHGlobal(LogfileBytes);
            Marshal.Copy(new byte[LogfileBytes], 0, logfile, LogfileBytes);
            Marshal.WriteIntPtr(logfile, 0, pathPointer);
            Marshal.WriteInt32(logfile, ModeOffset, unchecked((int)EventRecordMode));
            Marshal.WriteIntPtr(logfile, BufferCallbackOffset,
                Marshal.GetFunctionPointerForDelegate(bufferCallback));
            Marshal.WriteIntPtr(logfile, EventRecordCallbackOffset,
                Marshal.GetFunctionPointerForDelegate(eventCallback));

            traceHandle = OpenTraceW(logfile);
            if (traceHandle is 0 or ulong.MaxValue)
                return Refuse("opentrace_failed");

            processCode = ProcessTrace(ref traceHandle, 1, IntPtr.Zero, IntPtr.Zero);
            headerStart = Marshal.ReadInt64(logfile, HeaderStartTimeOffset);
            headerEnd = Marshal.ReadInt64(logfile, HeaderEndTimeOffset);
            headerEventsLost = unchecked((uint)Marshal.ReadInt32(logfile, HeaderEventsLostOffset));
            headerBuffersLost = unchecked((uint)Marshal.ReadInt32(logfile, HeaderBuffersLostOffset));
            headerMode = unchecked((uint)Marshal.ReadInt32(logfile, HeaderModeOffset));
            headerMaxFileSize = unchecked((uint)Marshal.ReadInt32(logfile, HeaderMaximumFileSizeOffset));
            headerPointerSize = unchecked((uint)Marshal.ReadInt32(logfile, HeaderPointerSizeOffset));
        }
        catch (DllNotFoundException) { return Refuse("census_native_api_unavailable"); }
        catch (EntryPointNotFoundException) { return Refuse("census_native_api_unavailable"); }
        catch (SEHException) { return Refuse("census_native_failure"); }
        finally
        {
            if (traceHandle is not (0 or ulong.MaxValue))
            {
                try { closeCode = CloseTrace(traceHandle); }
                catch { closeCode = uint.MaxValue; }
            }
            if (logfile != IntPtr.Zero) Marshal.FreeHGlobal(logfile);
            if (pathPointer != IntPtr.Zero) Marshal.FreeHGlobal(pathPointer);
            GC.KeepAlive(eventCallback);
            GC.KeepAlive(bufferCallback);
        }

        if (state.ReasonCode is { } reason) return Refuse(reason);
        if (processCode != 0) return Refuse("processtrace_failed");
        if (closeCode != 0) return Refuse("closetrace_failed");
        if (headerStart <= 0 || headerEnd <= headerStart ||
            headerMode != ExpectedCaptureMode || headerMaxFileSize != 128 ||
            headerPointerSize is not (8 or 64))
            return Refuse("etl_header_invalid");
        if (headerEventsLost != 0 || headerBuffersLost != 0)
            return Refuse("etl_header_loss_refused");
        if (state.EventCount == 0 || state.Schemas.Count == 0)
            return Refuse("census_empty");

        var items = state.Schemas.Values
            .OrderBy(s => s.ClassGuid.ToString("D"), StringComparer.Ordinal)
            .ThenBy(s => s.Opcode).ThenBy(s => s.Version)
            .Select(s => new SchemaCensusItem(s.ClassGuid.ToString("D"),
                s.Opcode, s.Version, s.EventId, s.ClassicHeader,
                s.TdhStatus, s.DecodingSource, s.Count,
                s.PropertyNames.ToArray()))
            .ToArray();
        var observed = new SchemaCensusResult("census_observed", state.EventCount, items,
            headerEventsLost, headerBuffersLost, headerStart, headerEnd,
            false, false);
        // Leave room for the outer run/Job/loss/deletion receipt under 8 KiB.
        if (JsonSerializer.SerializeToUtf8Bytes(observed).Length > 6144)
            return Refuse("census_summary_limit");
        return observed;
    }

    private static SchemaCensusResult Refuse(string reason) =>
        new(reason, 0, Array.Empty<SchemaCensusItem>(), 0, 0, 0, 0,
            false, false);

    private sealed class CensusState(TimeSpan maxDuration)
    {
        private readonly Stopwatch _watch = Stopwatch.StartNew();
        private int _nameChars;
        internal readonly Dictionary<SchemaKey, MutableSchema> Schemas = new();
        internal string? ReasonCode { get; private set; }
        internal int EventCount { get; private set; }

        internal uint OnBuffer(IntPtr _)
        {
            if (_watch.Elapsed > maxDuration && ReasonCode is null)
                ReasonCode = "census_deadline_refused";
            return ReasonCode is null ? 1u : 0u;
        }

        internal void OnEvent(IntPtr record)
        {
            if (ReasonCode is not null) return;
            try
            {
                if (_watch.Elapsed > maxDuration)
                {
                    ReasonCode = "census_deadline_refused";
                    return;
                }
                if (++EventCount > MaxEvents)
                {
                    ReasonCode = "census_event_limit";
                    return;
                }
                if (record == IntPtr.Zero)
                {
                    ReasonCode = "census_event_invalid";
                    return;
                }
                var guid = Marshal.PtrToStructure<Guid>(IntPtr.Add(record, RecordProviderOffset));
                var opcode = Marshal.ReadByte(record, RecordOpcodeOffset);
                var version = Marshal.ReadByte(record, RecordVersionOffset);
                var id = unchecked((ushort)Marshal.ReadInt16(record, RecordDescriptorIdOffset));
                var classic = (Marshal.ReadInt16(record, RecordFlagsOffset) & ClassicHeader) != 0;
                // Include ID only to preserve diagnostics for manifest events.
                // A later MOF parser must still bind classic events by class
                // GUID, opcode and version, not infer authority from ID.
                var key = new SchemaKey(guid, opcode, version, id, classic);
                if (Schemas.TryGetValue(key, out var prior))
                {
                    prior.Count++;
                    return;
                }
                if (Schemas.Count >= MaxSchemas)
                {
                    ReasonCode = "census_schema_limit";
                    return;
                }
                var metadata = ReadMetadata(record);
                if (metadata.FatalReason is { } fatal)
                {
                    ReasonCode = fatal;
                    return;
                }
                _nameChars += metadata.PropertyNames.Sum(s => s.Length);
                if (_nameChars > MaxTotalNameChars)
                {
                    ReasonCode = "census_metadata_limit";
                    return;
                }
                Schemas.Add(key, new MutableSchema(guid, opcode, version,
                    id, classic, metadata.TdhStatus,
                    metadata.DecodingSource, metadata.PropertyNames));
            }
            catch
            {
                // Never unwind a managed exception through the ETW callback.
                ReasonCode = "census_callback_failed";
            }
        }
    }

    private static MetadataRead ReadMetadata(IntPtr record)
    {
        uint size = 0;
        var first = TdhGetEventInformation(record, 0, IntPtr.Zero,
            IntPtr.Zero, ref size);
        if (first == ErrorNotFound)
            return new(null, first, -1, Array.Empty<string>());
        if (first != ErrorInsufficientBuffer || size < MetadataPropertyArrayOffset ||
            size > MaxMetadataBytes)
            return new("census_tdh_size_invalid", first, -1,
                Array.Empty<string>());
        var buffer = Marshal.AllocHGlobal(checked((int)size));
        try
        {
            Marshal.Copy(new byte[checked((int)size)], 0, buffer,
                checked((int)size));
            var second = TdhGetEventInformation(record, 0, IntPtr.Zero,
                buffer, ref size);
            if (second == ErrorNotFound)
                return new(null, second, -1, Array.Empty<string>());
            if (second != 0 || size < MetadataPropertyArrayOffset ||
                size > MaxMetadataBytes)
                return new("census_tdh_failed", second, -1,
                    Array.Empty<string>());
            var source = Marshal.ReadInt32(buffer, MetadataDecodingSourceOffset);
            var count = Marshal.ReadInt32(buffer, MetadataPropertyCountOffset);
            if (count < 0 || count > MaxProperties ||
                MetadataPropertyArrayOffset + count * PropertyInfoBytes > size)
                return new("census_metadata_malformed", second, source,
                    Array.Empty<string>());
            var names = new string[count];
            for (var i = 0; i < count; i++)
            {
                var offset = Marshal.ReadInt32(buffer,
                    MetadataPropertyArrayOffset + i * PropertyInfoBytes +
                    PropertyNameOffset);
                if (!TryReadPropertyName(buffer, checked((int)size), offset,
                    out var name))
                    return new("census_property_name_invalid", second, source,
                        Array.Empty<string>());
                names[i] = name!;
            }
            return new(null, 0, source, names);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static bool TryReadPropertyName(IntPtr metadata,
        int metadataBytes, int offset, out string? name)
    {
        name = null;
        if (offset < MetadataPropertyArrayOffset || offset >= metadataBytes ||
            (offset & 1) != 0) return false;
        var chars = new char[MaxPropertyNameChars];
        for (var i = 0; i < chars.Length; i++)
        {
            var at = offset + i * sizeof(char);
            if (at + sizeof(char) > metadataBytes) return false;
            var ch = unchecked((char)Marshal.ReadInt16(metadata, at));
            if (ch == '\0')
            {
                if (i == 0) return false;
                name = new string(chars, 0, i);
                return true;
            }
            if (!(ch is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or
                >= '0' and <= '9' or '_' or '.')) return false;
            chars[i] = ch;
        }
        return false;
    }

    private readonly record struct SchemaKey(Guid ClassGuid, byte Opcode,
        byte Version, ushort EventId, bool ClassicHeader);
    private sealed record MutableSchema(Guid ClassGuid, byte Opcode,
        byte Version, ushort EventId, bool ClassicHeader, uint TdhStatus,
        int DecodingSource, IReadOnlyList<string> PropertyNames)
    {
        internal int Count { get; set; } = 1;
    }
    private sealed record MetadataRead(string? FatalReason, uint TdhStatus,
        int DecodingSource, IReadOnlyList<string> PropertyNames);

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void EventRecordCallback(IntPtr eventRecord);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate uint TraceBufferCallback(IntPtr logfile);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("Sechost.dll", EntryPoint = "OpenTraceW", ExactSpelling = true)]
    private static extern ulong OpenTraceW(IntPtr logfile);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("Sechost.dll", EntryPoint = "ProcessTrace", ExactSpelling = true)]
    private static extern uint ProcessTrace(ref ulong handles, uint count,
        IntPtr start, IntPtr end);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("Sechost.dll", EntryPoint = "CloseTrace", ExactSpelling = true)]
    private static extern uint CloseTrace(ulong handle);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("Tdh.dll", EntryPoint = "TdhGetEventInformation",
        ExactSpelling = true)]
    private static extern uint TdhGetEventInformation(IntPtr record,
        uint contextCount, IntPtr context, IntPtr buffer, ref uint bufferSize);

    [StructLayout(LayoutKind.Explicit, Size = 448)]
    private struct LogfileLayout
    {
        [FieldOffset(HeaderOffset)] public HeaderLayout Header;
        [FieldOffset(BufferCallbackOffset)] public IntPtr BufferCallback;
        [FieldOffset(EventRecordCallbackOffset)] public IntPtr EventRecordCallback;
        [FieldOffset(440)] public IntPtr Context;
    }
    [StructLayout(LayoutKind.Explicit, Size = 280)]
    private struct HeaderLayout
    {
        [FieldOffset(16)] public long EndTime;
        [FieldOffset(48)] public uint EventsLost;
        [FieldOffset(276)] public uint BuffersLost;
    }
    [StructLayout(LayoutKind.Explicit, Size = 112)]
    private struct EventRecordLayout
    {
        [FieldOffset(RecordProviderOffset)] public Guid ProviderId;
        [FieldOffset(RecordVersionOffset)] public byte Version;
        [FieldOffset(RecordOpcodeOffset)] public byte Opcode;
    }
}

internal sealed record SchemaCensusItem(string ClassGuid, byte Opcode,
    byte Version, ushort EventId, bool ClassicHeader, uint TdhStatus,
    int DecodingSource, int EventCount, IReadOnlyList<string> PropertyNames);

internal sealed record SchemaCensusResult(string ReasonCode, int EventCount,
    IReadOnlyList<SchemaCensusItem> Schemas, uint HeaderEventsLost,
    uint HeaderBuffersLost, long HeaderStartFileTimeUtc,
    long HeaderEndFileTimeUtc, bool AuthorizesLoaderClosure,
    bool AuthorizesExecution)
{
    internal bool Accepted => ReasonCode == "census_observed";
    internal bool HeaderEndTimeValid => HeaderStartFileTimeUtc > 0 &&
        HeaderEndFileTimeUtc > HeaderStartFileTimeUtc;
}

internal sealed record SchemaCensusCheck(string Name, bool Passed);
