using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// Handle-owned, bounded deletion of one selected tree. Acquisition has no deletion
// effects; every object and ancestor stays held until commit or explicit disposal.
// A supplied identity associates the selection; it is not a grant of authority.
internal sealed class NativeRemovalTree : IDisposable
{
  internal sealed record Result(string Outcome, int Deleted, int? NativeError, bool ReleaseConfirmed);
  private sealed class Entry(string relative, bool directory, DirectoryLease.Identity identity,
      DirectoryLease.DirectoryHandle handle, long length, string? contentHash, Entry? parent)
  {
    internal readonly string Relative = relative;
    internal readonly bool Directory = directory;
    internal readonly DirectoryLease.Identity Identity = identity;
    internal DirectoryLease.DirectoryHandle Handle = handle;
    internal DirectoryLease.DirectoryHandle? Observation;
    internal readonly long Length = length;
    internal readonly string? ContentHash = contentHash;
    internal readonly Entry? Parent = parent;
    internal bool Closed;
  }
  private readonly DirectoryLease parent;
  private readonly List<Entry> entries = [];
  private bool disposed;
  private bool sealedForMutation;
  private bool observationStarted, observationComplete;
  private Result? result;
  internal DirectoryLease.Identity Identity => entries[0].Identity;
  internal int EntryCount => entries.Count;
#if REMOVAL_SESSION_TESTS
  internal Action<int>? AfterDelete;
#endif
  internal string InventoryDigest { get; private set; } = "";
  private readonly Dictionary<string, byte[]> metadata = new(StringComparer.Ordinal);
  internal byte[] Metadata(string component) => metadata.TryGetValue(component, out var bytes)
      ? bytes.ToArray() : throw new InvalidDataException("Removal metadata missing");
  internal bool HasRootEntry(Func<string, bool> predicate) => entries.Any(e => e.Parent == entries[0] && predicate(e.Relative));

  private NativeRemovalTree(DirectoryLease parent) { this.parent = parent; }

  internal static NativeRemovalTree Acquire(string parentPath, string component,
      DirectoryLease.Identity expected, int maximumEntries = 4096, long maximumBytes = 536870912)
  {
    DirectoryLease.ValidateComponent(component);
    if (maximumEntries is < 1 or > 4096 || maximumBytes is < 0 or > 536870912)
      throw new InvalidDataException("Invalid removal budget");
    var tree = new NativeRemovalTree(DirectoryLease.Acquire(parentPath));
    var clock = Stopwatch.StartNew();
    long bytes = 0;
    try
    {
      var selected = Path.Combine(tree.parent.Leaf.Path, component);
      var pending = new Stack<(string Path, string Relative, bool Directory, Entry? Parent)>();
      pending.Push((selected, "", true, null));
      var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      while (pending.Count != 0)
      {
        if (clock.ElapsedMilliseconds > 30000 || tree.entries.Count >= maximumEntries)
          throw new InvalidDataException("Removal preparation budget exceeded");
        var next = pending.Pop();
        if (next.Path.Length > 1024 || next.Path[3..].Split('\\').Length > 32 ||
            !names.Add(next.Relative)) throw new InvalidDataException("Unsupported removal path");
        // Strict encoding rejects unpaired UTF-16 names rather than hashing a replacement.
        _ = new UTF8Encoding(false, true).GetBytes(next.Relative);
        tree.parent.AssertCurrent();
        // Files are frozen against writers while Git inspects them. DELETE access
        // is obtained through relative name opens while the old object stays live;
        // Git's ordinary read handles do not share existing DELETE access.
        var handle = NativeRelativeFiles.OpenChild(next.Parent?.Handle ?? tree.parent.LeafHandle,
            Path.GetFileName(next.Path), next.Directory);
        try
        {
          var identity = DirectoryLease.Capture(handle, next.Directory);
          if (!string.Equals(identity.Path, next.Path, StringComparison.OrdinalIgnoreCase) ||
              identity.Volume != tree.parent.Leaf.Volume || identity.FileSystem != tree.parent.Leaf.FileSystem ||
              (next.Relative.Length == 0 && identity != expected))
            throw new InvalidDataException("Removal identity mismatch");
          long length = 0;
          string? digest = null;
          if (!next.Directory)
          {
            if (!GetFileSizeEx(handle, out length) || length < 0 || length > maximumBytes - bytes)
              throw new InvalidDataException("Removal byte budget exceeded");
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            using var captured = new MemoryStream();
            var capture = next.Parent == tree.entries.FirstOrDefault() &&
                next.Relative is ".git" or "gitdir" or "commondir" or "lexrunner-attempt.json" or "HEAD";
            if (length > 65536) capture = false; // Metadata consumers require a bounded captured entry.
            var buffer = new byte[65536];
            long readTotal = 0;
            while (true)
            {
              if (clock.ElapsedMilliseconds > 30000) throw new InvalidDataException("Removal preparation deadline");
              if (!ReadFile(handle, buffer, (uint)buffer.Length, out var read, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
              if (read == 0) break;
              readTotal += read;
              if (readTotal > length) throw new InvalidDataException("Removal file changed");
              hash.AppendData(buffer.AsSpan(0, (int)read));
              if (capture) captured.Write(buffer, 0, (int)read);
            }
            if (readTotal != length || DirectoryLease.Capture(handle, false) != identity)
              throw new InvalidDataException("Removal file changed");
            bytes += length;
            digest = "sha256:" + Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            if (capture) tree.metadata.Add(next.Relative, captured.ToArray());
          }
          var ownedEntry = new Entry(next.Relative, next.Directory, identity, handle, length, digest, next.Parent);
          tree.entries.Add(ownedEntry);
          handle = null!; // Ownership transferred; failures below dispose the complete tree.
          if (next.Directory)
          {
            foreach (var child in NativeRelativeFiles.Entries(ownedEntry.Handle))
            {
              if (pending.Count + tree.entries.Count >= maximumEntries)
                throw new InvalidDataException("Removal entry budget exceeded");
              var name = child.Name;
              pending.Push((Path.Combine(next.Path, name), next.Relative.Length == 0 ? name : next.Relative + "/" + name,
                  child.Directory, ownedEntry));
            }
          }
        }
        finally { if (handle != null) Close(handle); }
      }
      tree.AssertCurrent();
      tree.InventoryDigest = tree.Digest();
      return tree;
    }
    catch { tree.Dispose(); throw; }
  }

  // The digest covers selected names, physical identities and complete default-stream
  // bytes. It never authenticates the caller or substitutes for a clean Git observation.
  private string Digest()
  {
    using var buffer = new MemoryStream();
    using (var writer = new Utf8JsonWriter(buffer))
    {
      writer.WriteStartArray();
      foreach (var entry in entries.OrderBy(e => e.Relative, StringComparer.Ordinal))
      {
        writer.WriteStartObject();
        writer.WriteString("relative", entry.Relative);
        writer.WriteBoolean("directory", entry.Directory);
        writer.WriteString("volume", entry.Identity.Volume);
        writer.WriteString("fileId", entry.Identity.FileId);
        writer.WriteNumber("length", entry.Length);
        writer.WriteString("contentHash", entry.ContentHash);
        writer.WriteEndObject();
      }
      writer.WriteEndArray();
    }
    return "sha256:" + Convert.ToHexString(SHA256.HashData(buffer.ToArray())).ToLowerInvariant();
  }

  internal void AssertCurrent()
  {
    if (disposed || result != null) throw new InvalidOperationException("Removal tree is terminal");
    parent.AssertCurrent();
    foreach (var entry in entries)
      if (DirectoryLease.Capture(entry.Handle, entry.Directory) != entry.Identity ||
          (entry.Observation != null && DirectoryLease.Capture(entry.Observation, entry.Directory) != entry.Identity))
        throw new InvalidDataException("Removal tree changed");
  }

  internal void SealForObservation()
  {
    AssertCurrent();
    if (sealedForMutation || (observationStarted && !observationComplete))
      throw new InvalidOperationException("Removal observation is not available");
    if (observationComplete) return;
    observationStarted = true;
    foreach (var entry in entries)
    {
      var heldParent = entry.Parent?.Observation ?? entry.Parent?.Handle ?? parent.LeafHandle;
      var component = Path.GetFileName(entry.Identity.Path);
      var guard = entry.Directory
          ? NativeRelativeFiles.OpenCapabilityDirectory(heldParent, component, false)
          : NativeRelativeFiles.OpenCapabilityFile(heldParent, component, false);
      try
      {
        if (DirectoryLease.Capture(guard, entry.Directory) != entry.Identity)
          throw new InvalidDataException("Removal observation changed identity");
        entry.Observation = guard;
        guard = null!;
      }
      finally { if (guard != null) Close(guard); }
    }
    AssertCurrent();
    observationComplete = true;
  }

  internal void SealForMutation()
  {
    AssertCurrent();
    if (sealedForMutation) return;
    if (observationStarted && !observationComplete)
      throw new InvalidOperationException("Removal observation did not complete");
    foreach (var entry in entries)
    {
      // Git readers must not coexist with an existing DELETE grant. After Git
      // exits, drop this entry's no-delete observation guard while its original
      // object stays live, then reopen by retained parent and compare full ID.
      // A replacement cannot reuse the original object's still-live identity.
      CloseObservation(entry);
      // Resolve one name relative to the retained parent while the original
      // object remains held. Validate the full identity BEFORE transferring
      // ownership. A replacement cannot reuse the still-live object's ID.
      var owned = NativeRelativeFiles.OpenChild(entry.Parent?.Handle ?? parent.LeafHandle,
          Path.GetFileName(entry.Identity.Path), entry.Directory, deletion: true);
      try
      {
        if (DirectoryLease.Capture(owned, entry.Directory) != entry.Identity)
          throw new InvalidDataException("Removal reopen changed identity");
        var prior = entry.Handle;
        entry.Handle = owned;
        owned = null!;
        Close(prior);
      }
      finally { if (owned != null) Close(owned); }
    }
    AssertCurrent();
    sealedForMutation = true;
  }

  // One attempt only, including rejection/partial outcomes. A later call returns
  // historical evidence and can never delete a newly occupied pathname.
  internal Result Commit(int timeoutMs, int maximumDeletes = 4096)
  {
    if (result != null) return result;
    if (timeoutMs is < 1 or > 30000 || maximumDeletes is < 1 or > 4096)
      throw new InvalidDataException("Invalid removal commit budget");
    AssertCurrent();
    result = new Result("effect_unknown", 0, null, false);
    var clock = Stopwatch.StartNew();
    var deleted = 0;
    try
    {
      // Protocol preparation seals before admission; this also protects direct
      // internal callers. A seal failure performs no deletion and ends the call.
      if (!sealedForMutation)
      {
        result = null;
        try { SealForMutation(); }
        finally { result = new Result("effect_unknown", 0, null, false); }
      }
      // Preorder acquisition reversed is postorder; all descendants close before
      // their parent is disposed. Unknown/new entries are never swept by a retry.
      for (var i = entries.Count - 1; i >= 0; i--)
      {
        if (clock.ElapsedMilliseconds >= timeoutMs || deleted >= maximumDeletes)
          return result = new Result("budget_exhausted", deleted, null, false);
        parent.AssertCurrent();
        var entry = entries[i];
        if (DirectoryLease.Capture(entry.Handle, entry.Directory) != entry.Identity)
          throw new InvalidDataException("Removal identity changed before disposition");
        // DELETE | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE. Unsupported driver
        // behavior is a refusal/partial outcome, never a pathname-delete fallback.
        var flags = new Disposition { Flags = 0x13 };
        if (!SetFileInformationByHandle(entry.Handle, 21, ref flags, 4))
          return result = new Result("disposition_rejected", deleted, Marshal.GetLastWin32Error(), false);
        entry.Closed = true;
        Close(entry.Handle);
        deleted++;
#if REMOVAL_SESSION_TESTS
        AfterDelete?.Invoke(deleted);
#endif
      }
      parent.AssertCurrent();
      return result = new Result("selected_tree_removed", deleted, null, true);
    }
    catch
    {
      result = new Result("effect_unknown", deleted, null, false);
      throw;
    }
  }

  public void Dispose()
  {
    if (disposed) return;
    disposed = true;
    var uncertain = false;
    for (var i = entries.Count - 1; i >= 0; i--)
    {
      try { CloseObservation(entries[i]); } catch { uncertain = true; }
      if (entries[i].Closed) continue;
      entries[i].Closed = true;
      try { Close(entries[i].Handle); } catch { uncertain = true; }
    }
    try { parent.Dispose(); } catch { uncertain = true; }
    if (uncertain) throw new IOException("Removal tree release uncertain");
  }

  private static void CloseObservation(Entry entry)
  {
    var handle = entry.Observation;
    entry.Observation = null;
    if (handle != null) Close(handle);
  }

  private static void Close(DirectoryLease.DirectoryHandle handle)
  {
    var valid = !handle.IsInvalid; handle.Dispose();
    if (valid && handle.ReleaseSucceeded != true) throw new IOException("Removal handle release uncertain");
  }
  [StructLayout(LayoutKind.Sequential)] private struct Disposition { internal uint Flags; }
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetFileInformationByHandle(
      DirectoryLease.DirectoryHandle handle, int kind, ref Disposition value, uint length);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileSizeEx(DirectoryLease.DirectoryHandle handle, out long size);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ReadFile(DirectoryLease.DirectoryHandle handle,
      [Out] byte[] bytes, uint length, out uint read, IntPtr overlapped);
}
