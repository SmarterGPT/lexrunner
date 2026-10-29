using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace LexRunner.WindowsCoordinator.Git;

#if GIT_IMPORT_FIXTURE
internal sealed record JobProcessObservation(uint ProcessId, uint ParentProcessId,
    string ImageNativePath, string ObservedAt, long? CreationFileTimeUtc = null);
#endif

// Fixed Git-image, source-only child mechanism. The inherited handles and Job
// are attached at creation while the child is suspended. This does not prove
// protected Git/loader custody, a service token, or safe slot provenance.
internal static class BoundedGitChild
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateNoWindow = 0x08000000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
#if GIT_IMPORT_FIXTURE
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const int MaxObservedJobProcesses = 64;
#endif
    private const int MaxBytesPerStream = 8192;
    private const int MaxCommandCharacters = 30_000;
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan DrainLimit = TimeSpan.FromSeconds(2);

    internal static Task<CommandRecord> RunAsync(string phase, string cwd,
        string[] argv, IReadOnlyDictionary<string, string> env, CancellationToken token
#if GIT_IMPORT_FIXTURE
        , GraphSelectedGitProfile? graphProfile = null, string? calibrationGitSha256 = null
#endif
        ) =>
        // Always return a command record, including a pre-launch cancellation.
        Task.Run(() => Run(phase, cwd, argv, env, token
#if GIT_IMPORT_FIXTURE
            , null, graphProfile, calibrationGitSha256
#endif
            ), CancellationToken.None);

#if GIT_IMPORT_FIXTURE
    // Deterministically cancel while the child is still suspended. This route
    // and callback are absent from the normal NativeAOT image.
    internal static Task<CommandRecord> RunCanceledBeforeResumeFixtureAsync(string phase,
        string cwd, string[] argv, IReadOnlyDictionary<string, string> env,
        CancellationTokenSource cancellation) =>
        Task.Run(() => Run(phase, cwd, argv, env, cancellation.Token,
            cancellation.Cancel, null, null), CancellationToken.None);
#endif

    private static CommandRecord Run(string phase, string cwd, string[] argv,
        IReadOnlyDictionary<string, string> env, CancellationToken token
#if GIT_IMPORT_FIXTURE
        , Action? beforeResumeFixture, GraphSelectedGitProfile? graphProfile,
        string? calibrationGitSha256
#endif
        )
    {
        var began = DateTimeOffset.UtcNow;
        var clock = Stopwatch.StartNew();
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero;
        IntPtr jobs = IntPtr.Zero, environmentBlock = IntPtr.Zero;
        ProcessInformation child = default;
        FileStream? heldImage = null;
#if GIT_IMPORT_FIXTURE
        HeldStaticGitImports? heldStaticImports = null;
        StaticGitImportInventory? staticImports = null;
        var observedJobProcesses = new Dictionary<uint, JobProcessObservation>();
        uint? rootProcessId = null;
#endif
        AnonymousPipeServerStream? stdin = null, stdout = null, stderr = null;
        Task<Capture>? stdoutTask = null, stderrTask = null;
        bool attributeListInitialized = false, created = false, imageMatched = false;
        bool allowlistConfigured = false, jobDrained = false, handlesClosed = true;
        bool timedOut = false, canceled = false, outputExceeded = false, childExited = false;
        bool childResumed = false;
        uint jobTotalProcesses = 0;
        int? exitCode = null;
        string? error = null;
        string heldImageSha256 = "";
        // These record the configured launch block, not runtime readback from
        // Git or its descendants.
        var configuredSystemRoot = env.GetValueOrDefault("SystemRoot") ?? "";
        var configuredWindir = env.GetValueOrDefault("WINDIR") ?? "";
        var configuredComSpec = env.GetValueOrDefault("COMSPEC") ?? "";
        var configuredPathSha256 = Sha(Encoding.UTF8.GetBytes(env.GetValueOrDefault("PATH") ?? ""));
        var configuredGitExecPath = env.GetValueOrDefault("GIT_EXEC_PATH") ?? "";
        var imagePath = GitBundleImport.GitImage;
#if GIT_IMPORT_FIXTURE
        if (graphProfile is not null) imagePath = graphProfile.GitImage;
#endif
        void CheckStopBeforeLaunch(string boundary)
        {
            if (token.IsCancellationRequested)
            {
                canceled = true;
                throw new OperationCanceledException("git_child_canceled_" + boundary, token);
            }
            if (clock.Elapsed >= Deadline)
            {
                timedOut = true;
                throw new TimeoutException("git_child_deadline_" + boundary);
            }
        }
        try
        {
            if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess)
                throw new InvalidOperationException("native_windows_x64_required");
            if (!Path.IsPathFullyQualified(cwd) || cwd.Contains('\0') ||
                argv.Length is < 1 or > 40 || argv.Any(value => value.Length > 4096 || value.Contains('\0')))
                throw new InvalidOperationException("invalid_fixed_git_command");
            var commandText = string.Join(' ', new[] { imagePath }.Concat(argv).Select(Quote));
            if (commandText.Length > MaxCommandCharacters)
                throw new InvalidOperationException("git_command_too_large");
            var environmentText = ConstructEnvironmentBlock(env);

            heldImage = new FileStream(imagePath, FileMode.Open, FileAccess.Read, FileShare.Read);
            var expectedNativeImage = NativeFilePath(heldImage.SafeFileHandle.DangerousGetHandle());
            heldImageSha256 = Convert.ToHexString(SHA256.HashData(heldImage)).ToLowerInvariant();
            heldImage.Position = 0;
#if GIT_IMPORT_FIXTURE
            if (calibrationGitSha256 is not null)
            {
                if (calibrationGitSha256.Length != 64 ||
                    !calibrationGitSha256.All(Uri.IsHexDigit) ||
                    !StringComparer.Ordinal.Equals(calibrationGitSha256, heldImageSha256))
                    throw new InvalidOperationException("calibration_git_image_pin_mismatch");
            }
            else if (graphProfile is null)
            {
                heldStaticImports = HeldStaticGitImports.OpenPinned();
                staticImports = heldStaticImports.Observation;
                if (!StringComparer.Ordinal.Equals(staticImports.Files[0].Sha256, heldImageSha256))
                    throw new InvalidOperationException("held_git_image_pin_mismatch");
            }
            else if (!StringComparer.Ordinal.Equals(graphProfile.GitImageSha256, heldImageSha256))
                throw new InvalidOperationException("graph_git_image_pin_mismatch");
#endif

            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw NativeFailure("job_create_failed");
            var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = JobObjectLimitKillOnJobClose } };
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
                throw NativeFailure("job_limit_failed");

            stdin = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
            stdout = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
            stderr = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
            IntPtr listBytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref listBytes);
            if (listBytes == IntPtr.Zero) throw NativeFailure("attribute_size_failed");
            attributes = Marshal.AllocHGlobal(listBytes);
            handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
            jobs = Marshal.AllocHGlobal(IntPtr.Size);
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref listBytes))
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
            allowlistConfigured = true;
            environmentBlock = Marshal.StringToHGlobalUni(environmentText);
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
            CheckStopBeforeLaunch("before_create");
            if (!CreateProcessW(imagePath, new StringBuilder(commandText), IntPtr.Zero,
                    IntPtr.Zero, true, CreateSuspended | CreateUnicodeEnvironment |
                    ExtendedStartupInfoPresent | CreateNoWindow,
                    environmentBlock, cwd, ref startup, out child))
                throw NativeFailure("git_child_create_failed");
            created = true; // JOB_LIST assigns before any child code can run.
#if GIT_IMPORT_FIXTURE
            if (!IsProcessInJob(child.Process, job, out var isJobMember) || !isJobMember)
                throw NativeFailure("git_child_not_in_job_at_create");
            if (!GetProcessTimes(child.Process, out var creationFileTimeUtc,
                    out _, out _, out _) || creationFileTimeUtc <= 0)
                throw NativeFailure("git_child_creation_time_unavailable");
#endif
            if (!string.Equals(ProcessNativePath(child.Process), expectedNativeImage,
                    StringComparison.OrdinalIgnoreCase))
                throw new IOException("suspended_git_image_mismatch");
            imageMatched = true;
#if GIT_IMPORT_FIXTURE
            rootProcessId = child.Id;
            observedJobProcesses.Add(child.Id, new JobProcessObservation(child.Id,
                checked((uint)Environment.ProcessId), expectedNativeImage,
                DateTimeOffset.UtcNow.ToString("O"), creationFileTimeUtc));
#endif
            // A canceled or expired request must never resume the suspended PID.
#if GIT_IMPORT_FIXTURE
            beforeResumeFixture?.Invoke();
#endif
            CheckStopBeforeLaunch("before_resume");
            if (ResumeThread(child.Thread) != 1) throw NativeFailure("git_child_resume_failed");
            childResumed = true;
#if GIT_IMPORT_FIXTURE
            SampleJobProcesses(job, observedJobProcesses);
#endif

            stdin.DisposeLocalCopyOfClientHandle();
            stdout.DisposeLocalCopyOfClientHandle();
            stderr.DisposeLocalCopyOfClientHandle();
            stdin.Dispose(); // Fixed Git verbs receive EOF, never a coordinator pipe.
            stdin = null;
            stdoutTask = Task.Factory.StartNew(() => ReadBounded(stdout), TaskCreationOptions.LongRunning);
            stderrTask = Task.Factory.StartNew(() => ReadBounded(stderr), TaskCreationOptions.LongRunning);
            while (true)
            {
#if GIT_IMPORT_FIXTURE
                SampleJobProcesses(job, observedJobProcesses);
#endif
                if (token.IsCancellationRequested)
                {
                    canceled = true;
                    break;
                }
                if (clock.Elapsed >= Deadline)
                {
                    timedOut = true;
                    break;
                }
                var waited = WaitForSingleObject(child.Process, 10);
                if (waited == WaitObject0) childExited = true;
                else if (waited != WaitTimeout) throw NativeFailure("git_child_wait_failed");
                if (stdoutTask.IsFaulted || stderrTask.IsFaulted)
                    throw new IOException("git_pipe_reader_failed");
                if ((stdoutTask.IsCompletedSuccessfully && stdoutTask.Result.Truncated) ||
                    (stderrTask.IsCompletedSuccessfully && stderrTask.Result.Truncated))
                {
                    outputExceeded = true;
                    break;
                }
                if (!QueryInformationJobObject(job, 1, out var accounting,
                        (uint)Marshal.SizeOf<BasicAccounting>(), IntPtr.Zero))
                    throw NativeFailure("git_job_accounting_failed");
                jobTotalProcesses = Math.Max(jobTotalProcesses, accounting.TotalProcesses);
#if GIT_IMPORT_FIXTURE
                SampleJobProcesses(job, observedJobProcesses);
#endif
                if (childExited && accounting.ActiveProcesses == 0 &&
                    stdoutTask.IsCompletedSuccessfully && stderrTask.IsCompletedSuccessfully)
                {
                    if (!GetExitCodeProcess(child.Process, out var observedCode))
                        throw NativeFailure("git_child_exit_code_failed");
                    exitCode = checked((int)observedCode);
                    break;
                }
            }
            if (heldImage.Position != 0) heldImage.Position = 0;
            if (Convert.ToHexString(SHA256.HashData(heldImage)).ToLowerInvariant() != heldImageSha256)
                throw new IOException("held_git_image_changed");
#if GIT_IMPORT_FIXTURE
            if (calibrationGitSha256 is null)
            {
                if (graphProfile is null) heldStaticImports!.AssertUnchanged();
                else graphProfile.AssertUnchanged();
            }
#endif
        }
        catch (Exception exception)
        {
            error = exception.GetType().Name + ":" + exception.Message;
        }
        finally
        {
            if (created)
            {
                var terminated = job != IntPtr.Zero && TerminateJobObject(job, 1);
                if (!terminated && child.Process != IntPtr.Zero)
                    TerminateProcess(child.Process, 1);
                var drain = Stopwatch.StartNew();
                var empty = false;
                while (terminated && drain.Elapsed < DrainLimit)
                {
                    if (!QueryInformationJobObject(job, 1, out var accounting,
                            (uint)Marshal.SizeOf<BasicAccounting>(), IntPtr.Zero)) break;
                    jobTotalProcesses = Math.Max(jobTotalProcesses, accounting.TotalProcesses);
                    if (accounting.ActiveProcesses == 0) { empty = true; break; }
                    Thread.Sleep(5);
                }
                var processSettled = child.Process != IntPtr.Zero &&
                    WaitForSingleObject(child.Process, 2000) == WaitObject0;
                childExited |= processSettled;
                jobDrained = terminated && empty && processSettled;
            }
            var outSettled = ReaderSettled(stdoutTask);
            var errSettled = ReaderSettled(stderrTask);
            if ((stdoutTask is not null && !outSettled) ||
                (stderrTask is not null && !errSettled)) jobDrained = false;
            try { stdin?.Dispose(); stdout?.Dispose(); stderr?.Dispose(); }
            catch { handlesClosed = false; }
            if (child.Thread != IntPtr.Zero) handlesClosed &= CloseHandle(child.Thread);
            if (child.Process != IntPtr.Zero) handlesClosed &= CloseHandle(child.Process);
            if (attributeListInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
            if (job != IntPtr.Zero) handlesClosed &= CloseHandle(job);
            try { heldImage?.Dispose(); }
            catch { handlesClosed = false; }
#if GIT_IMPORT_FIXTURE
            try { heldStaticImports?.Dispose(); }
            catch { handlesClosed = false; }
#endif
            jobDrained &= handlesClosed;
            clock.Stop();
        }

        var outCapture = stdoutTask is { IsCompletedSuccessfully: true }
            ? stdoutTask.Result : new Capture([], false);
        var errCapture = stderrTask is { IsCompletedSuccessfully: true }
            ? stderrTask.Result : new Capture([], false);
        var streamsCompleted = stdoutTask is { IsCompletedSuccessfully: true } &&
            stderrTask is { IsCompletedSuccessfully: true };
        outputExceeded |= outCapture.Truncated || errCapture.Truncated;
        return new CommandRecord(phase, imagePath, cwd, argv,
            began.ToString("O"), clock.ElapsedMilliseconds, exitCode,
            timedOut, canceled, outputExceeded, streamsCompleted, childExited,
            jobDrained && imageMatched && allowlistConfigured,
            created && allowlistConfigured, childResumed, jobDrained, jobTotalProcesses,
            heldImageSha256, error, configuredSystemRoot, configuredWindir,
            configuredComSpec, configuredPathSha256, configuredGitExecPath,
            Sha(outCapture.Bytes), Sha(errCapture.Bytes), outCapture.Bytes.Length,
            errCapture.Bytes.Length, Display(outCapture.Bytes), Display(errCapture.Bytes)
#if GIT_IMPORT_FIXTURE
            , staticImports, rootProcessId,
            observedJobProcesses.Values.OrderBy(value => value.ProcessId).ToArray()
#endif
            );
    }

    private static string ConstructEnvironmentBlock(IReadOnlyDictionary<string, string> env)
    {
        if (env.Count is < 1 or > 64) throw new InvalidOperationException("git_environment_count_invalid");
        var entries = env.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase).ToArray();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, value) in entries)
        {
            if (name.Length is < 1 or > 128 || name[0] == '=' ||
                name.Contains('=') || name.Contains('\0') ||
                value.Length > 16_384 || value.Contains('\0') || !names.Add(name))
                throw new InvalidOperationException("git_environment_invalid");
        }
        var block = string.Join('\0', entries.Select(pair => pair.Key + "=" + pair.Value)) + "\0\0";
        if (block.Length > 32767) throw new InvalidOperationException("git_environment_too_large");
        return block;
    }

    private static string NativeFilePath(IntPtr file)
    {
        var text = new StringBuilder(32768);
        var length = GetFinalPathNameByHandleW(file, text, (uint)text.Capacity, 2);
        if (length == 0 || length >= text.Capacity) throw NativeFailure("held_git_path_unavailable");
        return text.ToString(0, checked((int)length));
    }

    private static string ProcessNativePath(IntPtr process)
    {
        var text = new StringBuilder(32768);
        var length = (uint)text.Capacity;
        if (!QueryFullProcessImageNameW(process, 1, text, ref length) || length == 0)
            throw NativeFailure("git_process_path_unavailable");
        return text.ToString(0, checked((int)length));
    }

#if GIT_IMPORT_FIXTURE
    // Bounded snapshots of processes active in this Job. Short-lived children
    // may be counted by Job accounting without appearing in a snapshot.
    private static void SampleJobProcesses(IntPtr job,
        Dictionary<uint, JobProcessObservation> observed)
    {
        var list = Marshal.AllocHGlobal(8 + MaxObservedJobProcesses * IntPtr.Size);
        try
        {
            if (!QueryInformationJobObject(job, 3, list,
                    (uint)(8 + MaxObservedJobProcesses * IntPtr.Size), IntPtr.Zero))
                throw NativeFailure("git_job_process_list_failed");
            var assigned = Marshal.ReadInt32(list, 0);
            var count = Marshal.ReadInt32(list, 4);
            if (assigned < 0 || count < 0 || assigned > MaxObservedJobProcesses ||
                count > MaxObservedJobProcesses || count > assigned)
                throw new InvalidOperationException("git_job_process_list_out_of_bounds");
            for (var i = 0; i < count; i++)
            {
                var raw = Marshal.ReadIntPtr(list, 8 + i * IntPtr.Size).ToInt64();
                if (raw is < 1 or > uint.MaxValue)
                    throw new InvalidOperationException("git_job_process_id_invalid");
                var pid = (uint)raw;
                if (observed.ContainsKey(pid)) continue;
                var process = OpenProcess(ProcessQueryLimitedInformation, false, pid);
                if (process == IntPtr.Zero) continue; // It may have exited.
                try
                {
                    var path = ProcessNativePath(process);
                    if (NtQueryInformationProcess(process, 0, out var basic,
                            (uint)Marshal.SizeOf<ProcessBasicInformation>(), IntPtr.Zero) != 0 ||
                        basic.UniqueProcessId.ToInt64() != pid ||
                        basic.InheritedFromUniqueProcessId.ToInt64() is < 1 or > uint.MaxValue)
                        continue;
                    observed.Add(pid, new JobProcessObservation(pid,
                        (uint)basic.InheritedFromUniqueProcessId.ToInt64(), path,
                        DateTimeOffset.UtcNow.ToString("O")));
                }
                catch (Win32Exception) { /* Process may have exited. */ }
                finally { CloseHandle(process); }
            }
        }
        finally { Marshal.FreeHGlobal(list); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public int ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public int BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }
#endif

    private static Capture ReadBounded(Stream stream)
    {
        var bytes = new byte[MaxBytesPerStream];
        var chunk = new byte[4096];
        var length = 0;
        while (true)
        {
            var count = stream.Read(chunk, 0, chunk.Length);
            if (count == 0) return new Capture(bytes[..length], false);
            var copied = Math.Min(MaxBytesPerStream - length, count);
            if (copied > 0) Buffer.BlockCopy(chunk, 0, bytes, length, copied);
            length += copied;
            if (copied != count) return new Capture(bytes[..length], true);
        }
    }

    private static bool ReaderSettled(Task<Capture>? task)
    {
        if (task is null) return false;
        try { return task.Wait(DrainLimit) && task.IsCompletedSuccessfully; }
        catch { return false; }
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && !value.Any(c => char.IsWhiteSpace(c) || c == '"')) return value;
        var output = new StringBuilder("\"");
        var slashes = 0;
        foreach (var c in value)
        {
            if (c == '\\') { slashes++; continue; }
            output.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            output.Append(c);
            slashes = 0;
        }
        return output.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static string Sha(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static string Display(byte[] bytes)
    {
        var text = Encoding.UTF8.GetString(bytes);
        return text.Length <= 2048 ? text : text[..1024] + "\n...[truncated]...\n" + text[^1024..];
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
#if GIT_IMPORT_FIXTURE
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind,
        IntPtr processIds, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access,
        [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);
    [DllImport("ntdll.dll", ExactSpelling = true)]
    private static extern int NtQueryInformationProcess(IntPtr process, int kind,
        out ProcessBasicInformation info, uint size, IntPtr returned);
#endif
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
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
#if GIT_IMPORT_FIXTURE
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation,
        out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job,
        [MarshalAs(UnmanagedType.Bool)] out bool inJob);
#endif
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
