# Performance Configuration Examples

> **Illustrative legacy sketches only.** The Plan-shaped YAML blocks in this file are not
> executable inputs. They use the unsupported `schemaVersion: "v1"`, historical
> `policy.performance` fields, or ellipses/incomplete required gates. Validate real Plan files
> against the current schema and use supported `maxWorkers`, gate runtime, and process controls.

## Small Project (< 20 PRs)

<!-- lexrunner-non-executable-plan:performance-small-legacy -->

```yaml
# plan-small.yml
schemaVersion: "v1"
target: main

policy:
  maxWorkers: 2
  requiredGates: ["lint", "test"]

  # Performance tuning for small scale
  performance:
    batchSize: 10
    maxMemoryMB: 512
    cacheTTLSeconds: 1800
    enableCaching: true
    throttleOnMemory: false # Not needed for small scale
    memoryThresholdPercent: 90

items:
  - name: feature-1
    deps: []
    gates:
      - name: lint
        run: npm run lint
```

## Medium Project (20-50 PRs)

<!-- lexrunner-non-executable-plan:performance-medium-legacy -->

```yaml
# plan-medium.yml
schemaVersion: "v1"
target: main

policy:
  maxWorkers: 4
  requiredGates: ["lint", "test", "build"]

  # Performance tuning for medium scale
  performance:
    batchSize: 25
    maxMemoryMB: 1024
    cacheTTLSeconds: 3600
    enableCaching: true
    throttleOnMemory: true
    memoryThresholdPercent: 80

items:
  - name: feature-1
    deps: []
    gates:
      - name: lint
        run: npm run lint
      - name: test
        run: npm test
      - name: build
        run: npm run build

  - name: feature-2
    deps: [feature-1]
    gates:
      - name: lint
        run: npm run lint
      - name: test
        run: npm test
```

## Large Project (50-100 PRs)

<!-- lexrunner-non-executable-plan:performance-large-legacy -->

```yaml
# plan-large.yml
schemaVersion: "v1"
target: main

policy:
  maxWorkers: 8
  requiredGates: ["lint", "test", "build", "integration"]

  # Retry configuration for stability at scale
  retries:
    test:
      maxAttempts: 3
      backoffSeconds: 5
    integration:
      maxAttempts: 2
      backoffSeconds: 10

  # Performance tuning for large scale
  performance:
    batchSize: 50
    maxMemoryMB: 2048
    cacheTTLSeconds: 3600
    enableCaching: true
    throttleOnMemory: true
    memoryThresholdPercent: 80

items:
  # Stack 1: Core infrastructure (20 PRs)
  - name: infra-base
    deps: []
    gates: [...]

  # Stack 2: API services (30 PRs, depends on infra)
  - name: api-auth
    deps: [infra-base]
    gates: [...]

  - name: api-users
    deps: [infra-base]
    gates: [...]

  # Stack 3: Frontend (20 PRs, depends on APIs)
  - name: ui-dashboard
    deps: [api-auth, api-users]
    gates: [...]
```

## Very Large Project (100+ PRs)

<!-- lexrunner-non-executable-plan:performance-xlarge-legacy -->

```yaml
# plan-xlarge.yml
schemaVersion: "v1"
target: main

policy:
  maxWorkers: 16
  requiredGates: ["lint", "test", "build", "integration", "e2e"]

  # Aggressive retry for reliability
  retries:
    test:
      maxAttempts: 3
      backoffSeconds: 5
    integration:
      maxAttempts: 3
      backoffSeconds: 10
    e2e:
      maxAttempts: 2
      backoffSeconds: 30

  # Performance tuning for very large scale
  performance:
    batchSize: 100
    maxMemoryMB: 4096
    cacheTTLSeconds: 7200 # 2 hours for stability
    enableCaching: true
    throttleOnMemory: true
    memoryThresholdPercent: 85 # More aggressive threshold

items:
  # Automatically generated from GitHub API
  # with dependency detection from file analysis
```

## CI/CD Integration Examples

### GitHub Actions

```yaml
# .github/workflows/merge-pyramid.yml
name: Merge Pyramid

on:
  workflow_dispatch:
    inputs:
      plan_size:
        description: "Plan size (small/medium/large/xlarge)"
        required: true
        default: "medium"

jobs:
  execute-merge-pyramid:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v7

      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version: "24"

      - name: Install dependencies
        run: npm ci

      - name: Generate plan from GitHub PRs
        run: |
          npm run cli plan \
            --from-github \
            --query "is:open label:stack:*" \
            --out /tmp/plan \
            --json > plan.json

      - name: Configure performance based on size
        run: |
          case "${{ github.event.inputs.plan_size }}" in
            small)
              MAX_WORKERS=2
              MAX_MEMORY=512
              BATCH_SIZE=10
              ;;
            medium)
              MAX_WORKERS=4
              MAX_MEMORY=1024
              BATCH_SIZE=25
              ;;
            large)
              MAX_WORKERS=8
              MAX_MEMORY=2048
              BATCH_SIZE=50
              ;;
            xlarge)
              MAX_WORKERS=16
              MAX_MEMORY=4096
              BATCH_SIZE=100
              ;;
          esac

          # Update plan with performance config
          jq ".policy.maxWorkers = $MAX_WORKERS | 
              .policy.performance.maxMemoryMB = $MAX_MEMORY | 
              .policy.performance.batchSize = $BATCH_SIZE" \
            plan.json > plan-configured.json

      - name: Execute merge pyramid with monitoring
        run: |
          NODE_OPTIONS="--expose-gc --max-old-space-size=4096" \
          npm run cli merge plan-configured.json \
            --execute \
            --artifact-dir /tmp/artifacts \
            --log-format json

      - name: Upload artifacts
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: merge-results
          path: /tmp/artifacts
```

### Docker Example

```dockerfile
# Dockerfile for high-performance execution
FROM node:20-alpine

# Install git for merge operations
RUN apk add --no-cache git

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

# Configure Node.js for performance
ENV NODE_OPTIONS="--expose-gc --max-old-space-size=8192"

# Default to large scale configuration
ENV MAX_WORKERS=8
ENV MAX_MEMORY_MB=4096
ENV BATCH_SIZE=50

ENTRYPOINT ["npm", "run", "cli", "merge"]
CMD ["--help"]
```

Run with:

```bash
docker run \
  -v $(pwd)/plan.json:/app/plan.json \
  -v $(pwd)/artifacts:/app/artifacts \
  -e MAX_WORKERS=16 \
  -e MAX_MEMORY_MB=8192 \
  lexrunner:latest \
  /app/plan.json \
  --execute \
  --artifact-dir /app/artifacts
```

## Monitoring & Observability

### Enable Metrics Export

This is another non-executable legacy performance-policy sketch.

<!-- lexrunner-non-executable-plan:performance-metrics-legacy -->

```yaml
# plan-with-metrics.yml
schemaVersion: "v1"
target: main

policy:
  maxWorkers: 8
  performance:
    maxMemoryMB: 2048
    # ... other config

items:
  # ... your items
```

Run with metrics:

```bash
# JSON logging for metrics collection
npm run cli merge plan.json \
  --execute \
  --log-format json | tee execution.log

# Extract metrics
cat execution.log | jq -r 'select(.metrics) | .metrics' > metrics.json
```

### Grafana Dashboard Query Examples

```promql
# Average gate execution time
avg(lex_pr_gate_execution_seconds)

# P95 merge execution time
histogram_quantile(0.95, rate(lex_pr_merge_execution_seconds_bucket[5m]))

# Memory usage trend
lex_pr_memory_usage_bytes{type="heap_used"}

# Active workers over time
lex_pr_active_workers

# Success rate
sum(rate(lex_pr_merge_success_total[5m])) /
(sum(rate(lex_pr_merge_success_total[5m])) + sum(rate(lex_pr_merge_failure_total[5m])))
```

## Troubleshooting Performance Issues

### Issue: High Memory Usage

This troubleshooting object is a Plan policy fragment, not an executable Plan.

<!-- lexrunner-non-executable-plan:performance-example-high-memory-policy -->

```yaml
# Reduce memory footprint
policy:
  maxWorkers: 4 # Reduce from 8
  performance:
    batchSize: 25 # Reduce from 50
    maxMemoryMB: 1024 # Lower limit
    memoryThresholdPercent: 75 # More aggressive throttling
    throttleOnMemory: true # Ensure enabled
```

### Issue: Slow Execution

This troubleshooting object is a Plan policy fragment, not an executable Plan.

<!-- lexrunner-non-executable-plan:performance-example-slow-execution-policy -->

```yaml
# Increase parallelism (if memory allows)
policy:
  maxWorkers: 16 # Increase from 8
  performance:
    batchSize: 100 # Larger batches
    throttleOnMemory: false # Disable if memory is not constrained
    enableCaching: true # Ensure caching is on
    cacheTTLSeconds: 7200 # Longer cache for stability
```

### Issue: Cache Ineffectiveness

Check cache hit rate:

```bash
npm run cli merge plan.json --execute --log-format json | \
  jq -r 'select(.cache_stats) | .cache_stats'
```

If hit rate is low:

1. Ensure plan structure is stable
2. Increase TTL: `cacheTTLSeconds: 7200`
3. Check for frequent plan modifications

## Best Practices Summary

1. **Start Conservative**: Begin with medium scale config and adjust
2. **Monitor Memory**: Watch for throttling events in logs
3. **Profile First Run**: Collect metrics to inform tuning
4. **Scale Gradually**: Increase workers in increments of 2-4
5. **Use Caching**: Enable for all long-running plans
6. **Set Limits**: Always configure `maxMemoryMB` in production
7. **Test Locally**: Validate config with dry runs first
