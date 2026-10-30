using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using LexRunner.WindowsCoordinator.SelectionCustody;
using Microsoft.Win32.SafeHandles;

namespace LexRunner.WindowsCoordinator.Client;

internal sealed record V3HeldDigest(long Bytes, string Sha256);
internal sealed record V3ServiceConfig(string Name, uint ServiceType, uint StartType,
    uint ErrorControl, string BinaryPath, string StartName, string LoadOrderGroup,
    string Dependencies, uint ServiceSidType);

// Read-only source observation. Every candidate, file hash and SCM string is
// comparison data, not installed authority or a SelectedEndpoint factory.
[SupportedOSPlatform("windows")]
internal static class CoordinatorV3InstalledObservation
{
    private const string CoordinatorName = "LexRunnerCoordinator";
    private const string WorkerName = "LexRunnerWorkerSlot1";
    private const string CoordinatorRelative = "service/LexRunner.WindowsCoordinator.Service.exe";
    private const string WorkerRelative = "service/LexRunner.WindowsCoordinator.WorkerSlot.exe";
    private const long MaxServiceImageBytes = 256L * 1024 * 1024;

    internal static CoordinatorObservation Observe()
    {
        if (!Environment.Is64BitProcess)
            return Stop("unsupported_host");
        var first = NativeRegistryReaderV3.ObserveSelected();
        if (first.Candidate is not { } selected)
            return CoordinatorV3RegistryObservation.FromCustody(first.Custody);
        try
        {
            using var held = V3HeldInstalledFiles.OpenInstalled(selected.GenerationId);
            var generation = held.GenerationPath;
            using var manifest = held.OpenManifest();
            byte[] manifestBytes;
            try { manifestBytes = ReadManifest(manifest); }
            catch { return Stop("graph_unavailable"); }
            GraphV3 graph;
            try { graph = GraphV3.Parse(manifestBytes, selected.ManifestDigest); }
            catch { return Stop("graph_invalid"); }
            if (!GraphMatches(selected, graph)) return Stop("graph_mismatch");
            // Preserve the prior observer's per-service hashing bound. AcquireGraph
            // checks actual stream lengths before hashing against these graph sizes.
            if (graph.ServiceImage.Bytes > MaxServiceImageBytes ||
                graph.WorkerServiceImage.Bytes > MaxServiceImageBytes)
                return Stop("image_unavailable");

            // Retain manifest, every graph member and their complete held ancestry
            // through fixed SCM/selection readback. No file stream or hash result
            // escapes this owner as installed authority. Signer, process, loader,
            // publication/history and provisioning qualification remain pending.
            held.AcquireGraph(graph);

            var configs = V3FixedScmReader.ReadBoth();
            if (configs is null) return Stop("scm_unavailable");
            if (!ScmMatches(configs.Value.Coordinator, configs.Value.Worker,
                    Path.Combine(generation, "service", "LexRunner.WindowsCoordinator.Service.exe"),
                    Path.Combine(generation, "service", "LexRunner.WindowsCoordinator.WorkerSlot.exe")))
                return Stop("scm_config_mismatch");
            var second = NativeRegistryReaderV3.ObserveSelected();
            if (second.Custody.State != "observed" || second.Candidate != selected)
                return Stop("selection_changed");
            var configsAfter = V3FixedScmReader.ReadBoth();
            if (configsAfter is null || configsAfter.Value != configs.Value)
                return Stop("scm_config_changed");
            held.VerifyGraphUnchanged();
            return new CoordinatorObservation("observed_source_only",
                "installed_structural_match_only");
        }
        catch (V3HeldPathException error) { return Stop(error.Reason); }
        catch { return Stop("installed_readback_unavailable"); }
    }

    private static CoordinatorObservation Stop(string reason) =>
        new("unavailable", reason);

    internal static bool GraphMatches(StructuralSelectionCandidateV3 selected, GraphV3 graph) =>
        selected.GenerationId == graph.GenerationId &&
        selected.GraphDigest == graph.GenerationId &&
        selected.ManifestDigest == graph.ManifestSha256 &&
        selected.ServiceImageDigest == graph.ServiceImage.Sha256 &&
        selected.WorkerServiceImageDigest == graph.WorkerServiceImage.Sha256 &&
        graph.ServiceImage.Path == CoordinatorRelative &&
        graph.WorkerServiceImage.Path == WorkerRelative;

    internal static bool ImagesMatch(GraphV3 graph, V3HeldDigest coordinator,
        V3HeldDigest worker) =>
        coordinator.Bytes == graph.ServiceImage.Bytes &&
        coordinator.Sha256 == graph.ServiceImage.Sha256 &&
        worker.Bytes == graph.WorkerServiceImage.Bytes &&
        worker.Sha256 == graph.WorkerServiceImage.Sha256;

    internal static bool ScmMatches(V3ServiceConfig coordinator, V3ServiceConfig worker,
        string coordinatorImage, string workerImage) =>
        Same(coordinator.Name, CoordinatorName) && Same(worker.Name, WorkerName) &&
        FixedService(coordinator, coordinatorImage, "NT SERVICE\\LexRunnerCoordinator") &&
        FixedService(worker, workerImage, "NT AUTHORITY\\LocalService");

    private static bool FixedService(V3ServiceConfig config, string image, string account) =>
        config.ServiceType == 0x10 && config.StartType == 3 &&
        config.ErrorControl == 1 && config.ServiceSidType == 3 &&
        FixedCommand(config.BinaryPath, image) &&
        Same(config.StartName, account) && config.LoadOrderGroup.Length == 0 &&
        config.Dependencies.Length == 0;

    private static bool FixedCommand(string command, string image)
    {
        const string suffix = " --service";
        return command.EndsWith(suffix, StringComparison.Ordinal) &&
            Same(command[..^suffix.Length], "\"" + image + "\"");
    }

    private static bool Same(string a, string b) =>
        string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    private static byte[] ReadManifest(FileStream stream)
    {
        if (stream.Length is < 1 or > 262_144) throw new InvalidDataException();
        var length = (int)stream.Length;
        var bytes = new byte[length];
        stream.ReadExactly(bytes);
        if (stream.Length != length) throw new InvalidDataException();
        return bytes;
    }

}

// Fixed read-only service configuration query. These handles close before the
// result is returned; the observation cannot bind a running PID or image.
[SupportedOSPlatform("windows")]
internal static class V3FixedScmReader
{
    private const uint ScManagerConnect = 1;
    private const uint ServiceQueryConfig = 1;
    private const uint ServiceConfigServiceSidInfo = 5;
    private const int ErrorInsufficientBuffer = 122;
    private const uint MaxConfigBytes = 8192;

    internal static (V3ServiceConfig Coordinator, V3ServiceConfig Worker)? ReadBoth()
    {
        using var manager = Native.OpenSCManagerW(null, null, ScManagerConnect);
        if (manager.IsInvalid) return null;
        var coordinator = Read(manager, "LexRunnerCoordinator");
        var worker = Read(manager, "LexRunnerWorkerSlot1");
        return coordinator is not null && worker is not null ? (coordinator, worker) : null;
    }

    private static V3ServiceConfig? Read(SafeServiceHandle manager, string name)
    {
        using var service = Native.OpenServiceW(manager, name, ServiceQueryConfig);
        if (service.IsInvalid) return null;
        if (QueryServiceConfigW(service, IntPtr.Zero, 0, out var needed) ||
            Marshal.GetLastWin32Error() != ErrorInsufficientBuffer ||
            needed < (uint)Marshal.SizeOf<NativeQueryServiceConfig>() || needed > MaxConfigBytes)
            return null;
        var buffer = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!QueryServiceConfigW(service, buffer, needed, out _)) return null;
            var config = Marshal.PtrToStructure<NativeQueryServiceConfig>(buffer);
            var command = ReadBoundedString(buffer, needed, config.BinaryPath);
            var account = ReadBoundedString(buffer, needed, config.StartName);
            var group = ReadBoundedString(buffer, needed, config.LoadOrderGroup);
            var dependencies = ReadDependencies(buffer, needed, config.Dependencies);
            if (command is null || account is null || group is null ||
                dependencies is null) return null;
            var sidBuffer = Marshal.AllocHGlobal(sizeof(uint));
            try
            {
                if (!QueryServiceConfig2W(service, ServiceConfigServiceSidInfo,
                        sidBuffer, sizeof(uint), out var sidNeeded) ||
                    sidNeeded != sizeof(uint)) return null;
                var sidType = (uint)Marshal.ReadInt32(sidBuffer);
                return new V3ServiceConfig(name, config.ServiceType, config.StartType,
                    config.ErrorControl, command, account, group, dependencies, sidType);
            }
            finally { Marshal.FreeHGlobal(sidBuffer); }
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static string? ReadBoundedString(IntPtr buffer, uint size, IntPtr pointer)
    {
        if (pointer == IntPtr.Zero) return "";
        var offset = pointer.ToInt64() - buffer.ToInt64();
        if (offset < 0 || offset >= size || (offset & 1) != 0) return null;
        var available = (int)size - (int)offset;
        var chars = new List<char>();
        for (var index = 0; index + 1 < available; index += 2)
        {
            var value = (char)(ushort)Marshal.ReadInt16(pointer, index);
            if (value == '\0') return new string([.. chars]);
            if (chars.Count == 4096) return null;
            chars.Add(value);
        }
        return null;
    }

    private static string? ReadDependencies(IntPtr buffer, uint size, IntPtr pointer)
    {
        var first = ReadBoundedString(buffer, size, pointer);
        if (first is null || first.Length != 0 || pointer == IntPtr.Zero) return first;
        var offset = pointer.ToInt64() - buffer.ToInt64();
        return offset >= 0 && offset + 4 <= size && Marshal.ReadInt16(pointer, 2) == 0
            ? "" : null;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeQueryServiceConfig
    {
        internal uint ServiceType, StartType, ErrorControl;
        internal IntPtr BinaryPath, LoadOrderGroup;
        internal uint TagId;
        internal IntPtr Dependencies, StartName, DisplayName;
    }

    [DllImport("advapi32.dll", EntryPoint = "QueryServiceConfigW", CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceConfigW(SafeServiceHandle service,
        IntPtr buffer, uint size, out uint needed);

    [DllImport("advapi32.dll", EntryPoint = "QueryServiceConfig2W", CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceConfig2W(SafeServiceHandle service,
        uint infoLevel, IntPtr buffer, uint size, out uint needed);
}
