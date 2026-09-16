using System.ComponentModel;
using System.Text.Json;

internal static class Program
{
  internal const int FileLimit = 65536;
  private static void Check(bool condition) { if (!condition) throw new Exception("Assertion failed"); }
  private static void Reject<T>(Action action) where T : Exception
  { try { action(); } catch (T) { return; } throw new Exception($"Expected {typeof(T).Name}"); }
  private static DirectoryLease.Identity Snapshot(string path)
  { using var lease = DirectoryLease.Acquire(path); return lease.Leaf; }

  private static int Main(string[] args)
  {
    if (args.Length != 1 || !OperatingSystem.IsWindows()) return 2;
    var root = Path.Combine(Path.GetFullPath(args[0]), "removal-probe-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);
    var results = new List<string>();
    void Run(string name, Action<string> test)
    {
      var path = Path.Combine(root, name);
      Directory.CreateDirectory(path);
      test(path);
      results.Add(name);
    }
    try
    {
      Run("empty-and-no-retry", path => {
        using var owner = OwnedDirectoryRemoval.Acquire(root, Path.GetFileName(path), Snapshot(path));
        var result = owner.RemoveEmpty();
        Check(result.Disposition == "accepted" && result.LeafRelease == "confirmed" && result.NameState == "absent");
        Check(!Directory.Exists(path));
        Directory.CreateDirectory(path);
        File.WriteAllText(Path.Combine(path, "replacement"), "preserve");
        Check(ReferenceEquals(result, owner.RemoveEmpty()));
        Check(File.ReadAllText(Path.Combine(path, "replacement")) == "preserve");
        Reject<InvalidOperationException>(() => owner.OpenReader());
        owner.Dispose();
        Check(owner.Released && !owner.ReleaseUncertain);
      });
      Run("identity-mismatch", path => {
        var expected = Snapshot(root);
        Reject<System.IO.InvalidDataException>(() => OwnedDirectoryRemoval.Acquire(root, Path.GetFileName(path), expected));
        Check(Directory.Exists(path));
      });
      Run("existing-guard", path => {
        using var guard = DirectoryLease.Acquire(path);
        Reject<Win32Exception>(() => OwnedDirectoryRemoval.Acquire(root, Path.GetFileName(path), guard.Leaf));
        Check(Directory.Exists(path));
      });
      Run("competing-owner", path => {
        var expected = Snapshot(path);
        using var owner = OwnedDirectoryRemoval.Acquire(root, Path.GetFileName(path), expected);
        Reject<Win32Exception>(() => OwnedDirectoryRemoval.Acquire(root, Path.GetFileName(path), expected));
        Check(Directory.Exists(path));
      });
      Run("tracked-readers", path => {
        Directory.CreateDirectory(Path.Combine(path, "child"));
        using var owner = OwnedDirectoryRemoval.Acquire(root, Path.GetFileName(path), Snapshot(path));
        using var reader = owner.OpenReader();
        using var child = owner.OpenReader("child");
        Reject<InvalidOperationException>(() => owner.RemoveEmpty());
        owner.Dispose();
        Check(owner.ClosePending && !owner.Released);
        reader.AssertCurrent(); child.AssertCurrent();
        Reject<InvalidOperationException>(() => owner.OpenReader());
        reader.Dispose(); Check(owner.ClosePending);
        child.Dispose(); Check(owner.Released && !owner.ClosePending);
        Check(Directory.Exists(path));
      });
      Run("nonempty-no-retry", path => {
        var file = Path.Combine(path, "keep");
        File.WriteAllText(file, "preserve");
        using var owner = OwnedDirectoryRemoval.Acquire(root, Path.GetFileName(path), Snapshot(path));
        var result = owner.RemoveEmpty();
        Check(result.Disposition == "rejected" && result.NativeError == 145);
        Check(File.ReadAllText(file) == "preserve");
        File.Delete(file);
        Check(ReferenceEquals(result, owner.RemoveEmpty()) && Directory.Exists(path));
      });
      Run("reader-then-remove", path => {
        using var owner = OwnedDirectoryRemoval.Acquire(root, Path.GetFileName(path), Snapshot(path));
        using (var reader = owner.OpenReader()) { reader.AssertCurrent(); }
        Check(owner.RemoveEmpty().NameState == "absent");
      });
      Run("dispose-only", path => {
        var owner = OwnedDirectoryRemoval.Acquire(root, Path.GetFileName(path), Snapshot(path));
        owner.Dispose(); owner.Dispose();
        Check(owner.Released && Directory.Exists(path));
        Reject<InvalidOperationException>(() => owner.RemoveEmpty());
      });
      Run("failed-reader-close-uncertain", path => {
        File.WriteAllText(Path.Combine(path, "file"), "preserve");
        using var owner = OwnedDirectoryRemoval.Acquire(root, Path.GetFileName(path), Snapshot(path));
        OwnedDirectoryRemoval.AfterHandleClosed = () => {
          OwnedDirectoryRemoval.AfterHandleClosed = null;
          throw new IOException("Injected missing close confirmation");
        };
        try { Reject<IOException>(() => owner.OpenReader("file")); }
        finally { OwnedDirectoryRemoval.AfterHandleClosed = null; }
        Check(owner.ReleaseUncertain);
        Reject<InvalidOperationException>(() => owner.RemoveEmpty());
        Reject<InvalidOperationException>(() => owner.OpenReader());
        owner.Dispose();
        Check(!owner.Released && owner.ReleaseUncertain);
        Check(File.ReadAllText(Path.Combine(path, "file")) == "preserve");
      });
      using var output = new MemoryStream();
      using (var json = new Utf8JsonWriter(output))
      {
        json.WriteStartObject();
        json.WriteString("root", root);
        json.WriteString("filesystem", Snapshot(root).FileSystem);
        json.WriteStartArray("passed");
        foreach (var result in results) json.WriteStringValue(result);
        json.WriteEndArray();
        json.WriteEndObject();
      }
      Console.WriteLine(System.Text.Encoding.UTF8.GetString(output.ToArray()));
      return 0;
    }
    finally
    {
      // Only this freshly created, exact fixture root is removed.
      Directory.Delete(root, true);
    }
  }
}
