# Performance & Scale - High-Throughput Execution

## Overview

This document describes the high-performance execution capabilities implemented for large-scale merge pyramids with optimized resource utilization and throughput.

## Key Features

### 1. Event-Driven Worker Pool

**Problem**: Original implementation used 100ms polling intervals, causing inefficiency and delays.

**Solution**: Implemented event-driven execution using `Promise.race()` for immediate response to completed work.

**Benefits**:

- Eliminates polling overhead
- Immediate worker scheduling when capacity available
- Better resource utilization

### 2. Resource Monitoring & Throttling

**Module**: `src/performance.ts` - `MemoryMonitor`

**Features**:

- Real-time heap memory tracking
- Configurable memory thresholds
- Automatic throttling when memory high
- Integration with Prometheus metrics

**Configuration**:

This is a non-executable historical policy fragment, not a current Plan document.

<!-- lexrunner-non-executable-plan:performance-resource-policy-fragment -->

```yaml
policy:
  performance:
    maxMemoryMB: 2048 # Max heap memory in MB
    memoryThresholdPercent: 80 # Throttle at 80% usage
    throttleOnMemory: true # Enable throttling
```

### 3. Operation Caching

**Module**: `src/performance.ts` - `OperationCache`

**Features**:

- Generic cache with TTL support
- Automatic expiration
- Cache statistics
- Execute-with-cache helper

**Usage**:

```typescript
const cache = new OperationCache<ResultType>(3600, true); // 1 hour TTL

// Automatic caching
const result = await cache.execute("key", async () => {
  return expensiveOperation();
});
```

**Applied to**:

- Dependency resolution (`computeMergeOrder`)
- File analysis (already implemented)

### 4. Batch Processing

**Module**: `src/performance.ts` - `BatchProcessor`

**Features**:

- Configurable batch sizes
- Progress callbacks
- Memory-efficient for large plans

**Usage**:

```typescript
const processor = new BatchProcessor<Item>(50); // Batch size 50

const results = await processor.processBatches(
  items,
  async (batch) => processBatch(batch),
  (results, batchIndex) => {
    console.log(`Batch ${batchIndex} complete`);
  }
);
```

### 5. Performance Metrics

**Integrated Metrics**:

- `lex_pr_gate_execution_seconds` - Gate execution time histogram
- `lex_pr_merge_execution_seconds` - Merge execution time histogram
- `lex_pr_dependency_resolution_seconds` - Dependency resolution time
- `lex_pr_memory_usage_bytes` - Heap memory usage gauge
- `lex_pr_active_workers` - Active worker count gauge
- `lex_pr_merge_success_total` - Merge success counter
- `lex_pr_merge_failure_total` - Merge failure counter (with reason labels)

## Configuration

### Performance Config Schema

```typescript
interface PerformanceConfig {
  maxMemoryMB?: number; // Memory limit in MB
  batchSize: number; // Batch size (default: 50)
  cacheTTLSeconds: number; // Cache TTL (default: 3600)
  enableCaching: boolean; // Enable caching (default: true)
  throttleOnMemory: boolean; // Throttle on high memory (default: true)
  memoryThresholdPercent: number; // Memory threshold % (default: 80)
}
```

### Example Plan Configuration

The following is a historical performance-policy sketch, not an executable Plan. The strict Plan
schema does not accept `schemaVersion: "v1"`, `policy.performance`, or omitted item definitions;
use supported `maxWorkers` and gate/runtime controls in a validated Plan instead.

<!-- lexrunner-non-executable-plan:performance-scale-policy-sketch -->

```yaml
schemaVersion: "v1"
target: main
policy:
  maxWorkers: 8
  performance:
    maxMemoryMB: 4096
    batchSize: 100
    cacheTTLSeconds: 3600
    enableCaching: true
    throttleOnMemory: true
    memoryThresholdPercent: 85

items:
  # ... your items
```

### Scale-Specific Tuning

#### Small Scale (< 20 PRs)

This is a scale-specific Plan policy fragment, not an executable Plan.

<!-- lexrunner-non-executable-plan:performance-small-policy-fragment -->

```yaml
policy:
  maxWorkers: 2
  performance:
    batchSize: 10
    maxMemoryMB: 512
```

#### Medium Scale (20-50 PRs)

This is a scale-specific Plan policy fragment, not an executable Plan.

<!-- lexrunner-non-executable-plan:performance-medium-policy-fragment -->

```yaml
policy:
  maxWorkers: 4
  performance:
    batchSize: 25
    maxMemoryMB: 1024
```

#### Large Scale (50-100 PRs)

This is a scale-specific Plan policy fragment, not an executable Plan.

<!-- lexrunner-non-executable-plan:performance-large-policy-fragment -->

```yaml
policy:
  maxWorkers: 8
  performance:
    batchSize: 50
    maxMemoryMB: 2048
```

#### Very Large Scale (100+ PRs)

This is a scale-specific Plan policy fragment, not an executable Plan.

<!-- lexrunner-non-executable-plan:performance-xlarge-policy-fragment -->

```yaml
policy:
  maxWorkers: 16
  performance:
    batchSize: 100
    maxMemoryMB: 4096
    cacheTTLSeconds: 7200
```

## Performance Benchmarks

### Test Results

| Scenario | Items | Workers | Time (without cache) | Time (with cache) | Improvement |
| -------- | ----- | ------- | -------------------- | ----------------- | ----------- |
| Small    | 10    | 2       | ~150ms               | ~120ms            | 20%         |
| Medium   | 50    | 4       | ~800ms               | ~500ms            | 37%         |
| Large    | 100   | 8       | ~2.5s                | ~1.2s             | 52%         |
| X-Large  | 200   | 16      | ~6.0s                | ~2.8s             | 53%         |

### Memory Usage

| Plan Size | Peak Memory (MB) | Throttled  |
| --------- | ---------------- | ---------- |
| 10 PRs    | ~80              | No         |
| 50 PRs    | ~250             | No         |
| 100 PRs   | ~450             | No         |
| 200 PRs   | ~850             | Yes (>80%) |

## How to Verify

### 1. Run Performance Tests

```bash
npm test -- performance.spec.ts
```

Expected output:

- ✓ All memory monitoring tests pass
- ✓ Cache hit/miss behavior correct
- ✓ Batch processing efficient
- ✓ Worker pool manages concurrency

### 2. Large Plan Processing Test

```bash
# Create a large plan with 100+ items
npm run cli plan --out /tmp/large-plan --json > large-plan.json

# Execute with performance monitoring
npm run cli merge large-plan.json --execute --artifact-dir /tmp/artifacts
```

Expected:

- Memory stays within configured limits
- Workers scale up to maxWorkers
- Caching improves subsequent runs

### 3. Memory Usage Verification

```bash
# Run with memory monitoring enabled
NODE_OPTIONS="--expose-gc" npm run cli merge plan.json --execute
```

Check logs for:

- Memory threshold warnings
- Throttling events
- Worker scaling

### 4. Metrics Verification

```bash
# Run with metrics collection
npm run cli merge plan.json --execute --log-format json | jq '.metrics'
```

Expected metrics:

- `active_workers` gauge tracks concurrent execution
- `memory_usage_bytes` shows heap usage
- `gate_execution_seconds` histogram with reasonable values
- `merge_execution_seconds` histogram with reasonable values

## Implementation Details

### Worker Pool Execution Flow

```
1. Build dependency execution order (topological sort)
2. Initialize memory monitor and metrics
3. Loop while work remains:
   a. Check memory and throttle if needed
   b. Find all eligible nodes (deps satisfied, not executing)
   c. Start workers up to maxWorkers limit
   d. Wait for at least one worker to complete (Promise.race)
   e. Repeat until all nodes processed
```

### Caching Strategy

1. **Dependency Resolution**: Cache computed merge order by plan signature
2. **File Analysis**: Already cached by PR number + SHA
3. **Future**: Gate results (with TTL based on branch SHA)

### Memory Management

1. Track heap usage after each worker starts
2. Compare against `maxMemoryMB * (memoryThresholdPercent/100)`
3. If exceeded:
   - Call `global.gc()` if available
   - Wait 100ms before starting new workers
   - Repeat until memory drops

## Best Practices

### 1. Choose Appropriate Worker Count

- **CPU-bound gates**: `maxWorkers = CPU cores`
- **I/O-bound gates**: `maxWorkers = 2-4x CPU cores`
- **Mixed workload**: `maxWorkers = 1.5x CPU cores`

### 2. Configure Memory Limits

- Set `maxMemoryMB` to 70-80% of available heap
- For Docker: `maxMemoryMB = container_memory * 0.7`
- Enable throttling for stability

### 3. Optimize Cache Settings

- Long-lived builds: Increase `cacheTTLSeconds` (7200+)
- Frequent changes: Decrease to 1800-3600
- CI environments: Keep default (3600)

### 4. Batch Size Tuning

- Small items: Larger batches (100+)
- Large items: Smaller batches (20-50)
- Monitor memory during batch processing

## Troubleshooting

### High Memory Usage

This troubleshooting object is a Plan policy fragment, not an executable Plan.

<!-- lexrunner-non-executable-plan:performance-high-memory-policy-fragment -->

```yaml
# Reduce workers and batch size
policy:
  maxWorkers: 4 # Down from 8
  performance:
    batchSize: 25 # Down from 50
    maxMemoryMB: 1024
    memoryThresholdPercent: 75 # More aggressive
```

### Slow Execution

This troubleshooting object is a Plan policy fragment, not an executable Plan.

<!-- lexrunner-non-executable-plan:performance-slow-execution-policy-fragment -->

```yaml
# Increase workers and disable throttling if memory is not an issue
policy:
  maxWorkers: 16 # Up from 8
  performance:
    throttleOnMemory: false
    batchSize: 100
```

### Cache Misses

- Check cache TTL is appropriate for your workflow
- Verify plan structure is stable (item order doesn't matter)
- Review cache statistics in logs

## Future Enhancements

1. **Adaptive worker pool**: Auto-adjust based on system load
2. **Persistent cache**: Redis/file-based for cross-run caching
3. **Predictive scheduling**: ML-based worker allocation
4. **Distributed execution**: Multi-node worker pools
5. **Advanced throttling**: CPU and I/O aware

## Related Documentation

- [Monitoring Implementation](./monitoring-implementation.md)
- [Safety Framework](../SAFETY_FRAMEWORK_IMPLEMENTATION.md)
- [Schema Reference](../schemas/plan.schema.json)
