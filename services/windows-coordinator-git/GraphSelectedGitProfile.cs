#if GIT_IMPORT_FIXTURE
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace LexRunner.WindowsCoordinator.Git;

// An offline, caller-selected comparison fixture. It does not authenticate a
// selection, protect directory ancestry, or authorize a service launch.
internal sealed class GraphSelectedGitProfile : IDisposable
{
    private const int MaxEntries = 1024;
    private static readonly Dictionary<string, string> GitMembers = new(StringComparer.Ordinal)
    {
        ["git/mingw64/bin/git.exe"] = "git-entry",
        ["git/mingw64/bin/libiconv-2.dll"] = "native-dll",
        ["git/mingw64/bin/libintl-8.dll"] = "native-dll",
        ["git/mingw64/bin/libpcre2-8-0.dll"] = "native-dll",
        ["git/mingw64/bin/libwinpthread-1.dll"] = "native-dll",
        ["git/mingw64/bin/zlib1.dll"] = "native-dll",
        ["git/mingw64/libexec/git-core/git.exe"] = "git-tool"
    };
    private readonly List<(FileStream Stream, string Sha256)> _held;
    internal string GitImage { get; }
    internal string GitBin { get; }
    internal string GitExecPath { get; }
    internal string GenerationId { get; }
    internal string ManifestSha256 { get; }
    internal int MemberCount { get; }
    internal string GitImageSha256 { get; }

    private GraphSelectedGitProfile(string root, GraphV2 graph,
        List<(FileStream Stream, string Sha256)> held)
    {
        _held = held;
        GitImage = Path.Combine(root, "git", "mingw64", "bin", "git.exe");
        GitBin = Path.GetDirectoryName(GitImage)!;
        GitExecPath = Path.Combine(root, "git", "mingw64", "libexec", "git-core");
        GenerationId = graph.GenerationId;
        ManifestSha256 = graph.ManifestSha256;
        MemberCount = graph.Files.Count;
        GitImageSha256 = graph.Files.Single(file => file.Role == "git-entry").Sha256;
    }

    internal static GraphSelectedGitProfile Open(string payloadRoot, string expectedManifestSha256)
    {
        if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess ||
            !Path.IsPathFullyQualified(payloadRoot) || payloadRoot.Contains('\0'))
            throw new InvalidDataException("graph_git_payload_root_invalid");
        var root = Path.GetFullPath(payloadRoot).TrimEnd(Path.DirectorySeparatorChar);
        if (!StringComparer.Ordinal.Equals(root, payloadRoot.TrimEnd(Path.DirectorySeparatorChar)) ||
            !Directory.Exists(root))
            throw new InvalidDataException("graph_git_payload_root_not_canonical");
        RequireNoReparseAncestors(root);
        var held = new List<(FileStream Stream, string Sha256)>();
        try
        {
            var manifestPath = Path.Combine(root, "generation-graph.json");
            var manifest = Hold(manifestPath, null, 262144);
            held.Add((manifest.Stream, manifest.Sha256));
            var graph = GraphV2.Parse(manifest.Bytes, expectedManifestSha256);
            var selectedGit = graph.Files.Where(file => file.Path.StartsWith("git/", StringComparison.Ordinal) ||
                file.Role is "git-entry" or "git-tool" or "git-support-file").ToArray();
            if (selectedGit.Length != GitMembers.Count ||
                selectedGit.Any(file => !GitMembers.TryGetValue(file.Path, out var role) ||
                    !StringComparer.Ordinal.Equals(role, file.Role)))
                throw new InvalidDataException("graph_git_member_inventory_invalid");
            RequireExactFilesystemInventory(root, graph);
            foreach (var file in graph.Files)
            {
                var path = Path.Combine(root, file.Path.Replace('/', Path.DirectorySeparatorChar));
                var opened = Hold(path, file.Sha256, file.Bytes);
                held.Add((opened.Stream, opened.Sha256));
            }
            return new GraphSelectedGitProfile(root, graph, held);
        }
        catch
        {
            foreach (var item in held) item.Stream.Dispose();
            throw;
        }
    }

    internal void AssertUnchanged()
    {
        foreach (var item in _held)
        {
            item.Stream.Position = 0;
            var current = Convert.ToHexString(SHA256.HashData(item.Stream)).ToLowerInvariant();
            if (!StringComparer.Ordinal.Equals(current, item.Sha256))
                throw new IOException("graph_git_held_member_changed");
            item.Stream.Position = 0;
        }
    }

    public void Dispose()
    {
        foreach (var item in _held) item.Stream.Dispose();
    }

    private static (FileStream Stream, string Sha256, byte[] Bytes) Hold(
        string path, string? expectedSha256, int expectedBytes)
    {
        var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        try
        {
            RequireHeldPath(stream.SafeFileHandle, path);
            if (stream.Length is < 1 or > 256L * 1024 * 1024 ||
                (expectedSha256 is not null && stream.Length != expectedBytes) ||
                (expectedSha256 is null && stream.Length > expectedBytes))
                throw new InvalidDataException("graph_git_member_size_mismatch");
            byte[] bytes;
            string sha;
            if (expectedSha256 is null)
            {
                bytes = new byte[checked((int)stream.Length)];
                stream.ReadExactly(bytes);
                sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            }
            else
            {
                bytes = [];
                sha = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
            }
            if (expectedSha256 is not null && !StringComparer.Ordinal.Equals(sha, expectedSha256))
                throw new InvalidDataException("graph_git_member_digest_mismatch");
            stream.Position = 0;
            return (stream, sha, bytes);
        }
        catch { stream.Dispose(); throw; }
    }

    private static void RequireHeldPath(SafeFileHandle handle, string expected)
    {
        var buffer = new StringBuilder(32768);
        var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "graph_git_held_path_unavailable");
        if (!StringComparer.OrdinalIgnoreCase.Equals(buffer.ToString(0, (int)length),
                @"\\?\" + expected))
            throw new InvalidDataException("graph_git_held_path_mismatch");
    }

    private static void RequireNoReparseAncestors(string path)
    {
        for (string? current = path; current is not null; current = Path.GetDirectoryName(current))
        {
            if (File.GetAttributes(current).HasFlag(FileAttributes.ReparsePoint))
                throw new InvalidDataException("graph_git_reparse_ancestor");
            var parent = Path.GetDirectoryName(current);
            if (parent is null || StringComparer.OrdinalIgnoreCase.Equals(parent, current)) break;
        }
    }

    private static void RequireExactFilesystemInventory(string root, GraphV2 graph)
    {
        var expected = new HashSet<string>(graph.Files.Select(file => file.Path), StringComparer.Ordinal);
        expected.Add("generation-graph.json");
        var expectedDirectories = new HashSet<string>(StringComparer.Ordinal);
        foreach (var file in graph.Files)
        {
            var parts = file.Path.Split('/');
            for (var index = 1; index < parts.Length; index++)
                expectedDirectories.Add(string.Join('/', parts.Take(index)));
        }
        var actual = new HashSet<string>(StringComparer.Ordinal);
        var stack = new Stack<DirectoryInfo>();
        stack.Push(new DirectoryInfo(root));
        var count = 0;
        while (stack.Count != 0)
        {
            foreach (var entry in stack.Pop().EnumerateFileSystemInfos())
            {
                if (++count > MaxEntries) throw new InvalidDataException("graph_git_entry_limit");
                if (entry.Attributes.HasFlag(FileAttributes.ReparsePoint))
                    throw new InvalidDataException("graph_git_reparse_entry");
                var relative = Path.GetRelativePath(root, entry.FullName).Replace('\\', '/');
                if (entry is DirectoryInfo directory)
                {
                    if (!expectedDirectories.Remove(relative))
                        throw new InvalidDataException("graph_git_unlisted_or_aliased_directory");
                    stack.Push(directory);
                    continue;
                }
                if (!expected.Remove(relative) || !actual.Add(relative))
                    throw new InvalidDataException("graph_git_unlisted_or_aliased_entry");
            }
        }
        if (expected.Count != 0 || expectedDirectories.Count != 0)
            throw new InvalidDataException("graph_git_missing_member");
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true,
        SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,
        StringBuilder path, uint capacity, uint flags);
}
#endif
