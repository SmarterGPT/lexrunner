using System.Buffers.Binary;
using System.Collections.ObjectModel;
using System.Runtime.Versioning;
using System.Text;

namespace LexRunner.WindowsCoordinator.SelectionCustody;

// Retained native observations only. This deliberately does not change the
// historical single-catalog observer or produce an installed context/lease.
[SupportedOSPlatform("windows")]
internal sealed class NativeInstalledPublicationReader : IDisposable
{
    internal const string ProjectionName = "SmarterGPT.LexRunner.WindowsCoordinator";
    internal const string PublicationName = "SmarterGPT.LexRunner.WindowsCoordinator.Publication";
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private readonly List<NativeRegistryReaderV3.Key> keys = [];
    private readonly Dictionary<string, NativeRegistryReaderV3.Key> catalogs = new(StringComparer.Ordinal);
    private NativeRegistryReaderV3.Key software = null!, projection = null!, publication = null!, generations = null!;
    private bool closed;

    internal sealed record Facts(string Epoch, string History, string ProvisioningDigest,
        long HighWater, string? Selection, IReadOnlyDictionary<string, string> Catalogs,
        string Consistency)
    {
        internal bool AuthorizesLaunch => false;
        internal bool AuthorizesEffect => false;
    }

    private NativeInstalledPublicationReader() { }

    internal static NativeInstalledPublicationReader Open()
    {
        var owner = new NativeInstalledPublicationReader();
        try
        {
            owner.software = owner.Hold(new nint(unchecked((int)0x80000002)), "SOFTWARE");
            owner.projection = owner.Hold(owner.software.Handle, ProjectionName);
            owner.publication = owner.Hold(owner.software.Handle, PublicationName);
            owner.generations = owner.Hold(owner.projection.Handle, "Generations");
            VerifyProtected(owner.generations.Handle);
            foreach (var name in NativeRegistryReaderV3.ListSubkeys(owner.generations.Handle, PublicationContractV3.MaxGenerations))
            {
                // ParseSelection below provides the stricter graph-id binding.
                if (name.Length != 64 || name.Any(c => c is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
                    throw new CustodyException("catalog_name_invalid");
                owner.catalogs.Add(name, owner.Hold(owner.generations.Handle, name));
            }
            _ = owner.ReadStable();
            return owner;
        }
        catch { owner.Dispose(); throw; }
    }

    private NativeRegistryReaderV3.Key Hold(nint parent, string child)
    {
        var key = NativeRegistryReaderV3.Open(parent, child, "publication_unavailable");
        keys.Add(key);
        return key;
    }

    internal NativeRegistryReaderV3.Key OpenHistoryWriter()
    {
        RequireOpen();
        // No create/delete, ownership or DACL rights; no mutable path argument.
        return NativeRegistryReaderV3.Open(software.Handle, PublicationName,
            "publication_unavailable", 0x0002001B); // KEY_READ | KEY_SET_VALUE
    }

    internal Facts ReadStable()
    {
        RequireOpen();
        var first = ReadOnce();
        var second = ReadOnce();
        if (!Same(first, second)) throw new CustodyException("publication_changed");
        return second;
    }

    internal static bool Same(Facts first, Facts second) =>
        first.Epoch == second.Epoch && first.History == second.History &&
        first.ProvisioningDigest == second.ProvisioningDigest && first.HighWater == second.HighWater &&
        first.Selection == second.Selection && first.Consistency == second.Consistency &&
        first.Catalogs.Count == second.Catalogs.Count && first.Catalogs.All(pair =>
            second.Catalogs.TryGetValue(pair.Key, out var value) && value == pair.Value);

    private Facts ReadOnce()
    {
        NativeRegistryReaderV3.RejectLink(software.Handle);
        foreach (var key in keys.Skip(1)) VerifyProtected(key.Handle);
        Names(NativeRegistryReaderV3.ListSubkeys(projection.Handle, 1), "Generations");
        var rootValues = NativeRegistryReaderV3.ListValues(projection.Handle, 2);
        if (!rootValues.Contains("HighWaterRevision", StringComparer.Ordinal) ||
            rootValues.Any(name => name is not ("ActiveSelection" or "HighWaterRevision")))
            throw new CustodyException("projection_shape_invalid");
        Names(NativeRegistryReaderV3.ListSubkeys(publication.Handle, 0));
        Names(NativeRegistryReaderV3.ListValues(publication.Handle, 3), "InstallEpoch", "ProvisioningRecord", "History");
        Names(NativeRegistryReaderV3.ListValues(generations.Handle, 0));
        Names(NativeRegistryReaderV3.ListSubkeys(generations.Handle, PublicationContractV3.MaxGenerations), [.. catalogs.Keys]);
        var epochValue = Required(publication.Handle, "InstallEpoch");
        var epoch = CustodyContractV3.ReadString(new Dictionary<string, RegistryValue> { ["InstallEpoch"] = epochValue }, "InstallEpoch");
        // Empty validates the epoch with the same exact nonzero digest contract.
        _ = PublicationContractV3.Empty(epoch);
        var historyValue = Required(publication.Handle, "History", PublicationContractV3.MaxBytes);
        if (historyValue.Type != 3) throw new CustodyException("history_type_invalid");
        string history;
        try { history = Utf8.GetString(historyValue.Data); }
        catch (DecoderFallbackException) { throw new CustodyException("history_encoding_invalid"); }
        var parsed = PublicationContractV3.ReadHistory(history);
        if (parsed.Epoch != epoch) throw new CustodyException("epoch_mismatch");
        var provisioning = Required(publication.Handle, "ProvisioningRecord", 16384);
        // Opaque installer bytes, not a certificate/authority parser. The live
        // installed origin must match these exact bytes before mutation opens.
        if (provisioning.Type != 3) throw new CustodyException("provisioning_type_invalid");
        var provenanceDigest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(provisioning.Data)).ToLowerInvariant();
        var highWaterValue = Required(projection.Handle, "HighWaterRevision");
        if (highWaterValue.Type != 11 || highWaterValue.Data.Length != 8)
            throw new CustodyException("high_water_invalid");
        var rawHighWater = BinaryPrimitives.ReadUInt64LittleEndian(highWaterValue.Data);
        if (rawHighWater > PublicationContractV3.MaxRevision) throw new CustodyException("high_water_invalid");
        var highWater = (long)rawHighWater;
        string? selection = null;
        if (rootValues.Contains("ActiveSelection", StringComparer.Ordinal))
        {
            var raw = Required(projection.Handle, "ActiveSelection");
            selection = CustodyContractV3.ReadString(new Dictionary<string, RegistryValue> { ["ActiveSelection"] = raw }, "ActiveSelection");
            _ = CustodyContractV3.ParseSelection(selection);
        }
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (name, key) in catalogs)
        {
            var snapshot = NativeRegistryReaderV3.Capture(key.Handle, 0, 7);
            Names(snapshot.Subkeys);
            Names(snapshot.Values.Keys, "GraphDigest", "ManifestDigest", "ServiceImageDigest", "ServiceName", "State", "WorkerServiceImageDigest", "WorkerServiceName");
            // Catalog canonicalization uses the actual model's fixed field
            // order after validating all seven native REG_SZ values.
            var field = snapshot.Values.ToDictionary(pair => pair.Key,
                pair => CustodyContractV3.ReadString(snapshot.Values, pair.Key), StringComparer.Ordinal);
            if (field["GraphDigest"] != name || field["ServiceName"] != "LexRunnerCoordinator" ||
                field["WorkerServiceName"] != "LexRunnerWorkerSlot1" || field["State"] != "qualified")
                throw new CustodyException("catalog_invalid");
            var text = "{\"GraphDigest\":\"" + field["GraphDigest"] + "\",\"ManifestDigest\":\"" + field["ManifestDigest"] +
                "\",\"ServiceImageDigest\":\"" + field["ServiceImageDigest"] + "\",\"ServiceName\":\"LexRunnerCoordinator\",\"State\":\"qualified\",\"WorkerServiceImageDigest\":\"" +
                field["WorkerServiceImageDigest"] + "\",\"WorkerServiceName\":\"LexRunnerWorkerSlot1\"}";
            if (!parsed.Catalogs.TryGetValue(name, out var expected) || expected != text)
                throw new CustodyException("catalog_history_mismatch");
            values.Add(name, text);
        }
        if (values.Count != parsed.Catalogs.Count) throw new CustodyException("catalog_history_mismatch");
        var consistency = PublicationContractV3.AssessAcquisition(history, epoch, highWater, selection, values).Reason;
        if (parsed.Next == "begin_required" && (highWater != 0 || selection is not null || values.Count != 0))
            throw new CustodyException("initial_projection_mismatch");
        if (parsed.Next == "retired_retained" && (highWater != parsed.ModelHighWater || selection is not null))
            throw new CustodyException("retired_projection_mismatch");
        return new Facts(epoch, history, provenanceDigest, highWater, selection,
            new ReadOnlyDictionary<string, string>(values), consistency);
    }

    internal static void VerifyProtected(nint handle)
    {
        NativeRegistryReaderV3.RejectLink(handle);
        CustodyContractV3.VerifySecurity(NativeRegistryReaderV3.ReadSecurity(handle));
    }

    private static RegistryValue Required(nint handle, string name, int maximum = 8192) =>
        NativeRegistryReaderV3.ReadRaw(handle, name, maximum) ?? throw new CustodyException("publication_value_absent");

    private static void Names(IEnumerable<string> values, params string[] expected)
    {
        var actual = values.ToArray();
        if (actual.Length != expected.Length || !expected.All(name => actual.Contains(name, StringComparer.Ordinal)))
            throw new CustodyException("publication_shape_invalid");
    }

    private void RequireOpen()
    {
        if (closed || NativeRegistryReaderV3.CloseUncertain) throw new CustodyException("publication_closed_or_uncertain");
    }

    public void Dispose()
    {
        if (closed) return;
        closed = true;
        var uncertain = false;
        for (var index = keys.Count - 1; index >= 0; --index)
            try { keys[index].Dispose(); } catch { uncertain = true; }
        if (uncertain) throw new CustodyException("registry_close_uncertain");
    }
}
