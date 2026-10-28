using System.Buffers.Binary;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;

namespace LexRunner.WindowsCoordinator.SelectionCustody;

internal sealed record RegistryValue(uint Type, byte[] Data);
internal sealed record KeySnapshot(byte[] Security, string[] Subkeys,
    IReadOnlyDictionary<string, RegistryValue> Values, bool IsLink);
internal sealed record RegistrySnapshot(KeySnapshot Root, KeySnapshot Generations,
    KeySnapshot Catalog, string CatalogName);

internal sealed record CustodyResult(string State, string Reason)
{
    internal static CustodyResult Unavailable(string reason) => new("unavailable", reason);
    internal static CustodyResult Observed() => new("observed", "registry_structural_match_only");

    internal static bool ValidReason(string reason) => reason is
        "publisher_unavailable" or "unsupported_host" or "registry_unavailable" or
        "registry_link" or "owner_or_dacl_mismatch" or "shape_mismatch" or
        "selection_unavailable" or "selection_invalid" or "high_water_invalid" or
        "high_water_mismatch" or "catalog_mismatch" or "generation_unqualified" or
        "selection_changed" or "registry_structural_match_only";
}

internal sealed class CustodyException(string reason) : Exception(reason)
{
    internal string Reason { get; } = reason;
}

// Structural checks only. This code never authenticates the writer, running
// service, signed release, mapped image, loader closure, or registry continuity.
[SupportedOSPlatform("windows")]
internal static class CustodyContract
{
    internal const string ServiceSid = "S-1-5-80-1295682314-449838899-4229104702-2958586083-1985219579";
    private const string SystemSid = "S-1-5-18";
    private const string AdministratorsSid = "S-1-5-32-544";
    private const string UsersSid = "S-1-5-32-545";
    private const int KeyAllAccess = 0x000F003F;
    private const int KeyRead = 0x00020019;
    private const uint RegSz = 1;
    private const uint RegQword = 11;
    private const long MaxSafeRevision = 9_007_199_254_740_991;
    private static readonly UnicodeEncoding StrictUtf16 = new(false, false, true);

    internal sealed record Selection(string Text, string GenerationId, string GraphDigest,
        string ManifestDigest, string ServiceImageDigest, long Revision);

    private sealed record Details(string SelectionText, ulong HighWater, string CatalogText);

    internal static CustodyResult Assess(RegistrySnapshot first, RegistrySnapshot second)
    {
        try
        {
            var initial = ValidateOne(first);
            var final = ValidateOne(second);
            if (initial != final) throw new CustodyException("selection_changed");
            return CustodyResult.Observed();
        }
        catch (CustodyException error) { return CustodyResult.Unavailable(error.Reason); }
        catch { return CustodyResult.Unavailable("registry_unavailable"); }
    }

    internal static Selection ParseSelection(string value)
    {
        try
        {
            if (Encoding.UTF8.GetByteCount(value) is < 1 or > 4096)
                throw new CustodyException("selection_invalid");
            using var document = JsonDocument.Parse(value, new JsonDocumentOptions { MaxDepth = 16 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new CustodyException("selection_invalid");
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in root.EnumerateObject())
                if (!names.Add(property.Name)) throw new CustodyException("selection_invalid");
            if (names.Count != 9 ||
                !Exact(root, "coordinatorProtocolVersion", "1.0.0") ||
                !Exact(root, "profile", "windows-coordinator-service-msi/2") ||
                !Exact(root, "schemaVersion", "windows-coordinator-active-selection/2") ||
                !Exact(root, "serviceName", "LexRunnerCoordinator"))
                throw new CustodyException("selection_invalid");
            var id = RequiredDigest(root, "generationId");
            var graph = RequiredDigest(root, "graphDigest");
            var manifest = RequiredDigest(root, "manifestSha256");
            var image = RequiredDigest(root, "serviceImageSha256");
            if (id != graph || !root.TryGetProperty("revision", out var revisionField) ||
                revisionField.ValueKind != JsonValueKind.Number ||
                !revisionField.TryGetInt64(out var revision) ||
                revision is < 1 or > MaxSafeRevision)
                throw new CustodyException("selection_invalid");
            var canonical = "{\"coordinatorProtocolVersion\":\"1.0.0\",\"generationId\":\"" +
                id + "\",\"graphDigest\":\"" + graph + "\",\"manifestSha256\":\"" +
                manifest + "\",\"profile\":\"windows-coordinator-service-msi/2\",\"revision\":" +
                revision.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                ",\"schemaVersion\":\"windows-coordinator-active-selection/2\",\"serviceImageSha256\":\"" +
                image + "\",\"serviceName\":\"LexRunnerCoordinator\"}";
            if (!string.Equals(value, canonical, StringComparison.Ordinal))
                throw new CustodyException("selection_invalid");
            return new Selection(value, id, graph, manifest, image, revision);
        }
        catch (CustodyException) { throw; }
        catch { throw new CustodyException("selection_invalid"); }
    }

    internal static string ReadString(IReadOnlyDictionary<string, RegistryValue> values, string name)
    {
        if (!values.TryGetValue(name, out var value) || value.Type != RegSz ||
            value.Data.Length is < 2 or > 8192 || (value.Data.Length & 1) != 0 ||
            value.Data[^1] != 0 || value.Data[^2] != 0)
            throw new CustodyException("shape_mismatch");
        try
        {
            var text = StrictUtf16.GetString(value.Data, 0, value.Data.Length - 2);
            if (text.Length == 0 || text.Contains('\0')) throw new CustodyException("shape_mismatch");
            return text;
        }
        catch (CustodyException) { throw; }
        catch { throw new CustodyException("shape_mismatch"); }
    }

    private static Details ValidateOne(RegistrySnapshot snapshot)
    {
        if (snapshot.Root.IsLink || snapshot.Generations.IsLink || snapshot.Catalog.IsLink)
            throw new CustodyException("registry_link");
        VerifySecurity(snapshot.Root.Security);
        VerifySecurity(snapshot.Generations.Security);
        VerifySecurity(snapshot.Catalog.Security);
        RequireNames(snapshot.Root.Subkeys, "Generations");
        RequireNames(snapshot.Root.Values.Keys, "ActiveSelection", "HighWaterRevision");
        var highWater = ReadHighWater(snapshot.Root.Values);
        var selection = ParseSelection(ReadString(snapshot.Root.Values, "ActiveSelection"));
        if (highWater != (ulong)selection.Revision)
            throw new CustodyException("high_water_mismatch");
        RequireNames(snapshot.Generations.Subkeys, selection.GenerationId);
        RequireNames(snapshot.Generations.Values.Keys);
        if (snapshot.CatalogName != selection.GenerationId || snapshot.Catalog.Subkeys.Length != 0)
            throw new CustodyException("catalog_mismatch");
        RequireNames(snapshot.Catalog.Values.Keys, "GraphDigest", "ManifestDigest",
            "ServiceImageDigest", "State", "ServiceName");
        var graph = ReadString(snapshot.Catalog.Values, "GraphDigest");
        var manifest = ReadString(snapshot.Catalog.Values, "ManifestDigest");
        var image = ReadString(snapshot.Catalog.Values, "ServiceImageDigest");
        var state = ReadString(snapshot.Catalog.Values, "State");
        var name = ReadString(snapshot.Catalog.Values, "ServiceName");
        if (graph != selection.GraphDigest || manifest != selection.ManifestDigest ||
            image != selection.ServiceImageDigest || name != "LexRunnerCoordinator")
            throw new CustodyException("catalog_mismatch");
        if (state != "qualified") throw new CustodyException("generation_unqualified");
        return new Details(selection.Text, highWater,
            graph + ":" + manifest + ":" + image + ":" + state + ":" + name);
    }

    private static ulong ReadHighWater(IReadOnlyDictionary<string, RegistryValue> values)
    {
        if (!values.TryGetValue("HighWaterRevision", out var value) || value.Type != RegQword ||
            value.Data.Length != 8)
            throw new CustodyException("high_water_invalid");
        var number = BinaryPrimitives.ReadUInt64LittleEndian(value.Data);
        if (number is < 1 or > MaxSafeRevision)
            throw new CustodyException("high_water_invalid");
        return number;
    }

    private static void VerifySecurity(byte[] bytes)
    {
        if (bytes.Length is < 20 or > 8192)
            throw new CustodyException("owner_or_dacl_mismatch");
        RawSecurityDescriptor descriptor;
        try { descriptor = new RawSecurityDescriptor(bytes, 0); }
        catch { throw new CustodyException("owner_or_dacl_mismatch"); }
        if (descriptor.Owner?.Value != SystemSid ||
            !descriptor.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclPresent) ||
            !descriptor.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclProtected) ||
            descriptor.DiscretionaryAcl?.Count != 4)
            throw new CustodyException("owner_or_dacl_mismatch");
        var expected = new Dictionary<string, int>(StringComparer.Ordinal)
        {
            [SystemSid] = KeyAllAccess,
            [AdministratorsSid] = KeyAllAccess,
            [UsersSid] = KeyRead,
            [ServiceSid] = KeyRead,
        };
        foreach (GenericAce entry in descriptor.DiscretionaryAcl)
        {
            if (entry is not CommonAce ace || ace.AceQualifier != AceQualifier.AccessAllowed ||
                ace.AceFlags != AceFlags.None ||
                !expected.Remove(ace.SecurityIdentifier.Value, out var access) ||
                ace.AccessMask != access)
                throw new CustodyException("owner_or_dacl_mismatch");
        }
        if (expected.Count != 0) throw new CustodyException("owner_or_dacl_mismatch");
    }

    private static void RequireNames(IEnumerable<string> actual, params string[] expected)
    {
        var names = actual.ToArray();
        if (names.Length != expected.Length ||
            !expected.All(name => names.Contains(name, StringComparer.Ordinal)))
            throw new CustodyException("shape_mismatch");
    }

    private static bool Exact(JsonElement root, string field, string expected) =>
        root.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String &&
        value.GetString() == expected;

    private static string RequiredDigest(JsonElement root, string field)
    {
        if (!root.TryGetProperty(field, out var value) || value.ValueKind != JsonValueKind.String)
            throw new CustodyException("selection_invalid");
        var text = value.GetString() ?? "";
        if (text.Length != 64 || text.Any(c => c is not (>= 'a' and <= 'f' or >= '0' and <= '9')))
            throw new CustodyException("selection_invalid");
        return text;
    }
}
