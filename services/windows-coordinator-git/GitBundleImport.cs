using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace LexRunner.WindowsCoordinator.Git;

#if GIT_HOSTED_2022_FIXTURE && !GIT_IMPORT_FIXTURE
#error The hosted Git candidate is only permitted in the non-authorizing fixture image.
#endif

// Non-authorizing source contract. The fixed child is Job-bound, but no
// protected slot, installed image graph or service token is connected.
internal sealed record ImportSlot(string Root, string Bundle, string Mirror,
    string EmptyHooks, string EmptyTemplate, string Home, string Temp,
    string PinnedCommit, string ExpectedBundleSha256);

internal sealed record CommandRecord(string Phase, string Executable, string Cwd,
    string[] Argv, string StartedAt, long DurationMs, int? ExitCode,
    bool TimedOut, bool Canceled, bool OutputExceeded, bool StreamsCompleted,
    bool ProcessExited, bool DescendantCleanupProven,
    bool JobAssignedAtCreation, bool ChildResumed, bool TerminalJobDrained,
    uint JobTotalProcesses, string HeldImageSha256, string? Error,
    string ConfiguredSystemRoot, string ConfiguredWindir,
    string ConfiguredComSpec, string ConfiguredPathSha256,
    string ConfiguredGitExecPath,
    string StdoutSha256, string StderrSha256, int StdoutBytes, int StderrBytes,
    string Stdout, string Stderr
#if GIT_IMPORT_FIXTURE
    , StaticGitImportInventory? StaticImports, uint? RootProcessId,
    IReadOnlyList<JobProcessObservation> ObservedJobProcesses
#endif
    );

internal sealed record ImportOutcome(bool Imported, string Disposition,
    string? Error, bool MirrorMayExist, bool UnknownEffects,
    string? ImportedCommit, string? BundleSha256,
    IReadOnlyList<CommandRecord> Commands);

internal static class GitBundleImport
{
    // Fixed candidate image; independent installed-image and loader protection
    // remain required before any service-token use.
#if GIT_HOSTED_2022_FIXTURE
    // The hosted inventory read back these exact PE bytes on windows-2022.
    // This pins the root image for a source-only fixture. The Git helper and
    // loader graph remain unknown and cannot authorize installed execution.
    internal const string GitImage = @"C:\Program Files\Git\bin\git.exe";
    internal const string GitBin = @"C:\Program Files\Git\bin";
    internal const string HostedGitImageSha256 =
        "3b64043b9e4dc225225f43ff9c1173b57493ff72e5b729accfae051eb160cca3";
#else
    internal const string GitImage = @"C:\Program Files\Git\mingw64\bin\git.exe";
    internal const string GitBin = @"C:\Program Files\Git\mingw64\bin";
    internal const string GitExecPath = @"C:\Program Files\Git\mingw64\libexec\git-core";
#endif
    private static readonly Regex Commit = new("^[0-9a-f]{40}([0-9a-f]{24})?$", RegexOptions.CultureInvariant);
    private static readonly Regex Digest = new("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);

#if GIT_IMPORT_FIXTURE
    internal static async Task<CommandRecord> RunCancellationFixtureAsync(
        ImportSlot slot, bool cancelBeforeResume)
    {
        // Exercise the launcher after the same slot and bundle preflight, with
        // one fixed mirror-init command and a fresh destination.
        ValidateSlot(slot);
        if (!File.Exists(GitImage)) throw new InvalidOperationException("fixed_git_image_missing");
        if (Directory.Exists(slot.Mirror) || File.Exists(slot.Mirror))
            throw new InvalidOperationException("mirror_slot_occupied");
        if (await HashFile(slot.Bundle, CancellationToken.None) != slot.ExpectedBundleSha256)
            throw new InvalidOperationException("bundle_digest_mismatch_before_import");
        var env = ConstructEnvironment(slot);
        var argv = new[] { "init", "--bare", "--initial-branch=main", slot.Mirror };
        using var cancellation = new CancellationTokenSource();
        if (cancelBeforeResume)
            return await BoundedGitChild.RunCanceledBeforeResumeFixtureAsync(
                "canceled-before-resume", slot.Root, argv, env, cancellation);
        cancellation.Cancel();
        return await BoundedGitChild.RunAsync("canceled-before-create",
            slot.Root, argv, env, cancellation.Token);
    }
#endif

    internal static async Task<ImportOutcome> ImportAsync(ImportSlot slot, CancellationToken token
#if GIT_IMPORT_FIXTURE
        , GraphSelectedGitProfile? graphProfile = null
#endif
        )
    {
        var commands = new List<CommandRecord>();
        bool mirrorMayExist = false;
        string? imported = null;
        string? bundleSha = null;
        try
        {
            ValidateSlot(slot);
            var selectedImage = GitImage;
#if GIT_IMPORT_FIXTURE
            if (graphProfile is not null) selectedImage = graphProfile.GitImage;
#endif
            if (!File.Exists(selectedImage)) throw new InvalidOperationException("fixed_git_image_missing");
            if (Directory.Exists(slot.Mirror) || File.Exists(slot.Mirror))
                throw new InvalidOperationException("mirror_slot_occupied");
            bundleSha = await HashFile(slot.Bundle, token);
            if (bundleSha != slot.ExpectedBundleSha256)
                throw new InvalidOperationException("bundle_digest_mismatch_before_import");
            var env = ConstructEnvironment(slot
#if GIT_IMPORT_FIXTURE
                , graphProfile
#endif
                );
            Task<CommandRecord> RunImport(string phase, string cwd, string[] argv) =>
                Run(phase, cwd, argv, env, commands, token
#if GIT_IMPORT_FIXTURE
                    , graphProfile
#endif
                    );
            var safe = new[] { "-c", "core.hooksPath=" + slot.EmptyHooks.Replace('\\', '/'),
                "-c", "core.fsmonitor=false", "-c", "gc.auto=0",
                "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true",
                "-c", "protocol.file.allow=always" };
            mirrorMayExist = true; // Even failed init can leave effects.
            await RunImport("mirror-init", slot.Root,
                new[] { "init", "--bare", "--initial-branch=main", slot.Mirror });
            AssertMirrorState(slot);
            await RunImport("bundle-verify", slot.Mirror,
                safe.Concat(new[] { "bundle", "verify", slot.Bundle }).ToArray());
            var heads = await RunImport("bundle-heads", slot.Mirror,
                safe.Concat(new[] { "bundle", "list-heads", slot.Bundle }).ToArray());
            if (heads.Stdout.Trim() != slot.PinnedCommit + " refs/heads/main")
                throw new InvalidOperationException("bundle_heads_not_exact_pin");
            bundleSha = await HashFile(slot.Bundle, token);
            if (bundleSha != slot.ExpectedBundleSha256)
                throw new InvalidOperationException("bundle_digest_changed_before_fetch");
            await RunImport("mirror-fetch", slot.Mirror,
                safe.Concat(new[] { "fetch", "--no-tags", "--no-write-fetch-head",
                    "--no-auto-maintenance", "--no-recurse-submodules", "--no-show-forced-updates",
                    slot.Bundle, "refs/heads/main:refs/heads/imported" }).ToArray());
            var head = await RunImport("imported-head", slot.Mirror,
                safe.Concat(new[] { "rev-parse", "--verify", "refs/heads/imported^{commit}" }).ToArray());
            imported = head.Stdout.Trim();
            if (imported != slot.PinnedCommit)
                throw new InvalidOperationException("imported_commit_not_pin");
            if (File.Exists(Path.Combine(slot.Mirror, "FETCH_HEAD")))
                throw new InvalidOperationException("unexpected_fetch_head");
            AssertMirrorState(slot);
            bundleSha = await HashFile(slot.Bundle, token);
            if (bundleSha != slot.ExpectedBundleSha256)
                throw new InvalidOperationException("bundle_digest_changed_after_fetch");
#if GIT_IMPORT_FIXTURE
            graphProfile?.AssertUnchanged();
#endif
            // Job drain covers this child tree, but the source/slot and loader
            // graph lack installed protected custody. Keep effects uncertain.
            return new ImportOutcome(true, "fixture_imported_host_custody_unproven", null, true, true,
                imported, bundleSha, commands);
        }
        catch (Exception ex)
        {
            // Preserve every partial mirror and report uncertainty. No retry or
            // recursive cleanup is part of this component.
            bool unknown = mirrorMayExist || ex is GitCommandException;
            return new ImportOutcome(false,
                unknown ? "preserve_unknown_effects" : "refused_before_effect",
                ex.Message, mirrorMayExist, unknown, imported, bundleSha, commands);
        }
    }

    internal static void ValidateSlot(ImportSlot slot)
    {
        if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("windows_only");
        if (!Commit.IsMatch(slot.PinnedCommit) || !Digest.IsMatch(slot.ExpectedBundleSha256))
            throw new InvalidOperationException("invalid_pin_or_bundle_digest");
        var root = Path.GetFullPath(slot.Root).TrimEnd(Path.DirectorySeparatorChar);
        if (!Path.IsPathFullyQualified(root) || !Directory.Exists(root))
            throw new InvalidOperationException("slot_root_missing");
        if (File.GetAttributes(root).HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidOperationException("root_reparse_point");
        foreach (var (path, kind) in new[] {
            (slot.Bundle, "file"), (slot.Mirror, "mirror"),
            (slot.EmptyHooks, "directory"), (slot.EmptyTemplate, "directory"),
            (slot.Home, "directory"), (slot.Temp, "directory") })
        {
            var full = Path.GetFullPath(path);
            if (!StringComparer.OrdinalIgnoreCase.Equals(Path.GetDirectoryName(full), root))
                throw new InvalidOperationException("slot_path_not_direct_child");
            if (kind == "file" && !File.Exists(full)) throw new InvalidOperationException("bundle_missing");
            if (kind == "directory" && !Directory.Exists(full))
                throw new InvalidOperationException("slot_directory_missing");
            if (kind != "mirror" && File.GetAttributes(full).HasFlag(FileAttributes.ReparsePoint))
                throw new InvalidOperationException("slot_reparse_point");
        }
        if (Directory.EnumerateFileSystemEntries(slot.EmptyHooks).Any() ||
            Directory.EnumerateFileSystemEntries(slot.EmptyTemplate).Any())
            throw new InvalidOperationException("hook_or_template_directory_not_empty");
    }

    internal static void AssertMirrorState(ImportSlot slot)
    {
        if (File.Exists(Path.Combine(slot.Mirror, "index")) ||
            File.Exists(Path.Combine(slot.Mirror, "info", "attributes")))
            throw new InvalidOperationException("mirror_inherited_local_git_state");
        var hooks = Path.Combine(slot.Mirror, "hooks");
        if (Directory.Exists(hooks) && Directory.EnumerateFileSystemEntries(hooks).Any())
            throw new InvalidOperationException("mirror_hooks_not_empty");
        var config = File.ReadAllText(Path.Combine(slot.Mirror, "config"));
        foreach (var key in new[] { "filter", "fsmonitor", "hooksPath", "include" })
            if (config.Contains(key, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("mirror_config_has_execution_setting");
    }

    internal static Dictionary<string, string> ConstructEnvironment(ImportSlot slot
#if GIT_IMPORT_FIXTURE
        , GraphSelectedGitProfile? graphProfile = null
#endif
        )
    {
        var windows = QueryWindowsPath(GetSystemWindowsDirectory);
        var system = QueryWindowsPath(GetSystemDirectory);
        if (!Path.IsPathFullyQualified(windows) ||
            !Path.IsPathFullyQualified(system) ||
            !StringComparer.OrdinalIgnoreCase.Equals(
                Path.GetFullPath(Path.Combine(windows, "System32")), system) ||
            !Directory.Exists(windows) || !Directory.Exists(system) ||
            !File.Exists(Path.Combine(system, "cmd.exe")))
            throw new InvalidOperationException("os_windows_root_unusable");
        var gitBin = GitBin;
#if !GIT_HOSTED_2022_FIXTURE
        var gitExecPath = GitExecPath;
#endif
#if GIT_IMPORT_FIXTURE
        if (graphProfile is not null)
        {
            gitBin = graphProfile.GitBin;
#if !GIT_HOSTED_2022_FIXTURE
            gitExecPath = graphProfile.GitExecPath;
#endif
        }
#endif
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["SystemRoot"] = windows, ["WINDIR"] = windows,
            ["COMSPEC"] = Path.Combine(system, "cmd.exe"),
            ["PATH"] = gitBin + ";" + system + ";" + windows,
            ["PATHEXT"] = ".COM;.EXE;.BAT;.CMD",
            ["HOME"] = slot.Home, ["USERPROFILE"] = slot.Home,
            ["APPDATA"] = slot.Home, ["LOCALAPPDATA"] = slot.Home,
            ["TEMP"] = slot.Temp, ["TMP"] = slot.Temp,
            ["GIT_CONFIG_NOSYSTEM"] = "1", ["GIT_CONFIG_GLOBAL"] = "NUL",
            ["GIT_CONFIG_SYSTEM"] = "NUL", ["GIT_ATTR_NOSYSTEM"] = "1",
            ["GIT_TEMPLATE_DIR"] = slot.EmptyTemplate,
            ["GIT_TERMINAL_PROMPT"] = "0", ["GCM_INTERACTIVE"] = "Never",
            ["GIT_OPTIONAL_LOCKS"] = "0", ["GIT_LFS_SKIP_SMUDGE"] = "1"
        };
#if !GIT_HOSTED_2022_FIXTURE
        environment["GIT_EXEC_PATH"] = gitExecPath;
#endif
        return environment;
    }

    private delegate uint WindowsPathApi(StringBuilder buffer, uint capacity);

    private static string QueryWindowsPath(WindowsPathApi api)
    {
        var buffer = new StringBuilder(32768);
        var length = api(buffer, (uint)buffer.Capacity);
        if (length == 0 || length >= buffer.Capacity)
            throw new InvalidOperationException("os_windows_root_query_failed");
        var path = buffer.ToString();
        if (path.Length != length || path.IndexOf('\0') >= 0)
            throw new InvalidOperationException("os_windows_root_query_malformed");
        return path;
    }

    [DllImport("kernel32.dll", EntryPoint = "GetSystemWindowsDirectoryW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetSystemWindowsDirectory(StringBuilder buffer, uint capacity);

    [DllImport("kernel32.dll", EntryPoint = "GetSystemDirectoryW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetSystemDirectory(StringBuilder buffer, uint capacity);

    internal static async Task<CommandRecord> Run(string phase, string cwd, string[] argv,
        IReadOnlyDictionary<string, string> env, List<CommandRecord> records, CancellationToken token
#if GIT_IMPORT_FIXTURE
        , GraphSelectedGitProfile? graphProfile = null
#endif
        )
    {
#if GIT_HOSTED_2022_FIXTURE
        var manualProfile = ManualEtwGitProfile.CreateHostedFixture(env, HostedGitImageSha256);
        env = manualProfile.Environment;
#endif
        var record = await BoundedGitChild.RunAsync(phase, cwd, argv, env, token
#if GIT_IMPORT_FIXTURE
            , graphProfile
#if GIT_HOSTED_2022_FIXTURE
            , manualProfile
#endif
#endif
            );
        records.Add(record);
        if (record.TimedOut || record.Canceled || record.OutputExceeded || !record.StreamsCompleted ||
            !record.ProcessExited || !record.JobAssignedAtCreation ||
            !record.TerminalJobDrained || !record.DescendantCleanupProven ||
            record.ExitCode != 0 || record.Error is not null)
            throw new GitCommandException("git_" + phase + "_failed");
        return record;
    }

    internal static async Task<string> HashFile(string path, CancellationToken token)
    {
        await using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, token)).ToLowerInvariant();
    }
}

internal sealed class GitCommandException(string message) : Exception(message);
