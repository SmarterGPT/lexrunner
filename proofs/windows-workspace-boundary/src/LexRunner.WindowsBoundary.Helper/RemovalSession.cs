using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

// Explicit development removal feature on the existing owned session. Supplied
// identities/digests bind selections; this peer is not a protected authority root.
internal sealed class RemovalSession : IDisposable
{
  internal const string Version = "1.0.0";
  private sealed class Held(DirectoryLease.DirectoryHandle slot, List<DirectoryLease> parents) : IDisposable
  {
    internal readonly DirectoryLease.DirectoryHandle Slot = slot;
    internal readonly List<DirectoryLease> Parents = parents;
    internal NativeRemovalTree? Root, Registration;
    internal readonly List<DirectoryLease> Observations = [];
    internal string? Admission;
    internal byte[]? CommitReply;
    public void Dispose()
    {
      var uncertain = false;
      foreach (var item in Observations) try { item.Dispose(); } catch { uncertain = true; }
      try { Registration?.Dispose(); } catch { uncertain = true; }
      try { Root?.Dispose(); } catch { uncertain = true; }
      try { Close(Slot); } catch { uncertain = true; }
      foreach (var parent in Parents) try { parent.Dispose(); } catch { uncertain = true; }
      if (uncertain) throw new IOException("Removal release uncertain");
    }
  }
  private readonly Dictionary<string, Held> held = [];

  internal byte[] Execute(JsonElement root, byte[] bytes, string nonce, string sessionNonce,
      HashSet<string> requests, HashSet<string> operations, IReadOnlyDictionary<string, DirectoryLease> leases)
  {
    Keys(root, "client_nonce", "kind", "operation_id", "payload", "protocol_version", "removal_version", "request_digest", "request_id", "session_nonce");
    var request = S(root, "request_id"); var operationId = S(root, "operation_id");
    var digest = S(root, "request_digest");
    if (!Program.IsId(request) || !Program.IsId(operationId) || S(root, "kind") != "removal_request" ||
        S(root, "protocol_version") != Program.Version || S(root, "removal_version") != Version ||
        S(root, "client_nonce") != nonce || S(root, "session_nonce") != sessionNonce ||
        digest != Hash(Canonical(root, omitDigest: true)) || !bytes.AsSpan().SequenceEqual(Canonical(root)) ||
        !requests.Add(request) || !operations.Add(operationId)) throw new InvalidDataException("Removal envelope");
    var payload = root.GetProperty("payload"); var operation = S(payload, "operation");
    Action<Utf8JsonWriter> result;
    if (operation is "prepare" or "recover")
    {
      Keys(payload, operation == "prepare" ?
        ["operation", "root_parent_token", "registration_parent_token", "slot_parent_token", "root_component", "registration_component", "slot_component", "root_identity", "registration_identity", "slot_identity", "slot_content_sha256", "marker_sha256", "git_executable", "git_environment"] :
        ["operation", "root_parent_token", "registration_parent_token", "slot_parent_token", "root_component", "registration_component", "slot_component", "root_identity", "registration_identity", "slot_identity", "slot_content_sha256", "previous_executor_id"]);
      if (held.Count >= 4) throw new InvalidDataException("Removal session capacity");
      var parents = new List<DirectoryLease>();
      DirectoryLease Retain(string key)
      {
        var selected = leases[S(payload, key)]; selected.AssertCurrent();
        var retained = DirectoryLease.Acquire(selected.Leaf.Path); parents.Add(retained);
        if (retained.Leaf != selected.Leaf) throw new InvalidDataException("Removal parent changed");
        return retained;
      }
      Held? owner = null;
      try
      {
      var rootParent = Retain("root_parent_token");
      var registrationParent = Retain("registration_parent_token");
      var slotParent = Retain("slot_parent_token");
      rootParent.AssertCurrent(); registrationParent.AssertCurrent(); slotParent.AssertCurrent();
      var rootComponent = S(payload, "root_component"); var registrationComponent = S(payload, "registration_component");
      var slotComponent = S(payload, "slot_component");
      DirectoryLease.ValidateComponent(rootComponent); DirectoryLease.ValidateComponent(registrationComponent);
      var slot = NativeRelativeFiles.OpenChild(slotParent.LeafHandle, slotComponent, false, exclusive: true);
      owner = new Held(slot, parents);
        var slotIdentity = Identity(payload.GetProperty("slot_identity"));
        if (DirectoryLease.Capture(slot, false) != slotIdentity || Hash(Read(slot, 65536)) != S(payload, "slot_content_sha256"))
          throw new InvalidDataException("Removal slot mismatch");
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        if (operation == "prepare")
        {
          owner.Root = NativeRemovalTree.Acquire(rootParent.Leaf.Path, rootComponent, Identity(payload.GetProperty("root_identity")));
          owner.Registration = NativeRemovalTree.Acquire(registrationParent.Leaf.Path, registrationComponent, Identity(payload.GetProperty("registration_identity")), 256, 16777216);
          var tree = owner.Root; var registration = owner.Registration;
          var rootPath = tree.Identity.Path; var registrationPath = registration.Identity.Path;
          var common = Path.GetDirectoryName(registrationParent.Leaf.Path)!;
          var utf8 = new UTF8Encoding(false, true);
          string Metadata(NativeRemovalTree selected, string name) => utf8.GetString(selected.Metadata(name)).TrimEnd('\r', '\n');
          var gitLink = Metadata(tree, ".git");
          using var marker = JsonDocument.Parse(registration.Metadata("lexrunner-attempt.json"));
          if (!Path.GetFileName(registrationParent.Leaf.Path).Equals("worktrees", StringComparison.OrdinalIgnoreCase) ||
              !gitLink.StartsWith("gitdir: ", StringComparison.Ordinal) ||
              !Path.GetFullPath(gitLink[8..], rootPath).Equals(registrationPath, StringComparison.OrdinalIgnoreCase) ||
              !Path.GetFullPath(Metadata(registration, "gitdir"), registrationPath).Equals(Path.Combine(rootPath, ".git"), StringComparison.OrdinalIgnoreCase) ||
              !Path.GetFullPath(Metadata(registration, "commondir"), registrationPath).Equals(common, StringComparison.OrdinalIgnoreCase) ||
              Hash(registration.Metadata("lexrunner-attempt.json")) != S(payload, "marker_sha256") ||
              Metadata(registration, "HEAD") != "ref: refs/heads/" + marker.RootElement.GetProperty("branch").GetString() ||
              registration.HasRootEntry(name => name.Equals("locked", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".lock", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidDataException("Removal registration mismatch");
          // Fixed read-only Git command. Preserve public config-location semantics
          // used by the broker; never inherit the general credential environment.
          var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
          foreach (var name in new[] { "SYSTEMROOT", "WINDIR", "TEMP", "TMP" })
            if (Environment.GetEnvironmentVariable(name) is string value) environment.Add(name, value);
          string[] allowed = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "XDG_CONFIG_HOME", "PROGRAMDATA", "ALLUSERSPROFILE", "APPDATA", "LOCALAPPDATA", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_ATTR_NOSYSTEM"];
          var gitEnvironment = payload.GetProperty("git_environment");
          if (gitEnvironment.ValueKind != JsonValueKind.Array || gitEnvironment.GetArrayLength() > allowed.Length) throw new InvalidDataException("Git environment budget");
          foreach (var entry in gitEnvironment.EnumerateArray())
          {
            Keys(entry, "name", "value_base64"); var name = S(entry, "name"); var encoded = S(entry, "value_base64");
            if (!allowed.Contains(name, StringComparer.Ordinal) || encoded.Length > 10924) throw new InvalidDataException("Git environment name");
            var decoded = Convert.FromBase64String(encoded);
            var value = new UTF8Encoding(false, true).GetString(decoded);
            if (decoded.Length > 8192 || Convert.ToBase64String(decoded) != encoded || value.Contains('\0') || !environment.TryAdd(name, value))
              throw new InvalidDataException("Git environment value");
          }
          environment["GIT_OPTIONAL_LOCKS"] = "0"; environment["GIT_TERMINAL_PROMPT"] = "0";
          if (environment.Sum(p => p.Key.Length + p.Value.Length + 2) + 1 > 32767) throw new InvalidDataException("Git environment block");
          var environmentDigest = Hash(Program.Json(w => { w.WritePropertyName("git_environment"); WriteValue(w, gitEnvironment); }));
          var gitExecutable = S(payload, "git_executable");
          string[] gitArguments = ["--git-dir=" + registrationPath, "--work-tree=" + rootPath, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=NUL", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored"];
          // Pin names without granting DELETE until the ordinary Git readers
          // exit. Preparation handles alone deliberately allow replacement.
          tree.SealForObservation(); registration.SealForObservation();
          var clean = NativeProcess.Run(gitExecutable, gitArguments, common, 30000, 65536, environment);
          if (clean.Status != "exited" || clean.ExitCode != 0 || clean.Stdout.Length != 0 || clean.Stderr.Length != 0 || clean.StdoutTruncated || clean.StderrTruncated)
            throw new InvalidDataException("Removal requires clean Git observation");
          tree.SealForMutation(); registration.SealForMutation();
#if REMOVAL_SESSION_TESTS
          tree.AfterDelete = count => RemovalFaultProbe.Check(slotIdentity.Path, count == tree.EntryCount ? "root-removed" : "root-partial");
          registration.AfterDelete = count => RemovalFaultProbe.Check(slotIdentity.Path, "registration-partial");
#endif
          var executor = ExecutorId(sessionNonce);
          void WriteClean(Utf8JsonWriter w)
          {
            w.WritePropertyName("clean_git"); w.WriteStartObject();
            w.WritePropertyName("arguments"); w.WriteStartArray(); foreach (var argument in gitArguments) w.WriteStringValue(argument); w.WriteEndArray();
            w.WriteString("cwd", common); w.WriteNumber("duration_ms", clean.DurationMs); w.WriteString("environment_sha256", environmentDigest); w.WriteString("executable", gitExecutable);
            w.WriteNumber("exit_code", clean.ExitCode); w.WriteBoolean("job_empty", true); w.WriteNumber("process_id", clean.ProcessId);
            w.WriteString("stderr_sha256", Hash(clean.Stderr)); w.WriteString("stdout_sha256", Hash(clean.Stdout)); w.WriteEndObject();
          }
          var selection = Hash(Program.Json(w =>
          {
            WriteClean(w);
            w.WriteString("executor_id", executor); w.WriteString("marker_sha256", S(payload, "marker_sha256"));
            w.WriteString("registration_inventory_sha256", registration.InventoryDigest);
            w.WriteString("root_inventory_sha256", tree.InventoryDigest);
            w.WriteString("slot_file_id", slotIdentity.FileId); w.WriteString("slot_volume", slotIdentity.Volume);
          }));
          result = w =>
          {
            WriteClean(w);
            w.WriteString("executor_id", executor); w.WriteString("operation", operation);
            WriteIdentity(w, "registration_identity", registration.Identity);
            w.WriteNumber("registration_entries", registration.EntryCount); w.WriteString("registration_inventory_sha256", registration.InventoryDigest);
            w.WriteString("removal_token", token); WriteIdentity(w, "root_identity", tree.Identity);
            w.WriteNumber("root_entries", tree.EntryCount); w.WriteString("root_inventory_sha256", tree.InventoryDigest);
            w.WriteString("selection_sha256", selection); w.WriteString("status", "prepared");
          };
        }
        else
        {
          var previous = S(payload, "previous_executor_id");
          var state = InspectExecutor(previous);
          DirectoryLease? Observe(DirectoryLease parent, string component)
          {
            var child = parent.OpenChild(component, true, false);
            if (child != null) owner.Observations.Add(child);
            return child;
          }
          // Still hold the original stable slot. Never resolve against an active
          // or uninspectable old executor, even if paths currently look absent.
          var observedRoot = state == "gone" ? Observe(rootParent, rootComponent) : null;
          var observedRegistration = state == "gone" ? Observe(registrationParent, registrationComponent) : null;
          var contents = observedRoot == null ? "unknown" : NativeRelativeFiles.Entries(observedRoot.LeafHandle).Any() ? "remaining" : "empty";
          var locked = observedRegistration != null && NativeRelativeFiles.Entries(observedRegistration.LeafHandle).Any(e => e.Name.Equals("locked", StringComparison.OrdinalIgnoreCase));
          result = w =>
          {
            w.WriteString("contents", contents); w.WriteString("executor_state", state); w.WriteString("operation", operation);
            WriteIdentity(w, "registration_identity", observedRegistration?.Leaf); w.WriteBoolean("registration_locked", locked);
            w.WriteString("removal_token", token); WriteIdentity(w, "root_identity", observedRoot?.Leaf); w.WriteString("status", "observed");
          };
        }
        rootParent.AssertCurrent(); registrationParent.AssertCurrent(); slotParent.AssertCurrent();
        held.Add(token, owner); owner = null;
        parents = []; // Ownership transferred to the operation, not the caller's scope tokens.
      }
      finally
      {
        if (owner != null) owner.Dispose();
        else foreach (var parent in parents) parent.Dispose();
      }
    }
    else if (operation == "commit")
    {
      Keys(payload, "operation", "removal_token", "admission_digest", "timeout_ms", "maximum_deletes");
      var token = S(payload, "removal_token"); var owner = held[token];
      foreach (var parent in owner.Parents) parent.AssertCurrent();
      var admission = S(payload, "admission_digest");
      if (!Digest(admission) || owner.Root == null || owner.Registration == null) throw new InvalidDataException("Removal admission");
      if (owner.Admission != null)
      {
        if (owner.Admission != admission || owner.CommitReply == null) throw new InvalidDataException("Removal terminal");
        using var historical = JsonDocument.Parse(owner.CommitReply);
        var historicalPayload = historical.RootElement.Clone(); result = w => WriteProperties(w, historicalPayload);
      }
      else
      {
        owner.Admission = admission; // Before the first effect; failures never reset it.
#if REMOVAL_SESSION_TESTS
        RemovalFaultProbe.Check(DirectoryLease.Capture(owner.Slot, false).Path, "before-effect");
#endif
        var clock = Stopwatch.StartNew(); var timeout = payload.GetProperty("timeout_ms").GetInt32();
        var maximum = payload.GetProperty("maximum_deletes").GetInt32();
        if (timeout is < 1 or > 30000 || maximum is < 1 or > 4096) throw new InvalidDataException("Removal commit budget");
        var first = owner.Root.Commit(timeout, maximum);
        NativeRemovalTree.Result? second = null;
        if (first.Outcome == "selected_tree_removed" && clock.ElapsedMilliseconds < timeout && first.Deleted < maximum)
          second = owner.Registration.Commit(timeout - (int)clock.ElapsedMilliseconds, maximum - first.Deleted);
#if REMOVAL_SESSION_TESTS
        RemovalFaultProbe.Check(DirectoryLease.Capture(owner.Slot, false).Path, "after-effect");
#endif
        owner.CommitReply = Program.Json(w =>
        {
          w.WriteString("admission_digest", admission); w.WriteString("operation", operation);
          w.WriteNumber("registration_deleted", second?.Deleted ?? 0); w.WriteString("registration_outcome", second?.Outcome ?? "not_started");
          if (second?.NativeError is int registrationError) w.WriteNumber("registration_native_error", registrationError); else w.WriteNull("registration_native_error");
          w.WriteString("removal_token", token); w.WriteNumber("root_deleted", first.Deleted); w.WriteString("root_outcome", first.Outcome);
          if (first.NativeError is int rootError) w.WriteNumber("root_native_error", rootError); else w.WriteNull("root_native_error");
          w.WriteString("status", second?.Outcome == "selected_tree_removed" ? "selected_trees_removed" : "partial");
        });
        using var completed = JsonDocument.Parse(owner.CommitReply);
        var completedPayload = completed.RootElement.Clone(); result = w => WriteProperties(w, completedPayload);
      }
    }
    else if (operation == "release")
    {
      Keys(payload, "operation", "removal_token"); var token = S(payload, "removal_token");
      var owner = held[token]; owner.Dispose(); held.Remove(token);
      result = w => { w.WriteString("operation", operation); w.WriteString("removal_token", token); w.WriteString("status", "released"); };
    }
    else throw new InvalidDataException("Removal operation");
    var reply = Program.Json(w =>
    {
      w.WriteString("client_nonce", nonce); w.WriteString("kind", "removal_result"); w.WriteString("operation_id", operationId);
      w.WritePropertyName("payload"); w.WriteStartObject(); result(w); w.WriteEndObject();
      w.WriteString("protocol_version", Program.Version); w.WriteString("removal_version", Version);
      w.WriteString("request_digest", digest); w.WriteString("request_id", request); w.WriteString("session_nonce", sessionNonce);
    });
    using var canonicalReply = JsonDocument.Parse(reply);
    return Canonical(canonicalReply.RootElement);
  }

  private static string ExecutorId(string nonce) => $"windows:{Environment.ProcessId}:{Process.GetCurrentProcess().StartTime.ToFileTimeUtc():x16}:{Hash(Encoding.UTF8.GetBytes(nonce))[7..39]}";
  private static string InspectExecutor(string value)
  {
    var parts = value.Split(':');
    if (parts.Length != 4 || parts[0] != "windows" || !uint.TryParse(parts[1], out var pid) || pid == 0 ||
        parts[2].Length != 16 || !long.TryParse(parts[2], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var creation) ||
        parts[3].Length != 32 || parts[3].Any(c => !Uri.IsHexDigit(c))) throw new InvalidDataException("Removal executor identity");
    using var process = OpenProcess(0x101000, false, pid);
    if (process.IsInvalid) return Marshal.GetLastWin32Error() == 87 ? "gone" : "unknown";
    if (!GetProcessTimes(process, out var actual, out _, out _, out _)) return "unknown";
    if (actual != creation) return "gone"; // A reused PID is a different process.
    return WaitForSingleObject(process, 0) switch { 0 => "gone", 258 => "alive", _ => "unknown" };
  }
  private static DirectoryLease.Identity Identity(JsonElement value)
  {
    Keys(value, "path", "file_id", "volume_serial_number", "filesystem");
    return new(S(value, "path"), S(value, "volume_serial_number"), S(value, "file_id"), S(value, "filesystem"));
  }
  private static void WriteIdentity(Utf8JsonWriter w, string name, DirectoryLease.Identity? identity)
  {
    w.WritePropertyName(name);
    if (identity == null) { w.WriteNullValue(); return; }
    w.WriteStartObject(); w.WriteString("file_id", identity.FileId); w.WriteString("filesystem", identity.FileSystem);
    w.WriteString("path", identity.Path); w.WriteString("volume_serial_number", identity.Volume); w.WriteEndObject();
  }
  private static byte[] Read(DirectoryLease.DirectoryHandle handle, int maximum)
  {
    var bytes = new byte[maximum + 1];
    if (!ReadFile(handle, bytes, (uint)bytes.Length, out var read, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if (read > maximum) throw new InvalidDataException("Removal slot budget");
    return bytes.AsSpan(0, (int)read).ToArray();
  }
  private static string S(JsonElement value, string name) => value.GetProperty(name).GetString() ?? throw new InvalidDataException();
  private static string Hash(byte[] bytes) => "sha256:" + Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
  private static bool Digest(string value) => value.Length == 71 && value.StartsWith("sha256:", StringComparison.Ordinal) && value[7..].All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
  private static void Keys(JsonElement value, params string[] names)
  {
    var fields = value.EnumerateObject().Select(p => p.Name).ToArray();
    if (fields.Length != names.Length || !fields.Order(StringComparer.Ordinal).SequenceEqual(names.Order(StringComparer.Ordinal))) throw new InvalidDataException("Removal fields");
  }
  private static byte[] Canonical(JsonElement value, bool omitDigest = false) => Program.Json(w => WriteProperties(w, value, omitDigest));
  private static void WriteProperties(Utf8JsonWriter w, JsonElement value, bool omitDigest = false)
  {
    foreach (var property in value.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
    {
      if (omitDigest && property.Name == "request_digest") continue;
      w.WritePropertyName(property.Name);
      WriteValue(w, property.Value);
    }
  }
  private static void WriteValue(Utf8JsonWriter w, JsonElement value)
  {
    if (value.ValueKind == JsonValueKind.Object) { w.WriteStartObject(); WriteProperties(w, value); w.WriteEndObject(); }
    else if (value.ValueKind == JsonValueKind.Array) { w.WriteStartArray(); foreach (var item in value.EnumerateArray()) WriteValue(w, item); w.WriteEndArray(); }
    else value.WriteTo(w);
  }
  private static void Close(DirectoryLease.DirectoryHandle handle)
  {
    var valid = !handle.IsInvalid; handle.Dispose();
    if (valid && handle.ReleaseSucceeded != true) throw new IOException("Removal slot close uncertain");
  }
  public void Dispose()
  {
    var uncertain = false;
    foreach (var owner in held.Values) try { owner.Dispose(); } catch { uncertain = true; }
    held.Clear(); if (uncertain) throw new IOException("Removal session close uncertain");
  }
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", ExactSpelling = true)] private static extern uint WaitForSingleObject(SafeProcessHandle handle, uint timeout);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ReadFile(DirectoryLease.DirectoryHandle handle, [Out] byte[] bytes, uint length, out uint read, IntPtr overlapped);
}
