using System.Text.Json;

// Structural parser fixture. No MSI, SCM, selection, or installed-root access.
if (args.Length != 3 || args[0] != "--parse" || !Path.IsPathFullyQualified(args[1]) ||
    !File.Exists(args[1]))
{
  Console.Error.WriteLine("graph_v3_fixture_refused");
  return 3;
}
try
{
  var graph = GraphV3.Parse(File.ReadAllBytes(args[1]), args[2]);
  Console.WriteLine(JsonSerializer.Serialize(new
  {
    schemaVersion = "windows-coordinator-graph-v3-fixture/1",
    graphDigest = graph.GenerationId,
    manifestSha256 = graph.ManifestSha256,
    fileCount = graph.Files.Count,
    serviceImage = graph.ServiceImage.Path,
    workerServiceImage = graph.WorkerServiceImage.Path,
    authorizesLaunch = false,
    installed = false,
  }));
  return 0;
}
catch (Exception exception) when (exception is IOException or InvalidDataException or UnauthorizedAccessException or
  System.Security.SecurityException or JsonException or InvalidOperationException or
  ArgumentException or OverflowException)
{
  Console.Error.WriteLine("graph_v3_fixture_refused");
  return 3;
}
