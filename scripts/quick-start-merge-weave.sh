#!/usr/bin/env bash

# Quick Start Script for Merge-Weave Setup
# This script helps you set up merge-weave in your Lex ecosystem repository
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Guffawaffle/LexRunner/main/scripts/quick-start-merge-weave.sh | bash
#   OR
#   ./scripts/quick-start-merge-weave.sh

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${BOLD}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  Merge-Weave Quick Start for Lex Ecosystem Repositories  ║${NC}"
echo -e "${BOLD}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Not in a git repository. Please run this from your repo root.${NC}"
    exit 1
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

echo -e "${BLUE}📍 Repository: $REPO_ROOT${NC}"
echo ""

# Step 1: Check for package.json
echo -e "${BOLD}Step 1: Checking project type...${NC}"
if [ -f "package.json" ]; then
    echo -e "${GREEN}✓${NC} Found package.json (Node.js project)"
    HAS_PACKAGE_JSON=true
else
    echo -e "${YELLOW}⚠️  No package.json found${NC}"
    echo "   This script is optimized for Node.js projects."
    echo "   You can still use merge-weave, but gate definitions may need adjustment."
    HAS_PACKAGE_JSON=false
fi
echo ""

# Step 2: Install LexRunner
echo -e "${BOLD}Step 2: Installing LexRunner...${NC}"
if command -v lex-pr &> /dev/null; then
    echo -e "${GREEN}✓${NC} lex-pr already installed"
    lex-pr --version | head -1
else
    if [ "$HAS_PACKAGE_JSON" = true ]; then
        echo "   Installing as dev dependency..."
        npm install --save-dev github:Guffawaffle/LexRunner
        echo -e "${GREEN}✓${NC} LexRunner installed"
    else
        echo -e "${YELLOW}⚠️  Please install LexRunner manually:${NC}"
        echo "   npm install --save-dev github:Guffawaffle/LexRunner"
        echo "   OR"
        echo "   npm link lexrunner (if you have it cloned locally)"
    fi
fi
echo ""

# Step 3: Create .smartergpt directory
echo -e "${BOLD}Step 3: Setting up workspace profile...${NC}"
if [ ! -d ".smartergpt" ]; then
    mkdir -p .smartergpt
    echo -e "${GREEN}✓${NC} Created .smartergpt/ directory"
else
    echo -e "${GREEN}✓${NC} .smartergpt/ directory already exists"
fi
echo ""

# Step 4: Create gates.yml
echo -e "${BOLD}Step 4: Configuring quality gates...${NC}"
if [ ! -f ".smartergpt/gates.yml" ]; then
    if [ "$HAS_PACKAGE_JSON" = true ]; then
        # lexrunner-non-executable-plan:quick-start-gates-config
        cat > .smartergpt/gates.yml << 'EOF'
# Quality gates for merge-weave
schemaVersion: "1.0.0"

gates:
  - name: lint
    description: "Run code linting"
    run: npm run lint
    required: true
    timeout: 60000

  - name: typecheck
    description: "Verify type safety (if applicable)"
    run: npm run typecheck || echo "No typecheck script"
    required: false
    timeout: 120000

  - name: test
    description: "Run test suite"
    run: npm test
    required: false
    timeout: 300000

policy:
  parallel: true
  maxWorkers: 2
  failFast: true
EOF
        echo -e "${GREEN}✓${NC} Created .smartergpt/gates.yml"
    else
        echo -e "${YELLOW}⚠️  Skipped gates.yml (no package.json)${NC}"
        echo "   Create .smartergpt/gates.yml manually based on your build system"
    fi
else
    echo -e "${GREEN}✓${NC} .smartergpt/gates.yml already exists"
fi
echo ""

# Step 5: Update .gitignore
echo -e "${BOLD}Step 5: Updating .gitignore...${NC}"
if [ -f ".gitignore" ]; then
    if ! grep -q ".smartergpt.local" .gitignore; then
        cat >> .gitignore << 'EOF'

# LexRunner artifacts
.smartergpt.local/
.smartergpt/runner/
weave-lock.json
artifacts/
audit/
plan.json
EOF
        echo -e "${GREEN}✓${NC} Updated .gitignore"
    else
        echo -e "${GREEN}✓${NC} .gitignore already configured"
    fi
else
    echo -e "${YELLOW}⚠️  No .gitignore found - create one manually${NC}"
fi
echo ""

# Step 6: Copy convenience script
echo -e "${BOLD}Step 6: Installing convenience script...${NC}"
if [ ! -d "scripts" ]; then
    mkdir -p scripts
fi

if [ ! -f "scripts/merge-weave.sh" ]; then
    # Try to find the wrapper script
    WRAPPER_SOURCE=""
    
    # Check if we're in LexRunner repo
    if [ -f "scripts/merge-weave-wrapper.sh" ]; then
        WRAPPER_SOURCE="scripts/merge-weave-wrapper.sh"
    # Check if LexRunner is installed in node_modules
    elif [ -f "node_modules/lexrunner/scripts/merge-weave-wrapper.sh" ]; then
        WRAPPER_SOURCE="node_modules/lexrunner/scripts/merge-weave-wrapper.sh"
    fi
    
    if [ -n "$WRAPPER_SOURCE" ]; then
        cp "$WRAPPER_SOURCE" scripts/merge-weave.sh
        chmod +x scripts/merge-weave.sh
        echo -e "${GREEN}✓${NC} Installed scripts/merge-weave.sh"
    else
        echo -e "${YELLOW}⚠️  Could not find wrapper script${NC}"
        echo "   Download manually from:"
        echo "   https://github.com/Guffawaffle/LexRunner/blob/main/scripts/merge-weave-wrapper.sh"
    fi
else
    echo -e "${GREEN}✓${NC} scripts/merge-weave.sh already exists"
fi
echo ""

# Step 7: Add npm scripts
echo -e "${BOLD}Step 7: Suggested npm scripts...${NC}"
if [ "$HAS_PACKAGE_JSON" = true ]; then
    echo "   Add these to your package.json scripts section:"
    echo ""
    echo '   "merge-weave": "lex-pr merge",'
    echo '   "merge-weave:discover": "lex-pr discover --owner ORG --repo REPO --labels ready-to-merge",'
    echo '   "merge-weave:preview": "lex-pr merge --dry-run",'
    echo '   "merge-weave:execute": "lex-pr merge --execute --cleanup"'
    echo ""
else
    echo -e "${YELLOW}⚠️  Skipped (no package.json)${NC}"
fi
echo ""

# Final summary
echo -e "${BOLD}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║                    Setup Complete! 🎉                     ║${NC}"
echo -e "${BOLD}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}Next steps:${NC}"
echo ""
echo "1. Review and customize .smartergpt/gates.yml"
echo ""
echo "2. Try discovering PRs:"
echo "   ${BLUE}npx lex-pr discover --owner YOUR_ORG --repo YOUR_REPO --labels ready-to-merge${NC}"
echo ""
echo "3. Preview a merge:"
echo "   ${BLUE}npx lex-pr merge --plan plan.json --dry-run${NC}"
echo ""
echo "4. Execute when ready:"
echo "   ${BLUE}npx lex-pr merge --plan plan.json --execute --cleanup${NC}"
echo ""
echo "5. Or use the convenience script:"
echo "   ${BLUE}./scripts/merge-weave.sh discover --labels ready-to-merge${NC}"
echo "   ${BLUE}./scripts/merge-weave.sh preview${NC}"
echo "   ${BLUE}./scripts/merge-weave.sh execute --cleanup${NC}"
echo ""
echo -e "${BOLD}Documentation:${NC}"
echo "• Full setup guide: https://github.com/Guffawaffle/LexRunner/blob/main/docs/MERGE_WEAVE_SETUP.md"
echo "• CLI reference: https://github.com/Guffawaffle/LexRunner/blob/main/docs/cli.md"
echo "• Quickstart: https://github.com/Guffawaffle/LexRunner/blob/main/docs/merge-weave-quickstart.md"
echo ""
