# ADR-000: Product Naming and Branding (LexRunner + Lex)

> Release-tag amendment, 2026-09-15 (accepted by Guff): new releases use
> `vX.Y.Z`. This supersedes the `lexrunner-v*` tag decision below; existing tags
> and their release evidence remain immutable. See [release process](../release-process.md).

> Licensing amendment, 2026-09-06: the current LexRunner source adopts Apache-2.0.
> Earlier source-available references below describe the prior decision and earlier releases.
> Lex remains MIT. See [licensing](../LICENSING.md) and [stewardship](../../GOVERNANCE.md).

**Date:** November 6, 2025
**Status:** Accepted; amended August 4, 2026
**Author:** Go-to-Market Initiative

---

## Context

The lexrunner project serves two audiences with distinct personas:

1. **Source-Available Product:** Enterprise teams using the merge-weave CLI and merge pyramid orchestration under an appropriate written license.
2. **Open Source Core (MIT):** Community developers building on architectural policy, frames, and episodic memory.

The current naming conflates both, making it unclear which product is which and which license applies to each component.

---

## Decision

### Product Names

| Product       | Brand       | Repo                    | License                       | Notes                                                             |
| ------------- | ----------- | ----------------------- | ----------------------------- | ----------------------------------------------------------------- |
| **LexRunner** | `LexRunner` | `Guffawaffle/lexrunner` | Source-available personal use | Commercial/organizational use requires a separate written license |
| **Lex**       | `Lex`       | `Guffawaffle/lex`       | MIT                           | OSS core; frames, memory, policy, atlas                           |

### CLI Name

- **Canonical CLI binary/command:** `lexrunner`.
- **Compatibility alias:** `lex-pr` invokes the same CLI and remains supported throughout 1.x.
- **Tagline:** `lexrunner` (powered by LexRunner).
- **Package name (npm, future):** `@guffawaffle/lexrunner` (for the LexRunner product).

The August 2026 amendment makes the package, product, and primary executable names consistent
without removing the original executable. It supersedes only the earlier decision that `lex-pr`
must remain the canonical spelling; the backward-compatibility requirement remains in force.

### Repository Names

- `Guffawaffle/LexRunner` → Renamed from `lexrunner` to align with branding.
- `Guffawaffle/lex` → Stays as-is (MIT badge + README).

### Release Tag Prefix

- **Canonical tag prefix (starting now):** `lexrunner-v*` (e.g., `lexrunner-v0.1.0`, `lexrunner-v1.0.0`).
- **CI/CD:** `.github/workflows/release.yml` triggers on `lexrunner-v*` tags.
- **Note:** Old `v*` tags may exist; new releases use `lexrunner-v*` exclusively.

---

## Rationale

1. **Clarity:** Distinguishes the source-available orchestration layer (LexRunner) from the OSS foundations (Lex).
2. **Portability:** Lex can be adopted independently; LexRunner is built on top of Lex.
3. **Legal/Licensing:** Clear separation eases compliance and customer communication.
4. **Brand Consistency:** "LexRunner" projects a premium, purpose-built identity; "Lex" projects open-source accessibility.
5. **Backward Compatibility:** Existing `lex-pr` scripts continue to work through the additive
   alias while new documentation uses `lexrunner`.

---

## Implications

### Immediate (Phase 1)

1. Update `lexrunner/README.md` with LexRunner branding.
2. Update `lex/README.md` with Lex (MIT) branding and cross-reference.
3. Add badges: "Source Available" (LexRunner), "MIT • OSS" (Lex).
4. Create `.github/workflows/release.yml` trigger on `lexrunner-v*` tags.

### Near-Term (Phase 2)

1. Update issue templates to use LexRunner/Lex where appropriate.
2. Update docs and references across both repos.
3. Plan first release tag: `lexrunner-v0.1.0`.

### Future (Phase 3)

1. npm package `@guffawaffle/lexrunner` (currently undefined; may remain as-is).
2. Branding assets: logos, website, marketing materials.
3. User documentation split (commercial-use vs. OSS guides).

---

## Consequences

- **Pros:**
  - Clear, memorable branding for both products.
  - Easy to communicate ("LexRunner for enterprise orchestration; Lex for policy foundations").
  - Supports future monetization and licensing strategies.

- **Cons:**
  - Documentation needs updating across both repos.
  - Users unfamiliar with the split may initially be confused.
  - Tag migration from `v*` to `lexrunner-v*` is a one-time maintenance task.

---

## Alternatives Considered

1. **Replace `lex-pr` with `lexrunner-pr`:** Rejected; removing the existing binary would break
   backward compatibility and the longer name adds verbosity. The later additive `lexrunner`
   alias avoids both problems.
2. **Rename repos to `lexrunner` and `lex-core`:** Rejected; GitHub repos stable; branding works via docs.
3. **Merge Lex into lexrunner:** Rejected; compromises MIT license and OSS adoption story.

---

## References

- `Guffawaffle/LexRunner` (https://github.com/Guffawaffle/LexRunner)
- `Guffawaffle/lex` (https://github.com/Guffawaffle/lex)
- `docs/TERMS.md` (canonical terminology)
- `.smartergpt/intent.md` (workspace profile example)

---

## Sign-Off

Accepted by: Go-to-Market Team
Date: November 6, 2025
