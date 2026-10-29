# Query-only NT Kernel Logger source fixture

This disposable Windows x64 fixture is a possible replacement for the
broad variable-length `xperf -loggers` discovery read. Its only native call is
`ControlTraceW` with trace ID `0`, the fixed `NT Kernel Logger` name, and
`EVENT_TRACE_CONTROL_QUERY` (`0`). It has no start, stop, flush, update, or
arbitrary session-name route. It prints one bounded JSON line with presence,
typed refusal, and the three loss counters when the named logger is present.
It does not print a logger path or name obtained from the host.

`--selftest` requires a Windows x64 process, checks the
`EVENT_TRACE_PROPERTIES` layout, and makes no native call. `--query` has the
same host requirement and performs the read-only query. The import uses
`Sechost.dll`, which Microsoft documents for current Windows, and restricts
native DLL resolution to System32. An absent logger is
reported from Win32 error `4201` with exit `0`; an occupied logger or any
other query/readback failure exits `3` and leaves it untouched. No result
authorizes a trace, Git loader closure, helper installation, or execution.

The earlier hosted `xperf -loggers` read refused at a 64 KiB output cap after
89,393 bytes; it did not start a trace. The manual main-only workflow builds
this source at the dispatch SHA, requires selftest, queries only the fixed
logger name, and retains only a bounded typed JSON receipt for one day.
The local read-only query observed `kernel_logger_not_running` on this
workstation. That is **not** a hosted runner result and does not establish
exclusive ownership of a future session. A hosted query still requires
independent source review, CI, exact main-head dispatch and receipt readback.
Any active trace needs a separate start/stop ownership design and approval.

The implementation follows the installed Windows SDK `evntrace.h` and
`wmistr.h` layout. Microsoft documents the fixed-name query, DLL and the three
counters in [ControlTraceW](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-controltracew)
and [EVENT_TRACE_PROPERTIES](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/ns-evntrace-event_trace_properties).
