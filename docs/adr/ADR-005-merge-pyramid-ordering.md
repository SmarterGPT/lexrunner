# ADR-005: Merge Pyramid Ordering

**Status:** Accepted
**Date:** 2025-11-25
**Authors:** lexrunner team

---

## Context

When merging multiple PRs, order matters. Dependencies must merge before dependents. The question: how do we compute and enforce correct ordering?

---

## Decision

We adopt **merge pyramid ordering** based on topological sort.

### Topological Sort

Compute an order from leaves → root such that a node runs only after all dependencies are green.

```
     [D]
    /   \
  [B]   [C]
    \   /
     [A]

Merge order: A → B → C → D (or A → C → B → D)
```

### Parallelism

Independent subgraphs may run concurrently **up to the concurrency limits** specified by policy/plan.

<!-- lexrunner-non-executable-plan:adr-merge-order-policy-fragment -->

```yaml
policy:
  maxWorkers: 2
```

### Promotion

A node is eligible to merge when:

1. All **required gates** pass
2. **Policy** authorizes (no blockers)
3. All **dependencies** have merged

### Short-Circuiting

If a dependency fails on required gates:

- **Do not** run dependents
- Mark dependents as `blocked`
- Surface which dependency caused the block

This prevents wasted compute on nodes that can't possibly merge.

### Cycle Detection

If the dependency graph contains cycles:

- **Fail fast** — Report the cycle
- **Do not attempt merge** — Cycles make ordering impossible

---

## Consequences

### Positive

- **Correct ordering** — Dependencies merge first
- **Efficient** — Parallel execution of independent subgraphs
- **Fast failure** — Short-circuit prevents wasted work

### Negative

- **DAG requirement** — Cycles are rejected
- **Complexity** — Topo sort implementation needed

---

## References

- `/AGENTS.md` — Section 4: Merge Pyramid & Ordering Rules
- `/docs/merge-weave-analysis.md` — Merge-weave algorithm details
