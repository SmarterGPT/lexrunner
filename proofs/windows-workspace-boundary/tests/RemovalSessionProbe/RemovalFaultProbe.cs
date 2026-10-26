using System.Diagnostics;
using System.Text;

// Linked only by this test executable. Production helper has no fault-file hook.
internal static class RemovalFaultProbe
{
  internal static void Check(string slotPath, string phase)
  {
    var fault = slotPath + ".fault";
    if (!File.Exists(fault) || File.ReadAllText(fault) != phase) return;
    using (var marker = new FileStream(slotPath + ".reached", FileMode.CreateNew, FileAccess.Write, FileShare.Read))
    {
      marker.Write(Encoding.UTF8.GetBytes(phase)); marker.Flush(true);
    }
    var clock = Stopwatch.StartNew();
    while (!File.Exists(slotPath + ".continue"))
    {
      if (clock.ElapsedMilliseconds >= 30000) throw new IOException("Fault probe barrier deadline");
      Thread.Sleep(10);
    }
  }
}
