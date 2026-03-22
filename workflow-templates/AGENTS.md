# Workflow Templates Guide

## Scope
Built-in template library used by the workflow engine.

## Start Files
- `workflow-templates/task-lifecycle.mjs` - task lifecycle ownership templates.
- `workflow-templates/task-execution.mjs` - task-type execution templates (built with `makeAgentPipeline`).
- `workflow-templates/sub-workflows.mjs` - reusable sub-workflow fragments.
- `workflow-templates/task-batch.mjs` - batched task orchestration.
- `workflow-templates/agents.mjs` - agent behavior templates.
- `workflow-templates/github.mjs` - GitHub automation templates.
- `workflow-templates/reliability.mjs` - recovery/self-healing templates.
- `workflow-templates/_helpers.mjs` - shared helpers + composition primitives.

## Composition System

Templates can be built from reusable parts instead of copy-pasting nodes:

### Factory Functions (`_helpers.mjs`)
- `makeAgentPipeline(opts)` — build trigger → phase₁ → … → done from phase defs.
- `agentPhase(id, label, prompt)` — agent node with standard boilerplate.
- `agentDefaults(extra)` — the 10-field boilerplate config for run_agent nodes.

### Sub-Workflow Fragments (`_helpers.mjs` + `sub-workflows.mjs`)
- `subWorkflow(id, nodes, edges, meta)` — define a reusable fragment.
- `embedSubWorkflow(sub, prefix, overrides)` — embed with prefixed IDs.
- `wire(from, to)` — connect embeds together.
- `VALIDATE_AND_PR_SUB` — build → test → lint → push → create-pr.
- `PR_HANDOFF_SUB` — create-pr → check → set-inreview → dispatch progressor.
- `makeAgentPlanExecuteVerifySub(opts)` — plan → implement → verify (3-phase).

### Adding a New Task-Type Workflow
```js
import { makeAgentPipeline } from "./_helpers.mjs";
export const MY_TEMPLATE = makeAgentPipeline({
  id: "template-task-my-type",
  name: "My Task Workflow",
  taskPattern: "keyword1|keyword2",
  tags: ["my-type", "task-type"],
  phases: [
    { id: "plan", label: "Plan", prompt: "## Plan\n..." },
    { id: "implement", label: "Implement", prompt: "## Implement\n..." },
    { id: "verify", label: "Verify", prompt: "## Verify\n..." },
  ],
});
```

## Common Task Routing
- Prompt/scope guardrails -> `task-lifecycle.mjs`, `agents.mjs`.
- Reliability/retry policy -> `reliability.mjs`, `security.mjs`, `ci-cd.mjs`.
- Template wiring issues -> `workflow/workflow-templates.mjs`.
- Agent config defaults -> `_helpers.mjs` `agentDefaults()`.

## Tests
- Focused: `npm test -- tests/workflow-templates*.test.mjs tests/workflow-task-lifecycle.test.mjs`
- Full: `npm test`
