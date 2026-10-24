# Runner Logging, Locks, and Cache

This document describes the logging, locking, and cache management features for lexrunner.

## NDJSON File Logging

The runner writes structured logs to `.smartergpt.local/runner/logs/runner.log.ndjson` in NDJSON (Newline Delimited JSON) format.

### Log Fields

Each log entry contains these stable fields:

- `timestamp` (string): ISO 8601 timestamp (e.g., "2025-11-09T12:34:56.789Z")
- `level` (string): Log level - one of: trace, debug, info, warn, error, fatal
- `message` (string, optional): Human-readable log message
- `module` (string, optional): Module name (e.g., "config/loader", "gates/executor")
- `operation` (string, optional): Operation name (e.g., "loadPlan", "executeGate")
- `duration_ms` (number, optional): Operation duration in milliseconds
- `error` (object/string, optional): Error information
- `metadata` (object, optional): Additional structured data

### Example Log Entries

```json
{"timestamp":"2025-11-09T12:34:56.789Z","level":"info","module":"gates/executor","operation":"executeGate","duration_ms":2341,"metadata":{"gate":"typecheck","result":"pass"}}
{"timestamp":"2025-11-09T12:34:59.123Z","level":"warn","module":"config/loader","operation":"loadScope","path_source":"runner/ (compatibility)","message":"Using compatibility runner/ configuration; move it to the profile root"}
```

### Usage

```typescript
import { createFileLogger } from "./src/monitoring/fileLogger.js";

const logger = createFileLogger({
  profileDir: ".smartergpt.local",
  minLevel: "info",
  enabled: true,
});

// Log with all fields
logger.info("Gate completed", {
  module: "gates/executor",
  operation: "executeGate",
  duration_ms: 2341,
  metadata: {
    gate: "typecheck",
    result: "pass",
  },
});

// Log errors
logger.error("Gate failed", {
  module: "gates/executor",
  operation: "executeGate",
  error: new Error("Test failed"),
  metadata: { gate: "lint" },
});

// Close logger when done
await logger.close();
```

## PID/Commit Locks

The runner uses locks to prevent concurrent executions on the same profile.

### Lock Files

Locks are stored in `.smartergpt.local/runner/locks/runner.lock` with this structure:

```json
{
  "pid": 12345,
  "commit": "abc123",
  "started": "2025-11-09T12:34:56.789Z",
  "command": "lex-pr gates run",
  "profile": ".smartergpt.local"
}
```

### Features

- **Concurrent execution prevention**: Only one runner can execute at a time per profile
- **Stale lock detection**: Automatically removes locks from dead processes
- **Clear error messages**: Provides PID, start time, command, and lock file path when blocked
- **Automatic cleanup**: Locks are released on normal exit and errors

### Usage

```typescript
import { createRunnerLock } from "./src/monitoring/lock.js";

const lock = createRunnerLock(".smartergpt.local");

try {
  // Acquire lock - throws LockError if another runner is active
  await lock.acquire();

  // Do work...
} finally {
  // Always release lock
  lock.release();
}
```

### Error Handling

If another runner is active, you'll see:

```
Another runner is active (PID 12345).
Started: 2025-11-09T12:34:56.789Z
Command: lex-pr gates run
If stale, remove: .smartergpt.local/runner/locks/runner.lock
```

## Ephemeral Cache Policy

The runner purges `.smartergpt.local/runner/.cache/` at the start of each run by default.

### Cache Purge Behavior

- **Default**: Cache is purged at run start
- **--keep-cache**: Preserves existing cache
- **Output**: Reports purged size or preservation message

### Usage in CLI

```bash
# Default - purges cache
lex-pr execute

# Keep cache for faster development iterations
lex-pr execute --keep-cache

# Use specific profile with cache preservation
lex-pr execute --profile-dir .smartergpt.local --keep-cache
```

### Output Examples

```
🗑️  Purged cache (15.23 MB)
✓ Cache directory ready (was empty)
ℹ️  Keeping existing cache (--keep-cache)
```

### Programmatic Usage

```typescript
import { purgeCacheIfNeeded, formatCachePurgeResult } from "./src/monitoring/cache.js";

const result = purgeCacheIfNeeded({
  profileDir: ".smartergpt.local",
  keepCache: false,
});

console.log(formatCachePurgeResult(result));
// Output: "🗑️  Purged cache (5.00 KB)"
```

## Runner Lifecycle Integration

The `src/cli/runnerLifecycle.ts` module provides helpers for managing the complete runner lifecycle:

```typescript
import {
  acquireRunnerLock,
  releaseRunnerLock,
  initializeFileLogger,
  closeFileLogger,
  purgeCache,
  cleanupRunnerResources,
} from "./src/cli/runnerLifecycle.js";

// Typical usage in a command
try {
  // 1. Purge cache
  purgeCache(profileDir, keepCache);

  // 2. Acquire lock
  await acquireRunnerLock(profileDir);

  // 3. Initialize logger
  const logger = initializeFileLogger(profileDir, { enabled: true });

  // 4. Do work...
  logger.info("Work started");
} finally {
  // 5. Always cleanup
  await cleanupRunnerResources();
}
```

## Testing

All features have comprehensive test coverage:

- File Logger: 16 tests in `tests/monitoring-fileLogger.spec.ts`
- Lock Mechanism: 22 tests in `tests/monitoring-lock.spec.ts`
- Cache Management: 21 tests in `tests/monitoring-cache.spec.ts`
- Integration: 10 tests in `tests/runner-lifecycle-integration.spec.ts`

Run tests:

```bash
npm test -- tests/monitoring-fileLogger.spec.ts
npm test -- tests/monitoring-lock.spec.ts
npm test -- tests/monitoring-cache.spec.ts
npm test -- tests/runner-lifecycle-integration.spec.ts
```

## Directory Structure

After running lexrunner, your profile will have this structure:

```
.smartergpt.local/
├── profile.yml                    # Profile manifest
├── intent.md                      # Project intent
├── scope.yml                      # Scope configuration
├── gates.yml                      # Gate definitions
└── runner/
    ├── logs/
    │   └── runner.log.ndjson     # NDJSON logs
    ├── locks/
    │   └── runner.lock           # PID/commit lock (removed after run)
    └── .cache/                   # Ephemeral cache (purged by default)
```

## Configuration

### File Logger

- **minLevel**: Minimum log level to write (trace, debug, info, warn, error, fatal)
- **enabled**: Enable/disable file logging

### Cache Management

- Controlled via `--keep-cache` CLI flag
- Automatically purges by default
- Displays user-friendly size messages

### Locks

- No configuration needed
- Automatically manages PID/commit tracking
- Provides helpful error messages

## Best Practices

1. **Always cleanup**: Use try/finally blocks to ensure locks are released
2. **Log structured data**: Use the metadata field for queryable information
3. **Use appropriate log levels**: Reserve error/fatal for actual problems
4. **Monitor log files**: Parse NDJSON for operational insights
5. **--keep-cache in development**: Speed up iterations when cache is expensive
6. **Check lock errors**: If you see lock errors, verify no zombie processes exist
