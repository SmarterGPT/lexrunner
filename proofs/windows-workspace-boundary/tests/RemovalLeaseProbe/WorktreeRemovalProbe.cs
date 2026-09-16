using System.Diagnostics;
using System.Text.Json;

// Disposable composition probe, not a recursive deletion implementation.
internal static class WorktreeRemovalProbe
{
  internal static void Run(string parent, string git, List<string> results)
  {
    if (!Path.IsPathFullyQualified(git)) throw new InvalidDataException("Absolute Git required");
    foreach (var phase in new[] { "content", "gitfile", "root" })
    {
      var root = Path.Combine(parent, "worktree-" + phase);
      var repo = Path.Combine(root, "repo");
      var target = Path.Combine(root, "worker");
      var other = Path.Combine(root, "other");
      Directory.CreateDirectory(repo);
      Git(git, repo, "init", "--quiet");
      Git(git, repo, "config", "gc.auto", "0");
      File.WriteAllText(Path.Combine(repo, "first.txt"), "first");
      File.WriteAllText(Path.Combine(repo, "second.txt"), "second");
      Git(git, repo, "add", "first.txt", "second.txt");
      Git(git, repo, "-c", "commit.gpgsign=false", "-c", "user.name=Fixture",
          "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
      Git(git, repo, "worktree", "add", "--detach", target, "HEAD");
      Git(git, repo, "worktree", "add", "--detach", other, "HEAD");
      Check(Git(git, target, "status", "--porcelain").Length == 0);
      DirectoryLease.Identity identity;
      using (var held = DirectoryLease.Acquire(target)) identity = held.Leaf;
      var gitfile = File.ReadAllText(Path.Combine(target, ".git"));
      var intentPath = Path.Combine(root, "intent.json");
      using (var file = new FileStream(intentPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
      {
        using (var json = new Utf8JsonWriter(file))
        {
          json.WriteStartObject();
          json.WriteString("path", identity.Path);
          json.WriteString("volume", identity.Volume);
          json.WriteString("fileId", identity.FileId);
          json.WriteString("filesystem", identity.FileSystem);
          json.WriteString("gitfile", gitfile);
          json.WriteEndObject();
          json.Flush();
        }
        file.Flush(true);
      }
      using (var owner = OwnedDirectoryRemoval.Acquire(root, "worker", identity))
      {
        File.Delete(Path.Combine(target, phase == "gitfile" ? ".git" : "first.txt"));
        if (phase == "root")
        {
          File.Delete(Path.Combine(target, "second.txt"));
          File.Delete(Path.Combine(target, ".git"));
          Check(owner.RemoveEmpty().NameState == "absent");
        }
      }
      // Planned stop: all handles close. Read the fixture intent anew before any
      // subsequent effects. This is not an abrupt process crash or authenticated intent.
      using var persisted = JsonDocument.Parse(File.ReadAllBytes(intentPath));
      var data = persisted.RootElement;
      string Field(string key) => data.GetProperty(key).GetString() ?? throw new InvalidDataException();
      var expected = new DirectoryLease.Identity(Field("path"), Field("volume"), Field("fileId"), Field("filesystem"));
      Check(expected == identity && Field("gitfile") == gitfile);
      var before = Git(git, repo, "worktree", "list", "--porcelain");
      Check(Registered(before, target) && Registered(before, other));
      if (phase != "root")
      {
        Check(File.ReadAllText(Path.Combine(target, "second.txt")) == "second");
        if (phase == "gitfile")
        {
          Check(!File.Exists(Path.Combine(target, ".git")));
          Check(File.ReadAllText(Path.Combine(target, "first.txt")) == "first");
        }
        using var resumed = OwnedDirectoryRemoval.Acquire(root, "worker", expected);
        // Exact known fixture files only, never a general recursive fallback.
        foreach (var name in new[] { "first.txt", "second.txt", ".git" })
          File.Delete(Path.Combine(target, name));
        var removal = resumed.RemoveEmpty();
        Check(removal.Disposition == "accepted" && removal.LeafRelease == "confirmed" && removal.NameState == "absent");
      }
      Check(!Directory.Exists(target));
      Git(git, repo, "worktree", "remove", target);
      var after = Git(git, repo, "worktree", "list", "--porcelain");
      Check(!Registered(after, target) && Registered(after, other));
      Check(File.ReadAllText(Path.Combine(other, "first.txt")) == "first");
      Check(File.ReadAllText(Path.Combine(other, "second.txt")) == "second");
      // A second recovery observation establishes completion without resending removal.
      Check(!Directory.Exists(target) && !Registered(Git(git, repo, "worktree", "list", "--porcelain"), target));
      results.Add("worktree-planned-stop-" + phase);
    }
  }

  private static bool Registered(string listing, string target) =>
      listing.Split('\n').Contains("worktree " + target.Replace('\\', '/'));
  private static void Check(bool condition)
  { if (!condition) throw new InvalidDataException("Worktree removal probe assertion failed"); }
  private static string Git(string executable, string cwd, params string[] args)
  {
    var start = new ProcessStartInfo(executable)
    { WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true,
      RedirectStandardOutput = true, RedirectStandardError = true };
    foreach (var arg in args) start.ArgumentList.Add(arg);
    using var process = Process.Start(start) ?? throw new IOException("Git start failed");
    var output = process.StandardOutput.ReadToEndAsync();
    var error = process.StandardError.ReadToEndAsync();
    if (!process.WaitForExit(10000))
    {
      process.Kill(true);
      if (!process.WaitForExit(5000)) throw new IOException("Fixture Git termination unconfirmed");
      throw new TimeoutException("Fixture Git deadline");
    }
    if (process.ExitCode != 0) throw new IOException(error.GetAwaiter().GetResult());
    return output.GetAwaiter().GetResult();
  }
}
