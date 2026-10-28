using System.Diagnostics;

internal static class TreeRemovalProbe
{
  internal static void Run(string root, string? git, List<string> results)
  {
    DirectoryLease.Identity Snapshot(string path) { using var scope = DirectoryLease.Acquire(path); return scope.Leaf; }
    void Check(bool condition) { if (!condition) throw new Exception("Tree removal assertion failed"); }
    void Test(string name, Action<string> test)
    {
      var path = Path.Combine(root, "tree-" + name); Directory.CreateDirectory(path);
      test(path); results.Add("tree-" + name);
    }
    Test("nested", path => {
      Directory.CreateDirectory(Path.Combine(path, "one", "two"));
      File.WriteAllText(Path.Combine(path, "top"), "top");
      File.WriteAllText(Path.Combine(path, "one", "two", "deep"), "deep");
      using var tree = NativeRemovalTree.Acquire(root, Path.GetFileName(path), Snapshot(path));
      Check(tree.EntryCount == 5 && tree.InventoryDigest.StartsWith("sha256:"));
      var result = tree.Commit(30000);
      if (result.Outcome != "selected_tree_removed" || result.Deleted != 5 || Directory.Exists(path))
        throw new Exception("Tree commit: " + result);
      Directory.CreateDirectory(path); File.WriteAllText(Path.Combine(path, "replacement"), "keep");
      Check(ReferenceEquals(result, tree.Commit(30000)) && File.Exists(Path.Combine(path, "replacement")));
    });
    Test("partial", path => {
      File.WriteAllText(Path.Combine(path, "a"), "a"); File.WriteAllText(Path.Combine(path, "b"), "b");
      using var tree = NativeRemovalTree.Acquire(root, Path.GetFileName(path), Snapshot(path));
      var result = tree.Commit(30000, 1);
      Check(result.Outcome == "budget_exhausted" && result.Deleted == 1 && Directory.Exists(path));
      Check(ReferenceEquals(result, tree.Commit(30000)));
      tree.Dispose(); Check(Directory.EnumerateFiles(path).Count() == 1);
    });
    Test("readonly", path => {
      var file = Path.Combine(path, "readonly"); File.WriteAllText(file, "readonly");
      File.SetAttributes(file, FileAttributes.ReadOnly);
      using var tree = NativeRemovalTree.Acquire(root, Path.GetFileName(path), Snapshot(path));
      Check(tree.Commit(30000).Outcome == "selected_tree_removed" && !Directory.Exists(path));
    });
    Test("prepare-budget", path => {
      File.WriteAllText(Path.Combine(path, "keep"), "keep");
      try { using var tree = NativeRemovalTree.Acquire(root, Path.GetFileName(path), Snapshot(path), 1); throw new Exception("Expected budget refusal"); }
      catch (InvalidDataException) { Check(File.ReadAllText(Path.Combine(path, "keep")) == "keep"); }
    });
    Test("dispose-only", path => {
      File.WriteAllText(Path.Combine(path, "keep"), "keep");
      using var tree = NativeRemovalTree.Acquire(root, Path.GetFileName(path), Snapshot(path));
      tree.Dispose(); Check(File.ReadAllText(Path.Combine(path, "keep")) == "keep");
    });
    Test("root-replaced-before-seal", path => {
      using var tree = NativeRemovalTree.Acquire(root, Path.GetFileName(path), Snapshot(path));
      var moved = path + "-moved"; Directory.Move(path, moved);
      File.WriteAllText(Path.Combine(moved, "original"), "original");
      Directory.CreateDirectory(path); File.WriteAllText(Path.Combine(path, "replacement"), "keep");
      try { tree.SealForMutation(); throw new Exception("Expected moved-root refusal"); }
      catch (InvalidDataException) { }
      Check(File.ReadAllText(Path.Combine(path, "replacement")) == "keep" && File.ReadAllText(Path.Combine(moved, "original")) == "original");
    });
    Test("descendant-replaced-before-seal", path => {
      var file = Path.Combine(path, "original"); File.WriteAllText(file, "original");
      using var tree = NativeRemovalTree.Acquire(root, Path.GetFileName(path), Snapshot(path));
      File.Move(file, file + "-moved"); File.WriteAllText(file, "replacement");
      try { tree.SealForMutation(); throw new Exception("Expected replaced-child refusal"); }
      catch (InvalidDataException) { }
      Check(File.ReadAllText(file) == "replacement" && File.ReadAllText(file + "-moved") == "original");
    });
    Test("competing-seal", path => {
      File.WriteAllText(Path.Combine(path, "keep"), "keep"); var expected = Snapshot(path);
      using var first = NativeRemovalTree.Acquire(root, Path.GetFileName(path), expected);
      using var second = NativeRemovalTree.Acquire(root, Path.GetFileName(path), expected);
      first.SealForMutation();
      try { second.SealForMutation(); throw new Exception("Expected competing-seal refusal"); }
      catch (System.ComponentModel.Win32Exception) { }
      second.Dispose(); Check(first.Commit(30000).Outcome == "selected_tree_removed");
    });
    Test("byte-budget", path => {
      var file = Path.Combine(path, "keep"); File.WriteAllText(file, "keep");
      try { using var tree = NativeRemovalTree.Acquire(root, Path.GetFileName(path), Snapshot(path), maximumBytes: 1); throw new Exception("Expected byte refusal"); }
      catch (InvalidDataException) { Check(File.ReadAllText(file) == "keep"); }
    });
    if (git != null) Test("git-read-compatibility", path => {
      var repo = Path.Combine(root, "tree-source-repository"); Directory.CreateDirectory(repo);
      string Git(params string[] args) {
        var info = new ProcessStartInfo(git) { WorkingDirectory = repo, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        info.Environment["GIT_OPTIONAL_LOCKS"] = "0";
        foreach (var arg in args) info.ArgumentList.Add(arg);
        using var process = Process.Start(info)!;
        var output = process.StandardOutput.ReadToEnd(); var error = process.StandardError.ReadToEnd();
        if (!process.WaitForExit(10000) || process.ExitCode != 0) throw new Exception("Git compatibility: " + error);
        return output;
      }
      Git("init", "--quiet"); File.WriteAllText(Path.Combine(repo, "tracked"), "tracked");
      Git("add", "tracked"); Git("-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
      Directory.Delete(path); Git("worktree", "add", "--detach", path, "HEAD");
      using var tree = NativeRemovalTree.Acquire(root, Path.GetFileName(path), Snapshot(path));
      tree.SealForObservation();
      Check(Git("--git-dir=" + Path.Combine(repo, ".git"), "--work-tree=" + path, "status", "--porcelain").Length == 0);
      Check(tree.Commit(30000).Outcome == "selected_tree_removed" && !Directory.Exists(path));
      Git("worktree", "remove", path);
      Check(!Git("worktree", "list", "--porcelain").Contains(path.Replace('\\', '/'), StringComparison.Ordinal));
    });
  }
}
