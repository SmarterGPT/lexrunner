#if COORDINATOR_CLIENT_FIXTURE_TESTS
using System.Security.Cryptography;
using System.Text;
using LexRunner.WindowsCoordinator.Client;

// Synthetic values only. These tests never write HKLM, touch SCM configuration,
// construct SelectedEndpoint, or reach the native pipe sender.
internal static class CoordinatorSelectionFixtureTests
{
    private const string ImageDigest =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string ImagePath =
        @"D:\Program Files\SmarterGPT.LexRunner.WindowsCoordinator\generations\" +
        ImageDigest + @"\LexRunner.WindowsCoordinator.Service.exe";

    private sealed class SelectionStore(string? value, CoordinatorCatalog? catalog)
        : ICoordinatorSelectionStore
    {
        internal string? First { get; set; } = value;
        internal string? Second { get; set; } = value;
        internal int SelectionReads { get; private set; }
        internal int CatalogReads { get; private set; }
        public string? ReadSelection() => ++SelectionReads == 1 ? First : Second;
        public CoordinatorCatalog? ReadCatalog(string generationId)
        {
            CatalogReads++;
            return generationId == ImageDigest ? catalog : null;
        }
    }

    private sealed class GenerationStore(byte[] manifest, string? digest)
        : ICoordinatorGenerationStore
    {
        internal int Reads { get; private set; }
        public string ImagePath(string generationId) =>
            generationId == ImageDigest ? CoordinatorSelectionFixtureTests.ImagePath :
                throw new InvalidOperationException();
        public byte[]? ReadManifest(string generationId)
        {
            Reads++;
            return generationId == ImageDigest ? manifest : null;
        }
        public string? ReadImageDigest(string generationId)
        {
            Reads++;
            return generationId == ImageDigest ? digest : null;
        }
    }

    private sealed class ServiceConfigSource(CoordinatorServiceConfig? value)
        : ICoordinatorServiceConfigSource
    {
        public CoordinatorServiceConfig? Read() => value;
    }

    private sealed class SyntheticFixture(SelectionStore selection,
        GenerationStore generation, ServiceConfigSource service)
    {
        internal SelectionStore Selection { get; } = selection;
        internal GenerationStore Generation { get; set; } = generation;
        internal ServiceConfigSource Service { get; set; } = service;
        internal CoordinatorObservation Observe() =>
            CoordinatorAcquisition.Observe(Selection, Generation, Service);
    }

    private static SyntheticFixture Fixture(bool qualified = true)
    {
        var state = qualified ? "qualified" : "provisioned-unqualified";
        var ready = qualified ? "true" : "false";
        var text = "{\"schemaVersion\":\"lexrunner-windows-coordinator-generation/1\"," +
            "\"profile\":\"windows-coordinator-service-msi/1\"," +
            $"\"generationId\":\"{ImageDigest}\"," +
            "\"serviceName\":\"LexRunnerCoordinator\"," +
            $"\"serviceImageSha256\":\"{ImageDigest}\"," +
            $"\"serviceVersion\":\"2.5.0\",\"state\":\"{state}\"," +
            $"\"productionReady\":{ready}}}";
        var manifest = Encoding.UTF8.GetBytes(text);
        var manifestDigest = Convert.ToHexString(SHA256.HashData(manifest)).ToLowerInvariant();
        var selection = $"{{\"generationId\":\"{ImageDigest}\"," +
            $"\"manifestSha256\":\"{manifestDigest}\"," +
            "\"profile\":\"windows-coordinator-service-msi/1\"," +
            "\"protocolVersion\":\"1.0.0\",\"revision\":1," +
            "\"schemaVersion\":\"windows-coordinator-active-selection/1\"," +
            $"\"serviceImageSha256\":\"{ImageDigest}\"," +
            "\"serviceName\":\"LexRunnerCoordinator\",\"serviceVersion\":\"2.5.0\"}";
        var catalog = new CoordinatorCatalog(manifestDigest, ImageDigest, state,
            "LexRunnerCoordinator");
        var config = new CoordinatorServiceConfig(0x10, 3, 1,
            $"\"{ImagePath}\" --service", @"NT SERVICE\LexRunnerCoordinator", "", "");
        return new SyntheticFixture(new SelectionStore(selection, catalog),
            new GenerationStore(manifest, ImageDigest), new ServiceConfigSource(config));
    }

    private static void Check(string name, bool passed, CoordinatorObservation result,
        List<TestCase> results, List<string> failures)
    {
        results.Add(new TestCase { Name = name, Passed = passed,
            State = result.State + ":" + result.Reason, BytesWritten = 0,
            ServerBytesRead = 0 });
        if (!passed) failures.Add(name);
    }

    internal static void Run(List<TestCase> results, List<string> failures)
    {
        var valid = Fixture();
        var outcome = valid.Observe();
        Check("selection_structural_only_no_send",
            outcome.State == "consistent" && outcome.Reason == "structural_only" &&
            !outcome.AuthorizesLaunch, outcome, results, failures);

        var absent = Fixture();
        absent.Selection.First = null;
        outcome = absent.Observe();
        Check("selection_absent_no_send", outcome.Reason == "selection_unavailable" &&
            absent.Selection.CatalogReads == 0 && absent.Generation.Reads == 0 &&
            !outcome.AuthorizesLaunch, outcome, results, failures);

        foreach (var (name, change) in new (string, Func<string, string>)[] {
            ("selection_old_profile_no_send", value =>
                value.Replace("windows-coordinator-service-msi/1", "windows-helper-msi-direct/1")),
            ("selection_duplicate_no_send", value =>
                value.Replace("\"revision\":1,", "\"revision\":1,\"revision\":2,")),
            ("selection_extra_pipe_no_send", value =>
                value.Replace("\"revision\":1,", "\"revision\":1,\"pipe\":\"other\",")),
            ("selection_noncanonical_no_send", value => value + "\n"),
            ("selection_wrong_service_no_send", value =>
                value.Replace("\"serviceName\":\"LexRunnerCoordinator\"",
                    "\"serviceName\":\"OtherService\""))
        })
        {
            var fixture = Fixture();
            fixture.Selection.First = change(fixture.Selection.First!);
            outcome = fixture.Observe();
            Check(name, outcome.Reason == "selection_invalid" &&
                fixture.Generation.Reads == 0 && !outcome.AuthorizesLaunch,
                outcome, results, failures);
        }

        var changed = Fixture();
        changed.Selection.Second = changed.Selection.First!.Replace("\"revision\":1,",
            "\"revision\":2,");
        outcome = changed.Observe();
        Check("selection_changed_no_send", outcome.Reason == "selection_changed" &&
            changed.Selection.SelectionReads == 2 && !outcome.AuthorizesLaunch,
            outcome, results, failures);

        var unqualified = Fixture(false);
        outcome = unqualified.Observe();
        Check("initial_msi_unqualified_no_send", outcome.Reason == "generation_unqualified" &&
            !outcome.AuthorizesLaunch, outcome, results, failures);

        var extraManifest = Fixture();
        var extraBytes = Encoding.UTF8.GetBytes(
            Encoding.UTF8.GetString(extraManifest.Generation.ReadManifest(ImageDigest)!)
                .Replace("\"productionReady\":true}",
                    "\"productionReady\":true,\"source\":{}}"));
        extraManifest.Generation = new GenerationStore(extraBytes, ImageDigest);
        outcome = extraManifest.Observe();
        Check("extra_manifest_field_no_send", outcome.Reason == "manifest_invalid" &&
            !outcome.AuthorizesLaunch, outcome, results, failures);

        var wrongImage = Fixture();
        wrongImage.Generation = new GenerationStore(
            wrongImage.Generation.ReadManifest(ImageDigest)!, new string('b', 64));
        outcome = wrongImage.Observe();
        Check("wrong_image_digest_no_send", outcome.Reason == "image_mismatch" &&
            !outcome.AuthorizesLaunch, outcome, results, failures);

        var wrongConfig = Fixture();
        wrongConfig.Service = new ServiceConfigSource(new CoordinatorServiceConfig(
            0x10, 3, 1, "\"D:\\other\\service.exe\" --service",
            @"NT SERVICE\LexRunnerCoordinator", "", ""));
        outcome = wrongConfig.Observe();
        Check("wrong_scm_image_no_send", outcome.Reason == "service_config_mismatch" &&
            !outcome.AuthorizesLaunch, outcome, results, failures);

        var wrongAccount = Fixture();
        wrongAccount.Service = new ServiceConfigSource(new CoordinatorServiceConfig(
            0x10, 3, 1, $"\"{ImagePath}\" --service", @"LocalSystem", "", ""));
        outcome = wrongAccount.Observe();
        Check("wrong_scm_account_no_send", outcome.Reason == "service_config_mismatch" &&
            !outcome.AuthorizesLaunch, outcome, results, failures);

        var wrongStart = Fixture();
        wrongStart.Service = new ServiceConfigSource(new CoordinatorServiceConfig(
            0x10, 2, 1, $"\"{ImagePath}\" --service",
            @"NT SERVICE\LexRunnerCoordinator", "", ""));
        outcome = wrongStart.Observe();
        Check("wrong_scm_start_no_send", outcome.Reason == "service_config_mismatch" &&
            !outcome.AuthorizesLaunch, outcome, results, failures);
    }
}
#endif
