# Internal Harness Gap Register

Date: 2026-04-03  
Scope: Step 11 explicit residual debt after dual-agent consolidation.

Only gaps that still materially block calling the harness fully consolidated are listed here.

## Open Gaps

| Gap ID | Area | Current file(s) | Canonical owner | Residual gap | Status |
| --- | --- | --- | --- | --- | --- |
| IH-GAP-006 | Broad validation remains red | `tests/voice-action-dispatcher.test.mjs`, `tests/context-indexer.test.mjs`, and `tests/workflow-nodes-security.test.mjs` within grouped full-suite coverage | Canonical owners vary by failing suite | The previously documented `tests/ui-server.test.mjs` and `tests/meeting-workflow-service.test.mjs` blockers are no longer live. Agent-track convergence fixed two real broad-suite leaks: `tests/voice-action-dispatcher.test.mjs` now resets the module graph before import so mocked harness/config boundaries are not contaminated by prior voice suites, and `workspace/context-indexer.mjs` now excludes `.bosun/context-index` generated artifacts from workspace freshness scans so a fresh index is not marked stale by its own outputs. Validation evidence: targeted `tests/voice-action-dispatcher.test.mjs` is green, the contaminated batch 19 reproduction is green, targeted `tests/context-indexer.test.mjs` is green, and grouped batch 4 reproduction is green. Broad validation still remains open because grouped batch 22 currently fails in `tests/workflow-nodes-security.test.mjs` with unresolved `action.create_pr` / `action.run_command` contract drift, including missing auto-merge schema/metadata, missing preflight block reasons (`invalid_repo_slug`, `unresolved_branch_placeholder`, `no_new_commits`), missing task metadata on two-argument `createTask` adapters, missing output-compaction fields, and expression-env parsing drift. | Open |
| IH-GAP-007 | Native compile proof is environment-blocked | `native/bosun-unified-exec/*`, `native/bosun-telemetry/*`, `tools/native-rust.mjs` | `lib/hot-path-runtime.mjs` and native crates | Bosun's native wrapper now resolves `cargo` from standard Rustup homes and `BOSUN_CARGO_BIN`, so the prior PATH-only discovery bug is closed. The remaining blocker is machine-level MSVC build tooling: this environment still lacks a usable Windows linker/SDK library setup (`link.exe`/`kernel32.lib`), so `npm run native:check`, `npm run native:test`, and `npm run native:build` still cannot complete here. This remains an environment validation gap, not a control-plane ownership gap. | Open |

## Closed In This Phase

| Area | Resolution |
| --- | --- |
| IH-GAP-001 legacy launcher footprint | Extracted launcher transport ownership into `agent/agent-launcher.mjs` and reduced `agent/agent-pool.mjs` to a thin compatibility facade that re-exports launcher and canonical session/thread helpers. |
| Primary session shell authority (`IH-GAP-002`) | `agent/primary-agent.mjs` no longer imports shell executors directly. Shell adapter catalog/parity lives in `shell/shell-adapter-registry.mjs`, and primary-session controller binding now delegates through `shell/shell-session-compat.mjs` into the canonical session manager. |
| Server composition debt (`IH-GAP-003`) | Extracted harness worker bridge and prompt-executor fallback ownership into `server/routes/harness-agent-bridge.mjs`, moved `/api/threads` compatibility routing into `server/routes/harness-subagents.mjs`, and moved `/api/harness/surface` payload assembly into `server/routes/harness-surface-payload.mjs`. `server/ui-server.mjs` now only binds dependencies into canonical route/support modules. |
| Telegram local server coupling (`IH-GAP-005`) | `telegram/telegram-bot.mjs` no longer imports `server/ui-server.mjs` directly or starts/stops the UI server. `infra/monitor.mjs` now owns UI-server lifecycle, `telegram/telegram-surface-runtime.mjs` is the bounded Telegram-to-ui-server bridge, and Telegram session/provider/thread operations continue through `telegram/harness-api-client.mjs` and the canonical harness APIs. |
| Native cargo discovery drift (`IH-GAP-007` partial) | `tools/native-rust.mjs` now resolves `cargo` from standard Rustup install locations and optional `BOSUN_CARGO_BIN`, with focused regression coverage in `tests/native-rust.test.mjs`. The only remaining blocker is host linker/SDK availability, not Bosun's native wrapper contract. |
| Hidden architecture contradictions in comments/docs | Updated code-level architecture notes so `provider-kernel`, `tool-orchestrator`, `session-manager`, `agent-event-bus`, `workflow-engine`, `shell-session-compat`, `telegram-bot`, and `ui-server` now describe the same canonical ownership story. |
| Undocumented transitional ownership | All remaining major transitional owners are now named explicitly in the consolidation matrix and this gap register. |
| Native boundary ambiguity | Step 9 native boundary remains explicit via [INTERNAL_HARNESS_NATIVE_BOUNDARY.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_NATIVE_BOUNDARY.md), and Step 11 accepts it as the reconciled hot-path contract. |
| IH-GAP-004 workflow coexistence debt | Replaced `workflow/workflow-nodes.mjs` with a pure composition shell over `workflow/workflow-nodes/*.mjs`, moved shared delegation watchdog/audit/guard normalization into `workflow/delegation-runtime.mjs`, and updated `workflow-engine.mjs` to consume that shared runtime instead of co-owning the delegation policy/bookkeeping. Harness-backed approval/tool/subagent/session flows now resolve through the modular registrars plus canonical harness node modules instead of the legacy monolith. |

## Closure Rule

This register can be considered cleared only when:

1. `agent/primary-agent.mjs` and `agent/agent-pool.mjs` are auditable thin wrappers or smaller transport entrypoints.
2. `server/ui-server.mjs` no longer mixes canonical harness routing with legacy runtime fallback ownership beyond documented transport composition.
3. `workflow/workflow-engine.mjs` is clearly only the scheduler around harness-backed nodes for agent-runtime behavior.
4. `telegram/telegram-bot.mjs` depends on canonical APIs without undocumented local runtime ownership.
5. Broad validation is green enough to satisfy the release signoff gate.
