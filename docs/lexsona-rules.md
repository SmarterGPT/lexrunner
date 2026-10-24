# LexSona Behavioral Rules

**Status:** ✅ v0.5.0 Ready

## Overview

LexSona is a behavioral rule system that provides AI agents with architectural guidance, policy enforcement, and best practices. This module provides infrastructure for integrating LexSona rules from the `@smartergpt/lex` package.

## Current Status

- ✅ Infrastructure implemented and tested
- ✅ Package integration ready
- ✅ **Feature enabled by default** (v0.5.0)

## Architecture

### Rule Structure

```typescript
interface BehavioralRule {
  id: string; // Unique identifier
  title: string; // Human-readable name
  description: string; // Rule description
  content: string; // Rule content/guidance
  scope?: {
    // Optional scope filtering
    environment?: string; // e.g., "development", "production"
    project?: string; // Project identifier
    agentFamily?: string; // e.g., "copilot", "claude"
  };
  priority?: number; // Higher = more important
}
```

### Rule Injection Configuration

```typescript
interface RuleInjectionConfig {
  enabled: boolean; // Whether injection is enabled
  source: "package" | "local"; // Rule source
  localRulesPath?: string; // Optional path to local rules
}
```

### Precedence Chain

1. **`LEX_RULES_ENABLED`** - Enable/disable rules (default: "true")
2. **`LEX_RULES_SOURCE`** - "package" or "local" (default: "package")
3. **`LEX_RULES_PATH`** - Custom local rules path (optional)

## Usage

### Loading Rules

```typescript
import { loadLexSonaRules, formatRulesForPrompt } from "./config/rulesResolver.js";

// Load rules with scope filtering
const rules = await loadLexSonaRules({
  environment: "development",
  project: "lexrunner",
  agentFamily: "copilot",
});

// Format for system prompt injection
const promptSection = formatRulesForPrompt(rules);
```

### Disabling Rules

```typescript
// Via configuration object
const rules = await loadLexSonaRules(scope, { enabled: false });

// Via environment variable
// LEX_RULES_ENABLED=false
```

### Injecting Rules into Prompts

```typescript
import { injectRulesIntoPrompt } from "./config/rulesResolver.js";

const basePrompt = "You are a helpful assistant.";
const promptWithRules = await injectRulesIntoPrompt(basePrompt, {
  project: "lexrunner",
  agentFamily: "copilot",
});
```

### Getting Configuration from Environment

```typescript
import { getRuleInjectionConfig } from "./config/rulesResolver.js";

const config = getRuleInjectionConfig();
// Returns { enabled: true, source: "package" } by default
```

## Available Rules (Package)

The `@smartergpt/lex` package includes canonical rules:

- **escalation-response.json** - Guidance on escalating to human operators
- **operator-role-primacy.json** - Human operator authority and override protocols
- **plan-execute-transition.json** - Planning vs. execution phase transitions
- **tool-fallback-protocol.json** - Tool failure handling and fallback strategies

## Scope Metadata

Rules support scope filtering to provide context-appropriate guidance:

- **environment**: Target deployment environment
- **project**: Specific project or repository
- **agentFamily**: AI agent type (for agent-specific customization)

## Environment Variables

| Variable            | Description                       | Default   |
| ------------------- | --------------------------------- | --------- |
| `LEX_RULES_ENABLED` | Enable/disable rule injection     | `true`    |
| `LEX_RULES_SOURCE`  | Rule source: "package" or "local" | `package` |
| `LEX_RULES_PATH`    | Path to local rules directory     | (none)    |

## Testing

```bash
npm test -- tests/rulesResolver.spec.ts
```

Test coverage:

- ✅ Package availability detection
- ✅ Rule loading (enabled/disabled states)
- ✅ Scope filtering support
- ✅ Prompt formatting
- ✅ Priority-based sorting
- ✅ Configuration from environment
- ✅ Prompt injection

## Remaining Compatibility Shims

The following compatibility shims are documented for removal in v3.0.0:

| Shim                                 | Location                     | Removal Timeline |
| ------------------------------------ | ---------------------------- | ---------------- |
| `LEXRUNNER_*` env var aliases        | `src/util/envUtils.ts`       | v3.0.0           |
| Compatibility `runner/` config reads | `src/config/pathResolver.ts` | v3.0.0           |

## See Also

- [Prompts Configuration](./prompts.md) - Prompts precedence chain
- [Lex Package Integration](./schemas.md) - Schema alignment
- [Migration Guide](./migration-guide.md) - Upgrading from previous versions
