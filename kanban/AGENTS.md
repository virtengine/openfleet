# Kanban Integration Guide

## Scope
Kanban adapter with internal, GitHub, and Jira backends.

## Start Files
- `kanban/kanban-adapter.mjs` - adapter abstraction and routing (internal/GitHub/Jira backends).

## Common Task Routing
- Adapter routing → `kanban-adapter.mjs`.
- Attempt state transitions → `task/`, `workflow/`.

## Tests
- Full: `npm test`
