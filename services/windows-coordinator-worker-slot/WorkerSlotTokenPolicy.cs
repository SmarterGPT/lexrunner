using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;

internal sealed record WorkerSlotTokenSnapshot(
    string UserSid,
    IReadOnlyCollection<string> EnabledGroupSids,
    IReadOnlyCollection<string> RestrictingSids,
    bool Elevated,
    IReadOnlyCollection<string> PresentForbiddenPrivileges);

// These values are fixed for the first one-slot source profile. An installed
// profile must independently read back the SCM name, service SID type, token,
// ACLs and effective child rights before any worker is launched.
internal static class WorkerSlotTokenPolicy
{
    internal const string LocalServiceSid = "S-1-5-19";
    internal const string WorkerServiceSid =
        "S-1-5-80-2257548793-97284598-3436774358-445624465-2531346843";
    internal const string CoordinatorServiceSid =
        "S-1-5-80-1295682314-449838899-4229104702-2958586083-1985219579";
    internal const string AllServicesSid = "S-1-5-80-0";
    private const string AdministratorsSid = "S-1-5-32-544";

    internal static string? ServiceRefusal(WorkerSlotTokenSnapshot snapshot)
    {
        if (snapshot.UserSid != LocalServiceSid) return "worker_user_mismatch";
        if (snapshot.Elevated) return "worker_elevated";
        if (!Has(snapshot.EnabledGroupSids, WorkerServiceSid) ||
            !Has(snapshot.RestrictingSids, WorkerServiceSid))
            return "worker_service_sid_missing";
        if (Has(snapshot.EnabledGroupSids, AdministratorsSid) ||
            Has(snapshot.EnabledGroupSids, CoordinatorServiceSid) ||
            Has(snapshot.RestrictingSids, CoordinatorServiceSid))
            return "worker_authority_overlap";
        if (snapshot.EnabledGroupSids.Any(OtherServiceSid) ||
            snapshot.RestrictingSids.Any(OtherServiceSid))
            return "worker_shared_service_sid";
        return null;
    }

    internal static string? ChildRefusal(WorkerSlotTokenSnapshot snapshot)
    {
        var refusal = ServiceRefusal(snapshot);
        if (refusal is not null) return refusal;
        return snapshot.PresentForbiddenPrivileges.Count == 0
            ? null : "worker_child_privilege_present";
    }

    private static bool Has(IReadOnlyCollection<string> values, string expected) =>
        values.Contains(expected, StringComparer.Ordinal);

    private static bool OtherServiceSid(string sid) =>
        sid.StartsWith("S-1-5-80-", StringComparison.Ordinal) &&
        sid != WorkerServiceSid && sid != AllServicesSid;
}

// This is source-only observation. Its snapshots are never a provisioner or
// an execution permit. The normal image always stops with a failure even
// when this readback matches the proposed one-slot profile.
internal static class WorkerSlotTokenCapture
{
    private const int TokenUser = 1;
    private const int TokenGroups = 2;
    private const int TokenPrivileges = 3;
    private const int TokenRestrictedSids = 11;
    private const int TokenElevation = 20;
    private const int ErrorInsufficientBuffer = 122;
    private const int ErrorNoToken = 1008;
    private const uint TokenQuery = 0x0008;
    private const int MaximumTokenInformationBytes = 65536;
    private const uint SeGroupEnabled = 0x00000004;

    private static readonly string[] ForbiddenPrivileges =
    {
        "SeAssignPrimaryTokenPrivilege", "SeBackupPrivilege", "SeCreateTokenPrivilege",
        "SeDebugPrivilege", "SeImpersonatePrivilege", "SeIncreaseQuotaPrivilege",
        "SeLoadDriverPrivilege", "SeManageVolumePrivilege", "SeRelabelPrivilege",
        "SeRestorePrivilege", "SeSecurityPrivilege", "SeTakeOwnershipPrivilege",
        "SeTcbPrivilege"
    };

    [SupportedOSPlatform("windows")]
    internal static WorkerSlotTokenSnapshot CaptureCurrent()
    {
        if (!OperatingSystem.IsWindows() || IntPtr.Size != 8 ||
            Marshal.SizeOf<SidAndAttributes>() != 16 ||
            Marshal.OffsetOf<SidAndAttributes>(nameof(SidAndAttributes.Attributes)).ToInt32() != 8 ||
            Marshal.SizeOf<LuidAndAttributes>() != 12)
            throw new InvalidOperationException("worker_token_layout_unavailable");
        EnsureNoThreadImpersonation();
        if (!OpenProcessToken(GetCurrentProcess(), TokenQuery, out var token) ||
            token == IntPtr.Zero)
            throw new InvalidOperationException("worker_process_token_unavailable");
        try
        {
            return new WorkerSlotTokenSnapshot(
                ReadUserSid(token),
                ReadSids(token, TokenGroups, true),
                ReadSids(token, TokenRestrictedSids, false),
                ReadElevation(token),
                ReadForbiddenPrivileges(token));
        }
        finally { CloseHandle(token); }
    }

    [SupportedOSPlatform("windows")]
    private static void EnsureNoThreadImpersonation()
    {
        if (OpenThreadToken(GetCurrentThread(), TokenQuery, true, out var threadToken))
        {
            if (threadToken != IntPtr.Zero) CloseHandle(threadToken);
            throw new InvalidOperationException("worker_thread_impersonation_present");
        }
        if (Marshal.GetLastPInvokeError() != ErrorNoToken)
            throw new InvalidOperationException("worker_thread_token_state_unknown");
    }

    [SupportedOSPlatform("windows")]
    private static string ReadUserSid(IntPtr token)
    {
        var (buffer, bytes) = ReadTokenInformation(token, TokenUser);
        try
        {
            if (bytes < 16) throw new InvalidOperationException("worker_token_user_short");
            return ReadBoundedSid(Marshal.ReadIntPtr(buffer), buffer, bytes);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    [SupportedOSPlatform("windows")]
    private static string[] ReadSids(IntPtr token, int informationClass, bool enabledOnly)
    {
        var (buffer, bytes) = ReadTokenInformation(token, informationClass);
        try
        {
            if (bytes < 8) throw new InvalidOperationException("worker_token_groups_short");
            var count = Marshal.ReadInt32(buffer);
            if (count < 0 || count > 1024 || 8L + (long)count * 16 > bytes)
                throw new InvalidOperationException("worker_token_groups_bound");
            var sids = new List<string>(count);
            for (var i = 0; i < count; i++)
            {
                var entry = IntPtr.Add(buffer, 8 + i * 16);
                var sid = Marshal.ReadIntPtr(entry);
                var attributes = unchecked((uint)Marshal.ReadInt32(entry, 8));
                if (!enabledOnly || (attributes & SeGroupEnabled) != 0)
                    sids.Add(ReadBoundedSid(sid, buffer, bytes));
            }
            return sids.ToArray();
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    [SupportedOSPlatform("windows")]
    private static string ReadBoundedSid(IntPtr sid, IntPtr buffer, int bytes)
    {
        var start = buffer.ToInt64();
        var address = sid.ToInt64();
        if (address < start || address >= start + bytes || !IsValidSid(sid))
            throw new InvalidOperationException("worker_token_sid_invalid");
        var length = GetLengthSid(sid);
        if (length == 0 || length > start + bytes - address)
            throw new InvalidOperationException("worker_token_sid_bound");
        return new SecurityIdentifier(sid).Value;
    }

    [SupportedOSPlatform("windows")]
    private static bool ReadElevation(IntPtr token)
    {
        // TOKEN_ELEVATION has a fixed DWORD payload. On this Windows host,
        // a zero-length probe returns ERROR_BAD_LENGTH rather than 122.
        var buffer = Marshal.AllocHGlobal(4);
        try
        {
            if (!GetTokenInformation(token, TokenElevation, buffer, 4, out var used) || used != 4)
                throw new InvalidOperationException("worker_token_elevation_unavailable");
            return Marshal.ReadInt32(buffer) != 0;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    [SupportedOSPlatform("windows")]
    private static string[] ReadForbiddenPrivileges(IntPtr token)
    {
        var (buffer, bytes) = ReadTokenInformation(token, TokenPrivileges);
        try
        {
            if (bytes < 4) throw new InvalidOperationException("worker_token_privileges_short");
            var count = Marshal.ReadInt32(buffer);
            if (count < 0 || count > 1024 || 4L + (long)count * 12 > bytes)
                throw new InvalidOperationException("worker_token_privileges_bound");
            var present = new HashSet<Luid>();
            for (var i = 0; i < count; i++)
            {
                var entry = IntPtr.Add(buffer, 4 + i * 12);
                present.Add(new Luid(
                    unchecked((uint)Marshal.ReadInt32(entry)),
                    Marshal.ReadInt32(entry, 4)));
            }
            var forbidden = new List<string>();
            foreach (var name in ForbiddenPrivileges)
            {
                if (!LookupPrivilegeValue(null, name, out var luid))
                    throw new InvalidOperationException("worker_privilege_lookup_unavailable");
                if (present.Contains(luid)) forbidden.Add(name);
            }
            return forbidden.ToArray();
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    [SupportedOSPlatform("windows")]
    private static (IntPtr Buffer, int Bytes) ReadTokenInformation(IntPtr token, int informationClass)
    {
        if (GetTokenInformation(token, informationClass, IntPtr.Zero, 0, out var bytes) ||
            Marshal.GetLastPInvokeError() != ErrorInsufficientBuffer ||
            bytes <= 0 || bytes > MaximumTokenInformationBytes)
            throw new InvalidOperationException("worker_token_information_unavailable");
        var buffer = Marshal.AllocHGlobal(bytes);
        try
        {
            if (!GetTokenInformation(token, informationClass, buffer, bytes, out var used) ||
                used <= 0 || used > bytes)
                throw new InvalidOperationException("worker_token_information_unavailable");
            return (buffer, used);
        }
        catch
        {
            Marshal.FreeHGlobal(buffer);
            throw;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private readonly struct SidAndAttributes
    {
        public readonly IntPtr Sid;
        public readonly uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private readonly record struct Luid(uint LowPart, int HighPart);

    [StructLayout(LayoutKind.Sequential)]
    private readonly struct LuidAndAttributes
    {
        public readonly Luid Luid;
        public readonly uint Attributes;
    }

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(
        IntPtr tokenHandle, int informationClass, IntPtr tokenInformation,
        int tokenInformationLength, out int returnLength);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentThread();

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenThreadToken(
        IntPtr thread, uint desiredAccess, bool openAsSelf, out IntPtr token);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool IsValidSid(IntPtr sid);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetLengthSid(IntPtr sid);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("advapi32.dll", EntryPoint = "LookupPrivilegeValueW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool LookupPrivilegeValue(
        string? systemName, string name, out Luid luid);
}
