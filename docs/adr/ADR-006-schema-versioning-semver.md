# ADR-006: Schema Versioning with SemVer

**Status:** Accepted
**Date:** 2025-11-25
**Authors:** lexrunner team

---

## Context

`plan.json` is a versioned schema. As the runner evolves, the schema will change. The question: how do we version schemas to maintain compatibility?

---

## Decision

We adopt **SemVer** for schema versioning.

### Version Field

Plans must include a schema version:

The following is a minimal structural fragment, not an executable Plan; target and policy details,
plus complete item definitions, are intentionally omitted.

<!-- lexrunner-non-executable-plan:adr-schema-version-fragment -->

```json
{
  "schemaVersion": "1.0.0",
  "items": [...]
}
```

### Versioning Rules

| Change Type | Version Bump  | Example                                     |
| ----------- | ------------- | ------------------------------------------- |
| **Patch**   | 1.0.0 → 1.0.1 | Additive, optional fields or docs only      |
| **Minor**   | 1.0.0 → 1.1.0 | Additive required fields with safe defaults |
| **Major**   | 1.x.y → 2.0.0 | Breaking changes to structure or semantics  |

### Runner Behavior

- **Patch differences** — Accept silently
- **Minor differences** — Accept with defaults
- **Major differences** — **Refuse** plans with unknown major versions

```typescript
function validateSchema(plan: Plan): void {
  const [major] = plan.schemaVersion.split(".").map(Number);
  if (major > SUPPORTED_MAJOR) {
    throw new Error(`Unsupported schema version: ${plan.schemaVersion}`);
  }
}
```

### Migration Path

When a major version changes:

1. Document migration steps
2. Provide upgrade tooling if feasible
3. Support previous major for deprecation period

---

## Consequences

### Positive

- **Compatibility guarantees** — Minor/patch changes are safe
- **Clear upgrade path** — Major changes are explicit
- **Tooling support** — Standard SemVer tooling applies

### Negative

- **Discipline required** — Must correctly classify changes
- **Major version friction** — Breaking changes require coordination

---

## References

- `/AGENTS.md` — Appendix A: Schema Versioning
- `/schemas/plan.schema.json` — Schema definition
