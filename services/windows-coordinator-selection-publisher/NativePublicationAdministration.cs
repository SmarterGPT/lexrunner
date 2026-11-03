using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;

namespace LexRunner.WindowsCoordinator.SelectionPublisher;

// Token checks are prerequisites, not a provisioning/administrator origin.
// There is no JSON constructor, public dispatch permit, or admitted MSI here.
[SupportedOSPlatform("windows")]
internal static class NativePublicationAdministration
{
    private static int tokenCloseUncertain;
    internal sealed class Session : IDisposable
    {
        private readonly long start = Stopwatch.GetTimestamp();
        private readonly int thread = Environment.CurrentManagedThreadId;
        private bool closed;
        private Session(string epoch, string provisioningDigest, string history,
            long highWater, string serviceBindingDigest, string intent)
        {
            Epoch = epoch; ProvisioningDigest = provisioningDigest;
            History = history; HighWater = highWater; Intent = intent;
            ServiceBindingDigest = serviceBindingDigest;
        }
        internal string Epoch { get; }
        internal string ProvisioningDigest { get; }
        internal string History { get; }
        internal long HighWater { get; }
        internal string Intent { get; }
        internal string ServiceBindingDigest { get; }

        internal void RequireLive()
        {
            if (closed || thread != Environment.CurrentManagedThreadId ||
                Stopwatch.GetElapsedTime(start) >= TimeSpan.FromSeconds(30))
                throw new InvalidOperationException("publication_session_closed_or_expired");
            RequirePrimarySystem();
            // A future private producer must retain authenticated installer,
            // image/graph and provisioning custody and revalidate it here.
            // Until that source is independently admitted this is hard closed,
            // even if reflection/unsafe trusted code manufactured an instance.
            throw new InvalidOperationException("independent_installer_root_unavailable");
        }
        public void Dispose() { closed = true; }
    }

    internal static bool TryOpenSession(bool recovery, out Session? session, out string reason)
    {
        session = null;
        RequirePrimarySystem();
        // Neither token membership, matching registry JSON nor this mode can
        // select its own trust root. No installed producer is admitted yet.
        reason = recovery ? "independent_recovery_root_and_node_fence_unavailable" : "independent_installer_root_unavailable";
        return false;
    }

    private static void RequirePrimarySystem()
    {
        if (Volatile.Read(ref tokenCloseUncertain) != 0)
            throw new InvalidOperationException("publication_token_close_uncertain");
        // A thread impersonation token, including impersonated SYSTEM, refuses.
        if (OpenThreadToken(GetCurrentThread(), 0x0008, true, out var threadToken))
        {
            CloseToken(threadToken);
            throw new InvalidOperationException("publication_impersonation_refused");
        }
        if (Marshal.GetLastWin32Error() != 1008) throw new InvalidOperationException("publication_thread_token_unavailable");
        if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out var token) || token == 0)
            throw new InvalidOperationException("publication_process_token_unavailable");
        try
        {
            if (!GetTokenType(token, 8, out var type, 4, out var typeSize) || typeSize != 4 || type != 1)
                throw new InvalidOperationException("publication_primary_system_required");
            if (GetTokenInformation(token, 1, 0, 0, out var size) || Marshal.GetLastWin32Error() != 122 || size is < 16 or > 1024)
                throw new InvalidOperationException("publication_token_user_unavailable");
            var memory = Marshal.AllocHGlobal(checked((int)size));
            try
            {
                if (!GetTokenInformation(token, 1, memory, size, out var actual) || actual != size)
                    throw new InvalidOperationException("publication_token_user_unavailable");
                var sid = Marshal.ReadIntPtr(memory);
                var offset = sid.ToInt64() - memory.ToInt64();
                if (offset < 0 || offset > size - 8)
                    throw new InvalidOperationException("publication_token_user_unavailable");
                var count = Marshal.ReadByte(sid, 1);
                var length = 8 + 4 * count;
                if (count > 15 || length > size - offset)
                    throw new InvalidOperationException("publication_token_user_unavailable");
                var bytes = new byte[length]; Marshal.Copy(sid, bytes, 0, length);
                if (new SecurityIdentifier(bytes, 0).Value != "S-1-5-18")
                    throw new InvalidOperationException("publication_primary_system_required");
            }
            finally { Marshal.FreeHGlobal(memory); }
        }
        finally { CloseToken(token); }
    }

    private static void CloseToken(nint token)
    {
        // One attempt only; even failed prerequisites cannot hide uncertain
        // release or reuse the numeric handle on another acquisition.
        if (CloseHandle(token)) return;
        Interlocked.Exchange(ref tokenCloseUncertain, 1);
        throw new InvalidOperationException("publication_token_close_uncertain");
    }

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern nint GetCurrentThread();
    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern nint GetCurrentProcess();
    [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenThreadToken(nint thread, uint access, [MarshalAs(UnmanagedType.Bool)] bool openAsSelf, out nint token);
    [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(nint process, uint access, out nint token);
    [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenType(nint token, int information, out int value, uint length, out uint required);
    [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(nint token, int information, nint value, uint length, out uint required);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(nint handle);
}
