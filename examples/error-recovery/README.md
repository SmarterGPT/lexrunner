# Error Recovery Configuration Examples

This directory preserves legacy split `stack.yml` plus `policy.json` sketches demonstrating error
recovery concepts. They are not executable current Plans: they omit `schemaVersion` and use the
historical `id`/`branch` item shape. Use the retry fields in a schema-valid Plan instead.

## Example 1: Basic Retry Configuration

A legacy split-config sketch with retry logic for flaky tests:

<!-- lexrunner-non-executable-plan:error-recovery-legacy-basic-stack -->

```yaml
# .smartergpt/stack.yml
version: 1
target: main

items:
  - id: unit-tests
    branch: feat/unit-tests
    deps: []
    gates:
      - name: test
        run: npm test

  - id: integration-tests
    branch: feat/integration
    deps: [unit-tests]
    gates:
      - name: integration
        run: npm run test:integration
```

<!-- lexrunner-non-executable-plan:error-recovery-legacy-basic-policy -->

```json
// .smartergpt/policy.json
{
  "requiredGates": ["test"],
  "optionalGates": ["integration"],
  "maxWorkers": 2,
  "retries": {
    "test": {
      "maxAttempts": 1,
      "backoffSeconds": 0
    },
    "integration": {
      "maxAttempts": 3,
      "backoffSeconds": 5
    }
  },
  "blockOn": [],
  "mergeRule": {
    "type": "strict-required"
  }
}
```

**Explanation:**

- Unit tests run once (no retries) - they should be stable
- Integration tests retry up to 3 times with 5-second exponential backoff
- Integration tests are optional (won't block merge if they fail after retries)

## Example 2: External Service Dependencies

Legacy split-config sketch for external service failures:

<!-- lexrunner-non-executable-plan:error-recovery-legacy-service-stack -->

```yaml
# .smartergpt/stack.yml
version: 1
target: main

items:
  - id: api-changes
    branch: feat/api-updates
    deps: []
    gates:
      - name: lint
        run: npm run lint
      - name: test
        run: npm test
      - name: e2e
        run: npm run test:e2e
        runtime: ci-service # Will gracefully degrade if unavailable
```

<!-- lexrunner-non-executable-plan:error-recovery-legacy-service-policy -->

```json
// .smartergpt/policy.json
{
  "requiredGates": ["lint", "test"],
  "optionalGates": ["e2e"],
  "maxWorkers": 2,
  "retries": {
    "lint": {
      "maxAttempts": 1,
      "backoffSeconds": 0
    },
    "test": {
      "maxAttempts": 2,
      "backoffSeconds": 3
    },
    "e2e": {
      "maxAttempts": 3,
      "backoffSeconds": 10
    }
  }
}
```

**Explanation:**

- E2E tests use CI service runtime (not yet implemented)
- System will gracefully degrade and skip E2E tests
- Core gates (lint, test) are still required
- E2E is optional, so PR can still merge

## Example 3: Progressive Retry Strategy

Different retry strategies for different gate types:

<!-- lexrunner-non-executable-plan:error-recovery-progressive-policy -->

```json
// .smartergpt/policy.json
{
  "requiredGates": ["build", "lint", "test", "security"],
  "optionalGates": ["performance", "visual-regression"],
  "maxWorkers": 3,
  "retries": {
    "build": {
      "maxAttempts": 1,
      "backoffSeconds": 0
    },
    "lint": {
      "maxAttempts": 1,
      "backoffSeconds": 0
    },
    "test": {
      "maxAttempts": 2,
      "backoffSeconds": 5
    },
    "security": {
      "maxAttempts": 3,
      "backoffSeconds": 10
    },
    "performance": {
      "maxAttempts": 3,
      "backoffSeconds": 15
    },
    "visual-regression": {
      "maxAttempts": 5,
      "backoffSeconds": 20
    }
  },
  "mergeRule": {
    "type": "strict-required"
  }
}
```

**Retry Strategy Guidelines:**

| Gate Type         | Max Attempts | Backoff | Rationale                    |
| ----------------- | ------------ | ------- | ---------------------------- |
| Build             | 1            | 0s      | Deterministic, config errors |
| Lint              | 1            | 0s      | Deterministic, code quality  |
| Unit Tests        | 1-2          | 3-5s    | Mostly stable, rare flakes   |
| Integration Tests | 2-3          | 5-10s   | External deps, network       |
| E2E Tests         | 3-5          | 10-20s  | Browser, timing, network     |
| Performance Tests | 3-5          | 15-30s  | Resource contention          |
| Security Scans    | 2-3          | 10-15s  | Network, rate limits         |

## Best Practices

### 1. Start Conservative

Begin with minimal retries and increase based on observed failure patterns:

```json
{
  "retries": {
    "test": {
      "maxAttempts": 1,
      "backoffSeconds": 0
    }
  }
}
```

### 2. Monitor Before Tuning

Collect metrics before adjusting retry configuration.

### 3. Use Circuit Breakers for External Services

Always wrap external service calls with circuit breakers.

### 4. Set Appropriate Timeouts

Prevent hanging operations with reasonable timeout values.

### 5. Alert on Error Patterns

Set up alerts for repeated failures to catch issues early.

## Related Documentation

- [Error Recovery Patterns](../../docs/error-recovery.md)
- [Error Taxonomy](../../docs/errors.md)
