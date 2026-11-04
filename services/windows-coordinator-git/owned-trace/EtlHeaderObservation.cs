// Bounded numeric readback, not a completed census or execution authority.
// A non-null record means all seven header fields were read after ProcessTrace.
[System.Text.Json.Serialization.JsonUnmappedMemberHandling(System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow)]
internal sealed record EtlHeaderObservation(
    [property: System.Text.Json.Serialization.JsonRequired] long StartFileTimeUtc,
    [property: System.Text.Json.Serialization.JsonRequired] long EndFileTimeUtc,
    [property: System.Text.Json.Serialization.JsonRequired] uint CaptureMode,
    [property: System.Text.Json.Serialization.JsonRequired] uint MaximumFileSizeMiB,
    [property: System.Text.Json.Serialization.JsonRequired] uint PointerSize,
    [property: System.Text.Json.Serialization.JsonRequired] uint EventsLost,
    [property: System.Text.Json.Serialization.JsonRequired] uint BuffersLost)
{
    public string FirstFailedCheck => StartFileTimeUtc <= 0 ? "start_time" :
        EndFileTimeUtc <= StartFileTimeUtc ? "end_time" :
        !SchemaCensus.CaptureModeIsExpected(CaptureMode) ? "capture_mode" :
        MaximumFileSizeMiB != 128 ? "maximum_file_size" :
        PointerSize is not (8 or 64) ? "pointer_size" : "none";
    internal bool HeaderValid => FirstFailedCheck == "none";
}
