# BubbleLab vs Bosun — Gap Assessment

**Date:** 2025-07-18
**Branch:** `feat/sub-workflows`

## Executive Summary

After thorough comparison of BubbleLab's architecture (packages: bubble-core, bubble-runtime, bubble-shared-schemas, bubble-studio, bubblelab-api) against Bosun's current workflow system, here is the definitive gap matrix.

## Parity Matrix

| # | Capability | BubbleLab | Bosun | Status | Notes |
|---|---|---|---|---|---|
| 1 | **Visual workflow builder** | FlowVisualizer (React Flow) | SVG canvas (Preact) | ✅ PARITY | Bosun's canvas is production-ready with drag-drop, zoom, pan |
| 2 | **Node type system** | ~30 bubble types (registry + factory) | **81 node types** across 12 categories | ✅ BOSUN LEADS | Bosun has far richer node catalog (MCP, agent, validation, meeting, etc.) |
| 3 | **Workflow templates** | None (AI-generated flows) | **73 templates** across 16 categories | ✅ BOSUN LEADS | Comprehensive template library with auto-layout |
| 4 | **Real cron scheduling** | cron-scheduler.ts (in-process, UTC) | cron-scheduler.mjs (pure JS, 5-field) | ✅ PARITY | Implemented in previous session |
| 5 | **Public webhooks** | webhooks.ts + activation lifecycle | webhook-gateway.mjs + token auth | ✅ PARITY | Implemented in previous session |
| 6 | **Run forensics** | ExecutionHistory + LiveOutput + AllEventsView | getRunForensics + getNodeForensics | ✅ PARITY | Implemented in previous session |
| 7 | **Run evaluation** | evaluation-trigger.ts (auto post-run) | run-evaluator.mjs (scoring + remediation) | ✅ PARITY | Implemented in previous session |
| 8 | **Snapshot/restore** | Code restore from execution history | createRunSnapshot + restoreFromSnapshot | ✅ PARITY | Implemented in previous session |
| 9 | **Code view (dual editor)** | Monaco + FlowIDEView (graph ↔ code) | Graph only, no code view | ❌ GAP | **Feature #5 — implementing now** |
| 10 | **Export/deploy bundles** | ExportModal + zipExportGenerator (client-side JSZip) | Only template install download | ❌ GAP | **Feature #5 — implementing now** |
| 11 | **Retry/Stop run buttons** | Wired in execution UI | Text-only "retry advice" in AI prompts | ❌ GAP | **Implementing now** |
| 12 | **AI copilot for flows** | Pearl (SSE stream, plan + build phases) | "Ask Bosun" + "Fix with Bosun" buttons | ⚠️ PARTIAL | Bosun has AI analysis but not iterative flow building |
| 13 | **Credential inventory** | 3 paradigms: API key, OAuth, browser-session | None — credentials in env/config | ❌ GAP | Medium priority — needed for multi-service workflows |
| 14 | **OAuth flow capture** | Full OAuth service with state/callback/refresh | None | ❌ GAP | Required for credential inventory |
| 15 | **Browser session capture** | BrowserBase integration | None | ❌ GAP | Low priority — niche use case |
| 16 | **Streaming execution logs** | SSE streaming in real-time | WebSocket + 3s polling | ⚠️ PARTIAL | Bosun's approach works but less granular |
| 17 | **Control flow nodes** | if/for/while/try_catch/parallel_execution | condition.expression, loop.for_each, loop.while, flow.gate, flow.join | ⚠️ PARTIAL | Missing: try_catch, parallel_execution as named types |
| 18 | **Variable declarations** | First-class AST with typed declarations | `action.set_variable` + workflow variables | ✅ PARITY | Different approach, same capability |
| 19 | **MCP integration** | None | 4 MCP node types + pipeline adapter | ✅ BOSUN LEADS | Unique differentiator |
| 20 | **Multi-agent orchestration** | None | Pipeline workflows (fanout, race, sequential) + multi-candidate agent | ✅ BOSUN LEADS | Unique differentiator |
| 21 | **Plan-based quotas** | Subscription validation service | None | ❌ GAP | Low priority for self-hosted |
| 22 | **Webhook cURL generation** | ExportModal generates curl commands | None | ❌ GAP | **Implementing now** as part of export |

## Priority Implementation Order (This Session)

### Now Implementing
1. **Code View** — JSON editor view for workflows (toggle between canvas ↔ code)
2. **Export Bundle** — Download workflow as package with README, cURL examples, env template
3. **Retry/Stop Buttons** — Wire actual retry and cancel actions in run detail view

### Future Priorities
4. **Credential Inventory** — Unified credential store with API key + env var support
5. **Try/Catch Node** — Error boundary node type for workflow error handling
6. **Iterative AI Flow Builder** — Enhanced Pearl-like streaming flow generation

## Bosun Unique Strengths (Not in BubbleLab)
- 81 node types vs ~30 bubble types
- 73 workflow templates with auto-layout
- MCP tool integration (4 node types + pipeline adapter)
- Multi-agent orchestration (fanout, race, consensus-vote)
- Git-native operations (worktree, branch, PR nodes)
- Meeting/voice workflow nodes
- Telegram/WhatsApp notification channels
- Desktop Electron shell
- Self-hosted with zero cloud dependencies
