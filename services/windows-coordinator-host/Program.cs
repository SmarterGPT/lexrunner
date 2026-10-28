using System.Buffers.Binary;
using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

// Console-only transport/peer probe. No SCM entrypoint, admission state or effects.
internal static class Program
{
    private const int MaxFrameBytes = 1024 * 1024;
    private const uint PipeAccessDuplex = 0x00000003;
    private const uint FileFlagOverlapped = 0x40000000;
    private const uint FileFlagFirstPipeInstance = 0x00080000;
    private const uint PipeRejectRemoteClients = 0x00000008;
    private const int SecurityDescriptorRevision = 1;

    private static async Task<int> Main(string[] args)
    {
        if (!OperatingSystem.IsWindows() || args.Length != 7 ||
            args[0] != "--probe" || args[1] != "--nonce" ||
            args[3] != "--expected-sid" || args[5] != "--timeout-ms" ||
            args[2].Length != 32 || !args[2].All(IsLowerHex) ||
            !int.TryParse(args[6], out var timeoutMs) || timeoutMs is < 1 or > 30000)
        {
            Console.Error.WriteLine("console_probe_only");
            return 2;
        }

        try
        {
            // SID parsing is only input validation. The caller also supplies the
            // expected SID; this probe cannot authenticate enrollment or intent.
            var expectedSid = new SecurityIdentifier(args[4]).Value;
            var hostSid = WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException();
            var pipeName = $@"\\.\pipe\LexRunner.Coordinator.Probe.{args[2]}";
            using var deadline = new CancellationTokenSource(timeoutMs);
            using var pipe = CreateProbePipe(pipeName, hostSid, expectedSid);
            Console.Out.WriteLine("ready");
            Console.Out.Flush();

            await pipe.WaitForConnectionAsync(deadline.Token);
            var header = new byte[4];
            await pipe.ReadExactlyAsync(header, deadline.Token);

            // Named-pipe impersonation uses the client's last read request. Keep
            // it synchronous and revert before parsing or writing a response.
            var observedSid = ReadPeerSidAndRevert(pipe.SafePipeHandle);
            if (observedSid != expectedSid)
            {
                await WriteDenial(pipe, null, "admission_unavailable", deadline.Token);
                return 0;
            }

            var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
            if (length is 0 or > MaxFrameBytes)
            {
                await WriteDenial(pipe, null, "invalid_frame", deadline.Token);
                return 0;
            }
            var payload = new byte[(int)length];
            await pipe.ReadExactlyAsync(payload, deadline.Token);
            var parsed = ParseStatusOnly(payload);
            await WriteDenial(pipe, parsed.RequestId, parsed.Reason, deadline.Token);
            return 0;
        }
        catch (OperationCanceledException)
        {
            Console.Error.WriteLine("probe_deadline");
            return 4;
        }
        catch (EndOfStreamException)
        {
            Console.Error.WriteLine("probe_disconnect");
            return 5;
        }
        catch (IOException)
        {
            Console.Error.WriteLine("probe_disconnect");
            return 5;
        }
        catch (Exception error) when (error is Win32Exception or UnauthorizedAccessException or
                                      ArgumentException or InvalidOperationException or SecurityException)
        {
            Console.Error.WriteLine("probe_boundary_unavailable");
            return 3;
        }
    }

    private static bool IsLowerHex(char c) => c is >= '0' and <= '9' or >= 'a' and <= 'f';

    private static NamedPipeServerStream CreateProbePipe(string name, string hostSid, string expectedSid)
    {
        // Console-fixture DACL only. Host SID GA lets a same-user test client
        // exercise wrong-SID refusal. The expected SID GRGW generic-write ACE
        // also includes FILE_CREATE_PIPE_INSTANCE (FILE_APPEND_DATA). Thus a
        // permitted peer can create a server instance after this one-shot host
        // exits. FIRST_PIPE_INSTANCE only detects a preexisting instance at
        // creation; it does not authenticate a future server. Never reuse this
        // DACL for a persistent protected endpoint. Production needs specific
        // client-open rights and independent server authentication.
        var sddl = $"D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{hostSid})(A;;GRGW;;;{expectedSid})";
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, SecurityDescriptorRevision,
                out var descriptor, out _))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var attributes = new SecurityAttributes
            {
                Length = Marshal.SizeOf<SecurityAttributes>(),
                SecurityDescriptor = descriptor,
                InheritHandle = 0
            };
            var handle = CreateNamedPipe(name,
                PipeAccessDuplex | FileFlagOverlapped | FileFlagFirstPipeInstance,
                PipeRejectRemoteClients, 1, 4096, 4096, 0, ref attributes);
            if (handle.IsInvalid)
            {
                var failure = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(failure);
            }
            try
            {
                return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }
        finally
        {
            LocalFree(descriptor);
        }
    }

    [SupportedOSPlatform("windows")]
    private static string ReadPeerSidAndRevert(SafePipeHandle handle)
    {
        if (!ImpersonateNamedPipeClient(handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            return WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException();
        }
        finally
        {
            // If reversion fails, terminate rather than continue as the peer.
            if (!RevertToSelf()) Environment.FailFast("Native pipe impersonation did not revert");
        }
    }

    private static (string? RequestId, string Reason) ParseStatusOnly(byte[] payload)
    {
        string json;
        try { json = new UTF8Encoding(false, true).GetString(payload); }
        catch (DecoderFallbackException) { return (null, "invalid_frame"); }
        try
        {
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 16 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return (null, "invalid_request");
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var field in root.EnumerateObject())
                if (!names.Add(field.Name)) return (null, "invalid_frame");
            if (names.Count != 5 ||
                !ReadOpaque(root, "request_id", out var requestId) ||
                !ReadOpaque(root, "run_id", out var runId) ||
                !ReadOpaque(root, "attempt_id", out var attemptId) ||
                !ReadExact(root, "schema_version", "1.0.0") ||
                !ReadExact(root, "verb", "attempt.status"))
                return (null, "invalid_request");

            // Exact TS canonicalJSONStringify shape for this bounded ASCII-only
            // status envelope. Prepare/packet semantics stay with the Node side.
            var canonical = "{\n" +
                $"  \"attempt_id\": \"{attemptId}\",\n" +
                $"  \"request_id\": \"{requestId}\",\n" +
                $"  \"run_id\": \"{runId}\",\n" +
                "  \"schema_version\": \"1.0.0\",\n" +
                "  \"verb\": \"attempt.status\"\n" +
                "}\n";
            return json == canonical ? (requestId, "admission_unavailable") : (null, "invalid_frame");
        }
        catch (JsonException) { return (null, "invalid_frame"); }
    }

    private static bool ReadOpaque(JsonElement root, string name, out string value)
    {
        value = "";
        if (!root.TryGetProperty(name, out var field) || field.ValueKind != JsonValueKind.String) return false;
        value = field.GetString() ?? "";
        return value.Length is >= 1 and <= 128 &&
               ((value[0] is >= 'A' and <= 'Z') || (value[0] is >= 'a' and <= 'z') ||
                (value[0] is >= '0' and <= '9')) &&
               value.All(c => c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '.' or '_' or ':' or '-');
    }

    private static bool ReadExact(JsonElement root, string name, string expected) =>
        root.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String &&
        field.GetString() == expected;

    private static async Task WriteDenial(Stream pipe, string? requestId, string reason,
        CancellationToken cancellation)
    {
        var id = requestId is null ? "null" : $"\"{requestId}\"";
        var json = "{\n" +
            "  \"authorizes_execution\": false,\n" +
            "  \"effect_state\": \"no_effect\",\n" +
            "  \"kind\": \"denial\",\n" +
            $"  \"reason_code\": \"{reason}\",\n" +
            $"  \"request_id\": {id},\n" +
            "  \"schema_version\": \"1.0.0\"\n" +
            "}\n";
        var payload = Encoding.UTF8.GetBytes(json);
        var frame = new byte[payload.Length + 4];
        BinaryPrimitives.WriteUInt32LittleEndian(frame, (uint)payload.Length);
        payload.CopyTo(frame.AsSpan(4));
        await pipe.WriteAsync(frame, cancellation);
        await pipe.FlushAsync(cancellation);
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
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
        string text, int revision, out IntPtr descriptor, out uint size);

    [DllImport("kernel32.dll", EntryPoint = "CreateNamedPipeW", CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode,
        int maxInstances, int outBufferSize, int inBufferSize, int defaultTimeout,
        ref SecurityAttributes securityAttributes);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool ImpersonateNamedPipeClient(SafePipeHandle handle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool RevertToSelf();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);
}
