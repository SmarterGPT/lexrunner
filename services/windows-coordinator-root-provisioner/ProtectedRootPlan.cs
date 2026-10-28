using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

// This source is deliberately not reachable from the command-line entry point.
// A separately approved provisioning action still needs a reviewed installed
// graph, an authorization record, and installed-host qualification.
internal static class ProtectedRootPlan
{
    internal const string ServiceName = "LexRunnerCoordinator";
    internal const string ServiceSid =
        "S-1-5-80-1295682314-449838899-4229104702-2958586083-1985219579";
    internal const string RootName = "SmarterGPT.LexRunner.WindowsCoordinator";
    internal const string StoreParent = @"C:\ProgramData";
    internal const string CVolumeParent = @"C:\";
    internal const string DVolumeParent = @"D:\";

    internal static RootPolicy PolicyForInstalledService(string resolvedServiceSid)
    {
        if (!resolvedServiceSid.Equals(ServiceSid, StringComparison.Ordinal))
            throw new InvalidOperationException("installed_service_sid_mismatch");
        // The owner is SYSTEM, never the approving administrator or client.
        // D:P prevents an ordinary user's inheritable parent ACE from reaching
        // the protected store, stage or final allocation parents.
        return new RootPolicy("S-1-5-18",
            $"O:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{ServiceSid})");
    }

    // No provisioning identity or exact authorization handoff has been
    // selected. In particular, the coordinator runs as a nonadministrator
    // virtual service account; this code does not require or substitute a
    // LocalSystem coordinator. Normal source cannot reach the effect path.
    [SupportedOSPlatform("windows")]
    internal static ProtectedRootObservation Provision()
        => throw new InvalidOperationException("approved_provisioning_authority_unavailable");

    // A future reviewed installer/operator authority may call this core only
    // after establishing its own token and exact-artifact approval. Existing
    // protected roots may be observed, never cleaned or replaced.
    [SupportedOSPlatform("windows")]
    private static ProtectedRootObservation ProvisionCore()
    {
        var serviceSid = VerifyInstalledService();
        var policy = PolicyForInstalledService(serviceSid);

        using var storeParent = Native.OpenDirectory(StoreParent);
        using var cVolume = Native.OpenDirectory(CVolumeParent);
        using var dVolume = Native.OpenDirectory(DVolumeParent);
        var cFileSystem = Native.GetFileSystem(cVolume);
        var dFileSystem = Native.GetFileSystem(dVolume);
        RequireSupportedFileSystem(cFileSystem);
        RequireSupportedFileSystem(dFileSystem);
        var cIdentity = Native.GetIdentity(cVolume, CVolumeParent);
        var dIdentity = Native.GetIdentity(dVolume, DVolumeParent);
        var storeParentIdentity = Native.GetIdentity(storeParent, StoreParent);
        if (cIdentity.volumeSerial != storeParentIdentity.volumeSerial ||
            cIdentity.volumeSerial == dIdentity.volumeSerial)
            throw new InvalidOperationException("fixed_volume_identity_mismatch");

        var rows = new List<ProtectedRootRow>(7);
        using var store = OpenOrCreate(storeParent, Path.Combine(StoreParent, RootName),
            RootName, policy, rows);
        using var cAnchor = OpenOrCreate(cVolume, Path.Combine(CVolumeParent, RootName),
            RootName, policy, rows);
        using var cStage = OpenOrCreate(cAnchor,
            Path.Combine(CVolumeParent, RootName, "stage"), "stage", policy, rows);
        using var cFinal = OpenOrCreate(cAnchor,
            Path.Combine(CVolumeParent, RootName, "final"), "final", policy, rows);
        using var dAnchor = OpenOrCreate(dVolume, Path.Combine(DVolumeParent, RootName),
            RootName, policy, rows);
        using var dStage = OpenOrCreate(dAnchor,
            Path.Combine(DVolumeParent, RootName, "stage"), "stage", policy, rows);
        using var dFinal = OpenOrCreate(dAnchor,
            Path.Combine(DVolumeParent, RootName, "final"), "final", policy, rows);

        foreach (var row in rows)
        {
            var expectedVolume = row.Observation.Path.StartsWith(@"D:\",
                StringComparison.OrdinalIgnoreCase) ? dIdentity.volumeSerial : cIdentity.volumeSerial;
            if (!row.Observation.VolumeSerial.Equals(expectedVolume,
                    StringComparison.Ordinal))
                throw new InvalidOperationException("created_root_volume_mismatch");
        }
        // The seven handles remain open until all readback comparisons finish.
        // This is a protected-source observation, not an installed token test,
        // cross-account denial, durable transaction or active selection.
        return new ProtectedRootObservation(serviceSid, cFileSystem, dFileSystem,
            rows.ToArray(), false, false);
    }

    internal static void RequireSupportedFileSystem(string fileSystem)
    {
        if (fileSystem is not ("NTFS" or "ReFS"))
            throw new InvalidOperationException("unsupported_provisioning_filesystem");
    }

    private static SafeFileHandle OpenOrCreate(SafeFileHandle parent,
        string expectedPath, string name, RootPolicy policy, List<ProtectedRootRow> rows)
    {
        SafeFileHandle handle;
        var created = true;
        try { handle = Native.CreateDirectory(parent, name, policy); }
        catch (InvalidOperationException error) when (
            error.Message == "create_refused_ntstatus_0xc0000035")
        {
            // An occupied path is accepted only after exact held-handle,
            // no-reparse, owner and DACL readback. It is never replaced.
            created = false;
            handle = Native.OpenChildDirectory(parent, name);
        }
        try
        {
            var observation = Native.Observe(handle, expectedPath, policy);
            rows.Add(new ProtectedRootRow(created, observation));
            return handle;
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    [SupportedOSPlatform("windows")]
    private static string VerifyInstalledService()
    {
        var manager = OpenSCManagerW(null, null, 0x0001);
        if (manager == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "service_manager_unavailable");
        try
        {
            var service = OpenServiceW(manager, ServiceName, 0x0001);
            if (service == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "installed_service_unavailable");
            try
            {
                // The selected MSI requires SERVICE_SID_TYPE_RESTRICTED (3).
                _ = QueryServiceConfig2W(service, 5, IntPtr.Zero, 0, out var bytes);
                if (Marshal.GetLastWin32Error() != 122 || bytes < sizeof(uint) || bytes > 4096)
                    throw new InvalidOperationException("installed_service_sid_type_unavailable");
                var buffer = Marshal.AllocHGlobal((int)bytes);
                try
                {
                    if (!QueryServiceConfig2W(service, 5, buffer, bytes, out _))
                        throw new Win32Exception(Marshal.GetLastWin32Error(),
                            "installed_service_sid_type_unavailable");
                    if (Marshal.ReadInt32(buffer) != 3)
                        throw new InvalidOperationException("installed_service_sid_not_restricted");
                }
                finally { Marshal.FreeHGlobal(buffer); }

                _ = QueryServiceConfigW(service, IntPtr.Zero, 0, out bytes);
                if (Marshal.GetLastWin32Error() != 122 ||
                    bytes < Marshal.SizeOf<ServiceConfiguration>() || bytes > 65536)
                    throw new InvalidOperationException("installed_service_config_unavailable");
                buffer = Marshal.AllocHGlobal((int)bytes);
                try
                {
                    if (!QueryServiceConfigW(service, buffer, bytes, out _))
                        throw new Win32Exception(Marshal.GetLastWin32Error(),
                            "installed_service_config_unavailable");
                    var config = Marshal.PtrToStructure<ServiceConfiguration>(buffer);
                    if (config.ServiceType != 0x10 || config.StartType != 3 ||
                        !string.Equals(Marshal.PtrToStringUni(config.StartName),
                            @"NT SERVICE\LexRunnerCoordinator", StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("installed_service_profile_mismatch");
                }
                finally { Marshal.FreeHGlobal(buffer); }

                var resolved = ((SecurityIdentifier)new NTAccount("NT SERVICE", ServiceName)
                    .Translate(typeof(SecurityIdentifier))).Value;
                if (resolved != ServiceSid)
                    throw new InvalidOperationException("installed_service_sid_mismatch");
                return resolved;
            }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceConfiguration
    {
        public uint ServiceType, StartType, ErrorControl;
        public IntPtr BinaryPath, LoadOrderGroup;
        public uint TagId;
        public IntPtr Dependencies, StartName, DisplayName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true,
        SetLastError = true)]
    private static extern IntPtr OpenSCManagerW(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true,
        SetLastError = true)]
    private static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceConfig2W(IntPtr service, uint level,
        IntPtr buffer, uint bufferSize, out uint needed);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceConfigW(IntPtr service, IntPtr buffer,
        uint bufferSize, out uint needed);
    [DllImport("advapi32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseServiceHandle(IntPtr service);
}

internal sealed record ProtectedRootRow(bool Created, RootObservation Observation);
internal sealed record ProtectedRootObservation(string InstalledServiceSid,
    string CFileSystem, string DFileSystem, ProtectedRootRow[] Rows,
    bool AuthorizesSelection, bool AuthorizesExecution);
