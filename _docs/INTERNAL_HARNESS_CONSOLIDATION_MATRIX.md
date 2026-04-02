# Internal Harness Consolidation Matrix

Date: 2026-04-03  
Scope: Step 11 dual-agent consolidation and gap closure for Bosun's internal harness adoption.

## Reconciliation Inputs

This consolidation pass reconciles the repository against:

- [2026-04-02-bosun-internal-agent-harness-adoption-plan.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/2026-04-02-bosun-internal-agent-harness-adoption-plan.md)
- [2026-04-03-bosun-internal-agent-harness-adoption-plan-continued.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/2026-04-03-bosun-internal-agent-harness-adoption-plan-continued.md)
- [INTERNAL_HARNESS_CUTOVER_MATRIX.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_CUTOVER_MATRIX.md)
- [INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md)
- [INTERNAL_HARNESS_NATIVE_BOUNDARY.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_NATIVE_BOUNDARY.md)
- [INTERNAL_HARNESS_RELEASE_SIGNOFF.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_RELEASE_SIGNOFF.md)

## Runtime Ownership Matrix

| Runtime area | Canonical owner | Transitional file(s) still present | Convergence result | Evidence |
| --- | --- | --- | --- | --- |
| Session lifecycle, lineage, replay, resume | `agent/session-manager.mjs`, `agent/thread-registry.mjs`, `agent/subagent-control.mjs` | `agent/primary-agent.mjs`, `agent/agent-pool.mjs`, `shell/shell-session-compat.mjs` | Converged with residual wrappers | `session-manager.mjs` owns lifecycle APIs and default manager; shell/session wrappers delegate into it. |
| Harness execution and per-turn runtime | `agent/internal-harness-runtime.mjs`, `agent/harness/*` | `agent/agent-pool.mjs`, `agent/primary-agent.mjs` | Converged with residual launcher debt | Harness session creation and run APIs are delegated through manager/runtime seams; `agent-pool` still exposes compatibility launch surfaces. |
| Provider resolution and normalized provider runtime | `agent/provider-kernel.mjs`, `agent/provider-session.mjs`, `agent/provider-registry.mjs` | `agent/primary-agent.mjs`, `shell/*` | Converged | Canonical provider selection and execution sessions resolve through the provider kernel; transitional shells and primary-agent call into it. |
| Tool control plane | `agent/tool-orchestrator.mjs`, `agent/tool-runtime-context.mjs`, `agent/tool-approval-manager.mjs`, `agent/tool-network-policy.mjs` | `shell/shell-session-compat.mjs` | Converged | Tool policy, approvals, retry, network, and truncation rules are centralized in the orchestrator; shell compatibility only adapts transport. |
| Canonical event and projection spine | `agent/agent-event-bus.mjs`, `infra/session-telemetry.mjs`, `infra/live-event-projector.mjs`, `infra/replay-reader.mjs` | `workflow/workflow-engine.mjs`, `shell/shell-session-compat.mjs` | Converged with residual ingestion-side debt | Canonical event normalization and telemetry recording are centralized; some producers still emit directly into the spine but do not define a second schema. |
| Surface APIs for web, TUI, Telegram | `server/routes/harness-*.mjs`, `ui/modules/harness-client.js`, `telegram/harness-api-client.mjs`, `tui/lib/ws-bridge.mjs` | `server/ui-server.mjs`, `telegram/telegram-bot.mjs` | Converged with residual composition debt | Surface clients call canonical harness endpoints; `ui-server` and `telegram-bot` still retain broad surface composition responsibilities. |
| Workflow-linked harness execution | `workflow/harness-session-node.mjs`, `workflow/harness-tool-node.mjs`, `workflow/harness-approval-node.mjs`, `workflow/harness-subagent-node.mjs` | `workflow/workflow-engine.mjs` | Converged with residual legacy coexistence | Workflow-linked sessions route through harness-backed nodes, but non-harness workflow actions still share the engine file. |
| Optional native hot path | `lib/hot-path-runtime.mjs`, `native/bosun-unified-exec/*`, `native/bosun-telemetry/*` | none beyond optional fallbacks | Converged | Native boundary is explicit; Node remains the control plane and JS fallbacks remain authoritative for correctness. |

## Transitional Files That Still Exist

| File | Current role | Why it remains transitional |
| --- | --- | --- |
| `agent/primary-agent.mjs` | Legacy-facing primary-session facade | Still imports shell executors and preserves historical entrypoint behavior for chat/session parity. |
| `agent/agent-pool.mjs` | Compatibility launcher plus legacy pooled-thread API surface | Still exports large compatibility surfaces such as pooled prompt execution and thread-launch helpers while delegating into canonical session/runtime modules. |
| `server/ui-server.mjs` | Surface composition shell | Still hosts broad server concerns and some fallback wiring to legacy entrypoints even though harness routes are canonical. |
| `workflow/workflow-engine.mjs` | Graph scheduler with mixed node families | Harness-backed nodes are canonical, but legacy workflow actions still coexist in the same engine file. |
| `telegram/telegram-bot.mjs` | Telegram surface controller | Uses canonical harness APIs but still owns local polling, local UI bootstrap, and broad bot command concerns. |
| `shell/shell-session-compat.mjs` | Narrow shell compatibility bridge | Purposefully translates legacy shell session shapes into canonical manager/kernel/orchestrator/telemetry contracts. |

## Convergence Decision

Bosun now has one coherent architecture story:

1. Canonical runtime ownership lives in the harness/session/provider/tool/observability modules, not in surface wrappers.
2. Transitional files can be named explicitly and mapped to canonical owners.
3. The remaining debt is no longer hidden. It is bounded and tracked in [INTERNAL_HARNESS_GAP_REGISTER.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_GAP_REGISTER.md).

## Explicit Non-Owners

The following files are not accepted as hidden long-term owners:

- `agent/primary-agent.mjs` is not the lifecycle source of truth.
- `agent/agent-pool.mjs` is not the canonical orchestration model.
- `workflow/workflow-engine.mjs` is not a second agent runtime.
- `server/ui-server.mjs` is not the canonical harness business-logic owner.
- `telegram/telegram-bot.mjs` is not the long-term session/provider/thread control plane.
- `shell/*` is not a second provider/session/tool architecture.
