# CI Version Validation

This document explains how LexRunner validates Lex version compatibility in CI.

## Version Pinning Strategy

LexRunner uses **strict version pinning** via `package-lock.json` to ensure Lex compatibility:

```json
{
  "dependencies": {
    "@smartergpt/lex": "4.4.4"
  }
}
```

### Why Pinned?

- **Frame schema v2 compatibility**: Ensures runId, planHash, and spend fields are available
- **Type safety**: TypeScript compilation validates against exact Lex types
- **Reproducible builds**: Same Lex version = same behavior across environments

## CI Validation Gates

The lint lane runs `npm run check:lex-compatibility` before TypeScript. This
offline guard compares the exact reviewed Lex/SQLite support claim with the
manifest, lockfile, installed package identities, resolved native dependency and
install-script decisions. It rejects a second locked Lex or SQLite installation;
it does not query or automatically adopt the registry's moving `latest` tag.

### 1. Dependency Installation (`npm ci`)

**Location**: `.github/workflows/ci.yml` (setup job)

```yaml
- name: Install dependencies
  run: npm ci
```

**What it validates**:

- Exact package versions from `package-lock.json`
- Lex version matches the exact `4.4.4` manifest constraint and lock identity
- All peer dependencies satisfied

**Failure modes**:

- Lock file out of sync with package.json → fails
- Incompatible Lex version → fails

### 2. TypeScript Compilation (`typecheck`)

**Location**: `.github/workflows/ci.yml` (typecheck job)

```yaml
- run: npm run typecheck
```

**What it validates**:

- LexRunner types compatible with Lex types
- Frame schema v2 fields (runId, planHash, spend) exist in Lex
- No breaking type changes in Lex

**Failure modes**:

- Lex removes v2 fields → type error
- Lex changes field types → type error

### 3. Integration Tests

**Location**: `.github/workflows/ci.yml` (test job)

```yaml
- run: npm test
```

**What it validates**:

- Frame emission with v2 fields works
- Lex schemas (e.g., `ExecutionFrameSchema`) parse correctly
- Cross-package integration (LexRunner → Lex)

**Failure modes**:

- Runtime schema validation fails
- v2 field validation fails (see `tests/frames/v2-schema-integration.spec.ts`)

## Version Update Process

### Updating Lex Dependency

```bash
# 1. Check current version
npm list @smartergpt/lex

# 2. Update to an explicitly selected published version
npm install --save-exact @smartergpt/lex@4.4.4

# 3. Verify compatibility
npm run typecheck
npm test

# 4. Commit lock file changes
git add package.json package-lock.json
git commit -m "Pin Lex to exact 4.4.4"
```

### Breaking Change Detection

If Lex introduces breaking changes:

1. **TypeScript compilation fails** → Field/type removed or changed
2. **Integration tests fail** → Runtime schema validation breaks
3. **Unit tests fail** → Function signatures changed

**Resolution**:

- Update LexRunner code to match new Lex API
- Update tests to reflect new behavior
- Document breaking change in CHANGELOG

## Manual Version Verification

### Check Installed Version

```bash
npm list @smartergpt/lex
```

**Expected output**:

```
@smartergpt/lexrunner@2.0.0 /path/to/lexrunner
└── @smartergpt/lex@4.4.4
```

### Verify Frame Schema v2 Support

```bash
# Run v2 schema integration test
npm test -- tests/frames/v2-schema-integration.spec.ts
```

**Expected**: All tests pass (9 tests)

### Verify Lock File Integrity

```bash
# Ensure lock file matches package.json
npm ci --dry-run
```

**Expected**: No warnings about mismatched versions

## Continuous Integration Matrix

| Gate           | Validates                    | Failure Impact         |
| -------------- | ---------------------------- | ---------------------- |
| `npm ci`       | Exact Lex version            | ❌ Cannot install deps |
| `typecheck`    | Type compatibility           | ❌ Build fails         |
| `npm test`     | Runtime schema compatibility | ❌ Tests fail          |
| `npm run lint` | Code quality (indirect)      | ❌ PR blocked          |

## Related Documentation

- [EVENT_SCHEMA.md](./EVENT_SCHEMA.md) - Frame schema v2 specification
- [MIGRATION_v0.1.md](./MIGRATION_v0.1.md) - Frame schema version expectations
- [package.json](../package.json) - Lex version pinning
- [LexRunner#344](https://github.com/Guffawaffle/lexrunner/issues/344) - This validation initiative

## Troubleshooting

### Error: "Cannot find module '@smartergpt/lex'"

**Cause**: Lock file out of sync or dependencies not installed

**Fix**:

```bash
rm -rf node_modules package-lock.json
npm install
```

### Error: "Property 'runId' does not exist on type..."

**Cause**: The installed Lex identity does not match the exact release validated by LexRunner.

**Fix**:

```bash
npm install --save-exact @smartergpt/lex@4.4.4
```

### Error: "Frame validation failed: missing required field 'runId'"

**Cause**: Runtime schema mismatch (the exact validated Lex release is not installed).

**Fix**: Same as above - install exact Lex 4.4.4.

---

**Last Updated**: 2026-08-27
**Maintainer**: LexRunner Team
