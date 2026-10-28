using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// An owned suspended-child control for the proposed one-shot launcher. It never
// resumes the redirected image or alters a shared DOS-device name.
internal static class ProcessImageProbe
{
  internal static void Run(string root, string canary, List<string> results)
  {
    // The managed probe changes only its own private map; load framework code
    // before that change so missing test dependencies cannot mimic a refusal.
    Thread.Sleep(0);
    Stopwatch.StartNew().Stop();
    var systemCmd = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
    var expected = SuspendedImage(systemCmd);
    var alias = Path.Combine(root, "process-image-alias"); Directory.CreateDirectory(alias);
    var fake = Path.Combine(alias, systemCmd[3..]); Directory.CreateDirectory(Path.GetDirectoryName(fake)!);
    File.Copy(canary, fake);
    PrivateDriveProbe.WithAlias(systemCmd[..2], alias, () => {
      var observed = SuspendedImage(systemCmd);
      if (observed.Equals(expected, StringComparison.OrdinalIgnoreCase) ||
          !observed.Contains("process-image-alias", StringComparison.OrdinalIgnoreCase))
        throw new InvalidDataException("Suspended-image readback missed private-map redirection");
    });
    if (SuspendedImage(systemCmd) != expected)
      throw new InvalidDataException("Image probe did not restore its private map");
    results.Add("process-suspended-image-readback");

    var cwdLeaf = "lexrunner-cwd-" + Guid.NewGuid().ToString("N");
    var privateCwd = Path.Combine(alias, cwdLeaf); Directory.CreateDirectory(privateCwd);
    File.WriteAllText(Path.Combine(privateCwd, "value"), "private-cwd");
    var output = Path.Combine(root, "cwd-observed");
    var exitCode = 0u;
    PrivateDriveProbe.WithAlias(systemCmd[..2], alias, () => {
      exitCode = RunSelectedChild(systemCmd, $"--cwd-read value \"{output}\"", systemCmd[..3] + cwdLeaf);
    });
    if (exitCode != 4 || File.Exists(output) || File.ReadAllText(Path.Combine(privateCwd, "value")) != "private-cwd")
      throw new InvalidDataException("Child map selection unexpectedly preserved the private cwd");
    results.Add("process-child-map-cwd-mismatch");

    var globalCwd = Path.Combine(root, "global-work"); Directory.CreateDirectory(globalCwd);
    File.WriteAllText(Path.Combine(globalCwd, "value"), "global-cwd");
    var workerOutput = Path.Combine(root, "worker-cwd-observed");
    PrivateDriveProbe.WithAlias(systemCmd[..2], alias, () => {
      var workerCode = RunSelectedChild(systemCmd,
        $"--launch-cwd \"{canary}\" \"{globalCwd}\" \"{workerOutput}\"", null);
      if (workerCode != 0) throw new InvalidDataException("Final-map launch worker canary failed");
    });
    if (File.ReadAllText(workerOutput) != "global-cwd")
      throw new InvalidDataException("Final-map worker did not bind its command cwd");
    results.Add("process-final-map-worker-cwd");

    var marker = Path.Combine(alias, "owned-grandchild-pid");
    IntPtr grandchild = IntPtr.Zero;
    try
    {
      PrivateDriveProbe.WithAlias(systemCmd[..2], alias, () => {
        try
        {
          RunSelectedChild(systemCmd, $"--launch-hold \"{canary}\" \"{marker}\"", null, () => {
            var wait = Stopwatch.StartNew();
            var aliasMarker = systemCmd[..3] + "owned-grandchild-pid";
            while (!File.Exists(aliasMarker) && wait.ElapsedMilliseconds < 3000) Thread.Sleep(5);
            if (!File.Exists(aliasMarker)) throw new IOException("Owned grandchild never started");
            var pid = uint.Parse(File.ReadAllText(aliasMarker));
            grandchild = OpenProcess(0x100000, false, pid); // Pin the actual process, not just its PID.
            if (grandchild == IntPtr.Zero || WaitForSingleObject(grandchild, 0) != 258)
              throw new IOException("Owned grandchild was not live");
            throw new InvalidOperationException("Injected outer cancellation");
          });
          throw new Exception("Expected outer cancellation");
        }
        catch (InvalidOperationException error) when (error.Message == "Injected outer cancellation") { }
      });
      if (grandchild == IntPtr.Zero || WaitForSingleObject(grandchild, 5000) != 0)
        throw new IOException("Owned job did not drain the grandchild");
      results.Add("process-worker-failure-drains-descendant");
    }
    finally { if (grandchild != IntPtr.Zero && !CloseHandle(grandchild)) throw new IOException("Grandchild observation release uncertain"); }
  }

  private static uint RunSelectedChild(string executable, string arguments, string? cwd, Action? afterResume = null)
  {
    var job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    ProcessInfo child = default;
    var assigned = false;
    var startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfo>() };
    var command = new StringBuilder($"\"{executable}\" {arguments}");
    try
    {
      var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false,
          0x4, IntPtr.Zero, cwd, ref startup, out child))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      // The child is still suspended. No code can run before job ownership.
      if (!AssignProcessToJobObject(job, child.Process)) throw new Win32Exception(Marshal.GetLastWin32Error());
      assigned = true;
      PrivateDriveProbe.SelectGlobalChild(child.Process);
      if (ResumeThread(child.Thread) != 1) throw new IOException("Owned canary resume failed");
      afterResume?.Invoke();
      if (WaitForSingleObject(child.Process, 5000) != 0 ||
          !GetExitCodeProcess(child.Process, out var code))
        throw new IOException("Owned cwd canary failed");
      return code;
    }
    finally
    {
      var closed = true;
      if (child.Process != IntPtr.Zero)
      {
        if (assigned)
        {
          closed &= TerminateJobObject(job, 1);
          var drain = Stopwatch.StartNew();
          while (closed)
          {
            if (!QueryInformationJobObject(job, 1, out var accounting,
                (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero)) { closed = false; break; }
            if (accounting.ActiveProcesses == 0) break;
            if (drain.ElapsedMilliseconds >= 2000) { closed = false; break; }
            Thread.Sleep(5);
          }
        }
        else closed &= TerminateProcess(child.Process, 1);
        closed &= WaitForSingleObject(child.Process, 2000) == 0;
        closed &= CloseHandle(child.Thread);
        closed &= CloseHandle(child.Process);
      }
      closed &= CloseHandle(job);
      if (!closed) throw new IOException("Owned canary job/descendant cleanup uncertain");
    }
  }

  private static string SuspendedImage(string executable)
  {
    var startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfo>() };
    if (!CreateProcessW(executable, new StringBuilder('"' + executable + '"'),
        IntPtr.Zero, IntPtr.Zero, false, 0x4, IntPtr.Zero, null, ref startup, out var child))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    try
    {
      var name = new StringBuilder(32768); var length = (uint)name.Capacity;
      if (!QueryFullProcessImageNameW(child.Process, 1, name, ref length) || length == 0)
        throw new Win32Exception(Marshal.GetLastWin32Error());
      return name.ToString(0, checked((int)length));
    }
    finally
    {
      var terminated = TerminateProcess(child.Process, 1);
      var exited = WaitForSingleObject(child.Process, 5000) == 0;
      var threadClosed = CloseHandle(child.Thread);
      var processClosed = CloseHandle(child.Process);
      if (!terminated || !exited || !threadClosed || !processClosed)
        throw new IOException("Owned suspended-image child cleanup uncertain");
    }
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo
  { internal int Size; internal IntPtr Reserved, Desktop, Title; internal uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags; internal ushort Show, ReservedSize; internal IntPtr ReservedBytes, Input, Output, Error; }
  [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo
  { internal IntPtr Process, Thread; internal uint Id, ThreadId; }
  [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
  { internal long ProcessTime, JobTime; internal uint Flags; internal UIntPtr Minimum, Maximum; internal uint Active; internal UIntPtr Affinity; internal uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits
  { internal BasicLimits Basic; internal ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] private struct Accounting
  { internal long User, Kernel, PeriodUser, PeriodKernel; internal uint Faults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateProcessW(string application, StringBuilder command,
      IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inherit,
      uint flags, IntPtr environment, string? cwd, ref StartupInfo startup, out ProcessInfo info);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryFullProcessImageNameW(
      IntPtr process, uint flags, StringBuilder image, ref uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] private static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
}
