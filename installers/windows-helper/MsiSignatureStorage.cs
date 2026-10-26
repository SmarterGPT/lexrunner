#nullable enable
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Runtime.Versioning;

// Read-only qualification helper; never performs an install or approves a signer.
[SupportedOSPlatform("windows")]
public static class LexRunnerMsiSignatureStorage
{
  [ComImport, Guid("0000000B-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IStoragePrefix
  {
    void CreateStream([MarshalAs(UnmanagedType.LPWStr)] string name, uint mode, uint reserved1, uint reserved2, out IStream stream);
    void OpenStream([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr reserved1, uint mode, uint reserved2, out IStream stream);
  }
  [DllImport("ole32.dll", CharSet = CharSet.Unicode)]
  private static extern int StgOpenStorage(string path, IntPtr priority, uint mode, IntPtr exclude, uint reserved, out IStoragePrefix storage);
  public static byte[] Read(string path)
  {
    IStoragePrefix? storage = null; IStream? stream = null; IntPtr count = IntPtr.Zero;
    try
    {
      Marshal.ThrowExceptionForHR(StgOpenStorage(path, IntPtr.Zero, 0x20, IntPtr.Zero, 0, out storage));
      storage.OpenStream("\u0005DigitalSignature", IntPtr.Zero, 0x10, 0, out stream);
      stream.Stat(out var stat, 1);
      if (stat.cbSize < 1 || stat.cbSize > 1048576) throw new IOException("MSI signature stream budget");
      var bytes = new byte[(int)stat.cbSize]; count = Marshal.AllocHGlobal(4); var offset = 0;
      while (offset < bytes.Length)
      {
        var buffer = new byte[Math.Min(65536, bytes.Length - offset)]; stream.Read(buffer, buffer.Length, count);
        var read = Marshal.ReadInt32(count);
        if (read <= 0 || read > buffer.Length) throw new IOException("MSI signature stream truncated");
        Buffer.BlockCopy(buffer, 0, bytes, offset, read); offset += read;
      }
      return bytes;
    }
    finally
    {
      if (count != IntPtr.Zero) Marshal.FreeHGlobal(count);
      if (stream != null) Marshal.FinalReleaseComObject(stream);
      if (storage != null) Marshal.FinalReleaseComObject(storage);
    }
  }
}
