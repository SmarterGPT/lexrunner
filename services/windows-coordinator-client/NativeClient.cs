using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace LexRunner.WindowsCoordinator.Client;

internal readonly record struct ServiceState(uint Type, uint State, uint ProcessId)
{
    public bool IsRunningOwnProcess => Type == 0x10 && State == 4 && ProcessId != 0;
}

internal interface IServiceSnapshots
{
    ServiceState? Read();
}

internal sealed class ScmServiceSnapshots : IServiceSnapshots
{
    internal const string ServiceName = "LexRunnerCoordinator";
    private const uint ScManagerConnect = 0x0001;
    private const uint ServiceQueryStatus = 0x0004;
    private const int ScStatusProcessInfo = 0;
    internal int LastError { get; private set; }

    public ServiceState? Read()
    {
        LastError = 0;
        using var manager = Native.OpenSCManagerW(null, null, ScManagerConnect);
        if (manager.IsInvalid)
        {
            LastError = Marshal.GetLastWin32Error();
            return null;
        }
        using var service = Native.OpenServiceW(manager, ServiceName, ServiceQueryStatus);
        if (service.IsInvalid)
        {
            LastError = Marshal.GetLastWin32Error();
            return null;
        }
        var buffer = Marshal.AllocHGlobal(Marshal.SizeOf<NativeServiceStatus>());
        try
        {
            if (!Native.QueryServiceStatusEx(service, ScStatusProcessInfo, buffer,
                (uint)Marshal.SizeOf<NativeServiceStatus>(), out _))
            {
                LastError = Marshal.GetLastWin32Error();
                return null;
            }
            var status = Marshal.PtrToStructure<NativeServiceStatus>(buffer);
            return new ServiceState(status.ServiceType, status.CurrentState, status.ProcessId);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeServiceStatus
    {
        public uint ServiceType, CurrentState, ControlsAccepted, Win32ExitCode,
            ServiceSpecificExitCode, CheckPoint, WaitHint, ProcessId, ServiceFlags;
    }
}

// There is no production factory for this evidence yet. The ordinary binary
// never constructs it. A future protected selection source must provide it.
internal sealed record SelectedEndpoint(string PipeName, string RunningImagePath);

internal sealed record ClientResult(string State, uint BytesWritten = 0,
    uint BytesRead = 0, uint? ServerPid = null, int NativeError = 0,
    byte[]? Reply = null, int? SecondInstanceError = null);

internal static class BoundClient
{
    internal const string ProductionPipeName = @"\\.\pipe\LexRunner.Coordinator.Service.v1";
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint Synchronize = 0x00100000;
    private const uint FileReadData = 0x1;
    private const uint FileWriteData = 0x2;
    private const uint FileFlagOverlapped = 0x40000000;
    private const uint SecuritySqosPresent = 0x00100000;
    private const uint SecurityIdentification = 0x00010000;
    private const uint OpenExisting = 3;
    private const uint WaitTimeout = 258;
    private const int MaxFrameBytes = 1024 * 1024;
    private const int MaxReplyBytes = 4096;

    internal static ClientResult RoundTrip(IServiceSnapshots service, SelectedEndpoint selected,
        byte[] requestFrame, int timeoutMs, bool testSecondInstance = false)
    {
        if (timeoutMs is < 1 or > 30000 || !ValidFrame(requestFrame))
            return new ClientResult("invalid_request");
        var clock = Stopwatch.StartNew();
        var first = service.Read();
        if (first is not { IsRunningOwnProcess: true })
            return new ClientResult("service_unavailable");

        // The process handle is acquired and retained before pipe open. It pins
        // the process object while SCM and connected pipe identity are compared.
        using var process = Native.OpenProcess(ProcessQueryLimitedInformation | Synchronize,
            false, first.Value.ProcessId);
        if (process.IsInvalid || Native.GetProcessId(process) != first.Value.ProcessId ||
            !Live(process) || !ImageMatches(process, selected.RunningImagePath))
            return new ClientResult("service_process_unavailable");

        // Specific rights: READ_DATA | WRITE_DATA | SYNCHRONIZE, excluding
        // FILE_CREATE_PIPE_INSTANCE. SQOS limits server impersonation to Identification.
        using var pipe = Native.CreateFileW(selected.PipeName,
            FileReadData | FileWriteData | Synchronize, 0, IntPtr.Zero, OpenExisting,
            FileFlagOverlapped | SecuritySqosPresent | SecurityIdentification, IntPtr.Zero);
        if (pipe.IsInvalid)
            return new ClientResult("pipe_unavailable", NativeError: Marshal.GetLastWin32Error());
        if (!Native.GetNamedPipeServerProcessId(pipe, out var connectedPid) || connectedPid == 0)
            return new ClientResult("server_pid_unavailable", NativeError: Marshal.GetLastWin32Error());
        if (connectedPid != first.Value.ProcessId)
            return new ClientResult("server_pid_mismatch", ServerPid: connectedPid);

        int? secondInstanceError = null;
#if COORDINATOR_CLIENT_FIXTURE_TESTS
        if (testSecondInstance)
            secondInstanceError = FixtureServer.TrySecondInstance(selected.PipeName);
#endif
        // Re-read the fixed service immediately before any request byte. A
        // configured image string or matching SID/PID alone is not authority.
        var second = service.Read();
        if (second is not { IsRunningOwnProcess: true } || second.Value != first.Value ||
            Native.GetProcessId(process) != first.Value.ProcessId || !Live(process) ||
            !ImageMatches(process, selected.RunningImagePath))
            return new ClientResult("service_changed", ServerPid: connectedPid,
                SecondInstanceError: secondInstanceError);

        var writer = new NativePipeIo(pipe, clock, timeoutMs);
        var sent = writer.WriteExact(requestFrame);
        if (!sent.Complete)
            return new ClientResult(sent.Attempted ? "outcome_unknown" :
                "deadline_exceeded_before_send", sent.Bytes, 0, connectedPid,
                sent.Error, SecondInstanceError: secondInstanceError);
        var header = writer.ReadExact(4);
        if (!header.Complete)
            return new ClientResult("outcome_unknown", sent.Bytes, header.Bytes, connectedPid,
                header.Error, SecondInstanceError: secondInstanceError);
        uint length = BitConverter.ToUInt32(header.Data, 0);
        if (length is 0 or > MaxReplyBytes)
            return new ClientResult("invalid_reply", sent.Bytes, 4, connectedPid,
                SecondInstanceError: secondInstanceError);
        var body = writer.ReadExact((int)length);
        if (!body.Complete)
            return new ClientResult("outcome_unknown", sent.Bytes, 4 + body.Bytes,
                connectedPid, body.Error, SecondInstanceError: secondInstanceError);
        return new ClientResult("reply", sent.Bytes, 4 + body.Bytes, connectedPid,
            Reply: body.Data, SecondInstanceError: secondInstanceError);
    }

    private static bool ValidFrame(byte[]? frame) => frame is { Length: >= 5 and <= MaxFrameBytes + 4 } &&
        BitConverter.ToUInt32(frame, 0) == frame.Length - 4;

    private static bool Live(SafeFileHandle process) =>
        Native.WaitForSingleObject(process, 0) == WaitTimeout;

    private static bool ImageMatches(SafeFileHandle process, string expected)
    {
        var actual = new StringBuilder(32768);
        uint length = (uint)actual.Capacity;
        return Native.QueryFullProcessImageNameW(process, 0, actual, ref length) &&
            string.Equals(actual.ToString(), expected, StringComparison.OrdinalIgnoreCase);
    }
}

internal readonly record struct IoResult(bool Complete, uint Bytes, int Error,
    byte[] Data, bool Attempted = false)
{
    public static IoResult Failure(uint bytes, int error, bool attempted = false) =>
        new(false, bytes, error, [], attempted);
}

internal sealed class NativePipeIo(SafeFileHandle pipe, Stopwatch clock, int deadlineMs)
{
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const int ErrorIoPending = 997;
    private const int ErrorPipeConnected = 535;
    private const int CancelDrainMs = 300;

    private int Remaining() => Math.Max(0, deadlineMs -
        checked((int)Math.Min(clock.ElapsedMilliseconds, int.MaxValue)));

    internal IoResult Connect()
    {
        using var call = new PendingCall(0);
        var started = Native.ConnectNamedPipe(pipe, call.Overlapped);
        var error = started ? 0 : Marshal.GetLastWin32Error();
        if (!started && error == ErrorPipeConnected)
            return new IoResult(true, 0, 0, []);
        return Finish(call, started, error);
    }

    internal IoResult WriteExact(byte[] data)
    {
        uint done = 0;
        var attempted = false;
        while (done < data.Length)
        {
            if (Remaining() <= 0) return IoResult.Failure(done, 1460, attempted);
            var offset = checked((int)done);
            using var call = new PendingCall(data.Length - offset);
            Marshal.Copy(data, offset, call.Buffer, data.Length - offset);
            attempted = true;
            // lpNumberOfBytesWritten is NULL for an overlapped handle. Counts
            // come only from terminal GetOverlappedResult, even when WriteFile
            // reports immediate completion.
            var started = Native.WriteFile(pipe, call.Buffer, (uint)(data.Length - offset),
                IntPtr.Zero, call.Overlapped);
            var outcome = Finish(call, started,
                started ? 0 : Marshal.GetLastWin32Error());
            done += outcome.Bytes;
            if (!outcome.Complete || outcome.Bytes == 0)
                return IoResult.Failure(done, outcome.Error, attempted);
        }
        return new IoResult(true, done, 0, [], attempted);
    }

    internal IoResult ReadExact(int size)
    {
        var data = new byte[size];
        uint done = 0;
        while (done < size)
        {
            if (Remaining() <= 0) return IoResult.Failure(done, 1460);
            using var call = new PendingCall(size - (int)done);
            // lpNumberOfBytesRead is NULL for overlapped I/O. The kernel keeps
            // the buffer and OVERLAPPED until terminal completion is observed.
            var started = Native.ReadFile(pipe, call.Buffer, (uint)(size - done),
                IntPtr.Zero, call.Overlapped);
            var outcome = Finish(call, started,
                started ? 0 : Marshal.GetLastWin32Error());
            if (!outcome.Complete || outcome.Bytes == 0)
                return IoResult.Failure(done, outcome.Error);
            Marshal.Copy(call.Buffer, data, (int)done, (int)outcome.Bytes);
            done += outcome.Bytes;
        }
        return new IoResult(true, done, 0, data);
    }

    private IoResult Finish(PendingCall call, bool started, int error)
    {
        if (started)
        {
            if (Native.GetOverlappedResult(pipe, call.Overlapped, out var immediateCount, false))
                return new IoResult(true, immediateCount, 0, []);
            error = Marshal.GetLastWin32Error();
            if (error != 996) return IoResult.Failure(0, error);
        }
        else if (error != ErrorIoPending) return IoResult.Failure(0, error);
        var waited = Native.WaitForSingleObject(call.Event, (uint)Remaining());
        if (waited == WaitObject0)
        {
            if (Native.GetOverlappedResult(pipe, call.Overlapped, out var count, false))
                return new IoResult(true, count, 0, []);
            var completionError = Marshal.GetLastWin32Error();
            if (completionError != 996) // ERROR_IO_INCOMPLETE is not terminal.
                return IoResult.Failure(0, completionError);
        }
        // CancelIoEx is only a request. Do not release OVERLAPPED or its buffer
        // until GetOverlappedResult proves the operation reached a terminal state.
        Native.CancelIoEx(pipe, call.Overlapped);
        if (Native.WaitForSingleObject(call.Event, CancelDrainMs) != WaitObject0)
            Environment.FailFast("Native pipe I/O cancellation did not become terminal");
        if (Native.GetOverlappedResult(pipe, call.Overlapped, out var finalCount, false))
            return IoResult.Failure(finalCount, waited == WaitTimeout ? 1460 : 6);
        var finalError = Marshal.GetLastWin32Error();
        if (finalError == 996) Environment.FailFast("Native pipe I/O stayed incomplete after cancellation");
        return IoResult.Failure(0, finalError);
    }

    private sealed class PendingCall : IDisposable
    {
        internal SafeWaitHandle Event { get; }
        internal IntPtr Overlapped { get; }
        internal IntPtr Buffer { get; }

        internal PendingCall(int size)
        {
            Event = Native.CreateEventW(IntPtr.Zero, true, false, null);
            if (Event.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                Overlapped = Marshal.AllocHGlobal(Marshal.SizeOf<NativeOverlapped>());
                Marshal.StructureToPtr(new NativeOverlapped { EventHandle = Event.DangerousGetHandle() },
                    Overlapped, false);
                Buffer = Marshal.AllocHGlobal(Math.Max(1, size));
            }
            catch
            {
                Marshal.FreeHGlobal(Overlapped);
                Event.Dispose();
                throw;
            }
        }

        public void Dispose()
        {
            Marshal.FreeHGlobal(Buffer);
            Marshal.FreeHGlobal(Overlapped);
            Event.Dispose();
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeOverlapped
    {
        public IntPtr Internal, InternalHigh;
        public uint Offset, OffsetHigh;
        public IntPtr EventHandle;
    }
}

internal static class Native
{
    [DllImport("advapi32.dll", EntryPoint = "OpenSCManagerW", CharSet = CharSet.Unicode,
        SetLastError = true)]
    internal static extern SafeServiceHandle OpenSCManagerW(string? machine, string? database,
        uint desiredAccess);
    [DllImport("advapi32.dll", EntryPoint = "OpenServiceW", CharSet = CharSet.Unicode,
        SetLastError = true)]
    internal static extern SafeServiceHandle OpenServiceW(SafeServiceHandle manager,
        string serviceName, uint desiredAccess);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryServiceStatusEx(SafeServiceHandle service, int infoLevel,
        IntPtr buffer, uint bufferSize, out uint bytesNeeded);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseServiceHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern SafeFileHandle OpenProcess(uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint GetProcessId(SafeFileHandle process);
    [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryFullProcessImageNameW(SafeFileHandle process, uint flags,
        StringBuilder imageName, ref uint size);
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode,
        SetLastError = true)]
    internal static extern SafeFileHandle CreateFileW(string path, uint desiredAccess,
        uint shareMode, IntPtr securityAttributes, uint creationDisposition,
        uint flagsAndAttributes, IntPtr templateFile);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetNamedPipeServerProcessId(SafeFileHandle pipe,
        out uint serverProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint WaitForSingleObject(SafeHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", EntryPoint = "CreateEventW", CharSet = CharSet.Unicode,
        SetLastError = true)]
    internal static extern SafeWaitHandle CreateEventW(IntPtr securityAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool manualReset,
        [MarshalAs(UnmanagedType.Bool)] bool initialState, string? name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ReadFile(SafeFileHandle pipe, IntPtr buffer, uint count,
        IntPtr bytesRead, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool WriteFile(SafeFileHandle pipe, IntPtr buffer, uint count,
        IntPtr bytesWritten, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetOverlappedResult(SafeFileHandle pipe, IntPtr overlapped,
        out uint count, [MarshalAs(UnmanagedType.Bool)] bool wait);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CancelIoEx(SafeFileHandle pipe, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ConnectNamedPipe(SafeFileHandle pipe, IntPtr overlapped);
}

internal sealed class SafeServiceHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    private SafeServiceHandle() : base(true) { }
    protected override bool ReleaseHandle() => Native.CloseServiceHandle(handle);
}
