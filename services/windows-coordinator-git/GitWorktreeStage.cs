using System.Text.RegularExpressions;
using System.Text;

namespace LexRunner.WindowsCoordinator.Git;

// Same-user source fixture only. A supplied mirror/slot is not protected
// custody, and even a matching readback cannot authorize an Attempt.
internal sealed record StageOutcome(bool Staged, string Disposition, string? Error,
    bool StageMayExist, bool UnknownEffects, string? StageHead,
    IReadOnlyList<CommandRecord> Commands);

internal static class GitWorktreeStage
{
    internal static readonly Regex Leaf = new("^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$",
        RegexOptions.CultureInvariant);

    internal static async Task<StageOutcome> StageAsync(ImportSlot slot, string stage,
        CancellationToken token)
    {
        var commands = new List<CommandRecord>();
        bool stageMayExist = false;
        string? stageHead = null;
        try
        {
            GitBundleImport.ValidateSlot(slot);
            var root = Path.GetFullPath(slot.Root).TrimEnd(Path.DirectorySeparatorChar);
            if (!Path.IsPathFullyQualified(stage) ||
                !StringComparer.OrdinalIgnoreCase.Equals(Path.GetDirectoryName(Path.GetFullPath(stage)), root) ||
                !StringComparer.Ordinal.Equals(Path.GetFullPath(stage), stage) ||
                !Leaf.IsMatch(Path.GetFileName(stage)) ||
                EntryExists(stage))
                throw new InvalidOperationException("stage_slot_invalid_or_occupied");
            if (!Directory.Exists(slot.Mirror) ||
                File.GetAttributes(slot.Mirror).HasFlag(FileAttributes.ReparsePoint))
                throw new InvalidOperationException("mirror_missing_or_reparse");
            if (await GitBundleImport.HashFile(slot.Bundle, token) != slot.ExpectedBundleSha256)
                throw new InvalidOperationException("bundle_digest_changed_before_stage");
            GitBundleImport.AssertMirrorState(slot);
            var env = GitBundleImport.ConstructEnvironment(slot);
            var safe = new[] { "-c", "core.hooksPath=" + slot.EmptyHooks.Replace('\\', '/'),
                "-c", "core.fsmonitor=false", "-c", "gc.auto=0",
                "-c", "protocol.file.allow=never" };
            var imported = await GitBundleImport.Run("stage-imported-head", slot.Mirror,
                safe.Concat(new[] { "rev-parse", "--verify", "refs/heads/imported^{commit}" }).ToArray(),
                env, commands, token);
            if (imported.Stdout.Trim() != slot.PinnedCommit)
                throw new InvalidOperationException("stage_mirror_pin_mismatch");
            var before = await GitBundleImport.Run("stage-inventory-before", slot.Mirror,
                safe.Concat(new[] { "worktree", "list", "--porcelain" }).ToArray(),
                env, commands, token);
            if (!InventoryHasOnlyMirror(before.Stdout, slot.Mirror))
                throw new InvalidOperationException("stage_mirror_has_other_worktrees");
            if (EntryExists(stage))
                throw new InvalidOperationException("stage_slot_occupied_before_git");
            stageMayExist = true; // Git can create the target before any failure.
            await GitBundleImport.Run("stage-add", slot.Mirror,
                safe.Concat(new[] { "worktree", "add", "--no-checkout", "--detach",
                    stage, "refs/heads/imported" }).ToArray(), env, commands, token);
            CheckStageEntry(slot, stage);
            var head = await GitBundleImport.Run("stage-head", stage,
                safe.Concat(new[] { "rev-parse", "--verify", "HEAD^{commit}" }).ToArray(),
                env, commands, token);
            stageHead = head.Stdout.Trim();
            if (stageHead != slot.PinnedCommit)
                throw new InvalidOperationException("stage_head_not_pin");
            var inventory = await GitBundleImport.Run("stage-inventory-after", slot.Mirror,
                safe.Concat(new[] { "worktree", "list", "--porcelain" }).ToArray(),
                env, commands, token);
            if (!InventoryHasStage(inventory.Stdout, slot.Mirror, stage, slot.PinnedCommit))
                throw new InvalidOperationException("stage_registration_not_exact");
            CheckStageEntry(slot, stage);
            if (await GitBundleImport.HashFile(slot.Bundle, token) != slot.ExpectedBundleSha256)
                throw new InvalidOperationException("bundle_digest_changed_after_stage");
            return new StageOutcome(true, "fixture_staged_host_custody_unproven", null,
                true, true, stageHead, commands);
        }
        catch (Exception ex)
        {
            // A failed Git call or any post-add mismatch can leave registration,
            // stage or descendants behind. Never retry or remove here.
            return new StageOutcome(false,
                stageMayExist ? "preserve_unknown_effects" : "refused_before_stage_effect",
                ex.Message, stageMayExist, true, stageHead, commands);
        }
    }

    internal static bool EntryExists(string path)
    {
        try { _ = File.GetAttributes(path); return true; }
        catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
    }

    internal static void CheckStageEntry(ImportSlot slot, string stage)
    {
        if (!Directory.Exists(stage) || File.GetAttributes(stage).HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidOperationException("stage_directory_missing_or_reparse");
        var dotGit = Path.Combine(stage, ".git");
        if (!File.Exists(dotGit) || File.GetAttributes(dotGit).HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidOperationException("stage_git_pointer_missing_or_reparse");
        using var pointer = File.Open(dotGit, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (pointer.Length is < 1 or > 4096)
            throw new InvalidOperationException("stage_git_pointer_size_invalid");
        var bytes = new byte[checked((int)pointer.Length)];
        pointer.ReadExactly(bytes);
        if (pointer.Length != bytes.Length)
            throw new InvalidOperationException("stage_git_pointer_changed");
        var text = new UTF8Encoding(false, true).GetString(bytes).Trim();
        if (!text.StartsWith("gitdir: ", StringComparison.Ordinal))
            throw new InvalidOperationException("stage_git_pointer_malformed");
        var target = text[8..].Replace('/', '\\');
        if (!Path.IsPathFullyQualified(target))
            throw new InvalidOperationException("stage_git_pointer_not_absolute");
        var worktrees = Path.GetFullPath(Path.Combine(slot.Mirror, "worktrees"));
        var parent = Path.GetDirectoryName(Path.GetFullPath(target));
        if (!StringComparer.OrdinalIgnoreCase.Equals(parent, worktrees) ||
            !Leaf.IsMatch(Path.GetFileName(target)))
            throw new InvalidOperationException("stage_git_pointer_outside_mirror");
    }

    private static bool InventoryHasOnlyMirror(string text, string mirror) =>
        ParseInventory(text) is var entries && entries.Count == 1 &&
        SamePath(entries[0].Path, mirror) && entries[0].Lines.Contains("bare");

    internal static bool InventoryHasStage(string text, string mirror, string stage, string pin)
    {
        var entries = ParseInventory(text);
        return entries.Count == 2 &&
            entries.Count(entry => SamePath(entry.Path, mirror) && entry.Lines.Contains("bare")) == 1 &&
            entries.Count(entry => SamePath(entry.Path, stage) &&
                entry.Lines.Contains("HEAD " + pin) && entry.Lines.Contains("detached") &&
                !entry.Lines.Any(line => line.StartsWith("prunable ", StringComparison.Ordinal) ||
                    line.StartsWith("locked ", StringComparison.Ordinal))) == 1;
    }

    private static List<(string Path, string[] Lines)> ParseInventory(string text)
    {
        var entries = new List<(string Path, string[] Lines)>();
        var blocks = text.Replace("\r\n", "\n", StringComparison.Ordinal).TrimEnd('\n').Split("\n\n");
        foreach (var block in blocks)
        {
            var lines = block.Split('\n');
            if (lines.Length < 2 || !lines[0].StartsWith("worktree ", StringComparison.Ordinal))
                return [];
            entries.Add((lines[0][9..], lines[1..]));
        }
        return entries;
    }

    private static bool SamePath(string observed, string expected)
    {
        var native = observed.Replace('/', '\\');
        return Path.IsPathFullyQualified(native) &&
            StringComparer.OrdinalIgnoreCase.Equals(Path.GetFullPath(native), Path.GetFullPath(expected));
    }
}
