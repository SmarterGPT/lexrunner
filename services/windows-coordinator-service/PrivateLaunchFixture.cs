#if COORDINATOR_SERVICE_FIXTURE_TESTS
using System.Buffers.Binary;
using System.Security.Principal;
using System.Text;
using System.Runtime.Versioning;

[SupportedOSPlatform("windows")]
internal static class PrivateLaunchFixture
{
    internal static bool SelfTest()
    {
        if (ProtectedGenerationLease.TryOpenInstalled(out var installed) || installed is not null)
            return false;
        var payload = Encoding.UTF8.GetBytes("{\n" +
            "  \"attempt_id\": \"attempt-1\",\n" +
            "  \"request_id\": \"request-1\",\n" +
            "  \"run_id\": \"run-1\",\n" +
            "  \"schema_version\": \"1.0.0\",\n" +
            "  \"verb\": \"attempt.status\"\n" +
            "}\n");
        var frame = new byte[4 + payload.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(frame, (uint)payload.Length);
        payload.CopyTo(frame.AsSpan(4));
        var peer = ObservedPipePeer.OpenSelfFixture();
        using var generation = ProtectedGenerationLease.OpenSelfFixture(FixtureChildCase.Normal);
        var prepare = CoordinatorPrivateNode.Run(generation, PrivateVerb.Prepare, peer,
            frame, CancellationToken.None);
        if (prepare.State != "uncertain" || prepare.ProcessId is not null ||
            prepare.Error != "protected_store_unavailable") return false;
        var normal = CoordinatorPrivateNode.Run(generation, PrivateVerb.Status, peer,
            frame, CancellationToken.None);
        if (normal.State != "status_received" || normal.StatusFrame is null ||
            !normal.JobMatched || !normal.ImageMatched || !normal.TokenMatched ||
            !normal.TerminalDrained || normal.ProcessId is null)
        {
            Console.Error.WriteLine($"normal:{normal.State}:{normal.Error}:job={normal.JobMatched}:image={normal.ImageMatched}:token={normal.TokenMatched}:drain={normal.TerminalDrained}");
            return false;
        }
        var parsed = CoordinatorProtocol.ParseStatusOnly(payload);
        if (parsed.Request is not { } request ||
            !normal.StatusFrame.SequenceEqual(CoordinatorProtocol.IndeterminateStatusFrame(request)))
            return false;
        using (generation.HoldForChild())
        {
            var duplicate = CoordinatorPrivateNode.Run(generation, PrivateVerb.Status, peer,
                frame, CancellationToken.None);
            if (duplicate.ProcessId is not null || duplicate.Error != "generation_lease_unavailable")
                return false;
        }
        using (var canceled = new CancellationTokenSource())
        {
            canceled.Cancel();
            var stopped = CoordinatorPrivateNode.Run(generation, PrivateVerb.Status, peer,
                frame, canceled.Token);
            if (stopped.ProcessId is not null || stopped.StatusFrame is not null ||
                stopped.State != "uncertain") return false;
        }
        foreach (var mode in new[] { FixtureChildCase.BadNonce,
                     FixtureChildCase.Flood, FixtureChildCase.Nonzero, FixtureChildCase.Sleep })
        {
            using var adverse = ProtectedGenerationLease.OpenSelfFixture(mode);
            var outcome = CoordinatorPrivateNode.Run(adverse, PrivateVerb.Status, peer,
                frame, CancellationToken.None);
            if (outcome.State != "uncertain" || outcome.StatusFrame is not null ||
                !outcome.TerminalDrained || outcome.ProcessId is null ||
                !outcome.JobMatched || !outcome.ImageMatched || !outcome.TokenMatched)
            {
                Console.Error.WriteLine($"adverse:{mode}:{outcome.State}:{outcome.Error}:job={outcome.JobMatched}:image={outcome.ImageMatched}:token={outcome.TokenMatched}:drain={outcome.TerminalDrained}");
                return false;
            }
        }
        generation.Dispose();
        var disposed = CoordinatorPrivateNode.Run(generation, PrivateVerb.Status, peer,
            frame, CancellationToken.None);
        if (disposed.ProcessId is not null || disposed.Error != "generation_lease_unavailable")
            return false;
        return true;
    }

    internal static int Child(string text)
    {
        if (!Enum.TryParse<FixtureChildCase>(text, false, out var mode) ||
            !Enum.IsDefined(mode)) return 2;
        if (mode == FixtureChildCase.Sleep) { Thread.Sleep(10000); return 0; }
        if (mode == FixtureChildCase.Nonzero) return 5;
        if (mode == FixtureChildCase.Flood)
        {
            Console.OpenStandardOutput().Write(new byte[8192]);
            return 0;
        }
        var request = ReadBounded(Console.OpenStandardInput(), 4096);
        if (request.Length < 31 ||
            !request.AsSpan(0, 8).SequenceEqual(CoordinatorPrivateNode.RequestMagic) ||
            request[24] != (byte)PrivateVerb.Status) return 3;
        var sidLength = BinaryPrimitives.ReadUInt16LittleEndian(request.AsSpan(25));
        var offset = 27 + sidLength;
        if (sidLength is < 7 or > 184 || request.Length < offset + 4) return 3;
        var sid = Encoding.ASCII.GetString(request, 27, sidLength);
        using var identity = WindowsIdentity.GetCurrent();
        if (sid != identity.User?.Value) return 3;
        var frameLength = BinaryPrimitives.ReadUInt32LittleEndian(request.AsSpan(offset));
        offset += 4;
        if (frameLength is < 5 or > 2048 || frameLength != request.Length - offset ||
            BinaryPrimitives.ReadUInt32LittleEndian(request.AsSpan(offset)) != frameLength - 4)
            return 3;
        var payload = request[(offset + 4)..];
        var parsed = CoordinatorProtocol.ParseStatusOnly(payload);
        if (parsed.Request is not { } status) return 3;
        var response = CoordinatorProtocol.IndeterminateStatusFrame(status);
        var reply = new byte[28 + response.Length];
        CoordinatorPrivateNode.ReplyMagic.CopyTo(reply.AsSpan());
        request.AsSpan(8, 16).CopyTo(reply.AsSpan(8));
        if (mode == FixtureChildCase.BadNonce) reply[8] ^= 1;
        BinaryPrimitives.WriteUInt32LittleEndian(reply.AsSpan(24), (uint)response.Length);
        response.CopyTo(reply.AsSpan(28));
        Console.OpenStandardOutput().Write(reply);
        return 0;
    }

    private static byte[] ReadBounded(Stream input, int maximum)
    {
        using var content = new MemoryStream();
        var buffer = new byte[1024];
        while (true)
        {
            var read = input.Read(buffer);
            if (read == 0) return content.ToArray();
            if (read > maximum - content.Length) throw new InvalidDataException("fixture_input_bound");
            content.Write(buffer, 0, read);
        }
    }
}
#endif
