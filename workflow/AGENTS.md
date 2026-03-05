# Workflow Engine Guide

## Scope
Workflow execution graph, node evaluation, migration, and MCP adapter glue.

## Start Files
- `workflow/workflow-engine.mjs` - runtime execution engine.
- `workflow/workflow-nodes.mjs` - node/action implementations.
- `workflow/workflow-templates.mjs` - template registration and loading.
- `workflow/workflow-migration.mjs` - legacy flow migration.
- `workflow/mcp-workflow-adapter.mjs` - MCP interaction layer.

## Common Task Routing
- Execution bugs -> `workflow-engine.mjs` + relevant node handlers.
- Node behavior contracts -> `workflow-nodes.mjs` + `workflow-templates/` file.
- Template update/migration -> `workflow-templates.mjs`, `workflow-migration.mjs`.

## Tests
- Focused: `npm test -- tests/workflow-*.test.mjs tests/workflow-*.node.test.mjs`
- Full: `npm test`
