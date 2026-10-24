# Gate Report Examples

This document provides example gate report templates for various use cases.

## Basic Gate Report

The minimal required fields for a valid gate report:

```json
{
  "item": "feature-auth",
  "gate": "lint",
  "status": "pass",
  "duration_ms": 1250,
  "started_at": "2024-01-15T10:30:00Z"
}
```

## Gate Report with Schema Version

It's recommended to include the schema version for forward compatibility:

```json
{
  "schemaVersion": "1.0.0",
  "item": "feature-auth",
  "gate": "lint",
  "status": "pass",
  "duration_ms": 1250,
  "started_at": "2024-01-15T10:30:00Z"
}
```

## Failed Gate Report

Example of a gate that failed with output paths:

```json
{
  "schemaVersion": "1.0.0",
  "item": "feature-payment",
  "gate": "test",
  "status": "fail",
  "duration_ms": 5420,
  "started_at": "2024-01-15T10:35:00Z",
  "stderr_path": "/logs/test-stderr.log",
  "stdout_path": "/logs/test-stdout.log"
}
```

## Gate Report with Metadata

Include additional context using the `meta` field:

```json
{
  "schemaVersion": "1.0.0",
  "item": "api-service",
  "gate": "integration-test",
  "status": "pass",
  "duration_ms": 12350,
  "started_at": "2024-01-15T10:40:00Z",
  "meta": {
    "exit_code": "0",
    "test_count": "42",
    "environment": "staging",
    "runner": "jest"
  }
}
```

## Gate Report with Artifacts

Include artifact metadata for build outputs, reports, or logs:

```json
{
  "schemaVersion": "1.0.0",
  "item": "frontend-app",
  "gate": "build",
  "status": "pass",
  "duration_ms": 28500,
  "started_at": "2024-01-15T10:45:00Z",
  "artifacts": [
    {
      "path": "/dist/bundle.js",
      "type": "build-output",
      "size": 524288,
      "description": "Production JavaScript bundle"
    },
    {
      "path": "/dist/bundle.js.map",
      "type": "sourcemap",
      "size": 1048576,
      "description": "Source map for debugging"
    }
  ]
}
```

## Coverage Report with Artifacts

Example for a test coverage gate:

```json
{
  "schemaVersion": "1.0.0",
  "item": "backend-api",
  "gate": "coverage",
  "status": "pass",
  "duration_ms": 8750,
  "started_at": "2024-01-15T10:50:00Z",
  "meta": {
    "coverage_percentage": "87.5",
    "lines_covered": "1425",
    "lines_total": "1628"
  },
  "artifacts": [
    {
      "path": "/coverage/index.html",
      "type": "coverage-report",
      "size": 245760,
      "description": "HTML coverage report"
    },
    {
      "path": "/coverage/lcov.info",
      "type": "lcov",
      "size": 98304,
      "description": "LCOV coverage data"
    }
  ]
}
```

## Security Scan Report

Example for a security scanning gate:

```json
{
  "schemaVersion": "1.0.0",
  "item": "auth-service",
  "gate": "security-scan",
  "status": "fail",
  "duration_ms": 15200,
  "started_at": "2024-01-15T11:00:00Z",
  "stderr_path": "/logs/security-scan-errors.log",
  "meta": {
    "scanner": "snyk",
    "vulnerabilities_found": "3",
    "critical_count": "1",
    "high_count": "2"
  },
  "artifacts": [
    {
      "path": "/reports/security-report.json",
      "type": "security-report",
      "size": 16384,
      "description": "Detailed vulnerability report"
    }
  ]
}
```

## Vulnerability Gate (vuln)

The `vuln` gate is a special built-in gate that automatically scans for vulnerability artifacts and enforces security policy thresholds.

### How It Works

1. The gate looks for vulnerability scan artifacts in the item's artifact directory
2. First checks for SARIF format (`scan-results.sarif`)
3. Falls back to npm audit JSON (`npm-audit.json`) if SARIF not found
4. Parses findings and counts by severity
5. Applies policy thresholds and fails if violations found

### Example Configuration

<!-- lexrunner-plan-example:gate-report-vulnerability -->

```json
{
  "schemaVersion": "1.0.0",
  "policy": {
    "requiredGates": ["vuln"],
    "security": {
      "blockCritical": true,
      "blockHigh": true,
      "maxMedium": 5,
      "maxLow": 10
    }
  },
  "items": [
    {
      "name": "feature-auth",
      "gates": [
        {
          "name": "vuln",
          "run": "trivy fs --format sarif --output scan-results.sarif ."
        }
      ]
    }
  ]
}
```

### Supported Scanners

Any tool that outputs **SARIF 2.1.0** format or **npm audit JSON**:

- Trivy (`trivy fs --format sarif`)
- Snyk (`snyk test --sarif`)
- CodeQL (`codeql database analyze --format=sarif-latest`)
- npm audit (`npm audit --json`)

### Example Output (Pass)

```json
{
  "gate": "vuln",
  "status": "pass",
  "exitCode": 0,
  "stdout": "Vulnerability scan results (trivy):\n  Critical: 0\n  High: 0\n  Medium: 2\n  Low: 5\n  Total: 7\n\n✅ All thresholds met",
  "stderr": "",
  "artifacts": ["scan-results.sarif"],
  "duration": 120
}
```

### Example Output (Fail)

```json
{
  "gate": "vuln",
  "status": "fail",
  "exitCode": 1,
  "stdout": "Vulnerability scan results (trivy):\n  Critical: 1\n  High: 2\n  Medium: 3\n  Low: 4\n  Total: 10\n\n❌ Policy violations:\n  - 1 critical vulnerabilities (threshold: 0)\n  - 2 high vulnerabilities (threshold: 0)",
  "stderr": "1 critical vulnerabilities (threshold: 0); 2 high vulnerabilities (threshold: 0)",
  "artifacts": ["scan-results.sarif"],
  "duration": 150
}
```

## Performance Benchmark Report

Example for a performance testing gate:

```json
{
  "schemaVersion": "1.0.0",
  "item": "api-endpoint",
  "gate": "performance",
  "status": "pass",
  "duration_ms": 45000,
  "started_at": "2024-01-15T11:10:00Z",
  "meta": {
    "p95_latency_ms": "125",
    "p99_latency_ms": "250",
    "requests_per_second": "1500",
    "error_rate": "0.001"
  },
  "artifacts": [
    {
      "path": "/reports/performance-metrics.json",
      "type": "metrics",
      "size": 32768,
      "description": "Detailed performance metrics"
    },
    {
      "path": "/reports/flame-graph.svg",
      "type": "visualization",
      "size": 204800,
      "description": "CPU flame graph"
    }
  ]
}
```

## Legacy Report Migration

If you have legacy gate reports using old field names, use the migration feature:

### Legacy Format (Pre-1.0.0)

```json
{
  "item": "feature-search",
  "gate": "test",
  "result": "success",
  "duration": 4200,
  "start_time": "2024-01-15T11:20:00Z"
}
```

### Migration Command

```bash
lex-pr gate-report validate legacy-report.json --migrate
```

### Migrated Format (1.0.0+)

```json
{
  "schemaVersion": "1.0.0",
  "item": "feature-search",
  "gate": "test",
  "status": "pass",
  "duration_ms": 4200,
  "started_at": "2024-01-15T11:20:00Z"
}
```

## Validation Tips

### Common Validation Errors

1. **Invalid Status**: Use only `"pass"` or `"fail"`
2. **Missing Required Fields**: Ensure `item`, `gate`, `status`, `duration_ms`, and `started_at` are present
3. **Invalid Timestamp**: Use ISO 8601 format (e.g., `"2024-01-15T10:30:00Z"`)
4. **Negative Duration**: `duration_ms` must be >= 0
5. **Invalid Schema Version**: Must match pattern `1.x.y` (e.g., `"1.0.0"`, `"1.2.3"`)

### Validation Commands

```bash
# Validate a single report
lex-pr gate-report validate report.json

# Get JSON output for CI/CD integration
lex-pr gate-report validate report.json --json

# Migrate and validate legacy report
lex-pr gate-report validate legacy-report.json --migrate
```

### Example Validation Output

**Success:**

```
✓ report.json is valid

  Item: feature-auth
  Gate: lint
  Status: ✅ pass
  Duration: 1250ms
  Schema Version: 1.0.0
```

**Failure with Suggestions:**

```
❌ Validation failed for report.json:

  status: Invalid enum value. Expected 'pass' | 'fail', received 'invalid-status'
    💡 Valid values: "pass" or "fail"
  started_at: Required
    💡 Use ISO 8601 format: "2024-01-15T10:30:00Z"
```

## JSON Schema

The complete JSON schema is available at `schemas/gate-report.schema.json` for validation in your IDE or CI/CD pipeline.

### Using with JSON Schema Validators

```bash
# Using ajv-cli
ajv validate -s schemas/gate-report.schema.json -d report.json

# Using VSCode
# Add to .vscode/settings.json:
{
  "json.schemas": [
    {
      "fileMatch": ["**/gate-results/*.json"],
      "url": "./schemas/gate-report.schema.json"
    }
  ]
}
```
