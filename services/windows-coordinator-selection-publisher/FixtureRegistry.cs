#if SELECTION_PUBLISHER_FIXTURE
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace LexRunner.WindowsCoordinator.SelectionPublisher;

// This adapter is compiled only into the fixture image. It cannot publish the
// production HKLM selection. The caller chooses no path: each live test uses
// one random direct child of HKCU\Software.
[SupportedOSPlatform("windows")]
internal sealed class FixtureRegistry : IDisposable
{
    private const uint KeyAllAccess = 0x000F003F;
    private const uint KeyRead = 0x00020019;
    private const uint KeyWow64_64Key = 0x00000100;
    private const uint RegOptionOpenLink = 0x00000008;
    private const uint RegCreatedNewKey = 1;
    private const uint RegSz = 1;
    private const uint RegQword = 11;
    private const int ErrorFileNotFound = 2;
    private const int ErrorMoreData = 234;
    private const int ErrorNoMoreItems = 259;
    private const int ErrorInsufficientBuffer = 122;
    private const uint OwnerSecurityInformation = 1;
    private const uint DaclSecurityInformation = 4;
    private const string Prefix = "LexRunnerCoordinatorSelectionFixture-";
    private static readonly nint Hkcu = new(unchecked((int)0x80000001));

    private readonly Key parent;
    private readonly Key root;
    private readonly Key generations;
    private readonly string ownerSid;
    private readonly string leaf;
    private bool disposed;

    private FixtureRegistry(Key parent, Key root, Key generations, string ownerSid, string leaf)
    {
        this.parent = parent;
        this.root = root;
        this.generations = generations;
        this.ownerSid = ownerSid;
        this.leaf = leaf;
    }

    internal string Leaf => leaf;

    internal static FixtureRegistry Create(string nonce, bool injectFailureAfterRootCreate = false)
    {
        if (!Guid.TryParseExact(nonce, "N", out _)) throw new InvalidOperationException("bad_nonce");
        var sid = WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("user_sid_missing");
        var leaf = Prefix + nonce;
        var parent = Open(Hkcu, "Software", KeyAllAccess);
        Key? root = null;
        Key? generations = null;
        try
        {
            using var security = new FixtureSecurity(sid);
            root = CreateOnly(parent.Handle, leaf, security);
            if (injectFailureAfterRootCreate) throw new InvalidOperationException("injected_after_root_create");
            VerifySecurity(root.Handle, sid);
            generations = CreateOnly(root.Handle, "Generations", security);
            VerifySecurity(generations.Handle, sid);
            SetQword(root.Handle, "HighWaterRevision", 0);
            SetString(root.Handle, "FixtureNonce", nonce);
            Flush(root.Handle);
            return new FixtureRegistry(parent, root, generations, sid, leaf);
        }
        catch (Exception original)
        {
            Exception? cleanupFailure = null;
            if (root is not null)
            {
                try { DeletePartialNewRoot(parent, root, generations, sid, leaf, nonce); }
                catch (Exception error) { cleanupFailure = error; }
            }
            generations?.Dispose();
            root?.Dispose();
            parent.Dispose();
            if (cleanupFailure is not null)
                throw new InvalidOperationException("partial_create_cleanup_uncertain",
                    new AggregateException(original, cleanupFailure));
            throw;
        }
    }

    internal static FixtureRegistry OpenExisting(string nonce)
    {
        if (!Guid.TryParseExact(nonce, "N", out _)) throw new InvalidOperationException("bad_nonce");
        var sid = WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("user_sid_missing");
        var leaf = Prefix + nonce;
        var parent = Open(Hkcu, "Software", KeyAllAccess);
        Key? root = null;
        Key? generations = null;
        try
        {
            root = Open(parent.Handle, leaf, KeyAllAccess);
            VerifySecurity(root.Handle, sid);
            if (ReadString(root.Handle, "FixtureNonce") != nonce) throw new InvalidOperationException("nonce_mismatch");
            generations = Open(root.Handle, "Generations", KeyAllAccess);
            VerifySecurity(generations.Handle, sid);
            return new FixtureRegistry(parent, root, generations, sid, leaf);
        }
        catch
        {
            generations?.Dispose();
            root?.Dispose();
            parent.Dispose();
            throw;
        }
    }

    internal static bool IsAbsent(string nonce)
    {
        if (!Guid.TryParseExact(nonce, "N", out _)) throw new InvalidOperationException("bad_nonce");
        using var parent = Open(Hkcu, "Software", KeyRead);
        using var existing = TryOpen(parent.Handle, Prefix + nonce, KeyRead);
        return existing is null;
    }

    internal static void CleanupIfPresent(string nonce, string id)
    {
        if (IsAbsent(nonce)) return;
        using var existing = OpenExisting(nonce);
        existing.DeleteExact(id);
    }

    internal bool CatalogExists(string id)
    {
        ValidateId(id);
        using var key = TryOpen(generations.Handle, id, KeyRead);
        if (key is null) return false;
        VerifySecurity(key.Handle, ownerSid);
        return true;
    }

    internal void WriteNewCatalog(string id, IReadOnlyDictionary<string, string> fields)
    {
        ValidateId(id);
        if (fields.Count != 5) throw new InvalidOperationException("catalog_shape");
        using var security = new FixtureSecurity(ownerSid);
        using var catalog = CreateOnly(generations.Handle, id, security);
        VerifySecurity(catalog.Handle, ownerSid);
        foreach (var name in new[] { "GraphDigest", "ManifestDigest", "ServiceImageDigest", "State", "ServiceName" })
        {
            if (!fields.TryGetValue(name, out var value)) throw new InvalidOperationException("catalog_shape");
            SetString(catalog.Handle, name, value);
        }
    }

    internal bool CatalogMatches(string id, IReadOnlyDictionary<string, string> fields)
    {
        ValidateId(id);
        using var catalog = TryOpen(generations.Handle, id, KeyRead);
        if (catalog is null) return false;
        VerifySecurity(catalog.Handle, ownerSid);
        if (!SameNames(SubkeyNames(generations.Handle), [id]) ||
            !SameNames(ValueNames(catalog.Handle),
                ["GraphDigest", "ManifestDigest", "ServiceImageDigest", "State", "ServiceName"])) return false;
        foreach (var field in fields)
        {
            if (ReadString(catalog.Handle, field.Key) != field.Value) return false;
        }
        return true;
    }

    internal void FlushCatalog(string id)
    {
        using var catalog = Open(generations.Handle, id, KeyAllAccess);
        VerifySecurity(catalog.Handle, ownerSid);
        Flush(catalog.Handle);
    }

    internal ulong ReadHighWater() => ReadQword(root.Handle, "HighWaterRevision") ?? throw new InvalidOperationException("high_water_missing");
    internal void SetHighWater(ulong value) => SetQword(root.Handle, "HighWaterRevision", value);
    internal string? ReadSelection() => ReadString(root.Handle, "ActiveSelection");
    internal void SetSelection(string value) => SetString(root.Handle, "ActiveSelection", value);
    internal void FlushRoot() => Flush(root.Handle);

    internal void VerifyRootShape() =>
        VerifyRootShape(root.Handle, generations.Handle, ownerSid, leaf[Prefix.Length..]);

    private static void VerifyRootShape(nint rootHandle, nint generationsHandle, string sid, string nonce)
    {
        VerifySecurity(rootHandle, sid);
        VerifySecurity(generationsHandle, sid);
        var selection = ReadString(rootHandle, "ActiveSelection");
        if (!SameNames(SubkeyNames(rootHandle), ["Generations"]) ||
            !SameNames(ValueNames(rootHandle), selection is null ?
                ["FixtureNonce", "HighWaterRevision"] :
                ["FixtureNonce", "HighWaterRevision", "ActiveSelection"]) ||
            ValueNames(generationsHandle).Length != 0)
            throw new InvalidOperationException("root_shape");
        if (ReadString(rootHandle, "FixtureNonce") != nonce)
            throw new InvalidOperationException("nonce_mismatch");
        if (ReadQword(rootHandle, "HighWaterRevision") is null)
            throw new InvalidOperationException("high_water_missing");
    }

    // Delete only the exact generated direct child, from the held HKCU\Software
    // parent. No recursive registry delete is used. Unexpected subkeys make
    // cleanup fail and are reported, never followed elsewhere.
    internal void DeleteExact(string id)
    {
        ValidateId(id);
        VerifyDeleteShape(root.Handle, generations.Handle, id);
        // Hold the original keys while reopening and validating the exact path.
        // This removes the close/reopen gap; HKCU still has a same-user race.
        using var reopened = Open(parent.Handle, leaf, KeyAllAccess);
        using var reopenedGenerations = Open(reopened.Handle, "Generations", KeyAllAccess);
        VerifyDeleteShape(reopened.Handle, reopenedGenerations.Handle, id);
        generations.Dispose();
        root.Dispose();
        if (SubkeyNames(reopenedGenerations.Handle).Length == 1)
            Check(RegDeleteKeyExW(reopenedGenerations.Handle, id, KeyWow64_64Key, 0), "delete_catalog");
        reopenedGenerations.Dispose();
        Check(RegDeleteKeyExW(reopened.Handle, "Generations", KeyWow64_64Key, 0), "delete_generations");
        reopened.Dispose();
        Check(RegDeleteKeyExW(parent.Handle, leaf, KeyWow64_64Key, 0), "delete_fixture_root");
        using var remaining = TryOpen(parent.Handle, leaf, KeyRead);
        if (remaining is not null) throw new InvalidOperationException("fixture_cleanup_incomplete");
        disposed = true;
        parent.Dispose();
    }

    private void VerifyDeleteShape(nint rootHandle, nint generationsHandle, string id)
    {
        VerifyRootShape(rootHandle, generationsHandle, ownerSid, leaf[Prefix.Length..]);
        var names = SubkeyNames(generationsHandle);
        if (names.Length > 1 || (names.Length == 1 && names[0] != id))
            throw new InvalidOperationException("extra_catalog");
        using var catalog = TryOpen(generationsHandle, id, KeyRead);
        if (catalog is null) return;
        VerifySecurity(catalog.Handle, ownerSid);
        if (SubkeyNames(catalog.Handle).Length != 0) throw new InvalidOperationException("catalog_cleanup_shape");
        foreach (var name in ValueNames(catalog.Handle))
        {
            if (name is not ("GraphDigest" or "ManifestDigest" or "ServiceImageDigest" or "State" or "ServiceName") ||
                ReadString(catalog.Handle, name) is null)
                throw new InvalidOperationException("catalog_cleanup_shape");
        }
    }

    // Used only if this call received REG_CREATED_NEW_KEY. A failed create may
    // have no nonce yet, so validate the held handle and the reopened path
    // before deleting the generated direct child. Unexpected shape leaves an
    // explicit cleanup uncertainty instead of deleting another key.
    private static void DeletePartialNewRoot(Key parent, Key root, Key? generations,
        string sid, string leaf, string nonce)
    {
        VerifyPartialShape(root.Handle, sid, nonce);
        using var reopened = Open(parent.Handle, leaf, KeyAllAccess);
        VerifyPartialShape(reopened.Handle, sid, nonce);
        generations?.Dispose();
        root.Dispose();
        if (SameNames(SubkeyNames(reopened.Handle), ["Generations"]))
            Check(RegDeleteKeyExW(reopened.Handle, "Generations", KeyWow64_64Key, 0), "delete_partial_generations");
        reopened.Dispose();
        Check(RegDeleteKeyExW(parent.Handle, leaf, KeyWow64_64Key, 0), "delete_partial_root");
        using var remaining = TryOpen(parent.Handle, leaf, KeyRead);
        if (remaining is not null) throw new InvalidOperationException("partial_cleanup_incomplete");
    }

    private static void VerifyPartialShape(nint rootHandle, string sid, string nonce)
    {
        VerifySecurity(rootHandle, sid);
        foreach (var name in ValueNames(rootHandle))
        {
            if (name == "FixtureNonce")
            {
                if (ReadString(rootHandle, name) != nonce) throw new InvalidOperationException("nonce_mismatch");
            }
            else if (name == "HighWaterRevision")
            {
                if (ReadQword(rootHandle, name) != 0) throw new InvalidOperationException("partial_high_water");
            }
            else throw new InvalidOperationException("partial_root_shape");
        }
        var children = SubkeyNames(rootHandle);
        if (children.Length == 0) return;
        if (!SameNames(children, ["Generations"])) throw new InvalidOperationException("partial_root_shape");
        using var child = Open(rootHandle, "Generations", KeyRead);
        VerifySecurity(child.Handle, sid);
        if (SubkeyNames(child.Handle).Length != 0 || ValueNames(child.Handle).Length != 0)
            throw new InvalidOperationException("partial_generations_shape");
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        generations.Dispose();
        root.Dispose();
        parent.Dispose();
    }

    private static void ValidateId(string id)
    {
        if (id.Length != 64 || id.Any(c => c is not (>= 'a' and <= 'f' or >= '0' and <= '9')))
            throw new InvalidOperationException("generation_id");
    }

    private static Key CreateOnly(nint parent, string name, FixtureSecurity security)
    {
        using var existing = TryOpen(parent, name, KeyRead);
        if (existing is not null) throw new InvalidOperationException("occupied_key");
        var attrs = security.Attributes;
        var rc = RegCreateKeyExW(parent, name, 0, null, 0, KeyAllAccess | KeyWow64_64Key,
            ref attrs, out var handle, out var disposition);
        Check(rc, "create_key");
        var key = new Key(handle);
        if (disposition != RegCreatedNewKey)
        {
            key.Dispose();
            throw new InvalidOperationException("occupied_key");
        }
        return key;
    }

    private static Key Open(nint parent, string name, uint access) =>
        TryOpen(parent, name, access) ?? throw new InvalidOperationException("key_missing");

    private static Key? TryOpen(nint parent, string name, uint access)
    {
        var rc = RegOpenKeyExW(parent, name, RegOptionOpenLink, access | KeyWow64_64Key, out var handle);
        if (rc == ErrorFileNotFound) return null;
        Check(rc, "open_key");
        var key = new Key(handle);
        if (ReadRaw(key.Handle, "SymbolicLinkValue") is not null)
        {
            key.Dispose();
            throw new InvalidOperationException("registry_link");
        }
        return key;
    }

    private static void VerifySecurity(nint key, string ownerSid)
    {
        uint size = 0;
        var rc = RegGetKeySecurity(key, OwnerSecurityInformation | DaclSecurityInformation, null, ref size);
        if (rc != ErrorInsufficientBuffer || size is < 20 or > 8192) throw new InvalidOperationException("security_read_size");
        var bytes = new byte[size];
        Check(RegGetKeySecurity(key, OwnerSecurityInformation | DaclSecurityInformation, bytes, ref size), "security_read");
        var descriptor = new RawSecurityDescriptor(bytes, 0);
        if (descriptor.Owner?.Value != ownerSid ||
            !descriptor.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclProtected) ||
            descriptor.DiscretionaryAcl?.Count != 1 ||
            descriptor.DiscretionaryAcl[0] is not CommonAce ace ||
            ace.SecurityIdentifier.Value != ownerSid || ace.AccessMask != (int)KeyAllAccess ||
            ace.AceQualifier != AceQualifier.AccessAllowed)
            throw new InvalidOperationException("security_mismatch");
    }

    private static bool SameNames(string[] actual, string[] expected) =>
        actual.Length == expected.Length && expected.All(name => actual.Contains(name, StringComparer.Ordinal));

    private static string[] SubkeyNames(nint key)
    {
        var names = new List<string>();
        for (uint index = 0; index <= 2; index++)
        {
            uint length = 260;
            var name = new StringBuilder((int)length);
            var rc = RegEnumKeyExW(key, index, name, ref length, nint.Zero, nint.Zero, nint.Zero, nint.Zero);
            if (rc == ErrorNoMoreItems) return [.. names];
            Check(rc, "enumerate_key");
            names.Add(name.ToString());
        }
        throw new InvalidOperationException("too_many_keys");
    }

    private static string[] ValueNames(nint key)
    {
        var names = new List<string>();
        for (uint index = 0; index <= 6; index++)
        {
            uint length = 260;
            var name = new StringBuilder((int)length);
            var rc = RegEnumValueW(key, index, name, ref length, nint.Zero, nint.Zero, nint.Zero, nint.Zero);
            if (rc == ErrorNoMoreItems) return [.. names];
            Check(rc, "enumerate_value");
            names.Add(name.ToString());
        }
        throw new InvalidOperationException("too_many_values");
    }

    private static (uint type, byte[] bytes)? ReadRaw(nint key, string name)
    {
        uint length = 0;
        var rc = RegQueryValueExW(key, name, nint.Zero, out var type, null, ref length);
        if (rc == ErrorFileNotFound) return null;
        if (rc != 0 && rc != ErrorMoreData) throw new InvalidOperationException("value_query");
        if (length is < 2 or > 2048) throw new InvalidOperationException("value_size");
        var bytes = new byte[length];
        Check(RegQueryValueExW(key, name, nint.Zero, out type, bytes, ref length), "value_read");
        if (length != bytes.Length) throw new InvalidOperationException("value_changed");
        return (type, bytes);
    }

    private static string? ReadString(nint key, string name)
    {
        var raw = ReadRaw(key, name);
        if (raw is null) return null;
        var (type, bytes) = raw.Value;
        if (type != RegSz || bytes.Length < 2 || bytes.Length % 2 != 0 ||
            bytes[^1] != 0 || bytes[^2] != 0)
            throw new InvalidOperationException("value_not_reg_sz");
        var value = Encoding.Unicode.GetString(bytes, 0, bytes.Length - 2);
        if (value.Contains('\0')) throw new InvalidOperationException("value_embedded_nul");
        return value;
    }

    private static ulong? ReadQword(nint key, string name)
    {
        var raw = ReadRaw(key, name);
        if (raw is null) return null;
        if (raw.Value.type != RegQword || raw.Value.bytes.Length != 8)
            throw new InvalidOperationException("value_not_reg_qword");
        return BitConverter.ToUInt64(raw.Value.bytes);
    }

    private static void SetString(nint key, string name, string value)
    {
        if (value.Length is < 1 or > 900 || value.Contains('\0')) throw new InvalidOperationException("value_not_bounded");
        var bytes = Encoding.Unicode.GetBytes(value + "\0");
        Check(RegSetValueExW(key, name, 0, RegSz, bytes, (uint)bytes.Length), "set_string");
    }

    private static void SetQword(nint key, string name, ulong value)
    {
        var bytes = BitConverter.GetBytes(value);
        Check(RegSetValueExW(key, name, 0, RegQword, bytes, 8), "set_qword");
    }

    private static void Flush(nint key) => Check(RegFlushKey(key), "flush_key");
    private static void Check(int status, string phase)
    {
        if (status != 0) throw new InvalidOperationException($"{phase}:{status}");
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

    private sealed class FixtureSecurity : IDisposable
    {
        private nint descriptor;
        internal SecurityAttributes Attributes { get; }
        internal FixtureSecurity(string sid)
        {
            var sddl = $"O:{sid}D:P(A;;KA;;;{sid})";
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, out _))
                throw new InvalidOperationException("fixture_security_descriptor");
            Attributes = new SecurityAttributes
            {
                Length = Marshal.SizeOf<SecurityAttributes>(),
                Descriptor = descriptor,
                InheritHandle = 0
            };
        }
        public void Dispose()
        {
            if (descriptor == 0) return;
            _ = LocalFree(descriptor);
            descriptor = 0;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SecurityAttributes
    {
        internal int Length;
        internal nint Descriptor;
        internal int InheritHandle;
    }

    [DllImport("advapi32.dll", EntryPoint = "RegOpenKeyExW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int RegOpenKeyExW(nint key, string subkey, uint options, uint desired, out nint result);
    [DllImport("advapi32.dll", EntryPoint = "RegCreateKeyExW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int RegCreateKeyExW(nint key, string subkey, uint reserved, string? keyClass,
        uint options, uint desired, ref SecurityAttributes security, out nint result, out uint disposition);
    [DllImport("advapi32.dll", EntryPoint = "RegCloseKey", ExactSpelling = true)]
    private static extern int RegCloseKey(nint key);
    [DllImport("advapi32.dll", EntryPoint = "RegSetValueExW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int RegSetValueExW(nint key, string name, uint reserved, uint type, byte[] data, uint size);
    [DllImport("advapi32.dll", EntryPoint = "RegQueryValueExW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int RegQueryValueExW(nint key, string name, nint reserved, out uint type, byte[]? data, ref uint size);
    [DllImport("advapi32.dll", EntryPoint = "RegFlushKey", ExactSpelling = true)]
    private static extern int RegFlushKey(nint key);
    [DllImport("advapi32.dll", EntryPoint = "RegGetKeySecurity", ExactSpelling = true)]
    private static extern int RegGetKeySecurity(nint key, uint securityInformation, byte[]? descriptor, ref uint size);
    [DllImport("advapi32.dll", EntryPoint = "RegEnumKeyExW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int RegEnumKeyExW(nint key, uint index, StringBuilder name, ref uint nameLength,
        nint reserved, nint keyClass, nint classLength, nint lastWriteTime);
    [DllImport("advapi32.dll", EntryPoint = "RegEnumValueW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int RegEnumValueW(nint key, uint index, StringBuilder name, ref uint nameLength,
        nint reserved, nint type, nint data, nint dataLength);
    [DllImport("advapi32.dll", EntryPoint = "RegDeleteKeyExW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int RegDeleteKeyExW(nint key, string subkey, uint desired, uint reserved);
    [DllImport("advapi32.dll", EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision,
        out nint descriptor, out uint size);
    [DllImport("kernel32.dll", EntryPoint = "LocalFree", ExactSpelling = true)]
    private static extern nint LocalFree(nint memory);
}
#endif
