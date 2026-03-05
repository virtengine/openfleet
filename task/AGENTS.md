# Task Module Guide

## Scope
Task lifecycle runtime: execution, claims, context, attachments, archiving, and CLI tooling.

## Start Files
- `task/task-executor.mjs` - task run loop and executor bridge.
- `task/task-claims.mjs` - claim ownership and conflict handling.
- `task/task-context.mjs` - prompt/runtime task context assembly.
- `task/task-store.mjs` - task persistence interfaces.
- `task/task-archiver.mjs` - archive and completion transitions.
- `task/task-cli.mjs` - CLI entry for task ops.

## Common Task Routing
- Claim conflicts -> `task-claims.mjs` + `workspace/shared-state-manager.mjs`.
- Missing task context -> `task-context.mjs`, `agent/agent-prompts.mjs`.
- Completion/archive regressions -> `task-archiver.mjs`, `kanban/kanban-adapter.mjs`.

## Tests
- Focused: `npm test -- tests/task-*.test.mjs tests/*task*.test.mjs`
- Full: `npm test`
