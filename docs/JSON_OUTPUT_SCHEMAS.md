# JSON Output Schemas

This document describes the JSON output format for all LexRunner CLI commands that support the `--json` flag.

## Universal JSON Envelope

All commands that support `--json` output use a consistent envelope structure with metadata.

### Success Response

```json
{
  "success": true,
  "data": {/* command-specific payload */},
  "meta": {
    "command": "lex-pr <command-name>",
    "timestamp": "<ISO 8601 timestamp>",
    "version": "0.5.0"
  }
}
```

### Error Response

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {/* optional additional context */}
  },
  "meta": {
    "command": "lex-pr <command-name>",
    "timestamp": "<ISO 8601 timestamp>",
    "version": "0.5.0"
  }
}
```

## Command-Specific Schemas

### `lex-pr init --json`

Initializes a new workspace configuration.

**Success:**

```json
{
  "success": true,
  "data": {
    "profileDir": "/path/to/.smartergpt.local",
    "message": "Workspace initialized successfully"
  },
  "meta": {
    "command": "lex-pr init",
    "timestamp": "<ISO 8601 timestamp>",
    "version": "0.5.0"
  }
}
```

**Error Codes:**

- `EINIT`: Configuration already exists
- `EWRITE_PROTECTED`: Write protection error
- `EINIT_FAILED`: Initialization failed for other reasons

---

### `lex-pr discover --json`

Discovers open pull requests from GitHub.

**Success:**

```json
{
  "pullRequests": [
    {
      "number": 123,
      "title": "Add feature X",
      "branch": "feature/x",
      "author": "username",
      "sha": "abc123...",
      "labels": ["feature", "priority:high"]
    }
  ],
  "total": 1,
  "authenticated": true,
  "user": "github-username"
}
```

**With `--suggest` flag:**

```json
{
  "pullRequests": [...],
  "suggestions": [
    {
      "from": "PR-123",
      "to": "PR-456",
      "confidence": 0.85,
      "heuristic": "file-overlap",
      "reason": "Both PRs modify overlapping files"
    }
  ],
  "total": 1,
  "suggestionsCount": 1,
  "authenticated": true,
  "user": "github-username"
}
```

---

### `lex-pr plan --json`

Generates a merge execution plan.

**Success:**

<!-- lexrunner-plan-example:json-output-plan -->

```json
{
  "schemaVersion": "1.0.0",
  "target": "main",
  "items": [
    {
      "name": "feature/x",
      "gates": [
        { "name": "lint", "run": "npm run lint" },
        { "name": "test", "run": "npm test" }
      ],
      "deps": []
    }
  ],
  "policy": {
    "maxWorkers": 2,
    "mergeRule": { "type": "strict-required" }
  }
}
```

---

### `lex-pr status --json`

Shows current execution status and merge eligibility.

**Success:**

```json
{
  "plan": {
    "schemaVersion": "1.0.0",
    "target": "main",
    "itemCount": 5,
    "policy": {
      "maxWorkers": 2,
      "mergeRule": { "type": "all-gates-pass" }
    }
  },
  "mergeSummary": {
    "eligible": ["PR-123", "PR-456"],
    "pending": ["PR-789"],
    "failed": []
  }
}
```

---

### `lex-pr doctor --json`

Environment and configuration health check.

**Success:**

```json
{
  "hasErrors": false,
  "nodejs": {
    "status": "ok",
    "current": "v20.19.6",
    "expected": "v20.19.6"
  },
  "configuration": {
    "hasConfiguration": true,
    "missingFiles": [],
    "suggestions": []
  },
  "projectType": "node",
  "github": {
    "detected": true,
    "authenticated": true,
    "user": "github-username"
  },
  "git": {
    "status": "ok",
    "isClean": true,
    "currentBranch": "main"
  },
  "issues": [],
  "suggestions": []
}
```

---

### `lex-pr execute --json`

Executes gates for a plan.

**Success:**

```json
{
  "executionResults": {
    "PR-123": {
      "gates": {
        "lint": { "passed": true, "duration": 1250 },
        "test": { "passed": true, "duration": 5432 }
      },
      "allPassed": true
    }
  },
  "summary": {
    "total": 1,
    "passed": 1,
    "failed": 0
  }
}
```

---

### `lex-pr merge-order --json`

Computes dependency levels and merge order.

**Success:**

```json
{
  "levels": [["PR-123", "PR-456"], ["PR-789"], ["PR-101"]]
}
```

---

## Common Error Codes

| Code               | Description                         |
| ------------------ | ----------------------------------- |
| `ENOTFOUND`        | Required file or resource not found |
| `ESCHEMA`          | Schema validation error             |
| `ECYCLE`           | Circular dependency detected        |
| `EUNKNOWN_DEP`     | Unknown dependency reference        |
| `EWRITE_PROTECTED` | Write-protected directory or file   |
| `EGITHUB`          | GitHub API error                    |
| `EGIT`             | Git operation error                 |
| `EUNKNOWN`         | Unknown error                       |

## Usage Examples

### Basic Usage

```bash
# Output JSON for parsing
lex-pr discover --json > prs.json

# Pipe to jq for filtering
lex-pr status --json | jq '.mergeSummary.eligible'

# Check success/failure in scripts
if lex-pr doctor --json | jq -e '.success == true'; then
  echo "All checks passed"
fi
```

### Error Handling

```bash
# Capture both success and error cases
result=$(lex-pr init --json 2>&1)
if echo "$result" | jq -e '.success == true' > /dev/null; then
  echo "Initialized successfully"
  profile_dir=$(echo "$result" | jq -r '.data.profileDir')
  echo "Profile: $profile_dir"
else
  error_msg=$(echo "$result" | jq -r '.error.message')
  echo "Error: $error_msg"
  exit 1
fi
```

### Integration with CI/CD

```yaml
# GitHub Actions example
- name: Check environment
  id: doctor
  run: |
    result=$(lex-pr doctor --json)
    echo "$result" > doctor-report.json

    # Parse and use results
    has_errors=$(echo "$result" | jq -r '.hasErrors')
    if [ "$has_errors" = "true" ]; then
      echo "Environment check failed"
      exit 1
    fi
```

## Type Definitions

For TypeScript users, the JSON envelope types are defined in `src/cli/jsonEnvelope.ts`:

```typescript
interface JsonMeta {
  command: string;
  timestamp: string;
  version: string;
}

interface JsonSuccessEnvelope<T = unknown> {
  success: true;
  data: T;
  meta: JsonMeta;
}

interface JsonErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta: JsonMeta;
}

type JsonEnvelope<T = unknown> = JsonSuccessEnvelope<T> | JsonErrorEnvelope;
```
