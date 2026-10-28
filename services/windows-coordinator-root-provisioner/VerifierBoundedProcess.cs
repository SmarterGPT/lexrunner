using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public enum RootVerifierOutcome
{
    Exited,
    OutputOverflow,
    TimedOut,
    TerminalUncertain,
    StreamFailure
}

public sealed record RootVerifierResult(RootVerifierOutcome Outcome,
    int? ExitCode, long DurationMs, string Stdout, string Stderr,
    bool CaptureTruncated, long TotalOutputBytes);

// Fixture verifier only. CreateDirectoryW fails if a randomly named output
// directory is already occupied; callers never adopt or clear that occupant.
public static class RootVerifierFiles
{
    [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW", CharSet = CharSet.Unicode,
        ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateDirectoryW(string path, nint securityAttributes);

    public static void CreateNewDirectory(string path)
    {
        if (!Path.IsPathFullyQualified(path)) throw new ArgumentException("Expected absolute output path");
        if (!CreateDirectoryW(path, nint.Zero))
            throw new IOException("Verifier output directory unavailable: " + Marshal.GetLastWin32Error());
    }
}

// Kept separate from the native fixture. Both streams are drained while the
// child runs, with a hard total-output budget and separately capped capture.
// Kill(entireProcessTree) requests descendant termination, but the result
// proves only the direct child exit and its stdout/stderr stream drain.
public static class RootVerifierProcess
{
    public static RootVerifierResult Run(ProcessStartInfo start, int timeoutMs,
        int maxOutputBytes, int captureBytesPerStream)
    {
        if (timeoutMs is < 1 or > 600000 || maxOutputBytes is < 1 or > 1048576 ||
            captureBytesPerStream is < 1 or > 16384 || !start.RedirectStandardOutput ||
            !start.RedirectStandardError || start.UseShellExecute)
            throw new ArgumentException("Invalid bounded verifier process profile");
        return RunAsync(start, timeoutMs, maxOutputBytes, captureBytesPerStream)
            .GetAwaiter().GetResult();
    }

    private static async Task<RootVerifierResult> RunAsync(ProcessStartInfo start,
        int timeoutMs, int maxOutputBytes, int captureBytesPerStream)
    {
        var timer = Stopwatch.StartNew();
        using var process = new Process { StartInfo = start };
        if (!process.Start()) throw new IOException("Verifier child did not start");
        var capture = new Capture(maxOutputBytes, captureBytesPerStream);
        var stdout = DrainAsync(process.StandardOutput.BaseStream, capture, false);
        var stderr = DrainAsync(process.StandardError.BaseStream, capture, true);
        var exit = process.WaitForExitAsync();
        var deadline = Task.Delay(timeoutMs);
        var first = await Task.WhenAny(exit, capture.Overflow.Task, deadline);
        var outcome = first == capture.Overflow.Task
            ? RootVerifierOutcome.OutputOverflow
            : first == deadline ? RootVerifierOutcome.TimedOut
            : RootVerifierOutcome.Exited;
        if (outcome != RootVerifierOutcome.Exited) Kill(process);

        if (await Task.WhenAny(exit, Task.Delay(10000)) != exit)
        {
            Kill(process);
            timer.Stop();
            return capture.Result(RootVerifierOutcome.TerminalUncertain, null,
                timer.ElapsedMilliseconds);
        }
        var drains = Task.WhenAll(stdout, stderr);
        if (await Task.WhenAny(drains, Task.Delay(10000)) != drains)
        {
            process.StandardOutput.Close();
            process.StandardError.Close();
            if (await Task.WhenAny(drains, Task.Delay(2000)) != drains)
            {
                timer.Stop();
                return capture.Result(RootVerifierOutcome.TerminalUncertain,
                    process.ExitCode, timer.ElapsedMilliseconds);
            }
        }
        if (drains.IsFaulted || drains.IsCanceled)
            outcome = RootVerifierOutcome.StreamFailure;
        else if (capture.Overflow.Task.IsCompleted)
            outcome = RootVerifierOutcome.OutputOverflow;
        timer.Stop();
        return capture.Result(outcome, process.ExitCode, timer.ElapsedMilliseconds);
    }

    private static void Kill(Process process)
    {
        // .NET does not wait for every descendant to exit here. The native Git
        // launcher has its own separate Job accounting and drain proof.
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }

    private static async Task DrainAsync(Stream stream, Capture capture, bool error)
    {
        var chunk = new byte[4096];
        while (true)
        {
            var read = await stream.ReadAsync(chunk);
            if (read == 0) return;
            capture.Add(chunk, read, error);
        }
    }

    private sealed class Capture
    {
        private readonly object gate = new();
        private readonly long maxOutput;
        private readonly int maxCapture;
        private readonly MemoryStream output = new();
        private readonly MemoryStream errors = new();
        private long total;
        private bool truncated;
        internal TaskCompletionSource<bool> Overflow { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal Capture(int maxOutput, int maxCapture)
        { this.maxOutput = maxOutput; this.maxCapture = maxCapture; }
        internal void Add(byte[] bytes, int length, bool error)
        {
            lock (gate)
            {
                total += length;
                if (total > maxOutput) Overflow.TrySetResult(true);
                var target = error ? errors : output;
                var keep = Math.Min(length, maxCapture - checked((int)target.Length));
                if (keep > 0) target.Write(bytes, 0, keep);
                if (keep < length) truncated = true;
            }
        }
        internal RootVerifierResult Result(RootVerifierOutcome outcome,
            int? exitCode, long durationMs)
        {
            lock (gate)
                return new RootVerifierResult(outcome, exitCode, durationMs,
                    Encoding.UTF8.GetString(output.ToArray()),
                    Encoding.UTF8.GetString(errors.ToArray()), truncated, total);
        }
    }
}
