using System.Diagnostics;
using System.Text.Json;

// Disposable composition probe, not a recursive deletion implementation.
internal static class WorktreeRemovalProbe
{
  internal static void Run(string parent, string git, List<string> results, List<RemovalEvidence> evidence, bool interrupted = false, string? node = null, string? journalScript = null)
  {
    if (!Path.IsPathFullyQualified(git)) throw new InvalidDataException("Absolute Git required");
    foreach (var phase in new[] { "content", "gitfile", "root" })
    {
      var root = Path.Combine(parent, (interrupted ? "interrupted-" : "worktree-") + phase);
      var caseName = (interrupted ? "worktree-process-killed-" : "worktree-planned-stop-") + phase;
      var checkpoints = node is null ? null : new List<JsonElement>();
      void Checkpoint(RemovalSnapshot snapshot) {
        if (checkpoints is not null)
          checkpoints.Add(JournalCheckpoint.Record(root, caseName, snapshot, node!, journalScript!));
      }
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
      Check(gitfile.StartsWith("gitdir: ", StringComparison.Ordinal));
      var registrationPath = Path.GetFullPath(gitfile[8..].Trim(), target);
      var snapshots = new List<RemovalSnapshot> {
        RemovalSnapshot.Capture(target, registrationPath, Registered(Git(git, repo, "worktree", "list", "--porcelain"), target))
      };
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
      // No target mutation until SQLite commit and independent connection readback succeed.
      Checkpoint(snapshots[0]);
      if (interrupted) InterruptAt(root, phase);
      else
      {
        using var owner = OwnedDirectoryRemoval.Acquire(root, "worker", identity);
        MutateFixture(owner, target, phase);
      }
      // Reload association after either planned close or confirmed child termination.
      // Neither the fixture file nor child handshake is authenticated authority.
      using var persisted = JsonDocument.Parse(File.ReadAllBytes(intentPath));
      var data = persisted.RootElement;
      string Field(string key) => data.GetProperty(key).GetString() ?? throw new InvalidDataException();
      var expected = new DirectoryLease.Identity(Field("path"), Field("volume"), Field("fileId"), Field("filesystem"));
      Check(expected == identity && Field("gitfile") == gitfile);
      var before = Git(git, repo, "worktree", "list", "--porcelain");
      Check(Registered(before, target) && Registered(before, other));
      snapshots.Add(RemovalSnapshot.Capture(target, registrationPath, Registered(before, target)));
      // Re-read the fixture's persisted selection and reopen the journal in a new Node process.
      Checkpoint(snapshots[^1]);
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
      snapshots.Add(RemovalSnapshot.Capture(target, registrationPath, Registered(Git(git, repo, "worktree", "list", "--porcelain"), target)));
      Checkpoint(snapshots[^1]);
      Git(git, repo, "worktree", "remove", target);
      var after = Git(git, repo, "worktree", "list", "--porcelain");
      Check(!Registered(after, target) && Registered(after, other));
      snapshots.Add(RemovalSnapshot.Capture(target, registrationPath, Registered(after, target)));
      Checkpoint(snapshots[^1]);
      Check(File.ReadAllText(Path.Combine(other, "first.txt")) == "first");
      Check(File.ReadAllText(Path.Combine(other, "second.txt")) == "second");
      // A second recovery observation establishes completion without resending removal.
      Check(!Directory.Exists(target) && !Registered(Git(git, repo, "worktree", "list", "--porcelain"), target));
      results.Add(caseName);
      evidence.Add(new RemovalEvidence(caseName, snapshots, checkpoints));
    }
  }

  private static void MutateFixture(OwnedDirectoryRemoval owner, string target, string phase)
  {
    File.Delete(Path.Combine(target, phase == "gitfile" ? ".git" : "first.txt"));
    if (phase == "root")
    {
      File.Delete(Path.Combine(target, "second.txt"));
      File.Delete(Path.Combine(target, ".git"));
      var result = owner.RemoveEmpty();
      Check(result.Disposition == "accepted" && result.LeafRelease == "confirmed" && result.NameState == "absent");
    }
  }

  internal static int RestartSnapshot(string root, string git)
  {
    ValidateRestartRoot(root);
    if (!Path.IsPathFullyQualified(git)) throw new InvalidDataException("Absolute Git required");
    var target = Path.Combine(root, "worker");
    if (new FileInfo(Path.Combine(root, "intent.json")).Length > 16384) throw new InvalidDataException("Oversized restart fixture intent");
    using var persisted = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(root, "intent.json")));
    var gitfile = persisted.RootElement.GetProperty("gitfile").GetString()!;
    if (!gitfile.StartsWith("gitdir: ", StringComparison.Ordinal)) throw new InvalidDataException("Invalid fixture gitfile");
    var registrationPath = Path.GetFullPath(gitfile[8..].Trim(), target);
    var expectedParent = Path.GetFullPath(Path.Combine(root, "repo", ".git", "worktrees"));
    if (Path.GetDirectoryName(registrationPath) != expectedParent) throw new InvalidDataException("Unexpected fixture registration path");
    var snapshot = RemovalSnapshot.Capture(target, registrationPath,
      Registered(Git(git, Path.Combine(root, "repo"), "worktree", "list", "--porcelain"), target));
    using var output = new MemoryStream();
    using (var json = new Utf8JsonWriter(output)) snapshot.Write(json);
    Console.WriteLine(System.Text.Encoding.UTF8.GetString(output.ToArray()));
    return 0;
  }

  private static void ValidateRestartRoot(string root)
  {
    if (!Path.IsPathFullyQualified(root) ||
        Path.GetFileName(root) is not ("interrupted-content" or "interrupted-gitfile" or "interrupted-root") ||
        !Path.GetFileName(Path.GetDirectoryName(root)!).StartsWith("removal-probe-", StringComparison.Ordinal))
      throw new InvalidDataException("Unexpected restart fixture root");
  }

  internal static int InterruptChild(string root, string phase, bool wait = true)
  {
    if (phase is not ("content" or "gitfile" or "root") || !Path.IsPathFullyQualified(root) ||
        Path.GetFileName(root) != "interrupted-" + phase ||
        !Path.GetFileName(Path.GetDirectoryName(root)!).StartsWith("removal-probe-", StringComparison.Ordinal))
      return 2;
    using var persisted = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(root, "intent.json")));
    string Field(string key) => persisted.RootElement.GetProperty(key).GetString() ?? throw new InvalidDataException();
    var identity = new DirectoryLease.Identity(Field("path"), Field("volume"), Field("fileId"), Field("filesystem"));
    using var owner = OwnedDirectoryRemoval.Acquire(root, "worker", identity);
    try
    {
      MutateFixture(owner, Path.Combine(root, "worker"), phase);
      Console.WriteLine("phase-reached:" + phase);
      Console.Out.Flush();
      if (!wait) return 0;
      Thread.Sleep(Timeout.Infinite);
      return 3;
    }
    finally { File.WriteAllText(Path.Combine(root, "child-finally.txt"), "managed cleanup ran"); }
  }

  private static void InterruptAt(string root, string phase)
  {
    var executable = Environment.ProcessPath ?? throw new IOException("Missing probe executable");
    var start = new ProcessStartInfo(executable)
    { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
    if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
      start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "RemovalLeaseProbe.dll"));
    foreach (var value in new[] { "--interrupt-child", root, phase }) start.ArgumentList.Add(value);
    using var child = Process.Start(start) ?? throw new IOException("Probe child start failed");
    try
    {
      var line = child.StandardOutput.ReadLineAsync();
      Check(line.Wait(10000) && line.Result == "phase-reached:" + phase && !child.HasExited);
      child.Kill(entireProcessTree: true);
      Check(child.WaitForExit(5000) && child.ExitCode != 0);
      Check(!File.Exists(Path.Combine(root, "child-finally.txt")));
    }
    finally
    {
      if (!child.HasExited)
      {
        child.Kill(entireProcessTree: true);
        if (!child.WaitForExit(5000)) throw new IOException("Probe child termination unconfirmed");
      }
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
