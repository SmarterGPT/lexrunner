#nullable enable
using System;
using System.IO;
using System.Reflection;

namespace LexRunner.WindowsCoordinator.Git;

// Artifact-only host probe. It derives fixture expectations from a fresh
// same-user observation; these values can never enroll an installed service.
public static class SelectedRootsFixtureProbe
{
    internal static SelectedGitRoot ObserveUntrusted(string path)
    {
        var type = typeof(HeldSelectedGitRoots).GetNestedType("DirectoryChain",
            BindingFlags.NonPublic) ?? throw new Exception("chain_type_missing");
        var open = type.GetMethod("Open", BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new Exception("chain_open_missing");
        var capture = type.GetMethod("Capture", BindingFlags.NonPublic | BindingFlags.Instance,
            null, Type.EmptyTypes, null) ?? throw new Exception("chain_capture_missing");
        var chain = (IDisposable)(open.Invoke(null, new object[] { path })
            ?? throw new Exception("chain_open_failed"));
        using (chain)
            return (SelectedGitRoot)(capture.Invoke(chain, Array.Empty<object>())
                ?? throw new Exception("chain_capture_failed"));
    }

    public static string RequireReparseRefused(string root)
    {
        var stage = Path.Combine(root, "stage");
        var final = Path.Combine(root, "final");
        var mirror = Path.Combine(stage, "mirror");
        var registration = Path.Combine(mirror, "worktrees");
        var original = ObserveUntrusted(Path.Combine(root, "final-old"))
            with { Path = final };
        var selected = new SelectedGitRoots(ObserveUntrusted(stage), original,
            ObserveUntrusted(mirror), ObserveUntrusted(registration));
        if (!File.GetAttributes(final).HasFlag(FileAttributes.ReparsePoint))
            throw new Exception("reparse_control_not_attached");
        try { using var unexpected = HeldSelectedGitRoots.Acquire(selected);
            throw new Exception("reparse_final_accepted"); }
        catch (InvalidDataException) { }
        catch (System.ComponentModel.Win32Exception) { }
        return "reparse_final_refused";
    }
    public static string Run(string root)
    {
        var stage = Path.Combine(root, "stage");
        var final = Path.Combine(root, "final");
        var mirror = Path.Combine(stage, "mirror");
        var registration = Path.Combine(mirror, "worktrees");
        Directory.CreateDirectory(registration);
        Directory.CreateDirectory(final);
        var selected = new SelectedGitRoots(ObserveUntrusted(stage),
            ObserveUntrusted(final), ObserveUntrusted(mirror),
            ObserveUntrusted(registration));
        var wrong = selected with { Mirror = selected.Mirror with {
            FileId = new string('0', 32) } };
        try { using var unexpected = HeldSelectedGitRoots.Acquire(wrong);
            throw new Exception("wrong_identity_accepted"); }
        catch (InvalidDataException e) when (e.Message == "selected_git_root_identity_mismatch") { }
        using (var held = HeldSelectedGitRoots.Acquire(selected))
        {
            held.AssertCurrent();
            if (held.ObserveStage("s1") is not null) throw new Exception("missing_stage_present");
            var candidate = held.StagePath("s1");
            Directory.CreateDirectory(candidate);
            if (held.ObserveStage("s1")?.Path != candidate)
                throw new Exception("stage_observation_missing");
            var moveDenied = false;
            try { Directory.Move(mirror, mirror + "-moved"); }
            catch (IOException) { moveDenied = true; }
            catch (UnauthorizedAccessException) { moveDenied = true; }
            if (!moveDenied) throw new Exception("held_mirror_rename_succeeded");
            held.AssertCurrent();
            // Same-user creation inside a held empty stage remains possible.
            // The installed worker/coordinator ACL split must exclude it.
            Directory.CreateDirectory(Path.Combine(candidate, "same-user-child"));
        }
        Directory.Move(final, final + "-old");
        Directory.CreateDirectory(final);
        try { using var unexpected = HeldSelectedGitRoots.Acquire(selected);
            throw new Exception("replaced_final_accepted"); }
        catch (InvalidDataException e) when (e.Message == "selected_git_root_identity_mismatch") { }
        return selected.StageParent.FileSystem + ":held_roots_and_replacement_refusal_pass;" +
            "same_user_stage_child_possible=true";
    }
}
