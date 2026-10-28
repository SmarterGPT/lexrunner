using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

// Constructed only from the just-read pipe's impersonation token. Never take
// peer identity from the client frame, process environment or a JSON context.
[SupportedOSPlatform("windows")]
internal sealed class ObservedPipePeer
{
    private ObservedPipePeer(string sid) => Sid = sid;
    internal string Sid { get; }

    internal static ObservedPipePeer Observe(SafePipeHandle pipe)
    {
        if (!ImpersonateNamedPipeClient(pipe))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            using var identity = WindowsIdentity.GetCurrent();
            return new ObservedPipePeer(identity.User?.Value ??
                throw new InvalidOperationException("peer_sid_unavailable"));
        }
        finally
        {
            if (!RevertToSelf())
                Environment.FailFast("Named-pipe client impersonation did not revert");
        }
    }

#if COORDINATOR_SERVICE_FIXTURE_TESTS
    internal static ObservedPipePeer OpenSelfFixture()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new ObservedPipePeer(identity.User?.Value ??
            throw new InvalidOperationException("fixture_sid_unavailable"));
    }
#endif

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ImpersonateNamedPipeClient(SafePipeHandle pipe);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RevertToSelf();
}
