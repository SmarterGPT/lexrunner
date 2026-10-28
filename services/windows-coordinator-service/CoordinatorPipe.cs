using System.Buffers.Binary;
using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

internal static class CoordinatorPipe
{
    private const uint PipeAccessDuplex = 0x00000003;
    private const uint FileFlagOverlapped = 0x40000000;
    private const uint FileFlagFirstPipeInstance = 0x00080000;
    private const uint PipeRejectRemoteClients = 0x00000008;
    private const int SecurityDescriptorRevision = 1;
    private const int RequestTimeoutMs = 5000;

    [SupportedOSPlatform("windows")]
    internal static NamedPipeServerStream Create(string name, string serviceSid)
        => CreateCore(name, serviceSid, null);

#if COORDINATOR_SERVICE_FIXTURE_TESTS
    [SupportedOSPlatform("windows")]
    internal static NamedPipeServerStream CreateFixture(string name, string serviceSid, string clientSid)
        => CreateCore(name, serviceSid, clientSid);
#endif

    [SupportedOSPlatform("windows")]
    private static NamedPipeServerStream CreateCore(string name, string serviceSid, string? clientSid)
    {
        // The normal image has no enrolled client and therefore no client ACE.
        // A compile-gated disposable fixture may grant an exact test SID only
        // READ_DATA | WRITE_DATA | READ_ATTRIBUTES | SYNCHRONIZE (0x00100083).
        // That omits FILE_CREATE_PIPE_INSTANCE (0x4), WRITE_DAC and WRITE_OWNER.
        // Installed service account, MIC and cross-account behavior are separate
        // qualification gates; no label downgrade or privilege is assumed here.
        var sddl = $"D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{serviceSid})";
        if (clientSid is not null)
            sddl += $"(A;;0x00100083;;;{clientSid})";
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl,
                SecurityDescriptorRevision, out var descriptor, out _))
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
                var code = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(code);
            }
            try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); }
            catch
            {
                handle.Dispose();
                throw;
            }
        }
        finally { LocalFree(descriptor); }
    }

    [SupportedOSPlatform("windows")]
    internal static async Task ServeAsync(NamedPipeServerStream pipe, CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            try { await pipe.WaitForConnectionAsync(stop); }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { return; }
            catch (IOException) when (stop.IsCancellationRequested) { return; }

            try
            {
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop);
                deadline.CancelAfter(RequestTimeoutMs);
                var header = new byte[4];
                await pipe.ReadExactlyAsync(header, deadline.Token);

                var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
                if (length is > 0 and <= CoordinatorProtocol.MaxRequestBytes)
                {
                    var payload = new byte[(int)length];
                    await pipe.ReadExactlyAsync(payload, deadline.Token);

                    // The last pipe read fixes the peer token for this
                    // synchronous observation. Never await or perform an
                    // effect while carrying the client token.
                    _ = ReadPeerSidAndRevert(pipe.SafePipeHandle);

                    var parsed = CoordinatorProtocol.ParseStatusOnly(payload);
                    if (parsed.Request is { } request)
                    {
                        // No protected store is open. The v2 status reply
                        // conservatively reports an unknown historical effect;
                        // it does not authorize execution or assert no_effect.
                        var reply = CoordinatorProtocol.IndeterminateStatusFrame(request);
                        await pipe.WriteAsync(reply.AsMemory(), deadline.Token);
                        // Keep this instance connected while the client reads
                        // the response. A completed pipe write is not proof of
                        // delivery; the next bounded read waits for peer close
                        // (or the deadline) before Disconnect can discard bytes.
                        _ = await pipe.ReadAsync(new byte[1], deadline.Token);
                    }
                }
                // Invalid or incomplete requests close without a status claim.
                // No Git, worker, Node or store is reachable from this image.
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { return; }
            catch (OperationCanceledException) { /* bounded client timeout */ }
            catch (EndOfStreamException) { /* disconnected client */ }
            catch (IOException) { /* disconnected client */ }
            finally
            {
                // A broken client can make IsConnected false while this server
                // instance still needs DisconnectNamedPipe before reuse.
                pipe.Disconnect();
            }
        }
    }

    [SupportedOSPlatform("windows")]
    private static string ReadPeerSidAndRevert(SafePipeHandle handle)
    {
        if (!ImpersonateNamedPipeClient(handle))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            return WindowsIdentity.GetCurrent().User?.Value ??
                throw new InvalidOperationException("peer_sid_unavailable");
        }
        finally
        {
            // A failed revert leaves this service thread carrying client
            // identity. Terminate the process rather than continue.
            if (!RevertToSelf())
                Environment.FailFast("Named-pipe client impersonation did not revert");
        }
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
