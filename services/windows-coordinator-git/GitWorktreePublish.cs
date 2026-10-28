#if GIT_IMPORT_FIXTURE
namespace LexRunner.WindowsCoordinator.Git;

// Source-only continuation from a checked stage. No protected final parent,
// journal or service token is present; even success remains effect-unknown.
internal sealed record PublishOutcome(bool Published, string Disposition,
    string? Error, bool UnknownEffects, string? FinalHead,
    NativeMoveObservation? Move, IReadOnlyList<CommandRecord> Commands);

internal static class GitWorktreePublish
{
    internal static async Task<PublishOutcome> PublishAsync(ImportSlot slot,
        string stage, string finalParent, string finalLeaf, CancellationToken token)
    {
        var commands = new List<CommandRecord>();
        NativeMoveObservation? move = null;
        string? finalHead = null;
        try
        {
            RequireNonceFixtureRoot(slot.Root);
            GitBundleImport.ValidateSlot(slot);
            var root = Path.GetFullPath(slot.Root).TrimEnd(Path.DirectorySeparatorChar);
            if (!DirectChild(stage, root) || !GitWorktreeStage.Leaf.IsMatch(Path.GetFileName(stage)) ||
                !Directory.Exists(stage))
                throw new InvalidOperationException("publish_stage_invalid");
            if (!DirectChild(finalParent, root) ||
                !GitWorktreeStage.Leaf.IsMatch(Path.GetFileName(finalParent)) ||
                !Directory.Exists(finalParent) ||
                File.GetAttributes(finalParent).HasFlag(FileAttributes.ReparsePoint) ||
                !GitWorktreeStage.Leaf.IsMatch(finalLeaf))
                throw new InvalidOperationException("publish_parent_or_leaf_invalid");
            var final = Path.Combine(finalParent, finalLeaf);
            if (GitWorktreeStage.EntryExists(final))
                throw new InvalidOperationException("publish_final_occupied_before_move");
            GitWorktreeStage.CheckStageEntry(slot, stage);
            GitBundleImport.AssertMirrorState(slot);
            if (await GitBundleImport.HashFile(slot.Bundle, token) != slot.ExpectedBundleSha256)
                throw new InvalidOperationException("bundle_digest_changed_before_publish");
            var env = GitBundleImport.ConstructEnvironment(slot);
            var safe = new[] { "-c", "core.hooksPath=" + slot.EmptyHooks.Replace('\\', '/'),
                "-c", "core.fsmonitor=false", "-c", "gc.auto=0",
                "-c", "protocol.file.allow=never" };
            var head = await GitBundleImport.Run("publish-stage-head", stage,
                safe.Concat(new[] { "rev-parse", "--verify", "HEAD^{commit}" }).ToArray(),
                env, commands, token);
            if (head.Stdout.Trim() != slot.PinnedCommit)
                throw new InvalidOperationException("publish_stage_pin_mismatch");
            var inventoryBefore = await GitBundleImport.Run("publish-inventory-before", slot.Mirror,
                safe.Concat(new[] { "worktree", "list", "--porcelain" }).ToArray(),
                env, commands, token);
            if (!GitWorktreeStage.InventoryHasStage(inventoryBefore.Stdout, slot.Mirror,
                    stage, slot.PinnedCommit))
                throw new InvalidOperationException("publish_stage_registration_mismatch");
            GitWorktreeStage.CheckStageEntry(slot, stage);
            if (GitWorktreeStage.EntryExists(final))
                throw new InvalidOperationException("publish_final_occupied_before_native");
            move = await NativeWorktreePublication.RenameNoReplaceHeldAsync(stage,
                finalParent, finalLeaf, async held =>
                {
                    move = held;
                    if (held.SourceIdentityBefore != held.SourceIdentityAfter ||
                        held.SourceIdentityBefore != held.FinalFreshIdentity ||
                        held.SourceParentIdentityBefore != held.SourceParentIdentityAfter ||
                        held.FinalParentIdentityBefore != held.FinalParentIdentityAfter ||
                        !ExactNativePath(held.SourceAfter, final) ||
                        GitWorktreeStage.EntryExists(stage))
                        throw new InvalidOperationException("native_publication_identity_mismatch");
                    GitWorktreeStage.CheckStageEntry(slot, final);
                    // Git retains the old stage path until this fixed repair.
                    // Native stage and parent handles remain held throughout.
                    await GitBundleImport.Run("publish-repair", slot.Mirror,
                        safe.Concat(new[] { "worktree", "repair", final }).ToArray(),
                        env, commands, token);
                    GitWorktreeStage.CheckStageEntry(slot, final);
                    var finalReadback = await GitBundleImport.Run("publish-final-head", final,
                        safe.Concat(new[] { "rev-parse", "--verify", "HEAD^{commit}" }).ToArray(),
                        env, commands, token);
                    finalHead = finalReadback.Stdout.Trim();
                    if (finalHead != slot.PinnedCommit)
                        throw new InvalidOperationException("publish_final_head_mismatch");
                    var inventoryAfter = await GitBundleImport.Run("publish-inventory-after",
                        slot.Mirror,
                        safe.Concat(new[] { "worktree", "list", "--porcelain" }).ToArray(),
                        env, commands, token);
                    if (!GitWorktreeStage.InventoryHasStage(inventoryAfter.Stdout,
                            slot.Mirror, final, slot.PinnedCommit))
                        throw new InvalidOperationException("publish_final_registration_mismatch");
                    GitWorktreeStage.CheckStageEntry(slot, final);
                    if (GitWorktreeStage.EntryExists(stage) ||
                        await GitBundleImport.HashFile(slot.Bundle, token) != slot.ExpectedBundleSha256)
                        throw new InvalidOperationException("publish_final_state_changed");
                }, token);
            if (!move.Moved)
                return new PublishOutcome(false, "native_no_replace_refused", move.NtStatus,
                    true, null, move, commands);
            if (move.SourceIdentityAfterRepair != move.SourceIdentityBefore ||
                move.SourceParentIdentityAfterRepair != move.SourceParentIdentityBefore ||
                move.FinalParentIdentityAfterRepair != move.FinalParentIdentityBefore ||
                move.FinalFreshIdentityAfterRepair != move.SourceIdentityBefore)
                throw new InvalidOperationException("post_repair_held_identity_mismatch");
            return new PublishOutcome(true, "fixture_published_host_custody_unproven",
                null, true, finalHead, move, commands);
        }
        catch (Exception ex)
        {
            // A native call can have moved the stage even when subsequent
            // readback fails. Retain the mirror, stage and/or final as found.
            return new PublishOutcome(false, "preserve_unknown_effects",
                ex.Message, true, finalHead, move, commands);
        }
    }

    private static bool DirectChild(string value, string root)
    {
        if (!Path.IsPathFullyQualified(value)) return false;
        var full = Path.GetFullPath(value);
        return StringComparer.Ordinal.Equals(full, value) &&
            StringComparer.OrdinalIgnoreCase.Equals(Path.GetDirectoryName(full), root);
    }

    private static void RequireNonceFixtureRoot(string rootValue)
    {
        var root = Path.GetFullPath(rootValue).TrimEnd(Path.DirectorySeparatorChar);
        var imageDirectory = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        var parent = Path.GetDirectoryName(root);
        var leaf = Path.GetFileName(root);
        if (!Path.IsPathFullyQualified(rootValue) ||
            !StringComparer.Ordinal.Equals(root, rootValue) ||
            !StringComparer.OrdinalIgnoreCase.Equals(Path.GetDirectoryName(imageDirectory), root) ||
            !StringComparer.Ordinal.Equals(Path.GetFileName(imageDirectory), "fixture-publish") ||
            !StringComparer.Ordinal.Equals(Path.GetFileName(parent), "tmp") ||
            !StringComparer.Ordinal.Equals(Path.GetFileName(Path.GetDirectoryName(parent)),
                "windows-coordinator-git") ||
            !leaf.StartsWith("import-", StringComparison.Ordinal) ||
            leaf.Length != 39 ||
            !System.Text.RegularExpressions.Regex.IsMatch(leaf[7..], "^[a-f0-9]{32}$"))
            throw new InvalidOperationException("publish_fixture_root_unavailable");
        var marker = Path.Combine(root, ".fixture-marker");
        using var stream = File.Open(marker, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length is < 32 or > 34)
            throw new InvalidOperationException("publish_fixture_marker_invalid");
        var bytes = new byte[checked((int)stream.Length)];
        stream.ReadExactly(bytes);
        if (stream.Length != bytes.Length ||
            System.Text.Encoding.UTF8.GetString(bytes).TrimEnd('\r', '\n') != leaf[7..])
            throw new InvalidOperationException("publish_fixture_marker_mismatch");
    }

    private static bool ExactNativePath(string observed, string expected)
    {
        if (!observed.StartsWith(@"\\?\", StringComparison.Ordinal)) return false;
        var withoutPrefix = observed[4..];
        return Path.IsPathFullyQualified(withoutPrefix) &&
            StringComparer.OrdinalIgnoreCase.Equals(Path.GetFullPath(withoutPrefix),
                Path.GetFullPath(expected));
    }
}
#endif
