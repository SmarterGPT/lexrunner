using System.Diagnostics;
using System.Text;

internal static class GitObservationProbe
{
  internal static void Run(string root, string git, List<string> results)
  {
    foreach (var guarded in new[] { false, true })
    {
      var name = guarded ? "guarded-dirty-preserved" : "weakened-clean-swap";
      var directory = Path.Combine(root, "git-observation-" + name);
      var repository = Path.Combine(directory, "repository");
      var worker = Path.Combine(directory, "worker");
      var moved = Path.Combine(directory, "moved-tracked");
      Directory.CreateDirectory(repository);
      string Git(string cwd, params string[] arguments)
      {
        var start = new ProcessStartInfo(git) { WorkingDirectory = cwd, UseShellExecute = false,
          CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.Environment["GIT_CONFIG_NOSYSTEM"] = "1";
        start.Environment["GIT_CONFIG_GLOBAL"] = "NUL";
        start.Environment["GIT_OPTIONAL_LOCKS"] = "0";
        start.Environment["GIT_TERMINAL_PROMPT"] = "0";
        foreach (var value in new[] { "-c", "commit.gpgsign=false" }.Concat(arguments)) start.ArgumentList.Add(value);
        using var process = Process.Start(start) ?? throw new IOException("Observation fixture Git start failed");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30000))
        {
          process.Kill(entireProcessTree: true); process.WaitForExit();
          throw new IOException("Observation fixture Git timeout");
        }
        var stdout = output.GetAwaiter().GetResult();
        var stderr = error.GetAwaiter().GetResult();
        if (process.ExitCode != 0 || stderr.Length != 0 || Encoding.UTF8.GetByteCount(stdout) > 65536)
          throw new IOException("Observation fixture Git failed: " + stderr);
        return stdout;
      }
      Git(repository, "init", "--quiet", "-b", "main");
      File.WriteAllText(Path.Combine(repository, "tracked"), "clean");
      Git(repository, "add", "tracked");
      Git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
      Git(repository, "worktree", "add", "--quiet", "--detach", worker, "HEAD");
      File.WriteAllText(Path.Combine(worker, "tracked"), "dirty-original");
      DirectoryLease.Identity expected;
      using (var snapshot = DirectoryLease.Acquire(worker)) expected = snapshot.Leaf;
      using (var tree = NativeRemovalTree.Acquire(directory, "worker", expected))
      {
        if (guarded) tree.SealForObservation();
        var swapped = false;
        try
        {
          try { File.Move(Path.Combine(worker, "tracked"), moved); swapped = true; }
          catch (IOException error) when ((error.HResult & 0xffff) is 5 or 32) { }
          if (swapped) File.WriteAllText(Path.Combine(worker, "tracked"), "clean");
          var registration = Path.Combine(repository, ".git", "worktrees", "worker");
          var status = Git(repository, "--git-dir=" + registration, "--work-tree=" + worker,
            "-c", "core.fsmonitor=false", "-c", "core.hooksPath=NUL", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored");
          if (guarded ? swapped || status.Length == 0 : !swapped || status.Length != 0)
            throw new Exception($"Git observation swap control failed: guarded={guarded}, swapped={swapped}, status={Convert.ToBase64String(Encoding.UTF8.GetBytes(status))}");
        }
        finally
        {
          if (swapped)
          {
            File.Delete(Path.Combine(worker, "tracked"));
            File.Move(moved, Path.Combine(worker, "tracked"));
          }
        }
        tree.AssertCurrent();
        // The weakened ordering can pass this check after a false clean result.
        // Keep the dirty fixture intact; no deletion is attempted in either case.
        tree.SealForMutation();
      }
      if (File.ReadAllText(Path.Combine(worker, "tracked")) != "dirty-original") throw new Exception("Dirty original lost");
      results.Add("git-observation-" + name);
    }
  }
}
