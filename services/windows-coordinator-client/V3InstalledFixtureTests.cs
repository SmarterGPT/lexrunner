#if COORDINATOR_CLIENT_FIXTURE_TESTS
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using LexRunner.WindowsCoordinator.Client;
using LexRunner.WindowsCoordinator.SelectionCustody;

// Pure comparison cases. This route creates no pipe, registry key, service,
// ACL or installed file. The graph and paths are synthetic comparison data.
[SupportedOSPlatform("windows")]
internal static class V3InstalledFixtureTests
{
    internal static int RunPure()
    {
        var results = new List<TestCase>();
        var failures = new List<string>();
        Run(results, failures);
        Program.Emit(new TestReport { State = failures.Count == 0 ? "pass" : "fail",
            Profile = "v3_installed_source_only_pure", Results = results, Failures = failures },
            failures.Count == 0 ? 0 : 1);
        return failures.Count == 0 ? 0 : 1;
    }

    internal static void Run(List<TestCase> results, List<string> failures)
    {
        void Check(string name, bool passed)
        {
            results.Add(new TestCase { Name = name, Passed = passed,
                BytesWritten = 0, ServerBytesRead = 0 });
            if (!passed) failures.Add(name);
        }
        var (graph, selected, coordinatorBytes, workerBytes) = SyntheticGraph();
        var goodCoordinator = new V3HeldDigest(coordinatorBytes.Length, Sha(coordinatorBytes));
        var goodWorker = new V3HeldDigest(workerBytes.Length, Sha(workerBytes));
        Check("v3_graph_exact_roles", CoordinatorV3InstalledObservation.GraphMatches(selected, graph));
        Check("v3_graph_id_refused", !CoordinatorV3InstalledObservation.GraphMatches(
            selected with { GenerationId = new string('a', 64) }, graph));
        Check("v3_manifest_pin_refused", !CoordinatorV3InstalledObservation.GraphMatches(
            selected with { ManifestDigest = new string('b', 64) }, graph));
        Check("v3_coordinator_pin_refused", !CoordinatorV3InstalledObservation.GraphMatches(
            selected with { ServiceImageDigest = new string('c', 64) }, graph));
        Check("v3_worker_pin_refused", !CoordinatorV3InstalledObservation.GraphMatches(
            selected with { WorkerServiceImageDigest = new string('d', 64) }, graph));
        Check("v3_images_exact", CoordinatorV3InstalledObservation.ImagesMatch(
            graph, goodCoordinator, goodWorker));
        Check("v3_worker_bytes_refused", !CoordinatorV3InstalledObservation.ImagesMatch(
            graph, goodCoordinator, goodWorker with { Sha256 = new string('e', 64) }));
        Check("v3_worker_length_refused", !CoordinatorV3InstalledObservation.ImagesMatch(
            graph, goodCoordinator, goodWorker with { Bytes = goodWorker.Bytes + 1 }));
        Check("v3_coordinator_bytes_refused", !CoordinatorV3InstalledObservation.ImagesMatch(
            graph, goodCoordinator with { Sha256 = new string('f', 64) }, goodWorker));

        const string root = @"C:\Program Files\SmarterGPT.LexRunner.WindowsCoordinator\generations\";
        var coordinatorImage = root + selected.GenerationId +
            @"\service\LexRunner.WindowsCoordinator.Service.exe";
        var workerImage = root + selected.GenerationId +
            @"\service\LexRunner.WindowsCoordinator.WorkerSlot.exe";
        var coordinator = new V3ServiceConfig("LexRunnerCoordinator", 0x10, 3, 1,
            "\"" + coordinatorImage + "\" --service", "NT SERVICE\\LexRunnerCoordinator",
            "", "", 3);
        var worker = new V3ServiceConfig("LexRunnerWorkerSlot1", 0x10, 3, 1,
            "\"" + workerImage + "\" --service", "NT AUTHORITY\\LocalService",
            "", "", 3);
        bool Match(V3ServiceConfig c, V3ServiceConfig w) =>
            CoordinatorV3InstalledObservation.ScmMatches(c, w, coordinatorImage, workerImage);
        Check("v3_scm_exact", Match(coordinator, worker));
        Check("v3_scm_windows_path_account_case_accepted", Match(coordinator,
            worker with { BinaryPath = "\"" + workerImage.ToUpperInvariant() + "\" --service",
                StartName = "nt authority\\localservice" }));
        Check("v3_worker_name_refused", !Match(coordinator,
            worker with { Name = "LexRunnerWorkerSlot2" }));
        Check("v3_worker_command_refused", !Match(coordinator,
            worker with { BinaryPath = "\"" + coordinatorImage + "\" --service" }));
        Check("v3_worker_service_argument_case_refused", !Match(coordinator,
            worker with { BinaryPath = "\"" + workerImage + "\" --SERVICE" }));
        Check("v3_worker_account_refused", !Match(coordinator,
            worker with { StartName = "NT SERVICE\\LexRunnerCoordinator" }));
        Check("v3_worker_sid_type_refused", !Match(coordinator,
            worker with { ServiceSidType = 1 }));
        Check("v3_worker_start_type_refused", !Match(coordinator,
            worker with { StartType = 2 }));
        Check("v3_coordinator_sid_type_refused", !Match(
            coordinator with { ServiceSidType = 1 }, worker));
        Check("v3_worker_dependency_refused", !Match(coordinator,
            worker with { Dependencies = "AnotherService" }));
    }

    private static (GraphV3 Graph, StructuralSelectionCandidateV3 Selected,
        byte[] CoordinatorBytes, byte[] WorkerBytes) SyntheticGraph()
    {
        var members = new (string Path, string Role)[] {
            ("bin/lexrunner-windows-boundary-helper.exe", "helper-image"),
            ("client/lexrunner-windows-coordinator-client.exe", "client-image"),
            ("git/cmd/git.exe", "git-entry"),
            ("node/better_sqlite3.node", "sqlite-addon"),
            ("node/node.exe", "node-image"),
            ("node/private-admission-worker.mjs", "admission-entry"),
            ("service/LexRunner.WindowsCoordinator.Service.exe", "service-image"),
            ("service/LexRunner.WindowsCoordinator.WorkerSlot.exe", "worker-service-image"),
        };
        byte[] Bytes(string path) => Encoding.UTF8.GetBytes("synthetic-v3:" + path + "\n");
        var files = new StringBuilder("[");
        for (var index = 0; index < members.Length; index++)
        {
            if (index > 0) files.Append(',');
            var member = members[index];
            var bytes = Bytes(member.Path);
            files.Append("{\"bytes\":").Append(bytes.Length)
                .Append(",\"path\":\"").Append(member.Path)
                .Append("\",\"role\":\"").Append(member.Role)
                .Append("\",\"sha256\":\"").Append(Sha(bytes)).Append("\"}");
        }
        files.Append(']');
        var leading = "{\"architecture\":\"win-x64\",\"boundaryProtocolVersion\":\"2.2.0\"," +
            "\"coordinatorProtocolVersion\":\"1.0.0\",\"files\":" + files + ",";
        const string trailing = "\"profile\":\"windows-coordinator-service-msi/3\"," +
            "\"removalProtocolVersion\":\"1.0.0\"," +
            "\"schemaVersion\":\"lexrunner-windows-coordinator-generation-graph/3\"," +
            "\"serviceName\":\"LexRunnerCoordinator\",\"workerServiceName\":\"LexRunnerWorkerSlot1\"," +
            "\"workerServiceSid\":\"S-1-5-80-2257548793-97284598-3436774358-445624465-2531346843\"," +
            "\"workerTokenUserSid\":\"S-1-5-19\"}";
        var canonicalBody = leading + trailing;
        var id = Sha(Encoding.UTF8.GetBytes(
            "lexrunner-windows-coordinator-generation-graph/3\n" + canonicalBody));
        var manifestBytes = Encoding.UTF8.GetBytes(leading +
            "\"graphDigest\":\"" + id + "\"," + trailing);
        var graph = GraphV3.Parse(manifestBytes, Sha(manifestBytes));
        var selected = new StructuralSelectionCandidateV3(graph.GenerationId,
            graph.GenerationId, graph.ManifestSha256,
            graph.ServiceImage.Sha256, graph.WorkerServiceImage.Sha256, 1);
        return (graph, selected, Bytes(members[6].Path), Bytes(members[7].Path));
    }

    private static string Sha(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
#endif
