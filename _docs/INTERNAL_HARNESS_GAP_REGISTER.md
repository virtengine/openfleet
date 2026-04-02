# Internal Harness Gap Register

Date: 2026-04-03  
Scope: Step 11 explicit residual debt after dual-agent consolidation.

Only gaps that still materially block calling the harness fully consolidated are listed here.

## Open Gaps

| Gap ID | Area | Current file(s) | Canonical owner | Residual gap | Status |
| --- | --- | --- | --- | --- | --- |
| IH-GAP-001 | Legacy launcher footprint | `agent/agent-pool.mjs` | `agent/session-manager.mjs`, `agent/internal-harness-runtime.mjs` | `agent-pool.mjs` still exposes a large compatibility API surface including pooled prompt execution, thread launch/resume helpers, and harness facade exports. Delegation is present, but the file is still too large to be considered a thin wrapper. | Open |
| IH-GAP-002 | Primary session facade | `agent/primary-agent.mjs` | `agent/session-manager.mjs`, `agent/provider-kernel.mjs`, `shell/shell-session-compat.mjs` | `primary-agent.mjs` still directly imports shell executors and keeps adapter-specific entrypoint behavior for parity. That is acceptable for compatibility, but the file is still too authoritative to be called fully demoted. | Open |
| IH-GAP-003 | Server composition debt | `server/ui-server.mjs` | `server/routes/harness-*.mjs`, `agent/session-manager.mjs`, `infra/session-telemetry.mjs` | `ui-server.mjs` still imports legacy thread/exec surfaces and contains fallback wiring to older entrypoints alongside canonical harness routes. The harness APIs are canonical, but the composition shell is still too broad. | Open |
| IH-GAP-004 | Workflow coexistence debt | `workflow/workflow-engine.mjs` | `workflow/harness-session-node.mjs`, `workflow/harness-tool-node.mjs`, `workflow/harness-approval-node.mjs`, `workflow/harness-subagent-node.mjs` | Harness-backed workflow nodes are canonical for session/tool/approval/subagent integration, but the engine still co-locates legacy non-harness actions, which makes the ownership boundary less obvious than desired. | Open |
| IH-GAP-005 | Telegram local server coupling | `telegram/telegram-bot.mjs` | `telegram/harness-api-client.mjs`, `server/routes/harness-*.mjs` | Telegram now routes canonical session/provider/thread operations through harness APIs, but it still bootstraps and depends on the local UI server process directly. That is acceptable for now, but remains explicit surface coupling. | Open |
| IH-GAP-006 | Broad validation remains red | `tests/bench-swebench.test.mjs`, `tests/bosun-mcp-server.test.mjs`, plus previously documented broad-suite failures in release signoff | Canonical owners vary by failing suite | Focused harness proofs are green, but broad validation is still not fully green. This blocks a final launch-ready claim even after ownership consolidation. | Open |
| IH-GAP-007 | Native compile proof is environment-blocked | `native/bosun-unified-exec/*`, `native/bosun-telemetry/*` | `lib/hot-path-runtime.mjs` and native crates | The native hot-path contract is implemented, but this environment still lacks `cargo`, so Step 9 native compile/check proof could not be executed here. This is an environment validation gap, not a control-plane ownership gap. | Open |

## Closed In This Phase

| Area | Resolution |
| --- | --- |
| Hidden architecture contradictions in comments/docs | Updated code-level architecture notes so `provider-kernel`, `tool-orchestrator`, `session-manager`, `agent-event-bus`, `workflow-engine`, `shell-session-compat`, `telegram-bot`, and `ui-server` now describe the same canonical ownership story. |
| Undocumented transitional ownership | All remaining major transitional owners are now named explicitly in the consolidation matrix and this gap register. |
| Native boundary ambiguity | Step 9 native boundary remains explicit via [INTERNAL_HARNESS_NATIVE_BOUNDARY.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_NATIVE_BOUNDARY.md), and Step 11 accepts it as the reconciled hot-path contract. |

## Closure Rule

This register can be considered cleared only when:

1. `agent/primary-agent.mjs` and `agent/agent-pool.mjs` are auditable thin wrappers or smaller transport entrypoints.
2. `server/ui-server.mjs` no longer mixes canonical harness routing with legacy runtime fallback ownership beyond documented transport composition.
3. `workflow/workflow-engine.mjs` is clearly only the scheduler around harness-backed nodes for agent-runtime behavior.
4. `telegram/telegram-bot.mjs` depends on canonical APIs without undocumented local runtime ownership.
5. Broad validation is green enough to satisfy the release signoff gate.
