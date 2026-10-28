#if SELECTION_CUSTODY_FIXTURE
using System.Buffers.Binary;
using System.Security.AccessControl;
using System.Runtime.Versioning;
using System.Text;

namespace LexRunner.WindowsCoordinator.SelectionCustody;

// Pure in-memory negatives: no registry key, service, ACL, or selection is
// created or changed by this fixture build.
[SupportedOSPlatform("windows")]
internal static class FixtureTests
{
    private static readonly string Id = new('a', 64);
    private static readonly string Manifest = new('b', 64);
    private static readonly string Image = new('c', 64);
    private const string GoodSddl = "O:SYD:P(A;;KA;;;SY)(A;;KA;;;BA)(A;;KR;;;BU)" +
        "(A;;KR;;;S-1-5-80-1295682314-449838899-4229104702-2958586083-1985219579)";

    internal static bool Run()
    {
        try
        {
            var good = Sample(1);
            var observations = new Dictionary<string, bool>(StringComparer.Ordinal)
            {
                ["positive_structural_only"] = CustodyContract.Assess(good, good) ==
                    CustodyResult.Observed(),
                ["root_link"] = Reason(good with { Root = good.Root with { IsLink = true } },
                    good, "registry_link"),
                ["generations_link"] = Reason(good with { Generations = good.Generations with
                    { IsLink = true } }, good, "registry_link"),
                ["catalog_link"] = Reason(good with { Catalog = good.Catalog with
                    { IsLink = true } }, good, "registry_link"),
                ["wrong_owner"] = Reason(good with { Root = good.Root with
                    { Security = Security(GoodSddl.Replace("O:SY", "O:BA", StringComparison.Ordinal)) } },
                    good, "owner_or_dacl_mismatch"),
                ["inherited_acl"] = Reason(good with { Root = good.Root with
                    { Security = Security(GoodSddl.Replace("D:P", "D:", StringComparison.Ordinal)) } },
                    good, "owner_or_dacl_mismatch"),
                ["extra_ace"] = Reason(good with { Root = good.Root with
                    { Security = Security(GoodSddl + "(A;;KR;;;WD)") } }, good,
                    "owner_or_dacl_mismatch"),
                ["wrong_qword_type"] = Reason(WithRootValue(good, "HighWaterRevision",
                    new RegistryValue(4, [1, 0, 0, 0])), good, "high_water_invalid"),
                ["zero_high_water"] = Reason(WithRootValue(good, "HighWaterRevision",
                    Qword(0)), good, "high_water_invalid"),
                ["high_water_overflow"] = Reason(WithRootValue(good, "HighWaterRevision",
                    Qword(9_007_199_254_740_992)), good, "high_water_invalid"),
                ["high_water_mismatch"] = Reason(WithRootValue(good, "HighWaterRevision",
                    Qword(2)), good, "high_water_mismatch"),
                ["wrong_selection_type"] = Reason(WithRootValue(good, "ActiveSelection",
                    new RegistryValue(2, Encoding.Unicode.GetBytes(SelectionText(1) + "\0"))),
                    good, "shape_mismatch"),
                ["wrong_catalog_type"] = Reason(WithCatalogValue(good, "State",
                    new RegistryValue(2, Encoding.Unicode.GetBytes("qualified\0"))),
                    good, "shape_mismatch"),
                ["extra_root_value"] = Reason(WithRootValue(good, "Other", Sz("x")),
                    good, "shape_mismatch"),
                ["extra_root_subkey"] = Reason(good with { Root = good.Root with
                    { Subkeys = ["Generations", "Other"] } }, good, "shape_mismatch"),
                ["changed_revision"] = Reason(good, Sample(2), "selection_changed"),
                ["duplicate_selection_field"] = Reason(WithRootValue(good,
                    "ActiveSelection", Sz(SelectionText(1).Replace("{", "{\"revision\":1,",
                        StringComparison.Ordinal))), good, "selection_invalid"),
                ["extra_catalog"] = Reason(good with { Generations = good.Generations with
                    { Subkeys = [Id, new string('d', 64)] } }, good, "shape_mismatch"),
                ["unqualified_claim"] = Reason(WithCatalogValue(good, "State",
                    Sz("provisioned-unqualified")), good, "generation_unqualified"),
                ["catalog_mismatch"] = Reason(WithCatalogValue(good, "GraphDigest",
                    Sz(new string('d', 64))), good, "catalog_mismatch"),
                ["service_sid_missing"] = Reason(good with { Root = good.Root with
                    { Security = Security(GoodSddl[..GoodSddl.LastIndexOf("(A;;KR;;;S-1-5-80", StringComparison.Ordinal)]) } },
                    good, "owner_or_dacl_mismatch"),
            };
            foreach (var (name, passed) in observations)
                if (!passed) { Console.Error.WriteLine("fixture_failed:" + name); return false; }
            return observations.Count == 21;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("fixture_exception:" + error.GetType().Name);
            return false;
        }
    }

    private static bool Reason(RegistrySnapshot first, RegistrySnapshot second, string expected)
    {
        var result = CustodyContract.Assess(first, second);
        return result.State == "unavailable" && result.Reason == expected;
    }

    private static RegistrySnapshot Sample(long revision)
    {
        var security = Security(GoodSddl);
        var root = new KeySnapshot(security, ["Generations"],
            new Dictionary<string, RegistryValue>(StringComparer.Ordinal)
            {
                ["HighWaterRevision"] = Qword((ulong)revision),
                ["ActiveSelection"] = Sz(SelectionText(revision)),
            }, false);
        var generations = new KeySnapshot(security, [Id],
            new Dictionary<string, RegistryValue>(StringComparer.Ordinal), false);
        var catalog = new KeySnapshot(security, [],
            new Dictionary<string, RegistryValue>(StringComparer.Ordinal)
            {
                ["GraphDigest"] = Sz(Id),
                ["ManifestDigest"] = Sz(Manifest),
                ["ServiceImageDigest"] = Sz(Image),
                ["State"] = Sz("qualified"),
                ["ServiceName"] = Sz("LexRunnerCoordinator"),
            }, false);
        return new RegistrySnapshot(root, generations, catalog, Id);
    }

    private static string SelectionText(long revision) =>
        "{\"coordinatorProtocolVersion\":\"1.0.0\",\"generationId\":\"" + Id +
        "\",\"graphDigest\":\"" + Id + "\",\"manifestSha256\":\"" + Manifest +
        "\",\"profile\":\"windows-coordinator-service-msi/2\",\"revision\":" +
        revision.ToString(System.Globalization.CultureInfo.InvariantCulture) +
        ",\"schemaVersion\":\"windows-coordinator-active-selection/2\",\"serviceImageSha256\":\"" +
        Image + "\",\"serviceName\":\"LexRunnerCoordinator\"}";

    private static byte[] Security(string sddl)
    {
        var descriptor = new RawSecurityDescriptor(sddl);
        var bytes = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(bytes, 0);
        return bytes;
    }

    private static RegistryValue Sz(string value) =>
        new(1, Encoding.Unicode.GetBytes(value + "\0"));

    private static RegistryValue Qword(ulong value)
    {
        var bytes = new byte[8];
        BinaryPrimitives.WriteUInt64LittleEndian(bytes, value);
        return new RegistryValue(11, bytes);
    }

    private static RegistrySnapshot WithRootValue(RegistrySnapshot snapshot, string name,
        RegistryValue value)
    {
        var values = snapshot.Root.Values.ToDictionary(pair => pair.Key, pair => pair.Value,
            StringComparer.Ordinal);
        values[name] = value;
        return snapshot with { Root = snapshot.Root with { Values = values } };
    }

    private static RegistrySnapshot WithCatalogValue(RegistrySnapshot snapshot, string name,
        RegistryValue value)
    {
        var values = snapshot.Catalog.Values.ToDictionary(pair => pair.Key, pair => pair.Value,
            StringComparer.Ordinal);
        values[name] = value;
        return snapshot with { Catalog = snapshot.Catalog with { Values = values } };
    }
}
#endif
