// Bounded numeric readback, not a completed census or execution authority.
// A non-null record means all seven header fields were read after ProcessTrace.
internal sealed record EtlHeaderObservation(long StartFileTimeUtc, long EndFileTimeUtc,
    uint CaptureMode, uint MaximumFileSizeMiB, uint PointerSize,
    uint EventsLost, uint BuffersLost)
{
    public string FirstFailedCheck => StartFileTimeUtc <= 0 ? "start_time" :
        EndFileTimeUtc <= StartFileTimeUtc ? "end_time" :
        !SchemaCensus.CaptureModeIsExpected(CaptureMode) ? "capture_mode" :
        MaximumFileSizeMiB != 128 ? "maximum_file_size" :
        PointerSize is not (8 or 64) ? "pointer_size" : "none";
    internal bool HeaderValid => FirstFailedCheck == "none";
}
