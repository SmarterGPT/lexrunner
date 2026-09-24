using System.Diagnostics;
using System.Text.Json;

// Cooperative ordering experiment ONLY. File barriers are driver instructions,
// not authenticated authority. Not compiled into/reachable from the helper.
internal static class AdmissionProbe
{
  internal static int Watch(string pid)
  {
    if (!int.TryParse(pid, out var id) || id <= 0) return 2;
    using var process = Process.GetProcessById(id);
    // Open and retain the actual process handle before announcing readiness.
    // Subsequent PID reuse cannot satisfy this wait with a different process.
    _ = process.Handle;
    if (process.HasExited) return 3;
    Console.WriteLine("watching");
    Console.Out.Flush();
    if (!process.WaitForExit(20000)) return 4;
    Console.WriteLine("exited:" + process.ExitCode);
    return 0;
  }
  internal static int Run(string root, string request)
  {
    if (!Path.IsPathFullyQualified(root) || Path.GetFileName(root) != "interrupted-content" ||
        !Path.GetFileName(Path.GetDirectoryName(root)!).StartsWith("removal-probe-", StringComparison.Ordinal) ||
        request.Length is < 1 or > 32 || request.Any(c => !char.IsAsciiLetterOrDigit(c))) return 2;
    var timer = Stopwatch.StartNew();
    void Emit(string stage)
    {
      using var buffer = new MemoryStream();
      using (var json = new Utf8JsonWriter(buffer))
      {
        json.WriteStartObject();
        json.WriteString("request", request);
        json.WriteString("stage", stage);
        json.WriteNumber("pid", Environment.ProcessId);
        json.WriteNumber("elapsedMs", timer.Elapsed.TotalMilliseconds);
        json.WriteEndObject();
      }
      var text = System.Text.Encoding.UTF8.GetString(buffer.ToArray());
      var signal = Path.Combine(root, request + "." + stage + ".json");
      File.WriteAllText(signal + ".tmp", text);
      File.Move(signal + ".tmp", signal);
    }
    string? Wait(string phase)
    {
      var path = Path.Combine(root, request + "." + phase);
      // Poll explicit barriers, never assume an ordering from elapsed sleep.
      // The single deadline also bounds an orphan waiting for its driver.
      while (timer.ElapsedMilliseconds < 15000)
      {
        if (File.Exists(path))
        {
          using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
          if (file.Length > 32) throw new InvalidDataException("Oversized fixture instruction");
          using var reader = new StreamReader(file);
          return reader.ReadToEnd();
        }
        Thread.Sleep(10);
      }
      return null;
    }
    FileStream owner;
    try
    {
      // The pre-created slot is outside the deletion target. Never unlink it
      // on release: replacing its name would let another process lock a new file.
      owner = new FileStream(Path.Combine(root, "effect-owner.lock"), FileMode.Open,
          FileAccess.ReadWrite, FileShare.None);
    }
    catch (IOException error) when ((error.HResult & 0xffff) == 32)
    { Emit("busy"); return 0; }
    var outcome = "cancelled";
    using (owner)
    {
      Emit("held");
      var decision = Wait("decision");
      if (decision == "admit")
      {
        Emit("admitted");
        var finish = Wait("finish");
        if (finish == "mutate")
        {
          // Linked native primitive, same exact known-file partial effect as the
          // existing restart fixture. No arbitrary or recursive delete facility.
          var output = Console.Out;
          try
          {
            // Coordinator pipe loss must not abort this admitted fixture effect.
            Console.SetOut(TextWriter.Null);
            if (WorktreeRemovalProbe.InterruptChild(root, "content", wait: false) != 0)
              throw new InvalidDataException("Native fixture mutation failed");
          }
          finally { Console.SetOut(output); }
          outcome = "effect-completed";
        }
        else if (finish == null) outcome = "deadline-before-effect";
        else if (finish != "cancel") throw new InvalidDataException("Unknown finish instruction");
      }
      else if (decision == null) outcome = "deadline-before-admission";
      else if (decision != "deny") throw new InvalidDataException("Unknown admission instruction");
    }
    // Recorded only after slot and native handles close. Driver separately waits
    // on an already-open process handle before cleaning the fixture.
    Emit(outcome);
    return 0;
  }
}
