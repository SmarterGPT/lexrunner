using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Native execution mechanism for the existing ownership contract, not a sandbox.
internal static class NativeProcess
{
  internal const int OutputLimit = 256 * 1024;
  internal sealed record Result(string Status, uint ExitCode, byte[] Stdout, byte[] Stderr,
      bool StdoutTruncated, bool StderrTruncated, long DurationMs, uint ProcessId);
  private sealed record Capture(byte[] Bytes, bool Truncated);

  internal static Result Run(string executable, string[] arguments, string cwd, int timeoutMs, int maximum, IReadOnlyDictionary<string, string>? environment = null)
  {
    if (!Path.IsPathFullyQualified(executable) || executable.Contains('\0') ||
        !executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ||
        arguments.Length > 64 || arguments.Any(a => a.Length > 2048 || a.Contains('\0')) ||
        timeoutMs is < 1 or > 30_000 || maximum is < 1 or > OutputLimit) throw new InvalidDataException();
    var command = string.Join(" ", new[] { executable }.Concat(arguments).Select(Quote));
    if (command.Length > 30_000) throw new InvalidDataException();
    var clock = Stopwatch.StartNew();
    using var job = CreateJobObjectW(IntPtr.Zero, null);
    if (job.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
    var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    using var stdout = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
    using var stderr = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
    using var stdin = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
    if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var attributes = Marshal.AllocHGlobal(size);
    var handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
    var jobs = Marshal.AllocHGlobal(IntPtr.Size);
    var initialized = false;
    ProcessInformation process = default;
    IntPtr environmentBlock = IntPtr.Zero;
    try
    {
      if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      initialized = true;
      Marshal.WriteIntPtr(jobs, job.DangerousGetHandle());
      Marshal.WriteIntPtr(handles, 0, stdin.ClientSafePipeHandle.DangerousGetHandle());
      Marshal.WriteIntPtr(handles, IntPtr.Size, stdout.ClientSafePipeHandle.DangerousGetHandle());
      Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, stderr.ClientSafePipeHandle.DangerousGetHandle());
      // Assign atomically at creation; inherit only the three dedicated stdio handles.
      if (!UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x2000d, jobs, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero) ||
          !UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x20002, handles, (IntPtr)(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      var startup = new StartupInfoEx
      {
        Info = new StartupInfo
        {
          Size = Marshal.SizeOf<StartupInfoEx>(), Flags = 0x100,
          Input = stdin.ClientSafePipeHandle.DangerousGetHandle(),
          Output = stdout.ClientSafePipeHandle.DangerousGetHandle(),
          Error = stderr.ClientSafePipeHandle.DangerousGetHandle()
        },
        Attributes = attributes
      };
      if (environment != null)
      {
        var block = string.Join('\0', environment.OrderBy(p => p.Key, StringComparer.OrdinalIgnoreCase).Select(p => p.Key + "=" + p.Value)) + "\0\0";
        environmentBlock = Marshal.StringToHGlobalUni(block);
      }
      if (!CreateProcessW(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true,
          0x08080400, environmentBlock, cwd, ref startup, out process))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      stdout.DisposeLocalCopyOfClientHandle();
      stderr.DisposeLocalCopyOfClientHandle();
      stdin.DisposeLocalCopyOfClientHandle();
      stdin.Dispose(); // Commands receive EOF, never the coordinator protocol pipe.
      // Independent synchronous pipe readers avoid thread-pool ramp-up delaying output.
      var outputTask = Task.Factory.StartNew(() => Read(stdout, maximum), TaskCreationOptions.LongRunning);
      var errorTask = Task.Factory.StartNew(() => Read(stderr, maximum), TaskCreationOptions.LongRunning);
      var status = "exited";
      try
      {
        while (true)
        {
          var wait = WaitForSingleObject(process.Process, 10);
          if (wait == 0) { if (clock.ElapsedMilliseconds >= timeoutMs) status = "timeout"; break; }
          if (wait != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
          if (outputTask.IsFaulted || errorTask.IsFaulted) throw new IOException("Process output failed");
          if ((outputTask.IsCompletedSuccessfully && outputTask.Result.Truncated) ||
              (errorTask.IsCompletedSuccessfully && errorTask.Result.Truncated)) { status = "output_limit"; break; }
          if (clock.ElapsedMilliseconds >= timeoutMs) { status = "timeout"; break; }
        }
        // Close the operation's descendants even if the direct command has exited.
        if (!TerminateJobObject(job, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var cleanup = Stopwatch.StartNew();
        while (true)
        {
          if (!QueryInformationJobObject(job, 1, out var accounting, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
          if (accounting.ActiveProcesses == 0) break;
          if (cleanup.ElapsedMilliseconds >= 2000) throw new IOException("Process cleanup uncertain");
          Thread.Sleep(5);
        }
        if (WaitForSingleObject(process.Process, 2000) != 0 || !GetExitCodeProcess(process.Process, out var exitCode))
          throw new IOException("Process exit unobserved");
        if (!Task.WaitAll([outputTask, errorTask], 2000)) throw new IOException("Process pipes unclosed");
        var output = outputTask.Result;
        var error = errorTask.Result;
        if (output.Truncated || error.Truncated) status = "output_limit";
        else if (status == "exited" && exitCode != 0) status = "nonzero_exit";
        return new Result(status, exitCode, output.Bytes, error.Bytes, output.Truncated,
            error.Truncated, clock.ElapsedMilliseconds, process.Id);
      }
      finally
      {
        // Job handle closure also requests termination if exception handling fails.
        TerminateJobObject(job, 1);
      }
    }
    finally
    {
      var closed = true;
      if (process.Thread != IntPtr.Zero) closed &= CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) closed &= CloseHandle(process.Process);
      if (initialized) DeleteProcThreadAttributeList(attributes);
      if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
      Marshal.FreeHGlobal(attributes);
      Marshal.FreeHGlobal(handles);
      Marshal.FreeHGlobal(jobs);
      job.Dispose();
      closed &= job.ReleaseSucceeded == true;
      if (!closed) throw new IOException("Process handle release uncertain");
    }
  }

  private static Capture Read(Stream stream, int maximum)
  {
    using var content = new MemoryStream();
    var buffer = new byte[8192];
    while (true)
    {
      var count = stream.Read(buffer, 0, (int)Math.Min(buffer.Length, maximum - content.Length + 1));
      if (count == 0) return new Capture(content.ToArray(), false);
      var retained = Math.Min(count, maximum - (int)content.Length);
      content.Write(buffer, 0, retained);
      if (retained != count) return new Capture(content.ToArray(), true);
    }
  }

  // Windows CRT argv quoting, including empty arguments and backslashes before quotes/end.
  private static string Quote(string value)
  {
    if (value.Length > 0 && !value.Any(c => char.IsWhiteSpace(c) || c == '"')) return value;
    var result = new StringBuilder("\"");
    var slashes = 0;
    foreach (var c in value)
    {
      if (c == '\\') { slashes++; continue; }
      result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
      result.Append(c);
      slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }

  [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
  { public long ProcessTime, JobTime; public uint Flags; public UIntPtr Minimum, Maximum; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits
  { public BasicLimits Basic; public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] private struct Accounting
  { public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo
  { public int Size; public IntPtr Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags; public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error; }
  [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation { public IntPtr Process, Thread; public uint Id, ThreadId; }
  private sealed class JobHandle : SafeHandleZeroOrMinusOneIsInvalid
  {
    public JobHandle() : base(true) { }
    internal bool? ReleaseSucceeded { get; private set; }
    protected override bool ReleaseHandle() { var closed = CloseHandle(handle); ReleaseSucceeded = closed; return closed; }
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern JobHandle CreateJobObjectW(IntPtr attributes, string? name);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(JobHandle job, int kind, ref ExtendedLimits value, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(JobHandle job, int kind, out Accounting value, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(JobHandle job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
  [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInformation info);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
}
