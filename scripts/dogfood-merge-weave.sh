#!/usr/bin/env bash

# Generic Dogfood Merge-Weave Script
# A parameterized, repo-agnostic script for executing merge-weave workflows
#
# This script wraps lexrunner commands to provide a reusable workflow for:
# - Discovering PRs from GitHub (or using a plan file)
# - Running gates locally
# - Executing merge pyramid
# - Generating artifacts and reports
#
# Usage:
#   ./dogfood-merge-weave.sh [options]
#
# Examples:
#   # Dry run with plan file
#   ./dogfood-merge-weave.sh --plan plan.json --dry-run
#
#   # Execute from GitHub discovery
#   ./dogfood-merge-weave.sh --from-github --owner myorg --repo-name myrepo --labels "ready-to-merge" --execute
#
#   # Execute with custom settings
#   ./dogfood-merge-weave.sh --plan plan.json --repo /path/to/repo --artifacts ./output --execute

set -e
set -o pipefail

# Default values
REPO_DIR="$(pwd)"
PLAN_FILE=""
FROM_GITHUB=false
GITHUB_OWNER=""
GITHUB_REPO=""
GITHUB_BASE=""
GITHUB_LABELS=""
GITHUB_QUERY=""
ARTIFACTS_DIR=""
DRY_RUN=true
EXECUTE=false
VERBOSE=false

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Helper functions
print_header() {
    echo ""
    echo -e "${BOLD}═════════════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}$1${NC}"
    echo -e "${BOLD}═════════════════════════════════════════════════════════════════${NC}"
    echo ""
}

print_section() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}$1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

print_step() {
    echo ""
    echo -e "${BOLD}$1${NC}"
    echo ""
}

print_success() {
    printf "%b✅ %s%b\n" "$GREEN" "$1" "$NC"
}

print_error() {
    printf "%b❌ %s%b\n" "$RED" "$1" "$NC"
}

print_warning() {
    printf "%b⚠️  %s%b\n" "$YELLOW" "$1" "$NC"
}

print_info() {
    printf "%bℹ️  %s%b\n" "$BLUE" "$1" "$NC"
}

usage() {
    cat << EOF
Generic Dogfood Merge-Weave Script

Usage: $0 [options]

Repository Options:
  --repo <path>              Path to repository (default: current directory)

Plan Source Options (choose one):
  --plan <path>              Path to plan.json file
  --from-github              Discover PRs from GitHub using filters

GitHub Discovery Options (used with --from-github):
  --owner <name>             GitHub repository owner
  --repo-name <name>         GitHub repository name
  --base <branch>            Base branch (default: repository default branch)
  --labels <labels>          Comma-separated list of labels to filter PRs
  --query <query>            Custom GitHub search query

Output Options:
  --artifacts <dir>          Artifacts output directory (default: ./artifacts/dogfood-<timestamp>)

Execution Options:
  --dry-run                  Preview operations without executing (default)
  --execute                  Actually perform merge operations
  --verbose                  Enable verbose output

Other Options:
  -h, --help                 Show this help message

Examples:
  # Dry run with existing plan file
  $0 --plan plan.json --dry-run

  # Execute from GitHub with labels filter
  $0 --from-github --owner myorg --repo-name myrepo --labels "ready-to-merge" --execute

  # Execute with a custom repository
  $0 --repo /srv/my-project --plan plan.json --execute

  # Discover and preview PRs from GitHub
  $0 --from-github --owner octocat --repo-name hello-world --base main --dry-run

EOF
    exit 0
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --repo)
            REPO_DIR="$2"
            shift 2
            ;;
        --plan)
            PLAN_FILE="$2"
            shift 2
            ;;
        --from-github)
            FROM_GITHUB=true
            shift
            ;;
        --owner)
            GITHUB_OWNER="$2"
            shift 2
            ;;
        --repo-name)
            GITHUB_REPO="$2"
            shift 2
            ;;
        --base)
            GITHUB_BASE="$2"
            shift 2
            ;;
        --labels)
            GITHUB_LABELS="$2"
            shift 2
            ;;
        --query)
            GITHUB_QUERY="$2"
            shift 2
            ;;
        --artifacts)
            ARTIFACTS_DIR="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            EXECUTE=false
            shift
            ;;
        --execute)
            EXECUTE=true
            DRY_RUN=false
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Validate inputs
if [ "$FROM_GITHUB" = true ]; then
    if [ -z "$GITHUB_OWNER" ] || [ -z "$GITHUB_REPO" ]; then
        print_error "When using --from-github, both --owner and --repo-name are required"
        exit 1
    fi
    if [ -n "$PLAN_FILE" ]; then
        print_warning "Both --from-github and --plan specified. Using GitHub discovery."
        PLAN_FILE=""
    fi
elif [ -z "$PLAN_FILE" ]; then
    print_error "Either --plan or --from-github must be specified"
    exit 1
fi

# Validate repository directory
if [ ! -d "$REPO_DIR" ]; then
    print_error "Repository directory not found: $REPO_DIR"
    exit 1
fi

# Ask Git to identify the worktree rather than assuming .git is a directory.
# Requiring the discovered top-level to equal the explicit --repo path keeps
# discovery bounded: a non-repository directory nested inside a checkout is
# not silently treated as the checkout itself.
REQUESTED_REPO_ROOT=$(cd "$REPO_DIR" && pwd -P)
if ! DISCOVERED_REPO_ROOT=$(git -C "$REPO_DIR" rev-parse --show-toplevel 2>/dev/null); then
    print_error "Not a git repository: $REPO_DIR"
    exit 1
fi

cd "$REQUESTED_REPO_ROOT"

if ! DISCOVERED_REPO_ROOT=$(cd "$DISCOVERED_REPO_ROOT" 2>/dev/null && pwd -P) || \
   [ "$DISCOVERED_REPO_ROOT" != "$REQUESTED_REPO_ROOT" ]; then
    print_error "Not a git repository: $REPO_DIR"
    exit 1
fi

# Set default artifacts directory if not specified
if [ -z "$ARTIFACTS_DIR" ]; then
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    ARTIFACTS_DIR="./artifacts/dogfood-${TIMESTAMP}"
fi

# Create artifacts directory
mkdir -p "$ARTIFACTS_DIR"

# A report is success evidence for exactly one completed invocation. Invalidate
# any report left by a previous run before the first fallible workflow step so
# a failed rerun cannot appear successful merely because it reused a directory.
REPORT_FILE="$ARTIFACTS_DIR/dogfood-report.md"
rm -f -- "$REPORT_FILE"

# Check for lex-pr CLI
if ! command -v lex-pr &> /dev/null; then
    # Try using npm run cli as fallback
    if [ -f "package.json" ] && grep -q '"cli"' package.json; then
        LEX_PR_CMD=(npm run cli --)
        print_info "Using npm run cli for lex-pr commands"
    else
        print_error "lex-pr command not found and no npm cli script available"
        print_info "Please install lexrunner or run from the repository root"
        exit 1
    fi
else
    LEX_PR_CMD=(lex-pr)
fi

# Print configuration
print_header "DOGFOOD MERGE-WEAVE WORKFLOW"

print_step "📋 Configuration:"
echo "  Repository:     $REPO_DIR"
if [ "$FROM_GITHUB" = true ]; then
    echo "  Plan Source:    GitHub Discovery"
    echo "  GitHub Owner:   $GITHUB_OWNER"
    echo "  GitHub Repo:    $GITHUB_REPO"
    [ -n "$GITHUB_BASE" ] && echo "  Base Branch:    $GITHUB_BASE"
    [ -n "$GITHUB_LABELS" ] && echo "  Labels Filter:  $GITHUB_LABELS"
    [ -n "$GITHUB_QUERY" ] && echo "  Custom Query:   $GITHUB_QUERY"
else
    echo "  Plan Source:    File"
    echo "  Plan File:      $PLAN_FILE"
fi
echo "  Artifacts Dir:  $ARTIFACTS_DIR"
echo "  Mode:           $([ "$EXECUTE" = true ] && echo "EXECUTE" || echo "DRY-RUN")"

# Step 1: Generate or validate plan
print_section "Step 1: Plan Generation"

if [ "$FROM_GITHUB" = true ]; then
    print_step "🔍 Discovering PRs from GitHub..."

    PLAN_FILE="$ARTIFACTS_DIR/plan.json"
    PLAN_ARGS=(
        weave plan
        --from-github
        "--owner=$GITHUB_OWNER"
        "--repo=$GITHUB_REPO"
        "--repo-root=$REQUESTED_REPO_ROOT"
    )
    [ -n "$GITHUB_BASE" ] && PLAN_ARGS+=("--target=$GITHUB_BASE")
    [ -n "$GITHUB_QUERY" ] && PLAN_ARGS+=("--query=$GITHUB_QUERY")
    if [ -n "$GITHUB_LABELS" ]; then
        IFS=',' read -r -a LABEL_VALUES <<< "$GITHUB_LABELS"
        PLAN_ARGS+=(--labels)
        for LABEL_VALUE in "${LABEL_VALUES[@]}"; do
            # Trim surrounding whitespace without evaluating the value.
            LABEL_VALUE="${LABEL_VALUE#"${LABEL_VALUE%%[![:space:]]*}"}"
            LABEL_VALUE="${LABEL_VALUE%"${LABEL_VALUE##*[![:space:]]}"}"
            if [ -z "$LABEL_VALUE" ] || [[ "$LABEL_VALUE" == -* ]]; then
                print_error "Invalid label in --labels: labels must be non-empty and must not begin with '-'"
                exit 1
            fi
            PLAN_ARGS+=("$LABEL_VALUE")
        done
    fi
    PLAN_ARGS+=("--output=$PLAN_FILE")

    if [ "$VERBOSE" = true ]; then
        "${LEX_PR_CMD[@]}" "${PLAN_ARGS[@]}"
    else
        "${LEX_PR_CMD[@]}" "${PLAN_ARGS[@]}" 2>&1 | tail -10
    fi

    if [ ! -f "$PLAN_FILE" ]; then
        print_error "Failed to generate plan from GitHub"
        exit 1
    fi

    print_success "Plan generated: $PLAN_FILE"
else
    if [ ! -f "$PLAN_FILE" ]; then
        print_error "Plan file not found: $PLAN_FILE"
        exit 1
    fi
fi

# Both supplied and discovered plans cross the same fail-closed validation
# boundary before gates, dependency analysis, or merge preview/execution.
print_step "📄 Validating plan file..."
if "${LEX_PR_CMD[@]}" schema validate "$PLAN_FILE" > /dev/null 2>&1; then
    print_success "Plan file validated: $PLAN_FILE"
else
    PLAN_VALIDATION_EXIT_CODE=$?
    print_error "Plan file validation failed (exit code: $PLAN_VALIDATION_EXIT_CODE): $PLAN_FILE"
    print_info "Supply a current schema-valid plan.json; legacy plan formats are not executable."
    exit "$PLAN_VALIDATION_EXIT_CODE"
fi

# Bind report evidence to the validated Plan rather than guessing the branch
# selected by GitHub discovery. Node is already a runtime prerequisite for the
# lexrunner CLI, and JSON parsing here avoids shell/grep ambiguity.
if ! TARGET_BRANCH=$(node -e '
const fs = require("node:fs");
const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof plan.target !== "string" || plan.target.length === 0) process.exit(1);
process.stdout.write(plan.target);
' "$PLAN_FILE"); then
    print_error "Validated plan does not expose a reportable target branch: $PLAN_FILE"
    exit 1
fi

# Show plan summary
print_step "📊 Plan Summary:"
if command -v jq &> /dev/null; then
    ITEM_COUNT=$(jq -r '.items | length' "$PLAN_FILE" 2>/dev/null || echo "unknown")

    echo "  Items:          $ITEM_COUNT"
else
    print_warning "jq not found, skipping detailed plan summary"
    head -20 "$PLAN_FILE"
fi
echo "  Target Branch:  $TARGET_BRANCH"
echo "  Integration:    auto-generated"

# Step 2: Run gates (if available)
print_section "Step 2: Gate Validation"

print_step "🧪 Running local gates..."

# In DRY-RUN mode, avoid executing repo-specific gates.
# This keeps the script safe, fast, and deterministic for previews/tests.
if [ "$DRY_RUN" = true ]; then
    print_info "DRY-RUN: Skipping local gate execution"
else

# Check if npm scripts exist
if [ -f "package.json" ]; then
    if grep -q '"lint"' package.json; then
        echo ""
        echo "Running lint gate..."
        if [ "$VERBOSE" = true ]; then
            npm run lint
        else
            npm run lint 2>&1 | tail -10
        fi
        print_success "Lint gate passed"
    fi

    if grep -q '"typecheck"' package.json; then
        echo ""
        echo "Running typecheck gate..."
        if [ "$VERBOSE" = true ]; then
            npm run typecheck
        else
            npm run typecheck 2>&1 | tail -10
        fi
        print_success "Typecheck gate passed"
    fi

    if grep -q '"test"' package.json && [ "$EXECUTE" = true ]; then
        echo ""
        echo "Running test gate..."
        if [ "$VERBOSE" = true ]; then
            npm test
        else
            npm test 2>&1 | tail -15
        fi
        print_success "Test gate passed"
    fi
else
    print_warning "No package.json found, skipping npm-based gates"
fi

fi

print_section "Step 3: Merge Analysis"

print_step "📊 Analyzing merge order and dependencies..."

MERGE_ORDER_FILE="$ARTIFACTS_DIR/merge-order.json"
if "${LEX_PR_CMD[@]}" merge-order "$PLAN_FILE" --json > "$MERGE_ORDER_FILE" 2>&1; then
    print_success "Merge order and dependencies validated"
else
    MERGE_ORDER_EXIT_CODE=$?
    print_error "Merge order analysis failed (exit code: $MERGE_ORDER_EXIT_CODE)"
    if [ -s "$MERGE_ORDER_FILE" ]; then
        echo ""
        echo "Details:"
        cat "$MERGE_ORDER_FILE"
    fi
    exit "$MERGE_ORDER_EXIT_CODE"
fi

if [ -f "$MERGE_ORDER_FILE" ] && [ "$VERBOSE" = true ]; then
    echo ""
    echo "Merge order:"
    cat "$MERGE_ORDER_FILE"
fi

# Step 4: Execute merge
print_section "Step 4: Merge Execution"

if [ "$EXECUTE" = true ]; then
    print_step "🚀 Executing merge pyramid..."

    MERGE_OPTS=(--plan "$PLAN_FILE" --execute)

    MERGE_RESULTS_FILE="$ARTIFACTS_DIR/merge-results.json"

    if [ "$VERBOSE" = true ]; then
        if "${LEX_PR_CMD[@]}" merge "${MERGE_OPTS[@]}" --json | tee "$MERGE_RESULTS_FILE"; then
            MERGE_EXIT_CODE=0
        else
            MERGE_EXIT_CODE=$?
        fi
    else
        if "${LEX_PR_CMD[@]}" merge "${MERGE_OPTS[@]}" --json > "$MERGE_RESULTS_FILE" 2>&1; then
            MERGE_EXIT_CODE=0
        else
            MERGE_EXIT_CODE=$?
        fi
    fi

    if [ $MERGE_EXIT_CODE -eq 0 ]; then
        print_success "Merge pyramid execution completed successfully"

        # Show summary
        if command -v jq &> /dev/null && [ -f "$MERGE_RESULTS_FILE" ]; then
            echo ""
            echo "Summary:"
            jq -r '.result // .summary // empty' "$MERGE_RESULTS_FILE" 2>/dev/null || echo "  (See $MERGE_RESULTS_FILE for details)"
        fi
    else
        print_error "Merge pyramid execution failed (exit code: $MERGE_EXIT_CODE)"
        [ -f "$MERGE_RESULTS_FILE" ] && echo "" && echo "Details:" && cat "$MERGE_RESULTS_FILE"
        exit $MERGE_EXIT_CODE
    fi
else
    print_step "🔍 Dry-run: Previewing merge operations..."

    MERGE_OPTS=(--plan "$PLAN_FILE" --dry-run)

    DRY_RUN_FILE="$ARTIFACTS_DIR/dry-run.json"

    if [ "$VERBOSE" = true ]; then
        if "${LEX_PR_CMD[@]}" merge "${MERGE_OPTS[@]}" --json | tee "$DRY_RUN_FILE"; then
            DRY_RUN_EXIT_CODE=0
        else
            DRY_RUN_EXIT_CODE=$?
        fi
    else
        if "${LEX_PR_CMD[@]}" merge "${MERGE_OPTS[@]}" --json > "$DRY_RUN_FILE" 2>&1; then
            DRY_RUN_EXIT_CODE=0
        else
            DRY_RUN_EXIT_CODE=$?
        fi
    fi

    if [ "$DRY_RUN_EXIT_CODE" -ne 0 ]; then
        print_error "Dry-run merge preview failed (exit code: $DRY_RUN_EXIT_CODE)"
        if [ -s "$DRY_RUN_FILE" ]; then
            echo ""
            echo "Details:"
            cat "$DRY_RUN_FILE"
        fi
        exit "$DRY_RUN_EXIT_CODE"
    fi

    # A zero exit status is authoritative. Retain a visible warning when the
    # successful JSON payload itself contains an error marker.
    if [ -f "$DRY_RUN_FILE" ] && grep -qi "error" "$DRY_RUN_FILE" 2>/dev/null; then
        print_warning "Dry-run output contains an error marker; review the preview artifact"
    else
        print_success "Dry-run completed"
    fi

    if command -v jq &> /dev/null && [ -f "$DRY_RUN_FILE" ]; then
        echo ""
        echo "Preview:"
        jq '.' "$DRY_RUN_FILE" 2>/dev/null || cat "$DRY_RUN_FILE"
    fi

    echo ""
    print_info "This was a dry-run. Use --execute to perform actual merge operations."
fi

# Step 5: Generate report
print_section "Step 5: Report Generation"

print_step "📝 Generating final report..."

cat > "$REPORT_FILE" << EOF
# Dogfood Merge-Weave Report

**Generated:** $(date)

## Configuration

- **Repository:** $REPO_DIR
- **Plan Source:** $([ "$FROM_GITHUB" = true ] && echo "GitHub Discovery" || echo "File: $PLAN_FILE")
- **Mode:** $([ "$EXECUTE" = true ] && echo "EXECUTE" || echo "DRY-RUN")
- **Artifacts:** $ARTIFACTS_DIR

$([ "$FROM_GITHUB" = true ] && cat << GITHUB_SECTION

### GitHub Discovery Settings

- Owner: $GITHUB_OWNER
- Repository: $GITHUB_REPO
- Base Branch: $TARGET_BRANCH
- Labels Filter: ${GITHUB_LABELS:-none}
- Custom Query: ${GITHUB_QUERY:-none}

GITHUB_SECTION
)

## Execution Summary

EOF

if [ "$EXECUTE" = true ] && [ -f "$MERGE_RESULTS_FILE" ]; then
    echo "### Merge Results" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    echo '```json' >> "$REPORT_FILE"
    cat "$MERGE_RESULTS_FILE" >> "$REPORT_FILE"
    echo '```' >> "$REPORT_FILE"
elif [ -f "$DRY_RUN_FILE" ]; then
    echo "### Dry-Run Preview" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    echo '```json' >> "$REPORT_FILE"
    cat "$DRY_RUN_FILE" >> "$REPORT_FILE"
    echo '```' >> "$REPORT_FILE"
fi

echo "" >> "$REPORT_FILE"
echo "## Artifacts" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
echo "All artifacts saved to: \`$ARTIFACTS_DIR\`" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
ls -lh "$ARTIFACTS_DIR" >> "$REPORT_FILE"

print_success "Report generated: $REPORT_FILE"

# Final summary
print_header "✨ WORKFLOW COMPLETE"

echo "Artifacts saved to: $ARTIFACTS_DIR"
echo ""
echo "Files:"
ls -1 "$ARTIFACTS_DIR"
echo ""

if [ "$EXECUTE" = true ]; then
    print_success "Merge-weave execution completed successfully!"
else
    print_info "Dry-run completed. Review the artifacts and use --execute to perform actual merges."
fi

echo ""
