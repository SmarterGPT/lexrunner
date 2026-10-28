using System;
using System.IO;
using System.Diagnostics;

// Unsigned single-image test canary, never packaged or selected as a helper.
if (!OperatingSystem.IsWindows()) return 2;
if (args.Length == 2 && args[0] == "--read")
{
  var bytes = File.ReadAllBytes(args[1]);
  if (bytes.Length > 1024) return 3;
  Console.OpenStandardOutput().Write(bytes); return 0;
}
if (args.Length == 2 && args[0] == "--touch")
{ File.WriteAllText(args[1], "resumed"); return 0; }
if (args.Length == 3 && args[0] == "--cwd-read")
{
  try { File.WriteAllText(args[2], File.ReadAllText(args[1])); return 0; }
  catch (DirectoryNotFoundException) { return 4; }
  catch (FileNotFoundException) { return 4; }
}
if (args.Length == 4 && args[0] == "--launch-cwd")
{
  var start = new ProcessStartInfo(args[1]) { WorkingDirectory = args[2], UseShellExecute = false,
    CreateNoWindow = true };
  start.ArgumentList.Add("--cwd-read"); start.ArgumentList.Add("value"); start.ArgumentList.Add(args[3]);
  using var child = Process.Start(start);
  if (child == null) return 5;
  if (!child.WaitForExit(5000)) { child.Kill(entireProcessTree: true); child.WaitForExit(); return 6; }
  return child.ExitCode;
}
if (args.Length == 2 && args[0] == "--hold")
{ File.WriteAllText(args[1], Environment.ProcessId.ToString()); System.Threading.Thread.Sleep(10000); return 0; }
if (args.Length == 3 && args[0] == "--launch-hold")
{
  var start = new ProcessStartInfo(args[1]) { UseShellExecute = false, CreateNoWindow = true };
  start.ArgumentList.Add("--hold"); start.ArgumentList.Add(args[2]);
  using var child = Process.Start(start);
  if (child == null) return 5;
  if (!child.WaitForExit(10000)) { child.Kill(entireProcessTree: true); child.WaitForExit(); return 6; }
  return child.ExitCode;
}
if (args.Length > 0 && args[0].Equals("/d", StringComparison.OrdinalIgnoreCase))
{ Console.Write("namespace-canary"); return 0; }
return 2;
