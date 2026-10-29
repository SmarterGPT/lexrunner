using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace LexRunner.WindowsCoordinator.SelectionCustody;

// Fixed-path read-only registry probe. No Registry.SetValue, RegCreateKeyEx,
// RegSetValueEx, RegDeleteKey, RegFlushKey, or privilege adjustment is present.
[SupportedOSPlatform("windows")]
internal static class NativeRegistryReader
{
    private const uint KeyRead = 0x00020019;
    private const uint KeyWow64_64Key = 0x00000100;
    private const uint RegOptionOpenLink = 0x00000008;
    private const uint OwnerSecurityInformation = 1;
    private const uint DaclSecurityInformation = 4;
    private const int ErrorFileNotFound = 2;
    private const int ErrorMoreData = 234;
    private const int ErrorNoMoreItems = 259;
    private const int ErrorInsufficientBuffer = 122;
    private static readonly nint Hklm = new(unchecked((int)0x80000002));

    internal static CustodyResult Observe() => ObserveSelected().Custody;

    // Service code must link this reader into its own protected image before
    // using the candidate. The returned fields never authorize a lease.
    internal static StructuralSelectionReadback ObserveSelected()
    {
        try
        {
            using var software = Open(Hklm, "SOFTWARE", "registry_unavailable");
            RejectLink(software.Handle);
            var first = ReadOnce(software.Handle);
            var second = ReadOnce(software.Handle);
            return CustodyContract.AssessSelected(first, second);
        }
        catch (CustodyException error)
        {
            return new StructuralSelectionReadback(CustodyResult.Unavailable(error.Reason), null);
        }
        catch
        {
            return new StructuralSelectionReadback(CustodyResult.Unavailable("registry_unavailable"),
                null);
        }
    }

    private static RegistrySnapshot ReadOnce(nint software)
    {
        using var root = Open(software, "SmarterGPT.LexRunner.WindowsCoordinator",
            "selection_unavailable");
        var rootSnapshot = Capture(root.Handle, 1, 2);
        if (!rootSnapshot.Values.ContainsKey("ActiveSelection"))
            throw new CustodyException("selection_unavailable");
        var selection = CustodyContract.ParseSelection(
            CustodyContract.ReadString(rootSnapshot.Values, "ActiveSelection"));
        using var generations = Open(root.Handle, "Generations", "registry_unavailable");
        var generationSnapshot = Capture(generations.Handle, 1, 0);
        using var catalog = Open(generations.Handle, selection.GenerationId, "registry_unavailable");
        var catalogSnapshot = Capture(catalog.Handle, 0, 5);
        return new RegistrySnapshot(rootSnapshot, generationSnapshot, catalogSnapshot,
            selection.GenerationId);
    }

    private static Key Open(nint parent, string child, string missingReason)
    {
        var result = RegOpenKeyExW(parent, child, RegOptionOpenLink,
            KeyRead | KeyWow64_64Key, out var handle);
        if (result == ErrorFileNotFound) throw new CustodyException(missingReason);
        if (result != 0 || handle == 0) throw new CustodyException("registry_unavailable");
        var key = new Key(handle);
        try { RejectLink(key.Handle); return key; }
        catch { key.Dispose(); throw; }
    }

    private static KeySnapshot Capture(nint key, int maxSubkeys, int maxValues)
    {
        RejectLink(key);
        var security = ReadSecurity(key);
        var subkeys = ListSubkeys(key, maxSubkeys);
        var names = ListValues(key, maxValues);
        var values = new Dictionary<string, RegistryValue>(StringComparer.Ordinal);
        foreach (var name in names)
        {
            var value = ReadRaw(key, name) ?? throw new CustodyException("registry_unavailable");
            if (!values.TryAdd(name, value)) throw new CustodyException("shape_mismatch");
        }
        return new KeySnapshot(security, subkeys, values, false);
    }

    private static void RejectLink(nint key)
    {
        // A link target can be empty or malformed. Presence alone is a
        // redirect marker, so do not parse the target as an ordinary value.
        uint length = 0;
        var status = RegQueryValueExW(key, "SymbolicLinkValue", nint.Zero,
            out _, null, ref length);
        if (status is 0 or ErrorMoreData) throw new CustodyException("registry_link");
        if (status != ErrorFileNotFound) throw new CustodyException("registry_unavailable");
    }

    private static byte[] ReadSecurity(nint key)
    {
        uint length = 0;
        var status = RegGetKeySecurity(key, OwnerSecurityInformation | DaclSecurityInformation,
            null, ref length);
        if (status != ErrorInsufficientBuffer || length is < 20 or > 8192)
            throw new CustodyException("registry_unavailable");
        var bytes = new byte[checked((int)length)];
        if (RegGetKeySecurity(key, OwnerSecurityInformation | DaclSecurityInformation,
                bytes, ref length) != 0 || length != bytes.Length)
            throw new CustodyException("registry_unavailable");
        return bytes;
    }

    private static string[] ListSubkeys(nint key, int maximum)
    {
        var names = new List<string>();
        for (uint index = 0; index <= maximum; index++)
        {
            uint length = 260;
            var buffer = new StringBuilder(260);
            var status = RegEnumKeyExW(key, index, buffer, ref length,
                nint.Zero, nint.Zero, nint.Zero, nint.Zero);
            if (status == ErrorNoMoreItems) return [.. names];
            if (status != 0 || length is 0 or > 260)
                throw new CustodyException("registry_unavailable");
            names.Add(buffer.ToString());
        }
        throw new CustodyException("shape_mismatch");
    }

    private static string[] ListValues(nint key, int maximum)
    {
        var names = new List<string>();
        for (uint index = 0; index <= maximum; index++)
        {
            uint length = 260;
            var buffer = new StringBuilder(260);
            var status = RegEnumValueW(key, index, buffer, ref length,
                nint.Zero, nint.Zero, nint.Zero, nint.Zero);
            if (status == ErrorNoMoreItems) return [.. names];
            if (status != 0 || length is 0 or > 260)
                throw new CustodyException("registry_unavailable");
            names.Add(buffer.ToString());
        }
        throw new CustodyException("shape_mismatch");
    }

    private static RegistryValue? ReadRaw(nint key, string name)
    {
        uint length = 0;
        var status = RegQueryValueExW(key, name, nint.Zero, out var type, null, ref length);
        if (status == ErrorFileNotFound) return null;
        if (status != 0 && status != ErrorMoreData) throw new CustodyException("registry_unavailable");
        if (length is < 1 or > 8192) throw new CustodyException("shape_mismatch");
        var bytes = new byte[checked((int)length)];
        var readLength = length;
        if (RegQueryValueExW(key, name, nint.Zero, out type, bytes, ref readLength) != 0 ||
            readLength != length)
            throw new CustodyException("registry_unavailable");
        return new RegistryValue(type, bytes);
    }

    private sealed class Key(nint handle) : IDisposable
    {
        private nint handle = handle;
        internal nint Handle => handle != 0 ? handle : throw new ObjectDisposedException(nameof(Key));
        public void Dispose()
        {
            if (handle == 0) return;
            _ = RegCloseKey(handle);
            handle = 0;
        }
    }

    [DllImport("advapi32.dll", EntryPoint = "RegOpenKeyExW", CharSet = CharSet.Unicode,
        ExactSpelling = true)]
    private static extern int RegOpenKeyExW(nint key, string subkey, uint options,
        uint desired, out nint result);
    [DllImport("advapi32.dll", EntryPoint = "RegCloseKey", ExactSpelling = true)]
    private static extern int RegCloseKey(nint key);
    [DllImport("advapi32.dll", EntryPoint = "RegGetKeySecurity", ExactSpelling = true)]
    private static extern int RegGetKeySecurity(nint key, uint securityInformation,
        byte[]? descriptor, ref uint size);
    [DllImport("advapi32.dll", EntryPoint = "RegEnumKeyExW", CharSet = CharSet.Unicode,
        ExactSpelling = true)]
    private static extern int RegEnumKeyExW(nint key, uint index, StringBuilder name,
        ref uint nameLength, nint reserved, nint keyClass, nint classLength,
        nint lastWriteTime);
    [DllImport("advapi32.dll", EntryPoint = "RegEnumValueW", CharSet = CharSet.Unicode,
        ExactSpelling = true)]
    private static extern int RegEnumValueW(nint key, uint index, StringBuilder name,
        ref uint nameLength, nint reserved, nint type, nint data, nint dataLength);
    [DllImport("advapi32.dll", EntryPoint = "RegQueryValueExW", CharSet = CharSet.Unicode,
        ExactSpelling = true)]
    private static extern int RegQueryValueExW(nint key, string name, nint reserved,
        out uint type, byte[]? data, ref uint size);
}
