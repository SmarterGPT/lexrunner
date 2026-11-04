using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;

namespace LexRunner.WindowsCoordinator.SelectionPublisher;

// The kernel object is ephemeral, not an MSI-persisted trust root. A fresh
// instance proves nothing about history; durable state is checked on every use.
[SupportedOSPlatform("windows")]
internal static class NativePublicationMutex
{
    internal const string Name = @"Global\SmarterGPT.LexRunner.WindowsCoordinator.Publication.v1";
    // No descriptor defaulting, Users/worker ACE, inheritance or caller policy.
    internal const string Descriptor = "O:SYG:SYD:P(A;;0x00120000;;;SY)(A;;0x00120000;;;BA)";
    internal const uint Access = 0x00120000; // READ_CONTROL | SYNCHRONIZE
    private static int uncertain;
    [ThreadStatic] private static bool nativeOwnerActive;
    internal static bool Uncertain => Volatile.Read(ref uncertain) != 0;

    // This same owner sequencing is used by the real native port and fake-only
    // fault tests. In particular WAIT_ABANDONED transfers ownership too.
    internal interface IPort
    {
        void ValidateSecurity();
        uint Wait();
        bool Release();
        bool Close();
    }

    internal sealed class Ownership : IDisposable
    {
        private readonly IPort port;
        private readonly int thread = Environment.CurrentManagedThreadId;
        private bool owns, closed;
        internal bool NativeOwner { private get; set; }
        internal bool DispositionUncertain { get; private set; }

        private Ownership(IPort port) { this.port = port; }

        internal static Ownership Acquire(IPort port)
        {
            var owner = new Ownership(port);
            try
            {
                port.ValidateSecurity();
                var result = port.Wait();
                owner.owns = result is 0 or 0x80;
                if (result == 0x80) throw new InvalidOperationException("publication_mutex_abandoned");
                if (result == 0x102) throw new InvalidOperationException("publication_mutex_timeout");
                if (result != 0) throw new InvalidOperationException("publication_mutex_wait_failed");
                port.ValidateSecurity();
                return owner;
            }
            catch { owner.Dispose(); throw; }
        }

        public void Dispose()
        {
            if (closed) return;
            closed = true; // terminal wrapper state before either OS release
            if (owns)
            {
                owns = false;
                // Never release ownership on a different thread or retry an
                // uncertain handle. Such misuse leaves process-lifetime doubt.
                if (thread != Environment.CurrentManagedThreadId)
                    DispositionUncertain = true;
                else
                {
                    try { if (!port.Release()) DispositionUncertain = true; }
                    catch { DispositionUncertain = true; }
                }
            }
            try { if (!port.Close()) DispositionUncertain = true; }
            catch { DispositionUncertain = true; }
            if (NativeOwner && thread == Environment.CurrentManagedThreadId) nativeOwnerActive = false;
            if (DispositionUncertain)
            {
                Interlocked.Exchange(ref uncertain, 1);
                throw new InvalidOperationException("publication_mutex_close_uncertain");
            }
        }
    }

    internal static Ownership AcquireNative()
    {
        if (Uncertain) throw new InvalidOperationException("publication_mutex_uncertain");
        if (nativeOwnerActive) throw new InvalidOperationException("publication_mutex_reentrant_refused");
        nativeOwnerActive = true;
        try
        {
            var owner = Ownership.Acquire(NativePort.Create());
            owner.NativeOwner = true;
            return owner;
        }
        catch { nativeOwnerActive = false; throw; }
    }

    private sealed class NativePort(nint handle) : IPort
    {
        private nint handle = handle;
        private nint Handle => handle != 0 ? handle : throw new ObjectDisposedException(nameof(NativePort));

        internal static NativePort Create()
        {
            // Only the typed admitted SYSTEM storage route calls this. The
            // fixed descriptor must also be bound by future installed policy.
            var descriptor = new RawSecurityDescriptor(Descriptor);
            var bytes = new byte[descriptor.BinaryLength];
            descriptor.GetBinaryForm(bytes, 0);
            var memory = Marshal.AllocHGlobal(bytes.Length);
            try
            {
                Marshal.Copy(bytes, 0, memory, bytes.Length);
                var attributes = new SecurityAttributes { Length = (uint)Marshal.SizeOf<SecurityAttributes>(), Descriptor = memory, Inherit = 0 };
                var value = CreateMutexExW(ref attributes, Name, 0, Access);
                if (value == 0) throw new InvalidOperationException("publication_mutex_create_or_collision_refused");
                return new NativePort(value);
            }
            finally { Marshal.FreeHGlobal(memory); }
        }

        public void ValidateSecurity()
        {
            if (Uncertain) throw new InvalidOperationException("publication_mutex_uncertain");
            // Kernel-object descriptor by the held handle, not a name re-open.
            if (GetKernelObjectSecurity(Handle, 7, null, 0, out var needed) || needed is < 20 or > 8192 || Marshal.GetLastWin32Error() != 122)
                throw new InvalidOperationException("publication_mutex_security_unavailable");
            var bytes = new byte[needed];
            if (!GetKernelObjectSecurity(Handle, 7, bytes, needed, out var read) || read != needed)
                throw new InvalidOperationException("publication_mutex_security_unavailable");
            VerifyDescriptor(bytes);
        }

        public uint Wait() => WaitForSingleObject(Handle, 5000);
        public bool Release()
        {
            var result = ReleaseMutex(Handle);
            if (!result) Interlocked.Exchange(ref uncertain, 1);
            return result;
        }
        public bool Close()
        {
            var owned = Interlocked.Exchange(ref handle, 0);
            if (owned == 0) return true;
            var result = CloseHandle(owned);
            if (!result) Interlocked.Exchange(ref uncertain, 1);
            return result;
        }
    }

    internal static void VerifyDescriptor(byte[] bytes)
    {
        RawSecurityDescriptor value;
        try { value = new RawSecurityDescriptor(bytes, 0); }
        catch { throw new InvalidOperationException("publication_mutex_descriptor_mismatch"); }
        if (value.Owner?.Value != "S-1-5-18" || value.Group?.Value != "S-1-5-18" ||
            value.ControlFlags != (ControlFlags.SelfRelative | ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected) ||
            value.DiscretionaryAcl?.Count != 2)
            throw new InvalidOperationException("publication_mutex_descriptor_mismatch");
        var expected = new HashSet<string>(StringComparer.Ordinal) { "S-1-5-18", "S-1-5-32-544" };
        foreach (GenericAce item in value.DiscretionaryAcl)
            if (item is not CommonAce ace || ace.AceFlags != AceFlags.None ||
                ace.AceQualifier != AceQualifier.AccessAllowed || ace.AccessMask != Access ||
                !expected.Remove(ace.SecurityIdentifier.Value))
                throw new InvalidOperationException("publication_mutex_descriptor_mismatch");
        if (expected.Count != 0) throw new InvalidOperationException("publication_mutex_descriptor_mismatch");
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { internal uint Length; internal nint Descriptor; internal int Inherit; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern nint CreateMutexExW(ref SecurityAttributes attributes, string name, uint flags, uint access);
    [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetKernelObjectSecurity(nint handle, uint information, byte[]? descriptor, uint length, out uint needed);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern uint WaitForSingleObject(nint handle, uint milliseconds);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReleaseMutex(nint handle);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(nint handle);
}
