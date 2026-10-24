# Error Recovery and Resilience Patterns

This document describes the error recovery and resilience patterns implemented in lexrunner.

## Overview

The error recovery system provides:

1. **Error Classification** - Categorize errors as transient, permanent, or unknown
2. **Retry with Exponential Backoff** - Automatically retry transient failures
3. **Circuit Breaker Pattern** - Prevent cascading failures from external services
4. **Graceful Degradation** - Continue operation when non-critical services fail
5. **Error Diagnostics** - Detailed logging and actionable recovery guidance
6. **Monitoring Integration** - Track and alert on error patterns

## Error Classification

Errors are automatically classified based on their type and context:

### Transient Errors (Retryable)

These errors are temporary and may succeed on retry:

- **Network errors**: Connection refused, timeouts, DNS failures
- **Rate limits**: GitHub API rate limiting
- **Service unavailable**: 503, 502 responses
- **Temporary timeouts**: Operation timeout errors

### Permanent Errors (Not Retryable)

These errors require manual intervention:

- **Authentication errors**: Invalid credentials, expired tokens
- **Validation errors**: Schema validation, configuration errors
- **Authorization errors**: Insufficient permissions
- **Not found errors**: Missing resources

### Unknown Errors

Errors that don't match known patterns are classified as unknown and handled conservatively (not retried by default).

## Retry with Exponential Backoff

The retry mechanism automatically retries transient failures with increasing delays:

```typescript
import { retryWithBackoff } from "./core/errorRecovery";

const result = await retryWithBackoff(
  async () => {
    // Your operation here
    return await fetchDataFromAPI();
  },
  {
    maxAttempts: 3, // Maximum retry attempts
    initialDelayMs: 1000, // Start with 1 second delay
    maxDelayMs: 30000, // Cap at 30 seconds
    backoffMultiplier: 2, // Double the delay each time
    jitter: true, // Add randomness to prevent thundering herd
    timeoutMs: 60000, // Timeout for each attempt
  },
  (attempt, error, delayMs) => {
    // Optional callback for retry notifications
    console.log(`Retrying (attempt ${attempt}): ${error.error.message}`);
  }
);
```

### Default Retry Behavior

- **Transient errors**: Automatically retried up to `maxAttempts`
- **Permanent errors**: Fail immediately without retry
- **Unknown errors**: Fail immediately without retry (conservative approach)

### Exponential Backoff Formula

```
delay = min(initialDelay * (multiplier ^ (attempt - 1)), maxDelay)
```

With jitter enabled:

```
delay = delay + random(0, delay * 0.1)
```

## Circuit Breaker Pattern

Circuit breakers prevent cascading failures by failing fast when a service is down:

```typescript
import { CircuitBreaker } from "./core/errorRecovery";

const breaker = new CircuitBreaker({
  failureThreshold: 5, // Open after 5 failures
  successThreshold: 2, // Close after 2 successes in half-open
  resetTimeoutMs: 60000, // Wait 1 minute before trying again
  rollingWindowMs: 120000, // Track failures over 2 minute window
});

const result = await breaker.execute(async () => {
  return await callExternalService();
});
```

### Circuit States

1. **Closed** (Normal operation)
   - Requests flow through normally
   - Failures are tracked
   - Opens when failure threshold is reached

2. **Open** (Failing fast)
   - Requests fail immediately
   - Prevents overloading failing service
   - Transitions to Half-Open after reset timeout

3. **Half-Open** (Testing recovery)
   - Limited requests allowed through
   - Closes after success threshold met
   - Reopens immediately on any failure

### Pre-configured Circuit Breakers

```typescript
import { createGitHubCircuitBreaker, createNetworkCircuitBreaker } from "./core/errorRecovery";

// GitHub API circuit breaker (higher threshold for API limits)
const githubBreaker = createGitHubCircuitBreaker();

// Network circuit breaker (lower threshold for network issues)
const networkBreaker = createNetworkCircuitBreaker();
```

## Error Classification API

### Classify Errors

```typescript
import { classifyError } from "./core/errorRecovery";

try {
  await someOperation();
} catch (error) {
  const classified = classifyError(error, "Operation context");

  console.log(classified.type); // 'transient' | 'permanent' | 'unknown'
  console.log(classified.severity); // 'critical' | 'high' | 'medium' | 'low'
  console.log(classified.retryable); // boolean
  console.log(classified.code); // Error code for automation
  console.log(classified.recoveryActions); // Array of suggested actions
}
```

### User-Friendly Error Display

```typescript
import { formatErrorForUser } from "./core/errorRecovery";

const classified = classifyError(error, "GitHub API call");
console.error(formatErrorForUser(classified));
```

Output example:

```
❌ GitHub API call

Error: API rate limit exceeded
Type: transient (retryable)
Severity: medium

💡 Recovery Actions:
  • Wait for rate limit reset
  • Use authenticated requests for higher limits
  • Implement request caching

📊 Additional Details:
  errorName: GitHubRateLimitError
```

## Integration Examples

### Enhanced GitHub API Client

The GitHub API client automatically uses error recovery:

```typescript
import { GitHubAPI } from "./github/api";

const api = new GitHubAPI({
  owner: "myorg",
  repo: "myrepo",
  token: process.env.GITHUB_TOKEN,
});

// Automatically retries on rate limits and network errors
const prs = await api.discoverPullRequests("open");
```

Features:

- Circuit breaker protection
- Automatic retry with exponential backoff
- Detailed error logging
- Graceful degradation

### Gate Execution with Recovery

Gate execution includes intelligent retry logic:

```typescript
import { executeGate } from "./gates";

const result = await executeGate(gate, policy, artifactDir);
```

Features:

- Classifies gate failures (permanent vs transient)
- Respects policy-defined retry configuration
- Logs detailed error diagnostics
- Tracks retry attempts in results

### Error Diagnostics in Execution State

Track errors during execution for debugging:

```typescript
import { ExecutionState } from "./executionState";

const state = new ExecutionState(plan);

// Errors are automatically recorded during gate execution
const diagnostics = state.getErrorDiagnostics();
const summary = state.getErrorSummary();

console.log(`Transient errors: ${summary.transient}`);
console.log(`Permanent errors: ${summary.permanent}`);
```

## Monitoring and Alerting

### Error Recovery Monitor

Track error patterns and recovery attempts:

```typescript
import { errorRecoveryMonitor } from "./monitoring/errorRecovery";

// Errors are automatically recorded by the system
// Query metrics for monitoring dashboards
const metrics = errorRecoveryMonitor.exportMetrics();

console.log(metrics.errorSummary); // Error counts by type/severity
console.log(metrics.circuitBreakerMetrics); // Circuit breaker state
console.log(metrics.events); // Detailed event log
```

### Alert Thresholds

Configure custom alert thresholds:

```typescript
import { ErrorType } from "./core/errorRecovery";

errorRecoveryMonitor.setAlertThreshold(ErrorType.Transient, 10);
errorRecoveryMonitor.setAlertThreshold(ErrorType.Permanent, 1);
```

### Event Types

Monitor these event types:

- `ErrorClassified` - Error was classified
- `RetryAttempt` - Retry initiated
- `RetrySuccess` - Retry succeeded
- `RetryFailed` - All retries exhausted
- `CircuitOpened` - Circuit breaker opened
- `CircuitClosed` - Circuit breaker closed
- `GracefulDegradation` - Feature degraded gracefully

## Policy Configuration

Configure retry behavior in your plan policy. The following block is a non-executable fragment;
replace the ellipsis with complete Plan items before validation:

```json
{
  "schemaVersion": "1.0.0",
  "target": "main",
  "policy": {
    "requiredGates": ["lint", "test"],
    "retries": {
      "lint": {
        "maxAttempts": 1,
        "backoffSeconds": 0
      },
      "test": {
        "maxAttempts": 3,
        "backoffSeconds": 5
      },
      "integration": {
        "maxAttempts": 5,
        "backoffSeconds": 10
      }
    }
  },
  "items": [...]
}
```

## Best Practices

### 1. Use Appropriate Retry Counts

- **Fast operations** (lint, format): 1-2 attempts
- **Medium operations** (tests): 3 attempts
- **Slow/flaky operations** (integration tests): 3-5 attempts
- **External services**: Use circuit breaker + retry

### 2. Set Reasonable Timeouts

```typescript
retryWithBackoff(fn, {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000, // Prevent indefinite delays
  timeoutMs: 60000, // Fail if single attempt takes too long
});
```

### 3. Classify Errors Explicitly

When throwing errors, use descriptive names for better classification:

```typescript
class DatabaseConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConnectionError";
  }
}

// Will be classified as transient and retried
throw new DatabaseConnectionError("Connection refused");
```

### 4. Monitor Circuit Breaker State

```typescript
const breaker = createGitHubCircuitBreaker();

setInterval(() => {
  const state = breaker.getState();
  if (state === CircuitState.Open) {
    console.warn("GitHub circuit breaker is OPEN - degraded mode");
  }
}, 30000);
```

### 5. Graceful Degradation

When a non-critical service fails, continue with reduced functionality:

```typescript
import { errorRecoveryMonitor } from "./monitoring/errorRecovery";

try {
  await enhancedFeature();
} catch (error) {
  errorRecoveryMonitor.recordGracefulDegradation("enhanced-feature", "Service unavailable");

  // Fall back to basic functionality
  await basicFeature();
}
```

## Debugging Failed Operations

### 1. Check Error Diagnostics

```typescript
const diagnostics = executionState.getErrorDiagnostics();
for (const diag of diagnostics) {
  console.log(`${diag.nodeName}/${diag.gateName}:`);
  console.log(`  Type: ${diag.classified.type}`);
  console.log(`  Severity: ${diag.classified.severity}`);
  console.log(`  Recovery: ${diag.classified.recoveryActions.join(", ")}`);
}
```

### 2. Review Recovery Events

```typescript
const events = errorRecoveryMonitor.getEvents();
const retryEvents = errorRecoveryMonitor.getEventsByType(RecoveryEventType.RetryAttempt);

console.log(`Total retry attempts: ${retryEvents.length}`);
```

### 3. Check Circuit Breaker Status

```typescript
const metrics = errorRecoveryMonitor.getCircuitBreakerMetrics();
if (metrics.currentlyOpen > 0) {
  console.warn("Some circuits are open - external services may be down");
}
```

## Testing Error Recovery

### Test Transient Error Recovery

```typescript
let callCount = 0;
const unstableOperation = async () => {
  callCount++;
  if (callCount < 3) {
    throw new Error("Network timeout");
  }
  return "success";
};

const result = await retryWithBackoff(unstableOperation, {
  maxAttempts: 5,
  initialDelayMs: 10,
});

expect(result).toBe("success");
expect(callCount).toBe(3);
```

### Test Circuit Breaker

```typescript
const breaker = new CircuitBreaker({ failureThreshold: 3 });

// Fail enough times to open circuit
for (let i = 0; i < 3; i++) {
  try {
    await breaker.execute(async () => {
      throw new Error("Service down");
    });
  } catch (e) {}
}

expect(breaker.getState()).toBe(CircuitState.Open);
```

## Future Enhancements

Potential areas for improvement:

1. **Adaptive Retry** - Adjust retry strategy based on error patterns
2. **Rate Limit Coordination** - Share rate limit state across instances
3. **Advanced Circuit Breakers** - Per-operation circuit breakers
4. **Error Correlation** - Group related errors for root cause analysis
5. **External Alerting** - Integration with PagerDuty, Slack, etc.
6. **Metric Export** - Prometheus, StatsD integration
7. **Distributed Tracing** - OpenTelemetry support

## Related Documentation

- [Error Taxonomy](./errors.md) - Error codes and exit codes
- [Monitoring](../src/monitoring/README.md) - Monitoring framework
- [Safety Framework](../src/autopilot/safety/README.md) - Safety patterns
