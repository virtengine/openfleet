# Test Suite Guide

## Scope

Vitest and node test coverage for runtime, workflows, integrations, and UI.

## Start Points

- Config: `vitest.config/config.mjs`
- Shared-state docs: `tests/SHARED_STATE_TESTS.md`
- Fixtures/sandbox: `tests/fixtures/`, `tests/sandbox/`

## Naming Heuristics

- `*.test.mjs` - standard vitest suites.
- `*.node.test.mjs` - node-specific/runtime behavior checks.
- Feature-prefixed files usually map directly to module names.

## Fast Routing

- Workflow changes -> `tests/workflow-*.test.mjs`
- Task/kanban changes -> `tests/*task*.test.mjs`
- Workspace/shared-state changes -> `tests/workspace-*.test.mjs`, `tests/shared-state*.test.mjs`
- UI/server changes -> `tests/*ui*.test.mjs`, `tests/*setup*.test.mjs`

## Validation Order

1. Run focused tests for changed module.
2. Run full suite: `npm test`.
3. Run build: `npm run build`.

## Pre-push Adjacency Map

The pre-push hook (`.githooks/pre-push`) contains a module adjacency map that
controls which tests run when a source directory changes. When adding a new
test file or a new module, update the `ADJACENCY_MAP` array in the hook so the
pre-push hook picks it up without falling back to the full suite.
