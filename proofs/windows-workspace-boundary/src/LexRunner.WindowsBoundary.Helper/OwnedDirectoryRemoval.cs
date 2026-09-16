using System.ComponentModel;
using System.Runtime.InteropServices;

// Development primitive only. Not reachable through the helper protocol.
// Parent custody and the DELETE-capable leaf are acquired before disposition.
internal sealed class OwnedDirectoryRemoval : IDisposable
{
  internal sealed record Observation(DirectoryLease.Identity Original, string Disposition,
      int? NativeError, string LeafRelease, string NameState, DirectoryLease.Identity? NameIdentity);

  private readonly object sync = new();
  private readonly DirectoryLease parent;
  private readonly DirectoryLease.DirectoryHandle leaf;
  internal DirectoryLease.Identity Identity { get; }
  private int readers;
  private bool closing;
  private bool released;
  private bool cleanupAttempted;
  private bool releaseUncertain;
  private Observation? observation;
  internal Observation? LastObservation { get { lock (sync) return observation; } }
  internal bool ClosePending { get { lock (sync) return closing && !released && !releaseUncertain; } }
  internal bool Released { get { lock (sync) return released; } }
  internal bool ReleaseUncertain { get { lock (sync) return releaseUncertain; } }

  private OwnedDirectoryRemoval(DirectoryLease parent, DirectoryLease.DirectoryHandle leaf,
      DirectoryLease.Identity identity)
  { this.parent = parent; this.leaf = leaf; Identity = identity; }

  // Expected identity is historical association data, not an authority grant.
  internal static OwnedDirectoryRemoval Acquire(string parentPath, string component,
      DirectoryLease.Identity expected)
  {
    DirectoryLease.ValidateComponent(component);
    var parent = DirectoryLease.Acquire(parentPath);
    DirectoryLease.DirectoryHandle? leaf = null;
    try
    {
      var path = Path.Combine(parent.Leaf.Path, component);
      if (path.Length > 1024 || parent.Identities.Count >= 33) throw new InvalidDataException();
      // DELETE | LIST_DIRECTORY | READ_ATTRIBUTES; deny competing delete opens.
      leaf = Open(path, 0x10081, 3);
      var identity = DirectoryLease.Capture(leaf);
      if (identity != expected || !string.Equals(identity.Path, path, StringComparison.OrdinalIgnoreCase) ||
          identity.Volume != parent.Leaf.Volume || identity.FileSystem != parent.Leaf.FileSystem)
        throw new InvalidDataException("Removal identity mismatch");
      parent.AssertCurrent();
      return new OwnedDirectoryRemoval(parent, leaf, identity);
    }
    catch
    {
      try { if (leaf != null) CloseChecked(leaf); }
      finally { parent.Dispose(); }
      throw;
    }
  }

  // A tracked reader keeps the deletion owner and parent chain alive. No DELETE
  // right is granted to the reader. Empty component means the owned leaf itself.
  internal Reader OpenReader(string? component = null)
  {
    lock (sync)
    {
      RequireActive();
      if (component != null) DirectoryLease.ValidateComponent(component);
      AssertCurrent();
      var path = component == null ? Identity.Path : Path.Combine(Identity.Path, component);
      if (path.Length > 1024) throw new InvalidDataException();
      var handle = Open(path, 0x81, 7);
      try
      {
        var identity = DirectoryLease.Capture(handle);
        if (!string.Equals(identity.Path, path, StringComparison.OrdinalIgnoreCase) ||
            identity.Volume != Identity.Volume || identity.FileSystem != Identity.FileSystem)
          throw new InvalidDataException();
        AssertCurrent();
        readers++;
        return new Reader(this, handle, identity);
      }
      catch { CloseChecked(handle); throw; }
    }
  }

  internal Observation RemoveEmpty()
  {
    lock (sync)
    {
      // Return the original terminal observation; never resend a disposition.
      if (observation != null) return observation;
      RequireActive();
      if (readers != 0) throw new InvalidOperationException("Removal readers still active");
      AssertCurrent();
      observation = new(Identity, "unknown", null, "not_requested", "not_observed", null);
      var flags = new Disposition { Flags = 3 }; // DELETE | POSIX_SEMANTICS
      if (!SetFileInformationByHandle(leaf, 21, ref flags, 4))
      {
        observation = observation with { Disposition = "rejected", NativeError = Marshal.GetLastWin32Error() };
        return observation;
      }
      observation = observation with { Disposition = "accepted" };
      try { CloseChecked(leaf); observation = observation with { LeafRelease = "confirmed" }; }
      catch (IOException)
      {
        releaseUncertain = true;
        observation = observation with { LeafRelease = "uncertain", NameState = "unknown" };
        return observation;
      }
      // Observe the name separately from the original object's disposition. A
      // subsequently occupied name must never be deleted as an implicit retry.
      try
      {
        parent.AssertCurrent();
        var check = CreateFileW(Identity.Path, 0x81, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        try
        {
        if (check.IsInvalid)
        {
          var error = Marshal.GetLastWin32Error();
          observation = observation with { NameState = error is 2 or 3 ? "absent" : "unknown", NativeError = error is 2 or 3 ? null : error };
        }
        else
        {
          var current = DirectoryLease.Capture(check);
          observation = observation with { NameState = "present", NameIdentity = current };
        }
        }
        finally
        {
          try { CloseChecked(check); }
          catch { releaseUncertain = true; throw; }
        }
        parent.AssertCurrent();
      }
      catch (Exception error) when (error is IOException or Win32Exception or InvalidDataException)
      { observation = observation with { NameState = "unknown", NameIdentity = null }; }
      return observation;
    }
  }

  private void RequireActive()
  {
    if (closing || released || releaseUncertain || observation != null)
      throw new InvalidOperationException("Removal owner is terminal");
  }
  private void AssertCurrent()
  {
    parent.AssertCurrent();
    if (DirectoryLease.Capture(leaf) != Identity) throw new InvalidDataException("Removal identity changed");
  }
  public void Dispose()
  {
    lock (sync)
    {
      closing = true;
      if (readers == 0) Release();
    }
  }
  private void Release()
  {
    if (cleanupAttempted) return;
    cleanupAttempted = true;
    try
    {
      try { CloseChecked(leaf); }
      finally { parent.Dispose(); }
      released = !releaseUncertain;
    }
    catch { releaseUncertain = true; throw; }
  }
  private void ReaderClosed(bool confirmed)
  {
    lock (sync)
    {
      readers--;
      if (!confirmed) { releaseUncertain = true; closing = true; }
      if (closing && readers == 0)
      {
        Release();
      }
    }
  }
  internal sealed class Reader : IDisposable
  {
    private readonly OwnedDirectoryRemoval owner;
    private readonly DirectoryLease.DirectoryHandle handle;
    private bool closed;
    internal DirectoryLease.Identity Identity { get; }
    internal Reader(OwnedDirectoryRemoval owner, DirectoryLease.DirectoryHandle handle,
        DirectoryLease.Identity identity) { this.owner = owner; this.handle = handle; Identity = identity; }
    internal void AssertCurrent()
    {
      lock (owner.sync)
      {
        if (closed) throw new ObjectDisposedException(nameof(Reader));
        owner.AssertCurrent();
        if (DirectoryLease.Capture(handle) != Identity) throw new InvalidDataException();
      }
    }
    public void Dispose()
    {
      lock (owner.sync)
      {
        if (closed) return;
        closed = true;
        var confirmed = false;
        try { CloseChecked(handle); confirmed = true; }
        finally { owner.ReaderClosed(confirmed); }
      }
    }
  }
  private static DirectoryLease.DirectoryHandle Open(string path, uint access, uint sharing)
  {
    var handle = CreateFileW(path, access, sharing, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (!handle.IsInvalid) return handle;
    var error = Marshal.GetLastWin32Error();
    handle.Dispose();
    throw new Win32Exception(error);
  }
  private static void CloseChecked(DirectoryLease.DirectoryHandle handle)
  {
    var valid = !handle.IsInvalid;
    handle.Dispose();
    if (valid && handle.ReleaseSucceeded != true) throw new IOException("Removal handle release uncertain");
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct Disposition { internal uint Flags; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern DirectoryLease.DirectoryHandle CreateFileW(string path, uint access, uint share,
      IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetFileInformationByHandle(DirectoryLease.DirectoryHandle handle, int kind,
      ref Disposition value, uint length);
}
