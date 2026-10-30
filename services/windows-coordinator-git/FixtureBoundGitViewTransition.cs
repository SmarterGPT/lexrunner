#if GIT_IMPORT_FIXTURE
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace LexRunner.WindowsCoordinator.Git;

// Fixture-only effect bridge. The selected roots and stage identity are
// supplied comparison data. A protected store must durably select them before
// an installed service can call equivalent operations. No normal image route
// reaches this class, and no outcome grants an Attempt or a destructive retry.
internal sealed record BoundStageResult(bool Staged, string Disposition,
    string? Error, SelectedGitRoot? StageIdentity, StageOutcome? Native,
    bool UnknownEffects, bool AuthorizesExecution);
internal sealed record BoundPublishResult(bool Published, string Disposition,
    string? Error, SelectedGitRoot? FinalIdentity, PublishOutcome? Native,
    bool UnknownEffects, bool AuthorizesExecution);
internal sealed record BoundRemoveResult(bool Removed, string Disposition,
    string? Error, SelectedGitRoot? FinalIdentityAfter,
    IReadOnlyList<CommandRecord> Commands, bool UnknownEffects,
    bool AuthorizesExecution);
internal sealed record BoundRecoveryObservation(string Disposition,
    string? Error, SelectedGitRoot? StageIdentity,
    SelectedGitRoot? FinalIdentity, string? ObservedHead,
    IReadOnlyList<CommandRecord> Commands, bool UnknownEffects,
    bool AuthorizesContinuation, bool AuthorizesExecution);

internal static class FixtureBoundGitViewTransition
{
    internal static async Task<BoundStageResult> StageAsync(ImportSlot slot,
        SelectedGitRoots selected, string stageComponent,
        CancellationToken token)
    {
        bool stageMayExist = false;
        try
        {
            using var held = HeldSelectedGitRoots.Acquire(selected);
            RequireSlot(slot, selected);
            using var marker = RequireDisposableFixture(slot, selected);
            var stage = held.StagePath(stageComponent);
            if (held.ObserveStage(stageComponent) is not null)
                throw new InvalidDataException("selected_stage_occupied");
            held.AssertCurrent();
            // The caller's durable intent must precede this boundary. The
            // fixture cannot attest that an installed protected store did so.
            stageMayExist = true;
            var native = await GitWorktreeStage.StageAsync(slot, stage, token);
            held.AssertCurrent();
            var identity = held.ObserveStage(stageComponent);
            if (!native.Staged || identity is null)
                return new BoundStageResult(false, "preserve_unknown_effects",
                    native.Error ?? "selected_stage_missing_after_git", identity,
                    native, true, false);
            return new BoundStageResult(true,
                "fixture_stage_selected_installed_custody_unproven", null,
                identity, native, true, false);
        }
        catch (Exception error)
        {
            return new BoundStageResult(false, stageMayExist ?
                "preserve_unknown_effects" : "selected_stage_refused_before_git",
                error.GetType().Name + ":" + error.Message, null, null,
                true, false);
        }
    }

    internal static async Task<BoundPublishResult> PublishAsync(ImportSlot slot,
        SelectedGitRoots selected, string stageComponent,
        SelectedGitRoot selectedStage, string finalComponent,
        CancellationToken token)
    {
        bool moveMayHaveEffect = false;
        try
        {
            using var held = HeldSelectedGitRoots.Acquire(selected);
            RequireSlot(slot, selected);
            using var marker = RequireDisposableFixture(slot, selected);
            var stage = held.StagePath(stageComponent);
            var final = held.FinalPath(finalComponent);
            if (held.ObserveStage(stageComponent) != selectedStage ||
                held.ObserveFinal(finalComponent) is not null)
                throw new InvalidDataException("selected_publish_leaf_mismatch");
            held.AssertCurrent();
            // The selected stage identity must be a durable prior effect row,
            // never a fresh observation promoted at this point.
            moveMayHaveEffect = true;
            var native = await GitWorktreePublish.PublishAsync(slot, stage,
                selected.FinalParent.Path, finalComponent, token);
            held.AssertCurrent();
            var finalIdentity = held.ObserveFinal(finalComponent);
            if (!native.Published || finalIdentity is null ||
                !SameObject(finalIdentity, selectedStage) ||
                held.ObserveStage(stageComponent) is not null)
                return new BoundPublishResult(false, "preserve_unknown_effects",
                    native.Error ?? "selected_publish_identity_mismatch",
                    finalIdentity, native, true, false);
            return new BoundPublishResult(true,
                "fixture_published_installed_custody_unproven", null,
                finalIdentity, native, true, false);
        }
        catch (Exception error)
        {
            return new BoundPublishResult(false, moveMayHaveEffect ?
                "preserve_unknown_effects" : "selected_publish_refused_before_move",
                error.GetType().Name + ":" + error.Message, null, null,
                true, false);
        }
    }

    internal static async Task<BoundRecoveryObservation> ObserveAsync(
        ImportSlot slot, SelectedGitRoots selected, string stageComponent,
        string finalComponent, CancellationToken token)
    {
        var commands = new List<CommandRecord>();
        SelectedGitRoot? stage = null, final = null;
        try
        {
            using var held = HeldSelectedGitRoots.Acquire(selected);
            RequireSlot(slot, selected);
            using var marker = RequireDisposableFixture(slot, selected);
            stage = held.ObserveStage(stageComponent);
            final = held.ObserveFinal(finalComponent);
            if (stage is not null && final is not null)
                throw new InvalidDataException("selected_recovery_two_leaves");
            GitBundleImport.ValidateSlot(slot);
            GitBundleImport.AssertMirrorState(slot);
            var env = GitBundleImport.ConstructEnvironment(slot);
            var safe = new[] { "-c", "core.hooksPath=" +
                slot.EmptyHooks.Replace('\\', '/'), "-c", "core.fsmonitor=false",
                "-c", "gc.auto=0", "-c", "protocol.file.allow=never" };
            var inventory = await GitBundleImport.Run("selected-recovery-inventory",
                slot.Mirror, safe.Concat(new[] { "worktree", "list",
                    "--porcelain" }).ToArray(), env, commands, token);
            held.AssertCurrent();
            var present = stage ?? final;
            if (present is null)
                return new BoundRecoveryObservation("absent_or_unlisted_unresolved",
                    null, null, null, null, commands, true, false, false);
            var path = stage is not null ? held.StagePath(stageComponent) :
                held.FinalPath(finalComponent);
            GitWorktreeStage.CheckStageEntry(slot, path);
            var head = await GitBundleImport.Run("selected-recovery-head", path,
                safe.Concat(new[] { "rev-parse", "--verify", "HEAD^{commit}" }).ToArray(),
                env, commands, token);
            held.AssertCurrent();
            if (head.Stdout.Trim() != slot.PinnedCommit ||
                !GitWorktreeStage.InventoryHasStage(inventory.Stdout, slot.Mirror,
                    path, slot.PinnedCommit) ||
                (stage is not null ? held.ObserveStage(stageComponent) != stage :
                    held.ObserveFinal(finalComponent) != final))
                throw new InvalidDataException("selected_recovery_registration_or_pin_mismatch");
            return new BoundRecoveryObservation(stage is not null ?
                "stage_observed_unresolved" : "final_observed_unresolved",
                null, stage, final, slot.PinnedCommit, commands, true, false,
                false);
        }
        catch (Exception error)
        {
            return new BoundRecoveryObservation("preserve_unknown_effects",
                error.GetType().Name + ":" + error.Message, stage, final,
                null, commands, true, false, false);
        }
    }

    // Only a coordinator-owned, no-checkout Git view containing the single
    // .git pointer is in scope. A separate worker private view is never passed
    // here. This fixture cannot prove cross-account exclusion, trusted intent,
    // loader custody, or a same-user-safe release/delete interval.
    internal static async Task<BoundRemoveResult> RemoveAsync(ImportSlot slot,
        SelectedGitRoots selected, string stageComponent,
        string finalComponent, BoundPublishResult issuedPublish,
        CancellationToken token)
    {
        var commands = new List<CommandRecord>();
        bool removalMayHaveEffect = false;
        try
        {
            using var held = HeldSelectedGitRoots.Acquire(selected);
            RequireSlot(slot, selected);
            using var marker = RequireDisposableFixture(slot, selected);
            var final = held.FinalPath(finalComponent);
            if (!issuedPublish.Published || issuedPublish.FinalIdentity is null)
                throw new InvalidDataException("selected_remove_issued_publish_missing");
            var selectedFinal = issuedPublish.FinalIdentity;
            if (selectedFinal.Path != final ||
                held.ObserveFinal(finalComponent) != selectedFinal ||
                held.ObserveStage(stageComponent) is not null)
                throw new InvalidDataException("selected_remove_leaf_mismatch");
            GitWorktreeStage.CheckStageEntry(slot, final);
            var contents = Directory.EnumerateFileSystemEntries(final).Take(2).ToArray();
            if (contents.Length != 1 || Path.GetFileName(contents[0]) != ".git" ||
                !File.Exists(contents[0]) ||
                File.GetAttributes(contents[0]).HasFlag(FileAttributes.ReparsePoint))
                throw new InvalidDataException("selected_remove_nonempty_or_reparse");
            GitBundleImport.ValidateSlot(slot);
            GitBundleImport.AssertMirrorState(slot);
            var env = GitBundleImport.ConstructEnvironment(slot);
            var safe = new[] { "-c", "core.hooksPath=" +
                slot.EmptyHooks.Replace('\\', '/'), "-c", "core.fsmonitor=false",
                "-c", "gc.auto=0", "-c", "protocol.file.allow=never" };
            var head = await GitBundleImport.Run("selected-remove-head", final,
                safe.Concat(new[] { "rev-parse", "--verify", "HEAD^{commit}" }).ToArray(),
                env, commands, token);
            var inventory = await GitBundleImport.Run("selected-remove-inventory",
                slot.Mirror, safe.Concat(new[] { "worktree", "list",
                    "--porcelain" }).ToArray(), env, commands, token);
            if (head.Stdout.Trim() != slot.PinnedCommit ||
                !GitWorktreeStage.InventoryHasStage(inventory.Stdout, slot.Mirror,
                    final, slot.PinnedCommit) ||
                held.ObserveFinal(finalComponent) != selectedFinal)
                throw new InvalidDataException("selected_remove_registration_or_pin_mismatch");
            held.AssertCurrent();
            // The future protected coordinator must durably record a one-shot
            // intent before this exact command. A lost reply is unresolved.
            removalMayHaveEffect = true;
            await GitBundleImport.Run("selected-remove-once", slot.Mirror,
                safe.Concat(new[] { "worktree", "remove", "--force", final }).ToArray(),
                env, commands, token);
            held.AssertCurrent();
            var after = held.ObserveFinal(finalComponent);
            var inventoryAfter = await GitBundleImport.Run("selected-remove-inventory-after",
                slot.Mirror, safe.Concat(new[] { "worktree", "list",
                    "--porcelain" }).ToArray(), env, commands, token);
            if (after is not null || !OnlyBareMirror(inventoryAfter.Stdout, slot.Mirror) ||
                Directory.EnumerateFileSystemEntries(selected.RegistrationParent.Path).Any())
                throw new InvalidDataException("selected_remove_poststate_uncertain");
            held.AssertCurrent();
            return new BoundRemoveResult(true,
                "fixture_removed_installed_custody_unproven", null,
                null, commands, true, false);
        }
        catch (Exception error)
        {
            return new BoundRemoveResult(false, removalMayHaveEffect ?
                "preserve_unknown_effects" : "selected_remove_refused_before_git_effect",
                error.GetType().Name + ":" + error.Message,
                null, commands, true, false);
        }
    }

    private static bool OnlyBareMirror(string inventory, string mirror)
    {
        var lines = inventory.Replace("\r\n", "\n", StringComparison.Ordinal)
            .TrimEnd('\n').Split('\n');
        return lines.Length == 2 && lines[0].StartsWith("worktree ",
            StringComparison.Ordinal) &&
            StringComparer.OrdinalIgnoreCase.Equals(
                lines[0][9..].Replace('/', '\\'), mirror) &&
            lines[1] == "bare";
    }
    private static bool SameObject(SelectedGitRoot a, SelectedGitRoot b) =>
        a.VolumeSerialNumber == b.VolumeSerialNumber &&
        a.FileId == b.FileId && a.FileSystem == b.FileSystem;

    // An artifact fixture may only touch a disposable root that contains its
    // own running image. This is an accidental-target guard, never an
    // authenticated selection or a same-user containment claim. Keep the
    // marker open without write/delete sharing through the Git effect.
    private static FileStream RequireDisposableFixture(ImportSlot slot,
        SelectedGitRoots selected)
    {
        var marker = HoldDisposableFixtureRoot(slot.Root);
        try
        {
            if (!StringComparer.Ordinal.Equals(selected.StageParent.Path, slot.Root) ||
                !StringComparer.Ordinal.Equals(selected.FinalParent.Path,
                    Path.Combine(slot.Root, "final")) ||
                !StringComparer.Ordinal.Equals(selected.Mirror.Path,
                    Path.Combine(slot.Root, "mirror")))
                throw new InvalidDataException("selected_fixture_slot_not_disposable");
            return marker;
        }
        catch { marker.Dispose(); throw; }
    }

    internal static FileStream HoldDisposableFixtureRoot(string root)
    {
        var imageDirectory = AppContext.BaseDirectory.TrimEnd('\\');
        var parent = Path.GetDirectoryName(root);
        var nonce = Path.GetFileName(root);
        if (!Path.IsPathFullyQualified(root) || Path.GetFullPath(root) != root ||
            parent is null ||
            !StringComparer.OrdinalIgnoreCase.Equals(imageDirectory,
                Path.Combine(root, "fixture-publish")) ||
            !StringComparer.Ordinal.Equals(Path.GetFileName(parent), "tmp") ||
            !StringComparer.Ordinal.Equals(
                Path.GetFileName(Path.GetDirectoryName(parent)),
                "windows-coordinator-git") ||
            !Regex.IsMatch(nonce, "^import-[a-f0-9]{32}$",
                RegexOptions.CultureInvariant))
            throw new InvalidDataException("selected_fixture_root_not_disposable");
        var markerPath = Path.Combine(root, ".fixture-marker");
        if (File.GetAttributes(markerPath).HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidDataException("selected_fixture_marker_reparse");
        var marker = File.Open(markerPath, FileMode.Open, FileAccess.Read,
            FileShare.Read);
        try
        {
            if (marker.Length is < 32 or > 34)
                throw new InvalidDataException("selected_fixture_marker_length");
            var bytes = new byte[checked((int)marker.Length)];
            marker.ReadExactly(bytes);
            var value = new UTF8Encoding(false, true).GetString(bytes)
                .TrimEnd('\r', '\n');
            if (marker.Length != bytes.Length || value != nonce[7..])
                throw new InvalidDataException("selected_fixture_marker_mismatch");
            return marker;
        }
        catch { marker.Dispose(); throw; }
    }

    private static void RequireSlot(ImportSlot slot, SelectedGitRoots selected)
    {
        if (!StringComparer.Ordinal.Equals(slot.Root, selected.StageParent.Path) ||
            !StringComparer.Ordinal.Equals(slot.Mirror, selected.Mirror.Path) ||
            !StringComparer.Ordinal.Equals(
                Path.Combine(slot.Mirror, "worktrees"),
                selected.RegistrationParent.Path))
            throw new InvalidDataException("selected_git_slot_topology_mismatch");
    }
}
#endif
