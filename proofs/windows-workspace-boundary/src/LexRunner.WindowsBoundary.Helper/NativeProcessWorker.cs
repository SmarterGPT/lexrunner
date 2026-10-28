using System.Buffers.Binary;
using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// One command per short-lived process. The owner selects this process's final
// device map before resume; the long-lived directory owner never changes maps.
internal static class NativeProcessWorker
{
  private const int RequestLimit = 256 * 1024;
  private const int ReplyLimit = 768 * 1024;
  private const uint Suspended = 0x4;
  private const uint ExtendedStartup = 0x80000;
  private const uint NoWindow = 0x08000000;

  internal static int RunEntrypoint()
  {
    try
    {
      // The inherited cwd was resolved before map selection. Re-establish it
      // only after the parent has selected this worker's final global map.
      Directory.SetCurrentDirectory(Path.GetDirectoryName(Environment.ProcessPath!)!);
      using var input = Console.OpenStandardInput();
      using var output = Console.OpenStandardOutput();
      var requestBytes = ReadFrame(input, RequestLimit);
      using var document = JsonDocument.Parse(requestBytes, new JsonDocumentOptions { MaxDepth = 5 });
      var root = document.RootElement;
      if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
      var fields = root.EnumerateObject().ToArray();
      if (fields.Length != 7 || fields.Select(p => p.Name).OrderBy(p => p, StringComparer.Ordinal)
          .SequenceEqual(new[] { "args", "cwd", "env", "executable", "max_output_bytes", "nonce", "timeout_ms" }) == false)
        throw new InvalidDataException();
      if (root.GetProperty("args").ValueKind != JsonValueKind.Array ||
          root.GetProperty("cwd").ValueKind != JsonValueKind.String ||
          root.GetProperty("executable").ValueKind != JsonValueKind.String ||
          root.GetProperty("nonce").ValueKind != JsonValueKind.String ||
          root.GetProperty("timeout_ms").ValueKind != JsonValueKind.Number ||
          root.GetProperty("max_output_bytes").ValueKind != JsonValueKind.Number)
        throw new InvalidDataException();
      var nonce = root.GetProperty("nonce").GetString()!;
      if (nonce.Length != 64 || !nonce.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f'))
        throw new InvalidDataException();
      var executable = root.GetProperty("executable").GetString()!;
      var cwd = root.GetProperty("cwd").GetString()!;
      var args = root.GetProperty("args").EnumerateArray().Select(p =>
        p.ValueKind == JsonValueKind.String ? p.GetString()! : throw new InvalidDataException()).ToArray();
      var env = root.GetProperty("env");
      Dictionary<string, string>? environment = null;
      if (env.ValueKind == JsonValueKind.Array)
      {
        environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in env.EnumerateArray())
        {
          if (item.ValueKind != JsonValueKind.Object || item.EnumerateObject().Count() != 2)
            throw new InvalidDataException();
          var name = item.GetProperty("name").GetString();
          var value = item.GetProperty("value").GetString();
          if (name == null || value == null || !environment.TryAdd(name, value)) throw new InvalidDataException();
        }
        if (environment.Count > 256 || environment.Any(p => string.IsNullOrEmpty(p.Key) ||
            p.Key[0] is >= '0' and <= '9' || p.Key.Contains('=') || p.Key.Contains('\0') || p.Value.Contains('\0')) ||
            environment.Sum(p => p.Key.Length + p.Value.Length + 2) + 1 > 32767)
          throw new InvalidDataException();
      }
      else if (env.ValueKind != JsonValueKind.Null) throw new InvalidDataException();
      var canonical = Request(nonce, executable, args, cwd,
          root.GetProperty("timeout_ms").GetInt32(), root.GetProperty("max_output_bytes").GetInt32(), environment);
      if (!requestBytes.AsSpan().SequenceEqual(canonical)) throw new InvalidDataException();
      var result = NativeProcess.Run(executable, args, cwd,
          root.GetProperty("timeout_ms").GetInt32(), root.GetProperty("max_output_bytes").GetInt32(), environment);
      var digest = Convert.ToHexString(SHA256.HashData(requestBytes)).ToLowerInvariant();
      var reply = Program.Json(writer =>
      {
        writer.WriteString("digest", digest);
        writer.WriteNumber("duration_ms", result.DurationMs);
        writer.WriteNumber("exit_code", result.ExitCode);
        writer.WriteString("nonce", nonce);
        writer.WriteNumber("process_id", result.ProcessId);
        writer.WriteString("status", result.Status);
        writer.WriteString("stderr", Convert.ToBase64String(result.Stderr));
        writer.WriteBoolean("stderr_truncated", result.StderrTruncated);
        writer.WriteString("stdout", Convert.ToBase64String(result.Stdout));
        writer.WriteBoolean("stdout_truncated", result.StdoutTruncated);
      });
      WriteFrame(output, reply, ReplyLimit);
      if (input.ReadByte() != -1) throw new InvalidDataException();
      return 0;
    }
    catch (Exception error) when (error is IOException or InvalidDataException or JsonException or
        Win32Exception or ArgumentException or InvalidOperationException or OverflowException or
        AggregateException or KeyNotFoundException)
    {
      Console.Error.WriteLine("process worker rejected");
      return 3;
    }
  }

  internal static byte[] Request(string nonce, string executable, string[] args, string cwd,
      int timeout, int maximum, IReadOnlyDictionary<string, string>? environment) => Program.Json(writer =>
  {
    writer.WriteStartArray("args");
    foreach (var argument in args) writer.WriteStringValue(argument);
    writer.WriteEndArray();
    writer.WriteString("cwd", cwd);
    if (environment == null) writer.WriteNull("env");
    else
    {
      writer.WriteStartArray("env");
      foreach (var item in environment.OrderBy(p => p.Key, StringComparer.OrdinalIgnoreCase))
      {
        writer.WriteStartObject();
        writer.WriteString("name", item.Key);
        writer.WriteString("value", item.Value);
        writer.WriteEndObject();
      }
      writer.WriteEndArray();
    }
    writer.WriteString("executable", executable);
    writer.WriteNumber("max_output_bytes", maximum);
    writer.WriteString("nonce", nonce);
    writer.WriteNumber("timeout_ms", timeout);
  });

  internal static NativeProcess.Result RunBound(string executable, string[] args, string cwd,
      int timeout, int maximum, IReadOnlyDictionary<string, string>? environment)
  {
    var workerPath = Environment.ProcessPath ?? throw new InvalidDataException();
    var workerDirectory = Path.GetDirectoryName(workerPath) ?? throw new InvalidDataException();
    var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    var request = Request(nonce, executable, args, cwd, timeout, maximum, environment);
    if (request.Length > RequestLimit) throw new InvalidDataException();
    var digest = Convert.ToHexString(SHA256.HashData(request)).ToLowerInvariant();
    // Keep the exact selected image non-writable and non-deletable while it is
    // created and checked. Deployment/loader protection is a separate gate.
    using var image = new FileStream(workerPath, FileMode.Open, FileAccess.Read, FileShare.Read);
    var expectedImage = new StringBuilder(32768);
    var expectedLength = GetFinalPathNameByHandleW(image.SafeFileHandle.DangerousGetHandle(),
        expectedImage, (uint)expectedImage.Capacity, 2);
    if (expectedLength == 0 || expectedLength >= expectedImage.Capacity)
      throw new Win32Exception(Marshal.GetLastWin32Error());
    var job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero;
    ProcessInformation worker = default;
    var attributesInitialized = false;
    var owned = false;
    Task<byte[]>? replyTask = null, errorTask = null;
    try
    {
      using var stdout = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
      using var stderr = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
      using var stdin = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
      var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
      if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      attributes = Marshal.AllocHGlobal(size);
      handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
      jobs = Marshal.AllocHGlobal(IntPtr.Size);
      if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      attributesInitialized = true;
      Marshal.WriteIntPtr(jobs, job);
      Marshal.WriteIntPtr(handles, 0, stdin.ClientSafePipeHandle.DangerousGetHandle());
      Marshal.WriteIntPtr(handles, IntPtr.Size, stdout.ClientSafePipeHandle.DangerousGetHandle());
      Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, stderr.ClientSafePipeHandle.DangerousGetHandle());
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
      var command = new StringBuilder('"' + workerPath + '"' + " --process-worker " + Program.Version);
      if (!CreateProcessW(workerPath, command, IntPtr.Zero, IntPtr.Zero, true,
          Suspended | ExtendedStartup | NoWindow, IntPtr.Zero, workerDirectory, ref startup, out worker))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      owned = true; // JOB_LIST placed the still-suspended worker in this Job.
      var observedImage = new StringBuilder(32768); var observedLength = (uint)observedImage.Capacity;
      if (!QueryFullProcessImageNameW(worker.Process, 1, observedImage, ref observedLength) ||
          !observedImage.ToString(0, checked((int)observedLength))
            .Equals(expectedImage.ToString(0, checked((int)expectedLength)), StringComparison.OrdinalIgnoreCase))
        throw new IOException("Launch worker image identity mismatch");
      SelectGlobalChild(worker.Process);
      if (ResumeThread(worker.Thread) != 1) throw new IOException("Launch worker resume failed");
      stdin.DisposeLocalCopyOfClientHandle();
      stdout.DisposeLocalCopyOfClientHandle();
      stderr.DisposeLocalCopyOfClientHandle();
      replyTask = Task.Factory.StartNew(() => ReadFrame(stdout, ReplyLimit), TaskCreationOptions.LongRunning);
      errorTask = Task.Factory.StartNew(() => Drain(stderr, 4096), TaskCreationOptions.LongRunning);
      WriteFrame(stdin, request, RequestLimit);
      stdin.Dispose();
      if (!replyTask.Wait(timeout + 8000)) throw new IOException("Launch worker response timed out");
      var result = ParseReply(replyTask.Result, nonce, digest, maximum);
      if (WaitForSingleObject(worker.Process, 2000) != 0 ||
          !GetExitCodeProcess(worker.Process, out var workerExit) || workerExit != 0)
        throw new IOException("Launch worker exit unobserved");
      if (stdout.ReadByte() != -1) throw new InvalidDataException("Launch worker sent extra bytes");
      if (!errorTask.Wait(2000)) throw new IOException("Launch worker stderr unclosed");
      return result;
    }
    finally
    {
      var closed = true;
      if (owned)
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
        closed &= WaitForSingleObject(worker.Process, 2000) == 0;
      }
      if (replyTask != null) closed &= SpinWait.SpinUntil(() => replyTask.IsCompleted, 2000);
      if (errorTask != null) closed &= SpinWait.SpinUntil(() => errorTask.IsCompleted, 2000);
      if (worker.Thread != IntPtr.Zero) closed &= CloseHandle(worker.Thread);
      if (worker.Process != IntPtr.Zero) closed &= CloseHandle(worker.Process);
      if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
      closed &= CloseHandle(job);
      if (!closed) throw new IOException("Launch worker cleanup uncertain");
    }
  }

  private static NativeProcess.Result ParseReply(byte[] bytes, string nonce, string digest, int maximum)
  {
    using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 3 });
    var root = document.RootElement;
    if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 10 ||
        root.GetProperty("nonce").GetString() != nonce || root.GetProperty("digest").GetString() != digest)
      throw new InvalidDataException();
    var stdout = Convert.FromBase64String(root.GetProperty("stdout").GetString()!);
    var stderr = Convert.FromBase64String(root.GetProperty("stderr").GetString()!);
    if (stdout.Length > maximum || stderr.Length > maximum ||
        Convert.ToBase64String(stdout) != root.GetProperty("stdout").GetString() ||
        Convert.ToBase64String(stderr) != root.GetProperty("stderr").GetString())
      throw new InvalidDataException();
    var status = root.GetProperty("status").GetString()!;
    if (status is not ("exited" or "nonzero_exit" or "timeout" or "output_limit"))
      throw new InvalidDataException();
    var result = new NativeProcess.Result(status, root.GetProperty("exit_code").GetUInt32(), stdout, stderr,
        root.GetProperty("stdout_truncated").GetBoolean(), root.GetProperty("stderr_truncated").GetBoolean(),
        root.GetProperty("duration_ms").GetInt64(), root.GetProperty("process_id").GetUInt32());
    if (result.ProcessId == 0 || result.DurationMs < 0 ||
        (result.Status == "exited" && result.ExitCode != 0) ||
        (result.Status == "nonzero_exit" && result.ExitCode == 0) ||
        (result.Status == "output_limit" && !result.StdoutTruncated && !result.StderrTruncated))
      throw new InvalidDataException();
    var canonical = Program.Json(writer =>
    {
      writer.WriteString("digest", digest);
      writer.WriteNumber("duration_ms", result.DurationMs);
      writer.WriteNumber("exit_code", result.ExitCode);
      writer.WriteString("nonce", nonce);
      writer.WriteNumber("process_id", result.ProcessId);
      writer.WriteString("status", result.Status);
      writer.WriteString("stderr", Convert.ToBase64String(result.Stderr));
      writer.WriteBoolean("stderr_truncated", result.StderrTruncated);
      writer.WriteString("stdout", Convert.ToBase64String(result.Stdout));
      writer.WriteBoolean("stdout_truncated", result.StdoutTruncated);
    });
    if (!bytes.AsSpan().SequenceEqual(canonical)) throw new InvalidDataException();
    return result;
  }

  private static byte[] Drain(Stream input, int maximum)
  {
    using var output = new MemoryStream();
    var buffer = new byte[4096];
    int count;
    while ((count = input.Read(buffer)) != 0)
      if (output.Length < maximum) output.Write(buffer, 0, Math.Min(count, maximum - (int)output.Length));
    return output.ToArray();
  }

  private static byte[] ReadFrame(Stream input, int maximum)
  {
    Span<byte> header = stackalloc byte[4];
    input.ReadExactly(header);
    var length = BinaryPrimitives.ReadUInt32BigEndian(header);
    if (length is 0 || length > maximum) throw new InvalidDataException();
    var bytes = new byte[length];
    input.ReadExactly(bytes);
    return bytes;
  }

  private static void WriteFrame(Stream output, byte[] bytes, int maximum)
  {
    if (bytes.Length is 0 || bytes.Length > maximum) throw new InvalidDataException();
    Span<byte> header = stackalloc byte[4];
    BinaryPrimitives.WriteUInt32BigEndian(header, (uint)bytes.Length);
    output.Write(header);
    output.Write(bytes);
    output.Flush();
  }

  private static void SelectGlobalChild(IntPtr process)
  {
    var nameText = Marshal.StringToHGlobalUni(@"\GLOBAL??");
    var name = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
    IntPtr directory = IntPtr.Zero;
    try
    {
      Marshal.StructureToPtr(new UnicodeString { Length = 18, MaximumLength = 18, Buffer = nameText }, name, false);
      var attributes = new ObjectAttributes { Length = Marshal.SizeOf<ObjectAttributes>(), ObjectName = name, Flags = 0x40 };
      var status = NtOpenDirectoryObject(out directory, 3, ref attributes);
      if (status < 0) throw new IOException($"Global map open status 0x{status:x8}");
      status = NtSetInformationProcess(process, 23, ref directory, (uint)IntPtr.Size);
      if (status < 0) throw new IOException($"Child map selection status 0x{status:x8}");
    }
    finally
    {
      var closed = directory == IntPtr.Zero || CloseHandle(directory);
      Marshal.FreeHGlobal(name);
      Marshal.FreeHGlobal(nameText);
      if (!closed) throw new IOException("Global map handle release uncertain");
    }
  }

  [StructLayout(LayoutKind.Sequential)] private struct UnicodeString
  { internal ushort Length, MaximumLength; internal IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] private struct ObjectAttributes
  { internal int Length; internal IntPtr RootDirectory, ObjectName; internal uint Flags; internal IntPtr SecurityDescriptor, SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
  { internal long ProcessTime, JobTime; internal uint Flags; internal UIntPtr Minimum, Maximum; internal uint Active; internal UIntPtr Affinity; internal uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits
  { internal BasicLimits Basic; internal ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] private struct Accounting
  { internal long User, Kernel, PeriodUser, PeriodKernel; internal uint Faults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo
  { internal int Size; internal IntPtr Reserved, Desktop, Title; internal uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags; internal ushort Show, ReservedSize; internal IntPtr ReservedBytes, Input, Output, Error; }
  [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { internal StartupInfo Info; internal IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation { internal IntPtr Process, Thread; internal uint Id, ThreadId; }
  [DllImport("ntdll.dll", ExactSpelling = true)] private static extern int NtOpenDirectoryObject(out IntPtr handle, uint access, ref ObjectAttributes attributes);
  [DllImport("ntdll.dll", ExactSpelling = true)] private static extern int NtSetInformationProcess(IntPtr process, int kind, ref IntPtr data, uint length);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
  [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInformation info);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder image, ref uint length);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
}
