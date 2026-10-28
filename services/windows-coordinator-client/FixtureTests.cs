#if COORDINATOR_CLIENT_FIXTURE_TESTS
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using LexRunner.WindowsCoordinator.Client;
using Microsoft.Win32.SafeHandles;

// This entire file is excluded from the ordinary NativeAOT image. These
// same-user controls do not authenticate an installed service or selection.
internal static class FixtureServer
{
    private const string Prefix = @"\\.\pipe\LexRunner.Coordinator.ClientFixture.";
    private const uint PipeAccessDuplex = 3;
    private const uint FileFlagOverlapped = 0x40000000;
    private const uint FileFlagFirstPipeInstance = 0x00080000;
    private const uint PipeRejectRemoteClients = 8;
    private const int SecurityDescriptorRevision = 1;

    internal static string Name(string nonce) => Prefix + nonce;
    internal static bool ValidNonce(string nonce) => nonce.Length == 32 &&
        nonce.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    [SupportedOSPlatform("windows")]
    internal static int Run(string nonce, string behavior)
    {
        if (!ValidNonce(nonce) || behavior is not
            ("echo" or "malformed" or "oversize" or "stall" or "stall-read" or "disconnect"))
            return Program.Emit(new Output { State = "invalid_fixture_arguments" }, 2);
        var sid = WindowsIdentity.GetCurrent().User?.Value ??
            throw new InvalidOperationException("Current user SID unavailable");
        // The 0x00100083 client ACE permits read/write/attributes/synchronize,
        // but not FILE_CREATE_PIPE_INSTANCE (0x4). This is the reviewed
        // PIPE-RIGHTS-001 / PIPE-OVERLAPPED-001 disposable profile.
        var sddl = $"D:P(A;;GA;;;SY)(A;;0x00100083;;;{sid})S:(ML;;NW;;;LW)";
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,
            SecurityDescriptorRevision, out var descriptor, out _))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var attributes = new SecurityAttributes
            {
                Length = Marshal.SizeOf<SecurityAttributes>(),
                SecurityDescriptor = descriptor
            };
            using var pipe = CreateNamedPipeWithSecurity(Name(nonce),
                PipeAccessDuplex | FileFlagOverlapped | FileFlagFirstPipeInstance,
                PipeRejectRemoteClients, 2, 4096, 4096, 0, ref attributes);
            if (pipe.IsInvalid)
                return Program.Emit(new Output { State = "server_start_failed",
                    Error = Marshal.GetLastWin32Error() }, 5);
            Program.Emit(new Output { State = "ready", Pid = Environment.ProcessId }, 0);
            Console.Out.Flush();
            var clock = Stopwatch.StartNew();
            var io = new NativePipeIo(pipe, clock, 2500);
            var connected = io.Connect();
            if (!connected.Complete)
                return Program.Emit(new Output { State = "connect_unavailable",
                    BytesRead = 0, Error = connected.Error }, 6);
            if (behavior == "stall-read")
            {
                Thread.Sleep(500);
                return Program.Emit(new Output { State = "stalled_read", BytesRead = 0 }, 0);
            }
            var header = io.ReadExact(4);
            if (!header.Complete)
                return Program.Emit(new Output { State = "request_unavailable",
                    BytesRead = header.Bytes, Error = header.Error }, 0);
            var size = BitConverter.ToUInt32(header.Data);
            if (size is 0 or > 1024 * 1024)
                return Program.Emit(new Output { State = "invalid_request", BytesRead = 4 }, 6);
            var body = io.ReadExact((int)size);
            if (!body.Complete)
                return Program.Emit(new Output { State = "request_unavailable",
                    BytesRead = 4 + body.Bytes, Error = body.Error }, 6);
            if (behavior == "disconnect")
                return Program.Emit(new Output { State = "disconnected",
                    BytesRead = 4 + body.Bytes }, 0);
            if (behavior == "stall")
            {
                Thread.Sleep(500);
                return Program.Emit(new Output { State = "stalled",
                    BytesRead = 4 + body.Bytes }, 0);
            }
            byte[] reply = behavior switch
            {
                "malformed" => [0, 0, 0, 0],
                "oversize" => [0x01, 0x10, 0, 0],
                _ => FixtureTests.Frame("{\"state\":\"fixture_reply\"}")
            };
            var written = io.WriteExact(reply);
            return Program.Emit(new Output { State = written.Complete ? "complete" : "reply_unavailable",
                BytesRead = 4 + body.Bytes, BytesWritten = written.Bytes,
                Error = written.Error }, written.Complete ? 0 : 6);
        }
        finally { LocalFree(descriptor); }
    }

    internal static int TrySecondInstance(string pipeName)
    {
        using var second = CreateNamedPipeWithoutSecurity(pipeName,
            PipeAccessDuplex | FileFlagOverlapped, PipeRejectRemoteClients,
            2, 4096, 4096, 0, IntPtr.Zero);
        return second.IsInvalid ? Marshal.GetLastWin32Error() : 0;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        public int InheritHandle;
    }

    [DllImport("advapi32.dll", EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string sddl, int revision, out IntPtr descriptor, out uint descriptorSize);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", EntryPoint = "CreateNamedPipeW", CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern SafeFileHandle CreateNamedPipeWithSecurity(string name,
        uint openMode, uint pipeMode, uint maxInstances, uint outBuffer,
        uint inBuffer, uint defaultTimeout, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", EntryPoint = "CreateNamedPipeW", CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern SafeFileHandle CreateNamedPipeWithoutSecurity(string name,
        uint openMode, uint pipeMode, uint maxInstances, uint outBuffer,
        uint inBuffer, uint defaultTimeout, IntPtr attributes);
}

internal sealed class SyntheticServiceSnapshots(uint pid, bool changeAfterFirst,
    int secondReadDelayMs = 0) : IServiceSnapshots
{
    private int reads;
    public ServiceState? Read()
    {
        reads++;
        if (reads == 2 && secondReadDelayMs > 0) Thread.Sleep(secondReadDelayMs);
        return reads > 1 && changeAfterFirst
            ? new ServiceState(0x10, 1, pid)
            : new ServiceState(0x10, 4, pid);
    }
}

internal sealed class MissingServiceSnapshots : IServiceSnapshots
{
    public ServiceState? Read() => null;
}

internal static class FixtureTests
{
    internal static byte[] Frame(string payload)
    {
        var bytes = Encoding.UTF8.GetBytes(payload);
        var frame = new byte[bytes.Length + 4];
        BitConverter.TryWriteBytes(frame.AsSpan(0, 4), (uint)bytes.Length);
        bytes.CopyTo(frame, 4);
        return frame;
    }

    internal static int RunAll()
    {
        var results = new List<TestCase>();
        var failures = new List<string>();
        void Check(string name, bool passed, ClientResult? client = null,
            int? observedBytes = null)
        {
            results.Add(new TestCase { Name = name, Passed = passed, State = client?.State,
                BytesWritten = client?.BytesWritten, ServerBytesRead = observedBytes,
                SecondInstanceError = client?.SecondInstanceError });
            if (!passed) failures.Add(name);
        }

        // Synthetic missing-SCM response proves no pipe open or request write.
        // The ordinary --status check below remains closed on any host state.
        var absent = BoundClient.RoundTrip(new MissingServiceSnapshots(),
            new SelectedEndpoint(FixtureServer.Name(new string('0', 32)),
                Environment.ProcessPath!), Frame("{\"protocol\":\"fixture\"}"), 100);
        Check("missing_service_no_write", absent.State == "service_unavailable" &&
            absent.BytesWritten == 0, absent);
        Check("invalid_request", BoundClient.RoundTrip(
            new SyntheticServiceSnapshots((uint)Environment.ProcessId, false),
            new SelectedEndpoint(FixtureServer.Name(new string('0', 32)),
                Environment.ProcessPath!), [0, 0, 0, 0], 100).State == "invalid_request");

        Run("echo", "positive", (serverPid, path) =>
            BoundClient.RoundTrip(new SyntheticServiceSnapshots((uint)serverPid, false),
                new SelectedEndpoint(path, Environment.ProcessPath!),
                Frame("{\"protocol\":\"fixture\"}"), 2000, true),
            (client, bytes) => client.State == "reply" &&
                client.SecondInstanceError == 5 &&
                Encoding.UTF8.GetString(client.Reply ?? []) == "{\"state\":\"fixture_reply\"}" &&
                bytes > 0, results, failures);
        Run("echo", "wrong_server_no_write", (_, path) =>
            BoundClient.RoundTrip(new SyntheticServiceSnapshots((uint)Environment.ProcessId, false),
                new SelectedEndpoint(path, Environment.ProcessPath!),
                Frame("{\"protocol\":\"fixture\"}"), 250),
            (client, bytes) => client.State == "server_pid_mismatch" &&
                client.BytesWritten == 0 && bytes == 0, results, failures);
        var squatDenied = false;
        Run("echo", "live_name_second_instance_denied_no_write", (_, path) =>
        {
            squatDenied = SecondServerDenied(path);
            return BoundClient.RoundTrip(
                new SyntheticServiceSnapshots((uint)Environment.ProcessId, false),
                new SelectedEndpoint(path, Environment.ProcessPath!),
                Frame("{\"protocol\":\"fixture\"}"), 250);
        }, (client, bytes) => squatDenied && client.State == "server_pid_mismatch" &&
            client.BytesWritten == 0 && bytes == 0, results, failures);
        Run("echo", "service_changed_no_write", (pid, path) =>
            BoundClient.RoundTrip(new SyntheticServiceSnapshots((uint)pid, true),
                new SelectedEndpoint(path, Environment.ProcessPath!),
                Frame("{\"protocol\":\"fixture\"}"), 250),
            (client, bytes) => client.State == "service_changed" &&
                client.BytesWritten == 0 && bytes == 0, results, failures);
        Run("echo", "expired_before_first_write_no_write", (pid, path) =>
            BoundClient.RoundTrip(new SyntheticServiceSnapshots((uint)pid, false, 150),
                new SelectedEndpoint(path, Environment.ProcessPath!),
                Frame("{\"protocol\":\"fixture\"}"), 100),
            (client, bytes) => client.State == "deadline_exceeded_before_send" &&
                client.BytesWritten == 0 && bytes == 0, results, failures);
        Run("malformed", "malformed_reply", (pid, path) =>
            BoundClient.RoundTrip(new SyntheticServiceSnapshots((uint)pid, false),
                new SelectedEndpoint(path, Environment.ProcessPath!),
                Frame("{\"protocol\":\"fixture\"}"), 2000),
            (client, _) => client.State == "invalid_reply", results, failures);
        Run("oversize", "oversize_reply", (pid, path) =>
            BoundClient.RoundTrip(new SyntheticServiceSnapshots((uint)pid, false),
                new SelectedEndpoint(path, Environment.ProcessPath!),
                Frame("{\"protocol\":\"fixture\"}"), 2000),
            (client, _) => client.State == "invalid_reply", results, failures);
        Run("stall", "reply_timeout_unknown", (pid, path) =>
            BoundClient.RoundTrip(new SyntheticServiceSnapshots((uint)pid, false),
                new SelectedEndpoint(path, Environment.ProcessPath!),
                Frame("{\"protocol\":\"fixture\"}"), 100),
            (client, _) => client.State == "outcome_unknown" &&
                client.BytesWritten > 0, results, failures);
        Run("stall-read", "write_timeout_unknown", (pid, path) =>
            BoundClient.RoundTrip(new SyntheticServiceSnapshots((uint)pid, false),
                new SelectedEndpoint(path, Environment.ProcessPath!),
                Frame(new string('x', 1024 * 1024)), 100),
            (client, bytes) => client.State == "outcome_unknown" && bytes == 0,
            results, failures);
        Run("disconnect", "disconnect_unknown", (pid, path) =>
            BoundClient.RoundTrip(new SyntheticServiceSnapshots((uint)pid, false),
                new SelectedEndpoint(path, Environment.ProcessPath!),
                Frame("{\"protocol\":\"fixture\"}"), 2000),
            (client, _) => client.State == "outcome_unknown" &&
                client.BytesWritten > 0, results, failures);

        Program.Emit(new TestReport { State = failures.Count == 0 ? "pass" : "fail",
            Profile = "synthetic_same_user_non_authorizing", Results = results, Failures = failures },
            failures.Count == 0 ? 0 : 1);
        return failures.Count == 0 ? 0 : 1;
    }

    private static void Run(string serverBehavior, string name,
        Func<int, string, ClientResult> clientCall,
        Func<ClientResult, int, bool> check, List<TestCase> results,
        List<string> failures)
    {
        var nonce = Guid.NewGuid().ToString("N");
        var path = FixtureServer.Name(nonce);
        using var server = new Process
        {
            StartInfo = new ProcessStartInfo(Environment.ProcessPath!,
                $"--fixture-server {nonce} {serverBehavior}")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            }
        };
        try
        {
            if (!server.Start()) throw new InvalidOperationException("fixture server did not start");
            var readyLine = server.StandardOutput.ReadLineAsync()
                .WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
            if (readyLine is null || !readyLine.Contains("\"ready\"", StringComparison.Ordinal))
                throw new InvalidOperationException("fixture server did not become ready: " + readyLine);
            var client = clientCall(server.Id, path);
            if (!server.WaitForExit(5000)) throw new InvalidOperationException("fixture server did not exit");
            var finalLine = server.StandardOutput.ReadLine();
            var bytes = 0;
            if (finalLine is not null)
            {
                using var final = JsonDocument.Parse(finalLine);
                if (final.RootElement.TryGetProperty("bytes_read", out var value))
                    bytes = value.GetInt32();
            }
            var passed = server.ExitCode == 0 && check(client, bytes);
            results.Add(new TestCase { Name = name, Passed = passed, State = client.State,
                BytesWritten = client.BytesWritten, ServerBytesRead = bytes,
                SecondInstanceError = client.SecondInstanceError,
                ServerExit = server.ExitCode });
            if (!passed) failures.Add(name);
        }
        catch (Exception error)
        {
            results.Add(new TestCase { Name = name, Passed = false,
                Error = error.GetType().Name });
            failures.Add(name);
        }
        finally
        {
            if (!server.HasExited) server.Kill(true);
            server.WaitForExit(3000);
        }
    }

    private static bool SecondServerDenied(string path)
    {
        var nonce = path[^32..];
        using var second = new Process
        {
            StartInfo = new ProcessStartInfo(Environment.ProcessPath!,
                $"--fixture-server {nonce} echo")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            }
        };
        try
        {
            if (!second.Start() || !second.WaitForExit(3000)) return false;
            var output = second.StandardOutput.ReadToEnd();
            using var report = JsonDocument.Parse(output);
            return second.ExitCode == 5 &&
                report.RootElement.GetProperty("state").GetString() == "server_start_failed" &&
                report.RootElement.GetProperty("error").GetInt32() == 5;
        }
        finally
        {
            if (!second.HasExited) second.Kill(true);
            second.WaitForExit(3000);
        }
    }
}
#endif
