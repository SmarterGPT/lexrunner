#if COORDINATOR_SERVICE_FIXTURE_TESTS
using System.Buffers.Binary;
using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Security.Principal;
using System.Text;

// Same-user source exercise only. The ordinary image has no client ACE, and
// this does not establish installed cross-account token or service identity.
internal static class PipeFixtureTests
{
    private const string StatusJson = "{\n" +
        "  \"attempt_id\": \"attempt-1\",\n" +
        "  \"request_id\": \"request-1\",\n" +
        "  \"run_id\": \"run-1\",\n" +
        "  \"schema_version\": \"1.0.0\",\n" +
        "  \"verb\": \"attempt.status\"\n" +
        "}\n";

    internal static bool SelfTest()
    {
        if (!OperatingSystem.IsWindows()) return false;
        try { return RunAsync().GetAwaiter().GetResult(); }
        catch (Exception error)
        {
            Console.Error.WriteLine("pipe_fixture_error:" + error);
            return false;
        }
    }

    [SupportedOSPlatform("windows")]
    private static async Task<bool> RunAsync()
    {
        var sid = WindowsIdentity.GetCurrent().User?.Value;
        if (sid is null) return false;
        var name = "LexRunner.Coordinator.ServiceFixture." + Guid.NewGuid().ToString("N");
        using var pipe = CoordinatorPipe.CreateFixture(@"\\.\pipe\" + name, sid, sid);
        using var stop = new CancellationTokenSource();
        var server = CoordinatorPipe.ServeAsync(pipe, stop.Token);
        try
        {
            var request = Frame(StatusJson);
            var expected = CoordinatorProtocol.IndeterminateStatusFrame(
                new CoordinatorProtocol.StatusRequest("request-1", "run-1", "attempt-1"));

            if (!await ReplyMatches(name, request, expected))
                throw new InvalidOperationException("first_reply_mismatch");
            if (!await ReplyMatches(name, request, expected))
                throw new InvalidOperationException("replay_mismatch");
            if (!await ClosesWithoutReply(name, Frame("{}")))
                throw new InvalidOperationException("malformed_not_closed");

            // A client that stops mid-header cannot leave a partial request
            // attached to the next connection or manufacture a status reply.
            using (var client = await Connect(name))
                await client.WriteAsync(new byte[] { 10, 0 });
            if (!await ReplyMatches(name, request, expected))
                throw new InvalidOperationException("post_disconnect_mismatch");
            return true;
        }
        finally
        {
            stop.Cancel();
            await server.WaitAsync(TimeSpan.FromSeconds(3));
        }
    }

    private static async Task<NamedPipeClientStream> Connect(string name)
    {
        var client = new NamedPipeClientStream(".", name, PipeDirection.InOut,
            PipeOptions.Asynchronous);
        try
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await client.ConnectAsync(3000, deadline.Token);
            return client;
        }
        catch
        {
            client.Dispose();
            throw;
        }
    }

    private static async Task<bool> ReplyMatches(string name, byte[] request, byte[] expected)
    {
        using var client = await Connect(name);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await client.WriteAsync(request.AsMemory(), deadline.Token);
        var header = new byte[4];
        await client.ReadExactlyAsync(header, deadline.Token);
        var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (length is 0 or > CoordinatorProtocol.MaxReplyBytes) return false;
        var reply = new byte[(int)length + 4];
        header.CopyTo(reply, 0);
        await client.ReadExactlyAsync(reply.AsMemory(4), deadline.Token);
        return reply.SequenceEqual(expected);
    }

    private static async Task<bool> ClosesWithoutReply(string name, byte[] request)
    {
        using var client = await Connect(name);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await client.WriteAsync(request.AsMemory(), deadline.Token);
        try { return await client.ReadAsync(new byte[1], deadline.Token) == 0; }
        catch (IOException) { return true; }
    }

    private static byte[] Frame(string json)
    {
        var payload = Encoding.UTF8.GetBytes(json);
        var frame = new byte[payload.Length + 4];
        BinaryPrimitives.WriteUInt32LittleEndian(frame, (uint)payload.Length);
        payload.CopyTo(frame.AsSpan(4));
        return frame;
    }
}
#endif
