using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// An owned suspended-child control for the proposed one-shot launcher. It never
// resumes the redirected image or alters a shared DOS-device name.
internal static class ProcessImageProbe
{
  internal static void Run(string root, string canary, List<string> results)
  {
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
  }

  private static uint RunSelectedChild(string executable, string arguments, string? cwd)
  {
    var startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfo>() };
    var command = new StringBuilder($"\"{executable}\" {arguments}");
    if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false,
        0x4, IntPtr.Zero, cwd, ref startup, out var child))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    try
    {
      PrivateDriveProbe.SelectGlobalChild(child.Process);
      if (ResumeThread(child.Thread) != 1 || WaitForSingleObject(child.Process, 5000) != 0 ||
          !GetExitCodeProcess(child.Process, out var code))
        throw new IOException("Owned cwd canary failed");
      return code;
    }
    finally
    {
      var stopped = WaitForSingleObject(child.Process, 0) == 0 ||
          (TerminateProcess(child.Process, 1) && WaitForSingleObject(child.Process, 5000) == 0);
      var threadClosed = CloseHandle(child.Thread);
      var processClosed = CloseHandle(child.Process);
      if (!stopped || !threadClosed || !processClosed)
        throw new IOException("Owned cwd canary cleanup uncertain");
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
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
}
