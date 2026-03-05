# Workspace Module Guide

## Scope
Workspace and worktree registry, shared-state coordination, and context indexing.

## Start Files
- `workspace/workspace-manager.mjs` - workspace lifecycle orchestration.
- `workspace/workspace-registry.mjs` - workspace metadata persistence.
- `workspace/worktree-manager.mjs` - worktree allocation/cleanup.
- `workspace/shared-state-manager.mjs` - distributed task coordination.
- `workspace/context-indexer.mjs` - code/context indexing pipeline.

## Common Task Routing
- Worktree leaks/orphans -> `worktree-manager.mjs`, `workspace-monitor.mjs`.
- Shared-state conflicts -> `shared-state-manager.mjs`, `task/task-claims.mjs`.
- Context search/index drift -> `context-indexer.mjs`, `context-cache.mjs`.

## Tests
- Focused: `npm test -- tests/workspace-*.test.mjs tests/worktree-*.test.mjs tests/shared-state*.test.mjs`
- Full: `npm test`
