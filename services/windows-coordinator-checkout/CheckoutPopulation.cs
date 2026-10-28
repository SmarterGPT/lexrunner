using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace LexRunner.WindowsCoordinator.Git;

// Deliberately narrow source fixture. The caller supplies the slot and graph;
// none is authenticated installed custody or an Attempt execution grant.
internal sealed record CheckoutFileObservation(string Path, long Bytes,
    string GitObjectId, string Sha256, string NativeIdentity, string OwnerAndDacl);
internal sealed record CheckoutCommandObservation(string Phase, int? ExitCode,
    bool JobAssignedAtCreation, bool TerminalJobDrained,
    bool DescendantCleanupProven, string HeldImageSha256,
    string ConfiguredGitExecPath, int StdoutBytes, int StderrBytes);
internal sealed record CheckoutReport(bool Populated, string Disposition,
    string? Error, bool StageMayContainTrackedFiles, bool UnknownEffects,
    string? PinnedCommit, string? StageIdentity,
    IReadOnlyList<CheckoutFileObservation> Files,
    IReadOnlyList<CheckoutCommandObservation> Commands);
internal sealed record TreeMember(string Path, string ObjectId, long Bytes);

internal static class CheckoutPopulation
{
    private const int MaxFiles = 32;
    private const int MaxObservedEntries = 512;
    private const int MaxPathBytes = 160;
    private const int MaxFileBytes = 8192;
    private const long MaxTotalBytes = 65536;
    private static readonly StringComparer PathComparer = StringComparer.OrdinalIgnoreCase;

    internal static async Task<CheckoutReport> RunAsync(ImportSlot slot, string stage,
        GraphSelectedGitProfile profile, CancellationToken token)
    {
        var commands = new List<CommandRecord>();
        var stageMayExist = false;
        string? stageIdentity = null;
        var files = new List<CheckoutFileObservation>();
        try
        {
            RequireStageSlot(slot, stage, mustExist: false);
            profile.AssertUnchanged();
            var imported = await GitBundleImport.ImportAsync(slot, token, profile);
            commands.AddRange(imported.Commands);
            if (!imported.Imported)
                return new CheckoutReport(false, imported.Disposition, imported.Error,
                    false, imported.UnknownEffects, slot.PinnedCommit, null, files,
                    Summaries(commands));
            var env = GitBundleImport.ConstructEnvironment(slot, profile);
            var safe = SafeOptions(slot);
            var tree = await ReadTree(slot, profile, env, safe, commands, token);
            GitBundleImport.AssertMirrorState(slot);
            if (GitWorktreeStage.EntryExists(stage))
                throw new InvalidOperationException("checkout_stage_occupied_before_git");
            stageMayExist = true;
            await Run("checkout-stage-add", slot.Mirror,
                safe.Concat(new[] { "worktree", "add", "--no-checkout", "--detach",
                    stage, "refs/heads/imported" }).ToArray(), slot, profile, env, commands, token);
            GitWorktreeStage.CheckStageEntry(slot, stage);
            RequireOnlyGitPointer(stage);
            using var held = HeldCheckout.Open(slot.Root, slot.Mirror, stage);
            stageIdentity = held.StageIdentity;
            await RequireStageRegistration(slot, stage, profile, env, safe, commands, token);
            held.AssertUnchanged();
            // The index change and content materialization are separate journal
            // boundaries. Any lost reply after either preserves unknown effects.
            await Run("checkout-index-prepare", stage,
                safe.Concat(new[] { "read-tree", "--reset", slot.PinnedCommit }).ToArray(),
                slot, profile, env, commands, token);
            held.AssertUnchanged();
            await Run("checkout-populate", stage,
                safe.Concat(new[] { "checkout-index", "--all", "--force" }).ToArray(),
                slot, profile, env, commands, token);
            held.AssertUnchanged();
            files.AddRange(ObserveFiles(stage, tree));
            await RequireStageRegistration(slot, stage, profile, env, safe, commands, token);
            GitBundleImport.AssertMirrorState(slot);
            if (await GitBundleImport.HashFile(slot.Bundle, token) != slot.ExpectedBundleSha256)
                throw new InvalidOperationException("checkout_bundle_changed");
            profile.AssertUnchanged();
            held.AssertUnchanged();
            return new CheckoutReport(true, "fixture_populated_installed_custody_unproven",
                null, true, true, slot.PinnedCommit, stageIdentity, files,
                Summaries(commands));
        }
        catch (Exception error)
        {
            // Never delete, retry or call this no_effect after a Git boundary.
            return new CheckoutReport(false, stageMayExist ? "preserve_unknown_effects" :
                "refused_before_checkout_stage", error.GetType().Name + ":" + error.Message,
                stageMayExist, true, slot.PinnedCommit, stageIdentity, files,
                Summaries(commands));
        }
    }

    internal static async Task<CheckoutReport> ObserveAsync(ImportSlot slot, string stage,
        GraphSelectedGitProfile profile, CancellationToken token)
    {
        var commands = new List<CommandRecord>();
        try
        {
            GitBundleImport.ValidateSlot(slot);
            RequireStageSlot(slot, stage, mustExist: true);
            if (await GitBundleImport.HashFile(slot.Bundle, token) != slot.ExpectedBundleSha256)
                throw new InvalidDataException("checkout_bundle_changed");
            GitWorktreeStage.CheckStageEntry(slot, stage);
            using var held = HeldCheckout.Open(slot.Root, slot.Mirror, stage);
            var env = GitBundleImport.ConstructEnvironment(slot, profile);
            var safe = SafeOptions(slot);
            var tree = await ReadTree(slot, profile, env, safe, commands, token);
            var files = ObserveFiles(stage, tree);
            await RequireStageRegistration(slot, stage, profile, env, safe, commands, token);
            GitBundleImport.AssertMirrorState(slot);
            if (await GitBundleImport.HashFile(slot.Bundle, token) != slot.ExpectedBundleSha256)
                throw new InvalidDataException("checkout_bundle_changed");
            held.AssertUnchanged();
            profile.AssertUnchanged();
            return new CheckoutReport(true, "fixture_observed_exact_no_replay_authority", null,
                true, true, slot.PinnedCommit, held.StageIdentity, files,
                Summaries(commands));
        }
        catch (Exception error)
        {
            return new CheckoutReport(false, "preserve_unknown_effects",
                error.GetType().Name + ":" + error.Message, true, true,
                slot.PinnedCommit, null, [], Summaries(commands));
        }
    }

    private static async Task<IReadOnlyList<TreeMember>> ReadTree(ImportSlot slot,
        GraphSelectedGitProfile profile, IReadOnlyDictionary<string, string> env,
        string[] safe, List<CommandRecord> commands, CancellationToken token)
    {
        var result = await Run("checkout-tree-preflight", slot.Mirror,
            safe.Concat(new[] { "ls-tree", "-r", "-l", "-z", "--full-tree",
                slot.PinnedCommit }).ToArray(), slot, profile, env, commands, token);
        if (!result.Stdout.EndsWith('\0') || result.Stdout.Contains('\uFFFD'))
            throw new InvalidDataException("checkout_tree_output_not_exact_ascii");
        var rows = result.Stdout.Split('\0', StringSplitOptions.RemoveEmptyEntries);
        if (rows.Length is < 1 or > MaxFiles)
            throw new InvalidDataException("checkout_tree_entry_limit");
        var members = new List<TreeMember>(rows.Length);
        var seen = new HashSet<string>(PathComparer);
        long total = 0;
        foreach (var row in rows)
        {
            var tab = row.IndexOf('\t');
            if (tab < 1 || row.LastIndexOf('\t') != tab)
                throw new InvalidDataException("checkout_tree_row_malformed");
            var fields = row[..tab].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length != 4 || fields[0] != "100644" || fields[1] != "blob" ||
                !ObjectId(fields[2]) || !long.TryParse(fields[3], NumberStyles.None,
                    CultureInfo.InvariantCulture, out var size) || size is < 1 or > MaxFileBytes)
                throw new InvalidDataException("checkout_tree_mode_or_size_refused");
            var relative = row[(tab + 1)..];
            RequireRelativePath(relative);
            if (!seen.Add(relative)) throw new InvalidDataException("checkout_tree_case_collision");
            total = checked(total + size);
            if (total > MaxTotalBytes) throw new InvalidDataException("checkout_tree_byte_limit");
            members.Add(new TreeMember(relative, fields[2], size));
        }
        foreach (var member in members)
            if (members.Any(other => !PathComparer.Equals(member.Path, other.Path) &&
                other.Path.StartsWith(member.Path + "/", StringComparison.OrdinalIgnoreCase)))
                throw new InvalidDataException("checkout_tree_file_directory_collision");
        return members;
    }

    private static IReadOnlyList<CheckoutFileObservation> ObserveFiles(string stage,
        IReadOnlyList<TreeMember> tree)
    {
        var expected = new HashSet<string>(tree.Select(member => member.Path), PathComparer);
        var observed = new HashSet<string>(PathComparer);
        var files = new List<CheckoutFileObservation>(tree.Count);
        var stack = new Stack<(string Directory, string Relative)>();
        stack.Push((stage, ""));
        var visited = 0;
        while (stack.Count > 0)
        {
            var (directory, prefix) = stack.Pop();
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
            {
                if (++visited > MaxObservedEntries)
                    throw new InvalidDataException("checkout_output_entry_budget");
                var name = Path.GetFileName(entry);
                if (prefix.Length == 0 && name == ".git") continue;
                if (File.GetAttributes(entry).HasFlag(FileAttributes.ReparsePoint))
                    throw new InvalidDataException("checkout_output_reparse");
                var relative = prefix.Length == 0 ? name : prefix + "/" + name;
                RequireRelativePath(relative);
                if (Directory.Exists(entry))
                {
                    if (!expected.Any(path => path.StartsWith(relative + "/",
                            StringComparison.OrdinalIgnoreCase)))
                        throw new InvalidDataException("checkout_output_unlisted_directory");
                    stack.Push((entry, relative));
                    continue;
                }
                if (!File.Exists(entry) || !expected.Contains(relative) || !observed.Add(relative))
                    throw new InvalidDataException("checkout_output_unlisted_or_duplicate");
                var member = tree.Single(value => PathComparer.Equals(value.Path, relative));
                using var held = HeldCheckout.OpenFile(entry);
                var bytes = held.ReadBounded(MaxFileBytes);
                if (bytes.Length != member.Bytes || !StringComparer.Ordinal.Equals(
                    HashGitBlob(bytes, member.ObjectId.Length), member.ObjectId))
                    throw new InvalidDataException("checkout_output_blob_mismatch");
                files.Add(new CheckoutFileObservation(relative, bytes.Length,
                    member.ObjectId, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
                    held.Identity, held.OwnerAndDacl));
            }
        }
        if (observed.Count != expected.Count)
            throw new InvalidDataException("checkout_output_missing");
        return files.OrderBy(file => file.Path, StringComparer.Ordinal).ToArray();
    }

    private static string HashGitBlob(byte[] bytes, int oidLength)
    {
        var header = Encoding.ASCII.GetBytes("blob " + bytes.Length.ToString(CultureInfo.InvariantCulture) + "\0");
        var input = new byte[header.Length + bytes.Length];
        Buffer.BlockCopy(header, 0, input, 0, header.Length);
        Buffer.BlockCopy(bytes, 0, input, header.Length, bytes.Length);
        var digest = oidLength == 40 ? SHA1.HashData(input) : SHA256.HashData(input);
        return Convert.ToHexString(digest).ToLowerInvariant();
    }

    private static async Task RequireStageRegistration(ImportSlot slot, string stage,
        GraphSelectedGitProfile profile, IReadOnlyDictionary<string, string> env,
        string[] safe, List<CommandRecord> commands, CancellationToken token)
    {
        var head = await Run("checkout-stage-head", stage,
            safe.Concat(new[] { "rev-parse", "--verify", "HEAD^{commit}" }).ToArray(),
            slot, profile, env, commands, token);
        if (head.Stdout.Trim() != slot.PinnedCommit)
            throw new InvalidDataException("checkout_stage_head_mismatch");
        var inventory = await Run("checkout-registration", slot.Mirror,
            safe.Concat(new[] { "worktree", "list", "--porcelain" }).ToArray(),
            slot, profile, env, commands, token);
        if (!GitWorktreeStage.InventoryHasStage(inventory.Stdout, slot.Mirror, stage,
            slot.PinnedCommit))
            throw new InvalidDataException("checkout_stage_registration_mismatch");
        GitWorktreeStage.CheckStageEntry(slot, stage);
    }

    private static Task<CommandRecord> Run(string phase, string cwd, string[] argv,
        ImportSlot slot, GraphSelectedGitProfile profile,
        IReadOnlyDictionary<string, string> env, List<CommandRecord> records,
        CancellationToken token) => GitBundleImport.Run(phase, cwd, argv, env,
            records, token, profile);

    private static IReadOnlyList<CheckoutCommandObservation> Summaries(
        IEnumerable<CommandRecord> commands) => commands.Select(record =>
            new CheckoutCommandObservation(record.Phase, record.ExitCode,
                record.JobAssignedAtCreation, record.TerminalJobDrained,
                record.DescendantCleanupProven, record.HeldImageSha256,
                record.ConfiguredGitExecPath, record.StdoutBytes,
                record.StderrBytes)).ToArray();

    private static string[] SafeOptions(ImportSlot slot) =>
    [
        "-c", "core.hooksPath=" + slot.EmptyHooks.Replace('\\', '/'),
        "-c", "core.fsmonitor=false", "-c", "gc.auto=0",
        "-c", "protocol.file.allow=never", "-c", "core.autocrlf=false",
        "-c", "core.safecrlf=true", "-c", "core.protectNTFS=true",
        "-c", "core.symlinks=false"
    ];

    private static void RequireStageSlot(ImportSlot slot, string stage, bool mustExist)
    {
        GitBundleImport.ValidateSlot(slot);
        var root = Path.GetFullPath(slot.Root).TrimEnd(Path.DirectorySeparatorChar);
        if (!Path.IsPathFullyQualified(stage) ||
            !StringComparer.Ordinal.Equals(Path.GetFullPath(stage), stage) ||
            !StringComparer.OrdinalIgnoreCase.Equals(Path.GetDirectoryName(stage), root) ||
            !GitWorktreeStage.Leaf.IsMatch(Path.GetFileName(stage)) ||
            (mustExist ? !Directory.Exists(stage) : GitWorktreeStage.EntryExists(stage)))
            throw new InvalidDataException("checkout_stage_slot_invalid_or_occupied");
    }

    private static void RequireOnlyGitPointer(string stage)
    {
        // Only one entry is permitted. Stop after the second one so a writer
        // cannot force an unbounded snapshot before this refusal.
        var entries = Directory.EnumerateFileSystemEntries(stage).Take(2).ToArray();
        if (entries.Length != 1 || Path.GetFileName(entries[0]) != ".git" ||
            !File.Exists(entries[0]) || File.GetAttributes(entries[0]).HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidDataException("checkout_stage_not_empty");
    }

    private static bool ObjectId(string value) =>
        (value.Length == 40 || value.Length == 64) && value.All(character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static void RequireRelativePath(string value)
    {
        if (value.Length is < 1 or > MaxPathBytes || !value.All(character =>
            character is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or
                '.' or '_' or '-' or '/') || value.Contains('\\') || value.Contains(':') ||
            value.Contains('~'))
            throw new InvalidDataException("checkout_tree_path_invalid");
        var parts = value.Split('/');
        if (parts.Length > 8)
            throw new InvalidDataException("checkout_tree_depth_limit");
        foreach (var part in parts)
        {
            if (part.Length is < 1 or > 80 || !char.IsAsciiLetterOrDigit(part[0]) ||
                part.EndsWith('.') || part.EndsWith(' ') ||
                part.Equals(".git", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("checkout_tree_component_invalid");
            var basename = part.Split('.')[0];
            if (new[] { "CON", "PRN", "AUX", "NUL" }.Contains(basename,
                    StringComparer.OrdinalIgnoreCase) ||
                (basename.Length == 4 && (basename.StartsWith("COM", StringComparison.OrdinalIgnoreCase) ||
                    basename.StartsWith("LPT", StringComparison.OrdinalIgnoreCase)) &&
                    basename[3] is >= '1' and <= '9'))
                throw new InvalidDataException("checkout_tree_device_name");
        }
    }
}
