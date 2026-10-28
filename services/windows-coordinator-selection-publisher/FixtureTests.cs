#if SELECTION_PUBLISHER_FIXTURE
using System.Runtime.Versioning;
namespace LexRunner.WindowsCoordinator.SelectionPublisher;

[SupportedOSPlatform("windows")]
internal static class FixtureTests
{
    private const string GenerationId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string ManifestDigest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string ServiceImageDigest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string Selection = "{\"coordinatorProtocolVersion\":\"1.0.0\",\"generationId\":\"" + GenerationId +
        "\",\"graphDigest\":\"" + GenerationId + "\",\"manifestSha256\":\"" + ManifestDigest +
        "\",\"profile\":\"windows-coordinator-service-msi/2\",\"revision\":1,\"schemaVersion\":\"windows-coordinator-active-selection/2\",\"serviceImageSha256\":\"" +
        ServiceImageDigest + "\",\"serviceName\":\"LexRunnerCoordinator\"}";
    private static readonly IReadOnlyDictionary<string, string> Catalog = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["GraphDigest"] = GenerationId,
        ["ManifestDigest"] = ManifestDigest,
        ["ServiceImageDigest"] = ServiceImageDigest,
        ["State"] = "qualified",
        ["ServiceName"] = "LexRunnerCoordinator",
    };

    private static readonly string[] Faults =
    [
        "catalog_write", "catalog_flush", "high_water_write",
        "high_water_flush", "selection_write", "selection_flush"
    ];

    internal static void Run()
    {
        if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess)
            throw new InvalidOperationException("windows_x64_required");
        RunFailedCreateCase();
        foreach (var fault in Faults) RunInterruptedCase(fault);
        RunCompleteCase();
    }

    private static void RunFailedCreateCase()
    {
        var nonce = Guid.NewGuid().ToString("N");
        try
        {
            try
            {
                using var unexpected = FixtureRegistry.Create(nonce, injectFailureAfterRootCreate: true);
                throw new InvalidOperationException("injected_create_not_refused");
            }
            catch (InvalidOperationException error) when (error.Message == "injected_after_root_create") { }
            Require(FixtureRegistry.IsAbsent(nonce), "failed_create_left_root");
        }
        finally { FixtureRegistry.CleanupIfPresent(nonce, GenerationId); }
    }

    private static void RunInterruptedCase(string fault)
    {
        var nonce = Guid.NewGuid().ToString("N");
        try
        {
            using (var store = FixtureRegistry.Create(nonce))
            {
                Require(!Ready(store), "new_fixture_ready");
                var state = Publish(store, fault);
                Require(state == "uncertain:" + fault, "interruption_not_uncertain");
            }
            using (var reopened = FixtureRegistry.OpenExisting(nonce))
            {
                var state = Recover(reopened);
                var expected = fault.StartsWith("selection_", StringComparison.Ordinal) ?
                    "already_published" : "simulated_published";
                Require(state == expected, "explicit_recovery_" + state);
                Require(Ready(reopened), "recovery_readback_failed");
                Require(Recover(reopened) == "already_published", "recovery_replay_failed");
            }
        }
        finally
        {
            FixtureRegistry.CleanupIfPresent(nonce, GenerationId);
        }
    }

    private static void RunCompleteCase()
    {
        var nonce = Guid.NewGuid().ToString("N");
        try
        {
            using var store = FixtureRegistry.Create(nonce);
            Require(Publish(store, null) == "simulated_published", "initial_publication_failed");
            Require(Ready(store), "initial_readback_failed");
            Require(Publish(store, null) == "recovery_required", "initial_replay_not_refused");
            Require(Recover(store) == "already_published", "explicit_replay_failed");
        }
        finally
        {
            FixtureRegistry.CleanupIfPresent(nonce, GenerationId);
        }
    }

    private static string Publish(FixtureRegistry store, string? interruptAfter)
    {
        try
        {
            store.VerifyRootShape();
            if (store.CatalogExists(GenerationId) || store.ReadHighWater() != 0 || store.ReadSelection() is not null)
                return "recovery_required";
            store.WriteNewCatalog(GenerationId, Catalog);
            Interrupt("catalog_write");
            store.FlushCatalog(GenerationId);
            Interrupt("catalog_flush");
            if (!store.CatalogMatches(GenerationId, Catalog) || store.ReadHighWater() != 0 || store.ReadSelection() is not null)
                return "uncertain:catalog_readback";
            store.SetHighWater(1);
            Interrupt("high_water_write");
            store.FlushRoot();
            Interrupt("high_water_flush");
            if (!store.CatalogMatches(GenerationId, Catalog) || store.ReadHighWater() != 1 || store.ReadSelection() is not null)
                return "uncertain:high_water_readback";
            store.SetSelection(Selection);
            Interrupt("selection_write");
            store.FlushRoot();
            Interrupt("selection_flush");
            return Ready(store) ? "simulated_published" : "uncertain:final_readback";
        }
        catch (FixtureInterruption ex) { return "uncertain:" + ex.Phase; }
        catch { return "uncertain:unknown"; }

        void Interrupt(string phase)
        {
            if (phase == interruptAfter) throw new FixtureInterruption(phase);
        }
    }

    private static string Recover(FixtureRegistry store)
    {
        try
        {
            store.VerifyRootShape();
            if (!store.CatalogExists(GenerationId) || !store.CatalogMatches(GenerationId, Catalog))
                return "catalog_conflict";
            var highWater = store.ReadHighWater();
            var selected = store.ReadSelection();
            if (highWater is not (0 or 1) || (selected is not null && selected != Selection) ||
                (selected is not null && highWater != 1)) return "selection_conflict";
            // An observed row may only be a volatile write. Flush on recovery
            // even when it already matches the expected bytes.
            store.FlushCatalog(GenerationId);
            if (!store.CatalogMatches(GenerationId, Catalog) || store.ReadHighWater() != highWater ||
                store.ReadSelection() != selected) return "uncertain:catalog_readback";
            if (highWater == 0) store.SetHighWater(1);
            store.FlushRoot();
            if (store.ReadHighWater() != 1 || store.ReadSelection() != selected)
                return "uncertain:high_water_readback";
            if (selected is null) store.SetSelection(Selection);
            store.FlushRoot();
            return Ready(store) ? selected is null ? "simulated_published" : "already_published" :
                "uncertain:final_readback";
        }
        catch { return "uncertain:unknown"; }
    }

    private static bool Ready(FixtureRegistry store)
    {
        store.VerifyRootShape();
        return store.CatalogMatches(GenerationId, Catalog) &&
            store.ReadHighWater() == 1 && store.ReadSelection() == Selection;
    }

    private static void Require(bool condition, string code)
    {
        if (!condition) throw new InvalidOperationException(code);
    }

    private sealed class FixtureInterruption(string phase) : Exception
    {
        internal string Phase { get; } = phase;
    }
}
#endif
