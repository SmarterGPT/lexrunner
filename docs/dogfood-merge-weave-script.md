# Dogfood Merge-Weave Script

> **Legacy helper:** the checked-in `merge-weave-dogfood.json` uses the retired
> `nodes` / `dependsOn` graph shape and is not a current executable Plan. Supply a schema-valid
> `plan.json`; validation failure does not become execution or merge authority.

## Overview

The `scripts/dogfood-merge-weave.sh` script provides a parameterized, repo-agnostic wrapper around `lexrunner` commands for executing merge-weave workflows. It automates the complete workflow from plan generation to merge execution and reporting.

## Features

- **Flexible Plan Sources**: Load a Plan file or generate one through
  `lexrunner weave plan --from-github`
- **Parameterized Configuration**: Customize repository path, artifacts location, and execution mode
- **Automated Workflow**: Runs validation gates, analyzes merge order, and executes merges
- **Rich Output**: Generates JSON artifacts, markdown reports, and user-friendly console output
- **Fail-Closed Preconditions**: Stops before gates or merge commands when schema or dependency analysis fails

## Installation

The script is located at `scripts/dogfood-merge-weave.sh` and requires:

- Bash shell (Git Bash on Windows, or Bash on Linux/macOS)
- `lexrunner` CLI (installed globally or via npm)
- `jq` (optional, for enhanced plan summaries)

On Windows, invoke a real Bash runtime such as Git Bash. The Windows `bash.exe` WSL launcher is
not itself a Bash installation and fails with `/bin/bash` errors when no WSL distribution provides
that executable.

## Usage

```bash
./scripts/dogfood-merge-weave.sh [options]
```

### Options

#### Repository Options

- `--repo <path>` - Path to repository (default: current directory)

#### Plan Source Options (choose one)

- `--plan <path>` - Path to plan.json file
- `--from-github` - Discover PRs from GitHub using filters

#### GitHub Discovery Options (used with --from-github)

- `--owner <name>` - GitHub repository owner
- `--repo-name <name>` - GitHub repository name
- `--base <branch>` - Base branch (default: repository default branch)
- `--labels <labels>` - Comma-separated list of labels to filter PRs
- `--query <query>` - Custom GitHub search query

#### Output Options

- `--artifacts <dir>` - Artifacts output directory (default: ./artifacts/dogfood-<timestamp>). If
  reused, any prior `dogfood-report.md` is invalidated before validation begins and is recreated
  only after the whole workflow succeeds.

#### Execution Options

- `--dry-run` - Preview operations without executing (default)
- `--execute` - Actually perform merge operations
- `--verbose` - Enable verbose output

#### Other Options

- `-h, --help` - Show help message

## Examples

### Dry Run with Existing Plan File

Preview merge operations without executing:

```bash
./scripts/dogfood-merge-weave.sh --plan plan.json --dry-run
```

### Execute from GitHub Discovery

Discover PRs from GitHub and execute merge:

```bash
./scripts/dogfood-merge-weave.sh \
  --from-github \
  --owner myorg \
  --repo-name myrepo \
  --labels "ready-to-merge" \
  --execute
```

### Execute with Custom Configuration

Use a custom repository and artifacts directory:

```bash
./scripts/dogfood-merge-weave.sh \
  --repo /srv/my-project \
  --plan plan.json \
  --artifacts ./output/dogfood-run \
  --execute
```

### Discover and Preview PRs

Preview PRs from GitHub without merging:

```bash
./scripts/dogfood-merge-weave.sh \
  --from-github \
  --owner octocat \
  --repo-name hello-world \
  --base main \
  --dry-run \
  --verbose
```

### Execute with Verbose Output

Get detailed output during execution:

```bash
./scripts/dogfood-merge-weave.sh \
  --plan plan.json \
  --execute \
  --verbose
```

## Workflow Steps

The script executes the following workflow:

1. **Plan Generation/Validation**
   - If `--from-github`: Calls the canonical `weave plan --from-github` route and writes a strict
     `plan.json`; it does not treat `discover` output as a Plan
   - If `--plan`: Loads the supplied plan file
   - Validates either source against the current Plan schema and stops on failure before gates,
     dependency analysis, preview, or execution

2. **Gate Validation**
   - Runs local gates: lint, typecheck
   - Optionally runs tests (only in execute mode)

3. **Merge Analysis**
   - Computes merge order and dependencies
   - Generates merge-order.json artifact
   - Stops before preview or execution if dependency/order analysis fails

4. **Merge Execution**
   - Dry-run: Previews merge operations without executing; a failed preview is a failed workflow
   - Execute: Performs actual merge operations and propagates command failure

5. **Report Generation**
   - Generates a markdown report only after the selected merge command succeeds
   - Invalidates a stale report at run start, so a failed rerun in the same directory cannot retain
     earlier success evidence
   - Saves artifacts to the selected output directory

## Output Artifacts

All artifacts are saved to the artifacts directory (default: `./artifacts/dogfood-<timestamp>/`):

- `plan.json` - Generated plan (if using --from-github)
- `merge-order.json` - Computed merge order and dependencies
- `dry-run.json` - Dry-run preview (if in dry-run mode)
- `merge-results.json` - Merge execution results (if in execute mode)
- `dogfood-report.md` - Comprehensive markdown report

## Exit Codes

- `0` - The full workflow, including merge preview or execution, succeeded
- `1` - A wrapper-level error such as missing arguments, an invalid path, or missing tooling
- Other nonzero values - The failed `lex-pr` command's exit status, including schema validation,
  merge-order analysis, and dry-run/execute merge failures

## Error Handling

The script fails closed at every prerequisite:

- **Schema Validation Failures**: Stops before local gates, merge-order analysis, or merge commands
- **Dependency/Order Failures**: Stops before dry-run preview or merge execution
- **Merge Preview Failures**: Returns the preview command's nonzero status and does not write a
  success report
- **Reused Artifact Directories**: Removes only the prior `dogfood-report.md` at run start; a new
  report is written only after success
- **Argument Boundaries**: Passes Plan paths, repository paths, queries, labels, and branch values
  as Bash array elements so spaces and wildcard characters are not reinterpreted by the shell
- **Missing Dependencies**: Checks for required tools and provides clear error messages

## Integration with CI/CD

The script can be used in CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Run dogfood merge-weave
  run: |
    ./scripts/dogfood-merge-weave.sh \
      --from-github \
      --owner ${{ github.repository_owner }} \
      --repo-name ${{ github.event.repository.name }} \
      --labels "auto-merge" \
      --execute
```

## Troubleshooting

### Script fails with "lex-pr command not found"

The script automatically falls back to `npm run cli` if `lex-pr` is not in PATH. Ensure you're running from the repository root or install `lexrunner` globally.

### Schema validation failures

The script stops before any gate or merge command if validation fails. Generate or supply a current
schema-valid `plan.json`; retired `nodes` / `dependsOn` formats are not executable inputs.

### Merge conflicts

In execute mode, the script will stop if merge conflicts occur. Resolve conflicts manually and re-run with `--resume` (if supported by the lex-pr merge command).

### Permission denied errors

Ensure the script is executable:

```bash
chmod +x scripts/dogfood-merge-weave.sh
```

## Related Documentation

- [Merge Weave Usage Guide](../MERGE_WEAVE_USAGE_GUIDE.md)
- [lexrunner README](../README.md)
- [Plan Schema Documentation](../schemas/)

## Contributing

When modifying the script:

1. Update the help text and this documentation
2. Add test cases in `tests/dogfood-merge-weave-script.spec.ts`
3. Test with both plan file and GitHub discovery modes
4. Keep all executable examples current-schema valid; do not silently accept retired plan formats
