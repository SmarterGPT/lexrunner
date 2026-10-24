#!/bin/bash
# Example: Cluster Gate Execution with Rollback Demo
# This demonstrates the gates & rollback feature

set -e

echo "🚀 Cluster Gate Execution & Rollback Demo"
echo "=========================================="
echo ""

# Setup
DEMO_DIR="/tmp/lexrunner-cluster-demo"
rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR"
cd "$DEMO_DIR"

echo "📦 Setting up demo repository..."
git init
git config user.name "Demo User"
git config user.email "demo@example.com"
git config commit.gpgsign false

# Create initial commit
echo "# Demo Repo" > README.md
git add README.md
git commit -m "Initial commit"

# Create base branch
git branch -M main

echo ""
echo "✅ Demo repository created"
echo ""

# Create a sample plan.json with gates
# lexrunner-plan-example:cluster-gates-demo
cat > plan.json << 'EOF'
{
  "schemaVersion": "1.0.0",
  "target": "main",
  "items": [
    {
      "name": "feature-1",
      "deps": [],
      "gates": [
        {
          "name": "lint",
          "run": "echo 'Running lint...' && exit 0",
          "runtime": "local"
        },
        {
          "name": "test",
          "run": "echo 'Running tests...' && exit 1",
          "runtime": "local"
        }
      ]
    }
  ],
  "policy": {
    "requiredGates": ["lint", "test"],
    "optionalGates": [],
    "maxWorkers": 1,
    "retries": {},
    "overrides": {},
    "blockOn": [],
    "mergeRule": { "type": "strict-required" }
  }
}
EOF

echo "📋 Plan created with failing test gate"
echo ""

# Simulate what would happen (without actually running the tool)
cat << 'EXAMPLE'
🎯 Expected Behavior:
---------------------

1. Cluster 0 starts merging:
   - Item: feature-1
   - Target: main

2. Gates execute:
   ✅ lint: PASS (exit 0)
   ❌ test: FAIL (exit 1)

3. Automatic Rollback:
   - Capture merge-patch.diff
   - git reset --hard <pre-cluster-sha>
   - Store artifacts in .weave/

4. Artifacts Created:
   .weave/
   ├── cluster-0-merge-patch.diff
   ├── cluster-0-failure-bundle.json
   └── cluster-0/
       └── gates/
           └── feature-1/
               ├── lint/
               └── test/

5. Failure Bundle Contents:
   {
     "clusterIndex": 0,
     "timestamp": "2024-12-17T...",
     "baseBranch": "main",
     "integrationBranch": "weave/integration-...",
     "items": ["feature-1"],
     "failedGates": [
       {
         "item": "feature-1",
         "gate": "test",
         "status": "fail",
         "exitCode": 1,
         "stderr": "..."
       }
     ],
     "mergePatchDiff": "diff --git ...",
     "rollbackSha": "abc123...",
     "artifactPaths": [...]
   }

6. Draft PR Created (optional):
   - Title: [DRAFT] Cluster 0 gate failures - feature-1
   - Body: Includes failure summary, artifacts, next steps
   - State: Draft (not ready for merge)

7. Next Steps:
   - Review failure bundle in .weave/
   - Fix failing tests
   - Re-run merge-weave workflow
   - Close draft PR when resolved

EXAMPLE

echo ""
echo "📖 To use in actual code:"
cat << 'CODE'

import { executeClusterWithGates, ClusterContext } from "./weave/clusterGates.js";
import { ExecutionState } from "./executionState.js";
import { GitOperations } from "./git/operations.js";
import { loadPlan } from "./schema.js";

const plan = loadPlan("plan.json");
const executionState = new ExecutionState(plan);
const gitOps = new GitOperations();

const cluster: ClusterContext = {
  clusterIndex: 0,
  items: plan.items,
  baseBranch: "main",
  integrationBranch: "weave/integration-2024",
  weaveDir: ".weave",
};

const result = await executeClusterWithGates(
  cluster,
  plan,
  executionState,
  gitOps,
  { skipGates: false, timeoutMs: 30000 }
);

if (!result.success) {
  console.error("Cluster failed!");
  console.log("Rollback SHA:", result.rollbackSha);
  console.log("Artifacts:", result.artifactPaths);
}

CODE

echo ""
echo "✨ Demo complete!"
echo ""
echo "For more information, see:"
echo "  - docs/cluster-gates-rollback.md"
echo "  - tests/cluster-gates-rollback.spec.ts"
echo ""
