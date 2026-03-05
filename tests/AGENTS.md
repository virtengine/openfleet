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
- Task/kanban changes -> `tests/*task*.test.mjs`, `tests/vk-api.test.mjs`, `tests/ve-orchestrator-native.test.mjs`
- Workspace/shared-state changes -> `tests/workspace-*.test.mjs`, `tests/shared-state*.test.mjs`
- UI/server changes -> `tests/*ui*.test.mjs`, `tests/*setup*.test.mjs`

## Validation Order
1. Run focused tests for changed module.
2. Run full suite: `npm test`.
3. Run build: `npm run build`.
