using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

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
    void Reject(string path, string reason)
    {
      try
      {
        using var tree = NativeRemovalTree.Acquire(root, Path.GetFileName(path), Snapshot(path));
        throw new Exception("Expected removal metadata refusal");
      }
      catch (InvalidDataException error) when (error.Message.Contains(reason, StringComparison.Ordinal)) { }
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
    Test("named-file-stream-refused", path => {
      var file = Path.Combine(path, "keep");
      File.WriteAllText(file, "ordinary");
      File.WriteAllText(file + ":named", "hidden");
      Reject(path, "stream");
      Check(File.ReadAllText(file) == "ordinary" && File.ReadAllText(file + ":named") == "hidden");
    });
    Test("named-directory-stream-refused", path => {
      File.WriteAllText(path + ":named", "hidden");
      File.SetAttributes(path, FileAttributes.Directory); // Archive bit cannot stand in for stream enumeration.
      Reject(path, "directory stream");
      Check(Directory.Exists(path) && File.ReadAllText(path + ":named") == "hidden");
    });
    Test("hardlink-refused", path => {
      var file = Path.Combine(path, "keep");
      var alias = Path.Combine(root, "hardlink-outside");
      File.WriteAllText(file, "ordinary");
      if (!CreateHardLinkW(alias, file, IntPtr.Zero))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Hardlink negative control setup");
      Reject(path, "link");
      Check(File.ReadAllText(file) == "ordinary" && File.ReadAllText(alias) == "ordinary");
    });
    Test("extended-attribute-refused", path => {
      var file = Path.Combine(path, "keep");
      File.WriteAllText(file, "ordinary");
      using (var writable = CreateFileW(file, 0x90, 7, IntPtr.Zero, 3, 0, IntPtr.Zero))
      {
        if (writable.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "EA setup open");
        var name = Encoding.ASCII.GetBytes("LEXTEST");
        var value = Encoding.ASCII.GetBytes("v");
        var input = new byte[8 + name.Length + 1 + value.Length];
        input[5] = checked((byte)name.Length);
        BitConverter.GetBytes(checked((ushort)value.Length)).CopyTo(input, 6);
        name.CopyTo(input, 8);
        value.CopyTo(input, 8 + name.Length + 1);
        if (NtSetEaFile(writable, out _, input, (uint)input.Length) != 0)
          throw new InvalidDataException("EA negative control setup failed");
      }
      Reject(path, "extended attributes");
      Check(File.ReadAllText(file) == "ordinary");
    });
    Test("sparse-file-refused", path => {
      var file = Path.Combine(path, "keep");
      File.WriteAllText(file, "ordinary");
      using (var writable = File.OpenHandle(file, FileMode.Open, FileAccess.ReadWrite,
          FileShare.ReadWrite | FileShare.Delete))
      {
        if (!DeviceIoControl(writable, 0x900c4, IntPtr.Zero, 0, IntPtr.Zero, 0,
            out _, IntPtr.Zero))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "Sparse negative control setup");
      }
      Reject(path, "attributes");
      Check(File.ReadAllText(file) == "ordinary");
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
  [StructLayout(LayoutKind.Sequential)] private struct IoStatusBlock
  { internal IntPtr Status, Information; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
      IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateHardLinkW(
      string newFile, string existingFile, IntPtr security);
  [DllImport("ntdll.dll", ExactSpelling = true)]
  private static extern int NtSetEaFile(SafeFileHandle handle, out IoStatusBlock io,
      [In] byte[] ea, uint length);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DeviceIoControl(
      SafeFileHandle handle, uint control, IntPtr input, uint inputLength,
      IntPtr output, uint outputLength, out uint returned, IntPtr overlapped);
}
