# Workflow To Harness Boundaries

Workflow ownership:

- `workflow-engine.mjs` owns graph scheduling, traversal, retries of workflow structure, checkpoints, and run bookkeeping.
- `workflow-nodes.mjs` is a transitional registry and composition layer only.
- `workflow-contract.mjs` defines workflow-to-harness requests and lineage expectations.
- `execution-ledger.mjs` persists workflow lineage using the same run/session/thread/approval identifiers as the harness.

Harness ownership:

- Session lifecycle, replay, and lineage live in `agent/session-manager.mjs` and `agent/thread-registry.mjs`.
- Tool execution and tool policy live in `agent/tool-orchestrator.mjs`.
- Approval interpretation lives in the shared tool approval layer and durable approval queue.
- Subagent lineage lives in `agent/subagent-control.mjs`.

Transitional helpers:

- `workflow/action-approval.mjs` remains transitional only until all risky action gating is represented as harness-backed approvals.
- workflow-specific node helpers may prepare prompts and data, but they may not own provider routing, session lifecycle, or tool policy.
