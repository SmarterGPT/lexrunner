#if GIT_IMPORT_FIXTURE
using System.Buffers.Binary;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace LexRunner.WindowsCoordinator.Git;

// Offline import-table evidence for this exact installed Git for Windows build.
// Static names and bytes do not prove which DLL paths the child loader maps, or
// account for delay imports, LoadLibrary, executable helpers or OS redirection.
internal sealed record StaticGitImportFile(string Path, string Sha256,
    IReadOnlyList<string> ImportedDlls);
internal sealed record StaticGitImportInventory(bool Pinned, string Scope,
    IReadOnlyList<StaticGitImportFile> Files);

internal sealed class HeldStaticGitImports : IDisposable
{
    private const int MaxImageBytes = 32 * 1024 * 1024;
    private const int MaxImports = 64;
    private const int MaxNameBytes = 128;
    private readonly List<FileStream> _held;
    internal StaticGitImportInventory Observation { get; }

    private HeldStaticGitImports(List<FileStream> held, StaticGitImportInventory observation)
    { _held = held; Observation = observation; }

    private sealed record Spec(string Name, string Sha256, string[] Imports);
    private static readonly Spec[] Specs =
    [
        new("git.exe", "11ce9bfcb40927767c474326ee87477079e1cc24a9782e69936b3351b6c3c205",
        ["advapi32.dll", "libiconv-2.dll", "libintl-8.dll", "kernel32.dll",
         "msvcrt.dll", "ntdll.dll", "libpcre2-8-0.dll", "libwinpthread-1.dll",
         "user32.dll", "ws2_32.dll", "zlib1.dll"]),
        new("libiconv-2.dll", "ff31fa811f9c07cc7fdaa68c9e8bca3a7b4fdf6e0a079a58175ea58ba139c7ae",
        ["kernel32.dll", "msvcrt.dll"]),
        new("libintl-8.dll", "479c8bffc0da6d28747cde0f4dd4d7714050811ebdfdf1fcc807efd9818e5a7f",
        ["advapi32.dll", "libiconv-2.dll", "kernel32.dll", "msvcrt.dll"]),
        new("libpcre2-8-0.dll", "21d741e2c5089776a535587cd5fcd933b51054e16bf8e50855e74e68b3790228",
        ["kernel32.dll", "msvcrt.dll"]),
        new("libwinpthread-1.dll", "212e84730ce3ee28cd9fab37113a34931ea947ff538085372bef27c009010182",
        ["kernel32.dll", "msvcrt.dll"]),
        new("zlib1.dll", "cb7ab3788d10940df874acd97b1821bbb5ee4a91f3eec11982bb5bf7a3c96443",
        ["kernel32.dll", "msvcrt.dll"])
    ];

    internal static HeldStaticGitImports OpenPinned()
    {
        var held = new List<FileStream>(Specs.Length);
        var files = new List<StaticGitImportFile>(Specs.Length);
        try
        {
            foreach (var spec in Specs)
            {
                var path = Path.Combine(GitBundleImport.GitBin, spec.Name);
                if (!Path.IsPathFullyQualified(path) ||
                    !StringComparer.Ordinal.Equals(Path.GetFullPath(path), path))
                    throw new InvalidOperationException("static_git_path_invalid");
                var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                    FileShare.Read);
                held.Add(stream);
                RequireHeldPath(stream, path);
                if (stream.Length is < 512 or > MaxImageBytes)
                    throw new InvalidOperationException("static_git_image_size_invalid:" + spec.Name);
                var bytes = new byte[checked((int)stream.Length)];
                stream.ReadExactly(bytes);
                var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
                if (!StringComparer.Ordinal.Equals(sha, spec.Sha256))
                    throw new InvalidOperationException("static_git_hash_mismatch:" + spec.Name);
                var imports = ReadImportNames(bytes);
                if (imports.Length != spec.Imports.Length ||
                    !imports.Order(StringComparer.Ordinal).SequenceEqual(
                        spec.Imports.Order(StringComparer.Ordinal), StringComparer.Ordinal))
                    throw new InvalidOperationException("static_git_import_mismatch:" + spec.Name);
                files.Add(new StaticGitImportFile(path, sha, imports));
                stream.Position = 0;
            }
            return new HeldStaticGitImports(held,
                new StaticGitImportInventory(true, "offline_static_pe_imports_only", files));
        }
        catch
        {
            foreach (var stream in held) stream.Dispose();
            throw;
        }
    }

    public void Dispose()
    {
        foreach (var stream in _held) stream.Dispose();
    }

    internal void AssertUnchanged()
    {
        for (var i = 0; i < _held.Count; i++)
        {
            _held[i].Position = 0;
            var current = Convert.ToHexString(SHA256.HashData(_held[i])).ToLowerInvariant();
            if (!StringComparer.Ordinal.Equals(current, Observation.Files[i].Sha256))
                throw new InvalidOperationException("held_static_git_image_changed");
            _held[i].Position = 0;
        }
    }

    private static void RequireHeldPath(FileStream stream, string expected)
    {
        var buffer = new StringBuilder(32768);
        var count = GetFinalPathNameByHandleW(stream.SafeFileHandle, buffer,
            (uint)buffer.Capacity, 0);
        if (count == 0 || count >= buffer.Capacity)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "static_git_path_unavailable");
        if (!StringComparer.OrdinalIgnoreCase.Equals(buffer.ToString(0, (int)count),
                @"\\?\" + expected))
            throw new InvalidOperationException("static_git_held_path_mismatch");
    }

    private static string[] ReadImportNames(byte[] bytes)
    {
        var data = bytes.AsSpan();
        if (data.Length < 512 || Read16(data, 0) != 0x5a4d)
            throw new InvalidOperationException("static_git_pe_dos_invalid");
        var pe = checked((int)Read32(data, 0x3c));
        Bounds(data, pe, 24);
        if (Read32(data, pe) != 0x00004550 || Read16(data, pe + 4) != 0x8664)
            throw new InvalidOperationException("static_git_pe_header_invalid");
        var sectionCount = Read16(data, pe + 6);
        var optionalSize = Read16(data, pe + 20);
        if (sectionCount is < 1 or > 96 || optionalSize < 128)
            throw new InvalidOperationException("static_git_pe_sections_invalid");
        var optional = pe + 24;
        Bounds(data, optional, optionalSize);
        if (Read16(data, optional) != 0x20b || Read32(data, optional + 108) < 2)
            throw new InvalidOperationException("static_git_pe_optional_invalid");
        var importRva = Read32(data, optional + 120);
        var importSize = Read32(data, optional + 124);
        if (importRva == 0 || importSize is < 20 or > 1_048_576)
            throw new InvalidOperationException("static_git_pe_import_directory_invalid");
        var sections = optional + optionalSize;
        Bounds(data, sections, sectionCount * 40);
        int RvaOffset(uint rva)
        {
            for (var i = 0; i < sectionCount; i++)
            {
                var section = sections + i * 40;
                var virtualSize = Read32(bytes, section + 8);
                var address = Read32(bytes, section + 12);
                var rawSize = Read32(bytes, section + 16);
                var rawOffset = Read32(bytes, section + 20);
                var extent = Math.Max(virtualSize, rawSize);
                if (rva >= address && (ulong)rva < (ulong)address + extent)
                {
                    var delta = rva - address;
                    if (delta >= rawSize) break;
                    var offset = checked((int)(rawOffset + delta));
                    Bounds(bytes, offset, 1);
                    return offset;
                }
            }
            throw new InvalidOperationException("static_git_pe_rva_invalid");
        }
        var importOffset = RvaOffset(importRva);
        Bounds(data, importOffset, checked((int)importSize));
        var names = new List<string>();
        for (var i = 0; i < MaxImports && (i + 1) * 20 <= importSize; i++)
        {
            var descriptor = importOffset + i * 20;
            var nameRva = Read32(data, descriptor + 12);
            if (nameRva == 0)
            {
                if (Read32(data, descriptor) != 0 || Read32(data, descriptor + 4) != 0 ||
                    Read32(data, descriptor + 8) != 0 || Read32(data, descriptor + 16) != 0)
                    throw new InvalidOperationException("static_git_pe_import_terminator_invalid");
                if (names.Count == 0) throw new InvalidOperationException("static_git_pe_imports_empty");
                return names.ToArray();
            }
            var nameAt = RvaOffset(nameRva);
            var end = nameAt;
            while (end < data.Length && end - nameAt <= MaxNameBytes && data[end] != 0) end++;
            if (end == nameAt || end - nameAt > MaxNameBytes || end == data.Length)
                throw new InvalidOperationException("static_git_pe_import_name_invalid");
            var name = Encoding.ASCII.GetString(data[nameAt..end]).ToLowerInvariant();
            if (name.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or '_')) ||
                !AddIfUnique(names, name))
                throw new InvalidOperationException("static_git_pe_import_name_invalid");
        }
        throw new InvalidOperationException("static_git_pe_imports_unterminated");
    }

    private static bool AddIfUnique(List<string> names, string name)
    {
        if (names.Contains(name, StringComparer.Ordinal)) return false;
        names.Add(name);
        return true;
    }
    private static void Bounds(ReadOnlySpan<byte> data, int offset, int length)
    {
        if (offset < 0 || length < 0 || offset > data.Length - length)
            throw new InvalidOperationException("static_git_pe_bounds_invalid");
    }
    private static ushort Read16(ReadOnlySpan<byte> data, int offset)
    { Bounds(data, offset, 2); return BinaryPrimitives.ReadUInt16LittleEndian(data[offset..]); }
    private static uint Read32(ReadOnlySpan<byte> data, int offset)
    { Bounds(data, offset, 4); return BinaryPrimitives.ReadUInt32LittleEndian(data[offset..]); }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true,
        SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(Microsoft.Win32.SafeHandles.SafeFileHandle handle,
        StringBuilder path, uint capacity, uint flags);
}
#endif
