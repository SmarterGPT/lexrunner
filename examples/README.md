# Examples

This directory contains minimal examples demonstrating lexrunner usage.

## Files

- **`sample-plan.json`**: Example plan with schema v1.0.0, showing dependency relationships and gate definitions
- **`sample-stack.yml`**: Supported StackConfig/profile input illustrating branch, dependency, and
  gate configuration. It is not a strict executable Plan and must be adapted into a selected
  workspace profile as `stack.yml` before config-mode plan creation.
- **`expected-snapshot.md`**: Expected snapshot output for the sample plan

## Usage

```bash
# Validate the sample plan
npm run cli -- schema validate examples/sample-plan.json

# Compute merge order from sample plan
npm run cli -- merge-order examples/sample-plan.json
```

This repository does not wire `sample-stack.yml` to a runnable example profile. Copy or adapt it as
the selected profile's `stack.yml`, then use the normal workspace/profile plan workflow; do not pass
it directly to commands that require a strict `plan.json`.
