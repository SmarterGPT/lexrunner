#nullable enable
using System;
using System.IO;
using System.Text.Json;
using System.Threading;

namespace LexRunner.WindowsCoordinator.Git;

// Artifact-only console fixture. Its selection JSON is same-user supplied.
internal static class GitViewProbeProgram
{
    private static T Read<T>(string path) => JsonSerializer.Deserialize<T>(
        File.ReadAllText(path)) ?? throw new InvalidDataException("fixture_json_missing");

    private static FileStream HoldFixtureImportSlot(ImportSlot slot)
    {
        var marker = FixtureBoundGitViewTransition.HoldDisposableFixtureRoot(
            slot.Root);
        try
        {
            if (slot.Bundle != Path.Combine(slot.Root, "source.bundle") ||
                slot.Mirror != Path.Combine(slot.Root, "mirror") ||
                slot.EmptyHooks != Path.Combine(slot.Root, "hooks") ||
                slot.EmptyTemplate != Path.Combine(slot.Root, "template") ||
                slot.Home != Path.Combine(slot.Root, "home") ||
                slot.Temp != Path.Combine(slot.Root, "tmp"))
                throw new InvalidDataException("fixture_import_slot_not_disposable");
            return marker;
        }
        catch { marker.Dispose(); throw; }
    }

    private static int Main(string[] args)
    {
        try
        {
#if GIT_HOSTED_2022_FIXTURE
            if (args is ["--hosted-profile-selftest"])
            {
                Console.Error.WriteLine("hosted_profile_selftest_entered");
                var slot = new ImportSlot(@"C:\fixture", @"C:\fixture", @"C:\fixture",
                    @"C:\fixture", @"C:\fixture", @"C:\fixture", @"C:\fixture",
                    new string('0', 40), new string('a', 64));
                var profile = ManualEtwGitProfile.CreateHostedFixture(
                    GitBundleImport.ConstructEnvironment(slot), GitBundleImport.HostedGitImageSha256);
                Console.Error.WriteLine("hosted_profile_environment_constructed");
                profile.AssertEnvironment(profile.Environment);
                if (profile.GitImage != ManualEtwGitProfile.FixedGitImage ||
                    profile.ExpectedSha256 != GitBundleImport.HostedGitImageSha256 ||
                    profile.Environment.ContainsKey("GIT_EXEC_PATH") ||
                    profile.Environment["PATH"].Contains(@"\Git\", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("hosted_profile_not_strict");
                var changed = new System.Collections.Generic.Dictionary<string, string>(
                    profile.Environment, StringComparer.OrdinalIgnoreCase) { ["PATH"] = @"C:\unexpected" };
                var refused = false;
                try { profile.AssertEnvironment(changed); }
                catch (InvalidOperationException) { refused = true; }
                if (!refused) throw new InvalidDataException("hosted_profile_mutation_accepted");
                Console.Error.WriteLine("hosted_profile_selftest_completed");
                Console.WriteLine("hosted_profile_source_selftest_pass");
                return 0;
            }
#endif
            if (args.Length == 2 && args[0] == "--import")
            {
                var slot = Read<ImportSlot>(args[1]);
                using var marker = HoldFixtureImportSlot(slot);
                var result = GitBundleImport.ImportAsync(slot,
                    CancellationToken.None).GetAwaiter().GetResult();
                Console.WriteLine(JsonSerializer.Serialize(result));
                return result.Imported ? 0 : 1;
            }
            if (args.Length == 4 && args[0] == "--select")
            {
                var slot = Read<ImportSlot>(args[1]);
                using var marker = HoldFixtureImportSlot(slot);
                if (args[2] != Path.Combine(slot.Root, "final") ||
                    args[3] != Path.Combine(slot.Root, "selection.json"))
                    throw new InvalidDataException("fixture_selection_path_not_disposable");
                var expected = new SelectedGitRoots(
                    SelectedRootsFixtureProbe.ObserveUntrusted(slot.Root),
                    SelectedRootsFixtureProbe.ObserveUntrusted(args[2]),
                    SelectedRootsFixtureProbe.ObserveUntrusted(slot.Mirror),
                    SelectedRootsFixtureProbe.ObserveUntrusted(
                        Path.Combine(slot.Mirror, "worktrees")));
                using var held = HeldSelectedGitRoots.Acquire(expected);
                held.AssertCurrent();
                File.WriteAllText(args[3], JsonSerializer.Serialize(expected));
                Console.WriteLine("fixture_selection_written_no_authority");
                return 0;
            }
            if (args.Length == 4 && args[0] == "--stage-exit-after-effect")
            {
                var result = FixtureBoundGitViewTransition.StageAsync(
                    Read<ImportSlot>(args[1]), Read<SelectedGitRoots>(args[2]),
                    args[3], CancellationToken.None).GetAwaiter().GetResult();
                if (!result.Staged) return 1;
                // Simulate abrupt loss after the Git effect and before any
                // result bytes or stage-identity row reach the coordinator.
                Environment.Exit(73);
            }
            if (args.Length == 4 && args[0] == "--stage")
            {
                var result = FixtureBoundGitViewTransition.StageAsync(
                    Read<ImportSlot>(args[1]), Read<SelectedGitRoots>(args[2]),
                    args[3], CancellationToken.None).GetAwaiter().GetResult();
                Console.WriteLine(JsonSerializer.Serialize(result));
                return result.Staged ? 0 : 1;
            }
            if (args.Length == 5 && args[0] == "--observe")
            {
                var result = FixtureBoundGitViewTransition.ObserveAsync(
                    Read<ImportSlot>(args[1]), Read<SelectedGitRoots>(args[2]),
                    args[3], args[4], CancellationToken.None).GetAwaiter().GetResult();
                Console.WriteLine(JsonSerializer.Serialize(result));
                return result.Error is null ? 0 : 1;
            }
            if (args.Length == 6 && args[0] == "--publish")
            {
                var prior = Read<BoundStageResult>(args[3]);
                if (!prior.Staged || prior.StageIdentity is null)
                    throw new InvalidDataException("fixture_prior_stage_identity_missing");
                var result = FixtureBoundGitViewTransition.PublishAsync(
                    Read<ImportSlot>(args[1]), Read<SelectedGitRoots>(args[2]),
                    args[4], prior.StageIdentity, args[5], CancellationToken.None)
                    .GetAwaiter().GetResult();
                if (result.Published)
                {
                    var slot = Read<ImportSlot>(args[1]);
                    using var marker = HoldFixtureImportSlot(slot);
                    using var issued = new FileStream(Path.Combine(slot.Root,
                        "issued-publish-result.json"), FileMode.CreateNew,
                        FileAccess.Write, FileShare.Read);
                    var bytes = JsonSerializer.SerializeToUtf8Bytes(result);
                    issued.Write(bytes);
                    issued.Flush(true);
                }
                Console.WriteLine(JsonSerializer.Serialize(result));
                return result.Published ? 0 : 1;
            }
            if (args.Length == 6 &&
                (args[0] == "--remove" || args[0] == "--remove-exit-after-effect"))
            {
                var slot = Read<ImportSlot>(args[1]);
                using var marker = HoldFixtureImportSlot(slot);
                if (args[3] != Path.Combine(slot.Root, "issued-publish-result.json"))
                    throw new InvalidDataException("fixture_issued_publish_path_required");
                // This row was emitted by this fixture's publish route. It is still
                // same-user test data, never an authenticated production receipt.
                var prior = Read<BoundPublishResult>(args[3]);
                if (!prior.Published || prior.FinalIdentity is null)
                    throw new InvalidDataException("fixture_prior_final_identity_missing");
                var result = FixtureBoundGitViewTransition.RemoveAsync(
                    Read<ImportSlot>(args[1]), Read<SelectedGitRoots>(args[2]),
                    args[4], args[5], prior, CancellationToken.None)
                    .GetAwaiter().GetResult();
                if (args[0] == "--remove-exit-after-effect" && result.Removed)
                    Environment.Exit(74);
                Console.WriteLine(JsonSerializer.Serialize(result));
                return result.Removed ? 0 : 1;
            }
            Console.Error.WriteLine("fixture_usage_refused");
            return 2;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ":" + error.Message);
            return 3;
        }
    }
}
