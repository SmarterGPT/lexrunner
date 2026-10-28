using System.Buffers.Binary;
using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

internal enum PrivateVerb : byte { Status = 1, Prepare = 2 }

internal sealed record PrivateChildOutcome(string State, uint? ProcessId,
    bool JobMatched, bool ImageMatched, bool TokenMatched, bool TerminalDrained,
    byte[]? StatusFrame, string? Error);

// The normal service has no way to construct a generation lease yet. This is
// an internal launch primitive, not an admission or effect authority. The
// only currently parsed private reply is a conservative status observation.
[SupportedOSPlatform("windows")]
internal static class CoordinatorPrivateNode
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateNoWindow = 0x08000000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint JobObjectLimitActiveProcess = 0x00000008;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const uint TokenQuery = 0x0008;
    private const int MaxClientFrameBytes = 2048;
    private const int MaxReplyFrameBytes = 4096 + 4;
    private const int MaxPrivateReplyBytes = 8 + 16 + 4 + MaxReplyFrameBytes;
    private const int MaxStderrBytes = 4096;
    private const int ChildTimeoutMs = 3000;
    private static readonly TimeSpan DrainLimit = TimeSpan.FromSeconds(2);
    internal static ReadOnlySpan<byte> RequestMagic => "LXNPEER2"u8;
    internal static ReadOnlySpan<byte> ReplyMagic => "LXNREPL2"u8;

    internal static PrivateChildOutcome Run(ProtectedGenerationLease generation,
        PrivateVerb verb, ObservedPipePeer peer, byte[] canonicalFrame, CancellationToken stop)
    {
        ArgumentNullException.ThrowIfNull(generation);
        ArgumentNullException.ThrowIfNull(peer);
        ArgumentNullException.ThrowIfNull(canonicalFrame);
        // Prepare needs a protected store and durable intent, neither of which
        // can be inferred from a successful child exit or reply.
        if (verb != PrivateVerb.Status)
            return Unknown("protected_store_unavailable");
        if (canonicalFrame.Length is < 5 or > MaxClientFrameBytes ||
            BinaryPrimitives.ReadUInt32LittleEndian(canonicalFrame) != canonicalFrame.Length - 4)
            return Unknown("private_frame_bound");
        var parsed = CoordinatorProtocol.ParseStatusOnly(canonicalFrame.AsSpan(4).ToArray());
        if (parsed.Request is not { } request) return Unknown("private_status_invalid");
        IDisposable hold;
        try { hold = generation.HoldForChild(); }
        catch (Exception holdError) when (holdError is ObjectDisposedException or InvalidOperationException)
        { return Unknown("generation_lease_unavailable"); }
        using var retainedGeneration = hold;

        var clock = Stopwatch.StartNew();
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero;
        IntPtr jobs = IntPtr.Zero, environment = IntPtr.Zero;
        ProcessInformation child = default;
        AnonymousPipeServerStream? stdin = null, stdout = null, stderr = null;
        Task<Capture>? stdoutTask = null, stderrTask = null;
        bool attributeListInitialized = false, created = false;
        bool jobMatched = false, imageMatched = false, tokenMatched = false;
        bool drained = false, releaseSucceeded = true;
        uint? exitCode = null;
        string? error = null;
        byte[]? statusFrame = null;
        var state = "uncertain";
        try
        {
            stop.ThrowIfCancellationRequested();
            if (!Environment.Is64BitProcess) throw new InvalidOperationException("native_windows_x64_required");
            ValidateGeneration(generation);
            var expectedImage = FinalNativePath(generation.HeldImage.SafeFileHandle.DangerousGetHandle());
            var expectedDigest = Digest(generation.HeldImage);
            generation.HeldImage.Position = 0;
            var nonce = RandomNumberGenerator.GetBytes(16);
            var privateRequest = BuildRequest(nonce, verb, peer, canonicalFrame);

            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw NativeFailure("job_create_failed");
            var limits = new ExtendedLimits
            {
                Basic = new BasicLimits
                {
                    Flags = JobObjectLimitKillOnJobClose | JobObjectLimitActiveProcess,
                    Active = 1
                }
            };
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
                throw NativeFailure("job_limit_failed");

            stdin = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
            stdout = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
            stderr = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            if (size == IntPtr.Zero) throw NativeFailure("attribute_size_failed");
            attributes = Marshal.AllocHGlobal(size);
            handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
            jobs = Marshal.AllocHGlobal(IntPtr.Size);
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size))
                throw NativeFailure("attribute_init_failed");
            attributeListInitialized = true;
            Marshal.WriteIntPtr(jobs, job);
            Marshal.WriteIntPtr(handles, 0, stdin.ClientSafePipeHandle.DangerousGetHandle());
            Marshal.WriteIntPtr(handles, IntPtr.Size, stdout.ClientSafePipeHandle.DangerousGetHandle());
            Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, stderr.ClientSafePipeHandle.DangerousGetHandle());
            if (!UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x2000d,
                    jobs, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero) ||
                !UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x20002,
                    handles, (IntPtr)(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw NativeFailure("attribute_update_failed");
            environment = Marshal.StringToHGlobalUni(ConstructEnvironment());
            var startup = new StartupInfoEx
            {
                Info = new StartupInfo
                {
                    Size = Marshal.SizeOf<StartupInfoEx>(), Flags = StartfUseStdHandles,
                    Input = stdin.ClientSafePipeHandle.DangerousGetHandle(),
                    Output = stdout.ClientSafePipeHandle.DangerousGetHandle(),
                    Error = stderr.ClientSafePipeHandle.DangerousGetHandle()
                },
                Attributes = attributes
            };
            var command = FixedCommand(generation);
            if (!CreateProcessW(generation.ImagePath, command, IntPtr.Zero, IntPtr.Zero, true,
                    CreateSuspended | CreateUnicodeEnvironment | ExtendedStartupInfoPresent |
                    CreateNoWindow, environment, generation.WorkingDirectory, ref startup, out child))
                throw NativeFailure("child_create_failed");
            created = true;
            if (!IsProcessInJob(child.Process, job, out var inJob))
                throw NativeFailure("suspended_job_query_failed");
            if (!inJob) throw new IOException("suspended_child_not_in_job");
            jobMatched = true;
            if (!string.Equals(ProcessNativePath(child.Process), expectedImage,
                    StringComparison.OrdinalIgnoreCase))
                throw new IOException("suspended_image_mismatch");
            imageMatched = true;
            if (!OpenProcessToken(child.Process, TokenQuery, out var token))
                throw NativeFailure("suspended_token_open_failed");
            try
            {
                using var identity = new WindowsIdentity(token);
                if (identity.User?.Value != generation.ExpectedSid)
                    throw new UnauthorizedAccessException("suspended_token_mismatch");
                tokenMatched = true;
            }
            finally { releaseSucceeded &= CloseHandle(token); }
            stop.ThrowIfCancellationRequested();
            if (clock.ElapsedMilliseconds >= ChildTimeoutMs)
                throw new TimeoutException("pre_resume_deadline");
            if (ResumeThread(child.Thread) != 1) throw NativeFailure("resume_failed");
            stdin.DisposeLocalCopyOfClientHandle();
            stdout.DisposeLocalCopyOfClientHandle();
            stderr.DisposeLocalCopyOfClientHandle();
            stdoutTask = Task.Factory.StartNew(() => ReadBounded(stdout, MaxPrivateReplyBytes),
                TaskCreationOptions.LongRunning);
            stderrTask = Task.Factory.StartNew(() => ReadBounded(stderr, MaxStderrBytes),
                TaskCreationOptions.LongRunning);
            // The fixed envelope is below a pipe buffer; the deadline still
            // applies to all completion and terminal-drain observations.
            stdin.Write(privateRequest);
            stdin.Dispose();
            stdin = null;
            while (true)
            {
                stop.ThrowIfCancellationRequested();
                var wait = WaitForSingleObject(child.Process, 10);
                if (wait == WaitObject0) break;
                if (wait != WaitTimeout) throw NativeFailure("child_wait_failed");
                if (stdoutTask.IsFaulted || stderrTask.IsFaulted)
                    throw new IOException("pipe_reader_failed");
                if ((stdoutTask.IsCompletedSuccessfully && stdoutTask.Result.Truncated) ||
                    (stderrTask.IsCompletedSuccessfully && stderrTask.Result.Truncated))
                    throw new IOException("private_output_limit");
                if (clock.ElapsedMilliseconds >= ChildTimeoutMs)
                    throw new TimeoutException("private_child_deadline");
            }
            if (!GetExitCodeProcess(child.Process, out var code))
                throw NativeFailure("child_exit_unavailable");
            exitCode = code;
            if (code != 0) throw new IOException("private_child_nonzero_exit");
            if (!QueryInformationJobObject(job, 1, out var accounting,
                    (uint)Marshal.SizeOf<BasicAccounting>(), IntPtr.Zero))
                throw NativeFailure("job_accounting_unavailable");
            if (accounting.TotalProcesses < 1)
                throw new IOException("job_membership_unobserved");
            if (Digest(generation.HeldImage) != expectedDigest)
                throw new IOException("held_image_changed");
            state = "exited";
            // Reply validation follows terminal Job drain below.
            statusFrame = ValidateReplyAfterReaders(stdoutTask, stderrTask, nonce, request);
        }
        catch (Exception exception)
        {
            error = exception.Message;
            state = "uncertain";
        }
        finally
        {
            if (created)
            {
                var terminated = job != IntPtr.Zero && TerminateJobObject(job, 1);
                if (!terminated && child.Process != IntPtr.Zero) TerminateProcess(child.Process, 1);
                var drainClock = Stopwatch.StartNew();
                var empty = false;
                while (terminated && drainClock.Elapsed < DrainLimit)
                {
                    if (!QueryInformationJobObject(job, 1, out var accounting,
                            (uint)Marshal.SizeOf<BasicAccounting>(), IntPtr.Zero)) break;
                    if (accounting.ActiveProcesses == 0) { empty = true; break; }
                    Thread.Sleep(5);
                }
                var exited = child.Process != IntPtr.Zero &&
                    WaitForSingleObject(child.Process, 2000) == WaitObject0;
                drained = terminated && empty && exited;
            }
            // Close the kill-on-close Job before disposing pipes or freeing
            // startup storage. Cleanup faults must not leave its handle open.
            if (job != IntPtr.Zero) releaseSucceeded &= CloseHandle(job);
            DisposeSafely(stdin, ref releaseSucceeded);
            if (!ReaderSettled(stdoutTask) || !ReaderSettled(stderrTask)) drained = false;
            DisposeSafely(stdout, ref releaseSucceeded);
            DisposeSafely(stderr, ref releaseSucceeded);
            if (child.Thread != IntPtr.Zero) releaseSucceeded &= CloseHandle(child.Thread);
            if (child.Process != IntPtr.Zero) releaseSucceeded &= CloseHandle(child.Process);
            if (attributeListInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            drained &= releaseSucceeded;
        }
        if (!drained || error is not null || state != "exited" || statusFrame is null)
            return new PrivateChildOutcome("uncertain", created ? child.Id : null,
                jobMatched, imageMatched, tokenMatched, drained, null,
                error ?? "terminal_job_or_reply_uncertain");
        return new PrivateChildOutcome("status_received", child.Id,
            jobMatched, imageMatched, tokenMatched, true, statusFrame, null);
    }

    private static PrivateChildOutcome Unknown(string reason) =>
        new("uncertain", null, false, false, false, false, null, reason);

    private static void ValidateGeneration(ProtectedGenerationLease generation)
    {
        if (generation.HeldImage.SafeFileHandle.IsClosed ||
            !Path.IsPathFullyQualified(generation.ImagePath) ||
            generation.ImagePath.Contains('"') || generation.ImagePath.Contains('\0') ||
            !generation.ImagePath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ||
            !Path.IsPathFullyQualified(generation.WorkingDirectory) ||
            generation.WorkingDirectory.Contains('"') || generation.WorkingDirectory.Contains('\0') ||
            generation.ExpectedSid.Length is < 7 or > 184 ||
            !generation.ExpectedSid.All(char.IsAscii))
            throw new InvalidDataException("generation_invalid");
#if !COORDINATOR_SERVICE_FIXTURE_TESTS
        if (generation.EntryPath is null || !Path.IsPathFullyQualified(generation.EntryPath) ||
            generation.EntryPath.Contains('"') || generation.EntryPath.Contains('\0') ||
            !generation.EntryPath.EndsWith(".mjs", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("generation_entry_invalid");
#endif
    }

    private static StringBuilder FixedCommand(ProtectedGenerationLease generation)
    {
#if COORDINATOR_SERVICE_FIXTURE_TESTS
        if (generation.EntryPath is null)
            return new StringBuilder('"' + generation.ImagePath + '"' +
                " --private-child-fixture " + generation.FixtureCase.ToString());
#endif
        return new StringBuilder('"' + generation.ImagePath + '"' + " \"" + generation.EntryPath + "\"");
    }

    private static byte[] BuildRequest(byte[] nonce, PrivateVerb verb,
        ObservedPipePeer peer, byte[] frame)
    {
        var sid = Encoding.ASCII.GetBytes(peer.Sid);
        if (sid.Length is < 7 or > 184) throw new InvalidDataException("peer_sid_bound");
        var bytes = new byte[8 + 16 + 1 + 2 + sid.Length + 4 + frame.Length];
        var offset = 0;
        RequestMagic.CopyTo(bytes.AsSpan(offset)); offset += 8;
        nonce.CopyTo(bytes, offset); offset += 16;
        bytes[offset++] = (byte)verb;
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(offset), (ushort)sid.Length); offset += 2;
        sid.CopyTo(bytes, offset); offset += sid.Length;
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(offset), (uint)frame.Length); offset += 4;
        frame.CopyTo(bytes, offset);
        return bytes;
    }

    private static byte[] ValidateReplyAfterReaders(Task<Capture> output,
        Task<Capture> error, byte[] nonce, CoordinatorProtocol.StatusRequest request)
    {
        if (!ReaderSettled(output) || !ReaderSettled(error))
            throw new IOException("private_reader_not_settled");
        var stdout = output.Result;
        var stderr = error.Result;
        if (stdout.Truncated || stderr.Truncated || stderr.Bytes.Length != 0)
            throw new IOException("private_output_invalid");
        var reply = stdout.Bytes;
        if (reply.Length < 28 + 5 ||
            !reply.AsSpan(0, 8).SequenceEqual(ReplyMagic) ||
            !reply.AsSpan(8, 16).SequenceEqual(nonce))
            throw new InvalidDataException("private_reply_nonce");
        var length = BinaryPrimitives.ReadUInt32LittleEndian(reply.AsSpan(24, 4));
        if (length is < 5 or > MaxReplyFrameBytes || length != reply.Length - 28)
            throw new InvalidDataException("private_reply_length");
        var expected = CoordinatorProtocol.IndeterminateStatusFrame(request);
        if (!reply.AsSpan(28).SequenceEqual(expected))
            throw new InvalidDataException("private_reply_status");
        return expected;
    }

    private static bool ReaderSettled(Task<Capture>? reader)
    {
        if (reader is null) return true;
        try { return reader.Wait(DrainLimit) && reader.IsCompletedSuccessfully; }
        catch { return false; }
    }

    private static void DisposeSafely(IDisposable? resource, ref bool released)
    {
        try { resource?.Dispose(); }
        catch { released = false; }
    }

    private static Capture ReadBounded(Stream stream, int maximum)
    {
        var bytes = new byte[maximum];
        var chunk = new byte[4096];
        var length = 0;
        while (true)
        {
            var count = stream.Read(chunk, 0, chunk.Length);
            if (count == 0) return new Capture(bytes[..length], false);
            var copied = Math.Min(maximum - length, count);
            if (copied > 0) Buffer.BlockCopy(chunk, 0, bytes, length, copied);
            length += copied;
            if (copied != count) return new Capture(bytes[..length], true);
        }
    }

    private static string ConstructEnvironment()
    {
        var system = Environment.SystemDirectory;
        if (!Path.IsPathFullyQualified(system) ||
            !string.Equals(Path.GetFileName(system), "System32", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("system_root_unavailable");
        var windows = Path.GetDirectoryName(system) ?? throw new InvalidOperationException("system_root_unavailable");
        var entries = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["SystemRoot"] = windows, ["WINDIR"] = windows,
            ["PATH"] = system, ["OS"] = "Windows_NT"
        };
        return string.Join('\0', entries.Select(pair => pair.Key + "=" + pair.Value)) + "\0\0";
    }

    private static string Digest(Stream stream)
    {
        stream.Position = 0;
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    private static string FinalNativePath(IntPtr file)
    {
        var path = new StringBuilder(32768);
        var length = GetFinalPathNameByHandleW(file, path, (uint)path.Capacity, 2);
        if (length == 0 || length >= path.Capacity) throw NativeFailure("held_image_path_unavailable");
        return path.ToString(0, checked((int)length));
    }

    private static string ProcessNativePath(IntPtr process)
    {
        var path = new StringBuilder(32768);
        var length = (uint)path.Capacity;
        if (!QueryFullProcessImageNameW(process, 1, path, ref length) || length == 0)
            throw NativeFailure("suspended_image_path_unavailable");
        return path.ToString(0, checked((int)length));
    }

    private static Win32Exception NativeFailure(string stage) =>
        new(Marshal.GetLastWin32Error(), stage);
    private sealed record Capture(byte[] Bytes, bool Truncated);

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr Minimum, Maximum;
        public uint Active;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccounting
    {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint Faults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo Info;
        public IntPtr Attributes;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process, Thread;
        public uint Id, ThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind,
        ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind,
        out BasicAccounting accounting, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list,
        int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags,
        IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string application, StringBuilder command,
        IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags,
        IntPtr environment, string cwd, ref StartupInfoEx startup,
        out ProcessInformation process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder path,
        uint length, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags,
        StringBuilder path, ref uint length);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job,
        [MarshalAs(UnmanagedType.Bool)] out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
