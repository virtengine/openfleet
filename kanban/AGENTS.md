# Kanban Integration Guide

## Scope
Vibe-Kanban/GitHub board adapters plus orchestrator wrapper scripts.

## Start Files
- `kanban/kanban-adapter.mjs` - adapter abstraction and routing.
- `kanban/ve-kanban.mjs` - Vibe-Kanban API wrapper.
- `kanban/ve-orchestrator.mjs` - orchestration around task attempts.
- `kanban/vk-error-resolver.mjs` - API error normalization/recovery.
- `kanban/vk-log-stream.mjs` - VK activity/event streaming.

## Script Wrappers
- Bash/PowerShell wrappers: `ve-kanban.sh/.ps1`, `ve-orchestrator.sh/.ps1`.

## Common Task Routing
- API routing/URL bugs -> `ve-kanban.mjs`, `kanban-adapter.mjs`.
- Attempt state transitions -> `ve-orchestrator.mjs`, `task/`, `workflow/`.
- Adapter caching and retries -> `vk-error-resolver.mjs`, `infra/sync-engine.mjs`.

## Tests
- Focused: `npm test -- tests/vk-api.test.mjs tests/ve-orchestrator-native.test.mjs`
- Full: `npm test`
