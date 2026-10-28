using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using Microsoft.Win32;

namespace LexRunner.WindowsCoordinator.Client;

internal interface ICoordinatorSelectionStore
{
    string? ReadSelection();
    CoordinatorCatalog? ReadCatalog(string generationId);
}

internal interface ICoordinatorGenerationStore
{
    string ImagePath(string generationId);
    byte[]? ReadManifest(string generationId);
    string? ReadImageDigest(string generationId);
}

internal interface ICoordinatorServiceConfigSource
{
    CoordinatorServiceConfig? Read();
}

[SupportedOSPlatform("windows")]
internal sealed class WindowsCoordinatorSelectionStore : ICoordinatorSelectionStore
{
    private const string Key = @"Software\SmarterGPT.LexRunner.WindowsCoordinator";

    public string? ReadSelection()
    {
        using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine,
            RegistryView.Registry64);
        using var key = machine.OpenSubKey(Key, false);
        if (key is null || key.GetValueKind("ActiveSelection") != RegistryValueKind.String)
            return null;
        var value = key.GetValue("ActiveSelection", null,
            RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
        return value is { Length: > 0 and <= 4096 } ? value : null;
    }

    public CoordinatorCatalog? ReadCatalog(string generationId)
    {
        if (!CoordinatorSelectionContract.Digest(generationId)) return null;
        using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine,
            RegistryView.Registry64);
        using var key = machine.OpenSubKey($@"{Key}\Generations\{generationId}", false);
        if (key is null) return null;
        var names = key.GetValueNames();
        if (names.Length != 4 || names.Distinct(StringComparer.Ordinal).Count() != 4 ||
            !new HashSet<string>(names, StringComparer.Ordinal).SetEquals(
                ["ManifestDigest", "ImageDigest", "State", "ServiceName"])) return null;
        foreach (var name in names)
            if (key.GetValueKind(name) != RegistryValueKind.String) return null;
        string? Read(string name) => key.GetValue(name, null,
            RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
        var manifest = Read("ManifestDigest");
        var image = Read("ImageDigest");
        var state = Read("State");
        var service = Read("ServiceName");
        return CoordinatorSelectionContract.Digest(manifest) &&
            CoordinatorSelectionContract.Digest(image) &&
            state is "qualified" or "provisioned-unqualified" &&
            service == CoordinatorSelectionContract.ServiceName
            ? new CoordinatorCatalog(manifest!, image!, state!, service!) : null;
    }
}

internal sealed class WindowsCoordinatorGenerationStore : ICoordinatorGenerationStore
{
    private const long MaxImageBytes = 128L * 1024 * 1024;

    private static string GenerationPath(string generationId)
    {
        if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess ||
            !CoordinatorSelectionContract.Digest(generationId))
            throw new InvalidOperationException("Unsupported generation location");
        var system = Environment.SystemDirectory;
        var volume = Path.GetPathRoot(system);
        if (volume is not { Length: 3 } || volume[1] != ':' || volume[2] != '\\' ||
            !char.IsAsciiLetter(volume[0]) ||
            !string.Equals(Path.GetFileName(system), "System32",
                StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetFullPath(system), system,
                StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Unsupported Windows system root");
        var parts = new[] {
            volume,
            Path.Combine(volume, "Program Files"),
            Path.Combine(volume, "Program Files", "SmarterGPT.LexRunner.WindowsCoordinator"),
            Path.Combine(volume, "Program Files", "SmarterGPT.LexRunner.WindowsCoordinator",
                "generations"),
            Path.Combine(volume, "Program Files", "SmarterGPT.LexRunner.WindowsCoordinator",
                "generations", generationId)
        };
        foreach (var part in parts)
        {
            var attributes = File.GetAttributes(part);
            if ((attributes & FileAttributes.Directory) == 0 ||
                (attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("Generation directory unavailable");
        }
        return parts[^1];
    }

    public string ImagePath(string generationId) =>
        Path.Combine(GenerationPath(generationId), CoordinatorSelectionContract.ImageName);

    public byte[]? ReadManifest(string generationId)
    {
        var file = Path.Combine(GenerationPath(generationId), "generation.json");
        if ((File.GetAttributes(file) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
            return null;
        using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length is < 1 or > 16384) return null;
        var bytes = new byte[stream.Length];
        stream.ReadExactly(bytes);
        if (stream.Length != bytes.Length ||
            (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) return null;
        return bytes;
    }

    public string? ReadImageDigest(string generationId)
    {
        var file = ImagePath(generationId);
        if ((File.GetAttributes(file) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
            return null;
        using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length is < 1 or > MaxImageBytes) return null;
        var length = stream.Length;
        var digest = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        return stream.Length == length &&
            (File.GetAttributes(file) & FileAttributes.ReparsePoint) == 0 ? digest : null;
    }
}

internal sealed class WindowsCoordinatorServiceConfigSource : ICoordinatorServiceConfigSource
{
    private const uint ScManagerConnect = 0x0001;
    private const uint ServiceQueryConfig = 0x0001;
    private const int ErrorInsufficientBuffer = 122;
    private const uint MaxConfigBytes = 8192;

    public CoordinatorServiceConfig? Read()
    {
        using var manager = Native.OpenSCManagerW(null, null, ScManagerConnect);
        if (manager.IsInvalid) return null;
        using var service = Native.OpenServiceW(manager,
            CoordinatorSelectionContract.ServiceName, ServiceQueryConfig);
        if (service.IsInvalid) return null;
        var succeeded = QueryServiceConfigW(service, IntPtr.Zero, 0, out var needed);
        if (succeeded || Marshal.GetLastWin32Error() != ErrorInsufficientBuffer ||
            needed < (uint)Marshal.SizeOf<NativeQueryServiceConfig>() ||
            needed > MaxConfigBytes) return null;
        var buffer = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!QueryServiceConfigW(service, buffer, needed, out _)) return null;
            var config = Marshal.PtrToStructure<NativeQueryServiceConfig>(buffer);
            var binaryPath = Marshal.PtrToStringUni(config.BinaryPath);
            var startName = Marshal.PtrToStringUni(config.StartName);
            var group = Marshal.PtrToStringUni(config.LoadOrderGroup);
            var dependencies = Marshal.PtrToStringUni(config.Dependencies);
            if (binaryPath is null || startName is null) return null;
            return new CoordinatorServiceConfig(config.ServiceType, config.StartType,
                config.ErrorControl, binaryPath, startName, group ?? "",
                dependencies ?? "");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeQueryServiceConfig
    {
        public uint ServiceType, StartType, ErrorControl;
        public IntPtr BinaryPath, LoadOrderGroup;
        public uint TagId;
        public IntPtr Dependencies, StartName, DisplayName;
    }

    [DllImport("advapi32.dll", EntryPoint = "QueryServiceConfigW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceConfigW(SafeServiceHandle service,
        IntPtr buffer, uint bufferSize, out uint needed);
}
