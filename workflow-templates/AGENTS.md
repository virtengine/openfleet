# Workflow Templates Guide

## Scope
Built-in template library used by the workflow engine.

## Start Files
- `workflow-templates/task-lifecycle.mjs` - task lifecycle ownership templates.
- `workflow-templates/task-batch.mjs` - batched task orchestration.
- `workflow-templates/agents.mjs` - agent behavior templates.
- `workflow-templates/github.mjs` - GitHub automation templates.
- `workflow-templates/reliability.mjs` - recovery/self-healing templates.
- `workflow-templates/_helpers.mjs` - shared helpers.

## Common Task Routing
- Prompt/scope guardrails -> `task-lifecycle.mjs`, `agents.mjs`.
- Reliability/retry policy -> `reliability.mjs`, `security.mjs`, `ci-cd.mjs`.
- Template wiring issues -> `workflow/workflow-templates.mjs`.

## Tests
- Focused: `npm test -- tests/workflow-templates*.test.mjs tests/workflow-task-lifecycle.test.mjs`
- Full: `npm test`
