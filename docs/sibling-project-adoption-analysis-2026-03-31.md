# Bosun adoption analysis from sibling projects

Date: 2026-03-31
Scope: `usezombie-main`, `pi-mono-main`, `paperclip-master`, `abtop-main`, `agentfield`, `attractor`, `OpenHands-main`, `bridge-ide-main`

## Executive summary

The highest-value Bosun upgrades in this set are not "replace Bosun with X". They are:

1. Build a better internal coding harness from `pi-mono-main`, with selective reliability and harness-compilation ideas from `usezombie-main`.
2. Import `bridge-ide-main` coordination primitives into Bosun as opt-in supervision layers: hierarchy, approval gates, scope locks, liveness nudges, execution journals, and capability routing.
3. Import `paperclip-master` company-level planning structures where Bosun is currently task-first: goal ancestry, org/role metadata, budgets, and durable heartbeat records.
4. Upgrade Bosun monitoring and TUI/Web UI observability using `abtop-main` and `pi-mono-main`.
5. Treat `OpenHands-main`, `agentfield`, and `attractor` as pattern sources, not direct code-port candidates.

The strongest direct copy/refactor candidates for Bosun `.mjs` are:

- `bridge-ide-main/Backend/approval_gate.py`
- `bridge-ide-main/Backend/handlers/scope_locks.py`
- `bridge-ide-main/Backend/agent_liveness_supervisor.py`
- `bridge-ide-main/Backend/execution_journal.py`
- `usezombie-main/src/harness/control_plane.zig`
- `usezombie-main/src/reliability/reliable_call.zig`
- `abtop-main/src/collector/codex.rs`
- `pi-mono-main/packages/agent/src/agent-loop.ts`

## Bosun seams that make adoption realistic

Bosun already has the right integration seams for most of this work:

- Runtime coordination: `bosun/task/task-claims.mjs`, `bosun/workspace/shared-state-manager.mjs`, `bosun/agent/fleet-coordinator.mjs`
- Settings and UI wiring: `bosun/ui/modules/settings-schema.js`, `bosun/server/ui-server.mjs`
- TUI shell and screens: `bosun/bosun-tui.mjs`, `bosun/tui/app.mjs`, `bosun/tui/screens/*`
- Session and event surfaces: `bosun/ui/modules/session-api.js`, `bosun/ui/modules/agent-events.js`, `bosun/ui/modules/streaming.js`
- Knowledge and durable workspace state: `bosun/workspace/shared-knowledge.mjs`
- Existing retry and monitor surface: `bosun/agent/retry-queue.mjs`, `bosun/infra/monitor.mjs`
- Optional backend seam already established elsewhere: `bosun/kanban/kanban-adapter.mjs`

That means most of the useful work here is additive, not a rewrite.

## Project-by-project adoption

### 1. `bridge-ide-main`

Recommendation: highest-priority donor for multi-agent coordination.

What is worth adopting:

- Team hierarchy in `Backend/team.json.example` with `level`, `team`, and `reports_to`
- Human approval queue in `Backend/approval_gate.py`
- Liveness supervision in `Backend/agent_liveness_supervisor.py`
- Path-level work exclusion and audit in `Backend/handlers/scope_locks.py`
- Durable per-run evidence in `Backend/execution_journal.py`
- Capability routing and skill/catalog ideas from the backend module layout

Why it fits Bosun:

- Bosun already orchestrates multiple executors; it does not yet express hierarchy as a first-class planning primitive.
- Bridge's `reports_to` chain gives Bosun a concrete model for planner -> implementer -> reviewer -> verifier routing.
- Scope locks are directly relevant to Bosun's managed worktrees and concurrent edits.
- Approval gates fit Bosun's existing operator-control posture.
- The liveness supervisor is compatible with Bosun's existing "start or nudge" style recovery pattern.

How to apply it in Bosun:

- Add optional hierarchy metadata to executor/team/task configuration and surface it in Settings/UI.
- Add an opt-in approval layer for irreversible actions:
  - git push
  - deploy
  - credential access
  - destructive repo operations
- Add repo/path scope locks on top of `task/task-claims.mjs` rather than replacing task claims.
- Add an execution journal under Bosun private storage for each task/run with:
  - run metadata
  - step jsonl
  - artifact references
  - stable resume identifiers
- Add a light liveness supervisor that calls Bosun's canonical restart/nudge path instead of inventing a second restart mechanism.

Concrete Bosun landing zones:

- `bosun/task/task-claims.mjs`
- `bosun/workspace/shared-state-manager.mjs`
- `bosun/agent/fleet-coordinator.mjs`
- `bosun/server/ui-server.mjs`
- `bosun/ui/modules/settings-schema.js`
- `bosun/infra/monitor.mjs`
- `bosun/workspace/` for private execution journal storage

Porting stance:

- Copy logic, not framework shape.
- Re-implement in `.mjs` with Bosun storage/runtime conventions.
- Keep off by default and user-enabled in Settings.

### 2. `pi-mono-main`

Recommendation: highest-priority donor for Bosun's internal coding harness, TUI, and web chat surfaces.

What is worth adopting:

- Extension-based coding harness from `packages/coding-agent`
- Event-driven agent loop from `packages/agent/src/agent-loop.ts`
- Differential-render TUI primitives from `packages/tui`
- Artifact/attachment/sandbox UX from `packages/web-ui/src/ChatPanel.ts`
- Session-local state and extension hooks instead of hard-coding every behavior into the core runtime

Why it fits Bosun:

- The user specifically wants an internal Bosun-based coding harness that Bosun can continuously improve.
- `pi-mono` is modular enough to serve as a base architecture rather than just a UI inspiration repo.
- Bosun already has chat/session/event surfaces, but `pi-mono` has a cleaner local abstraction for:
  - agent loop lifecycle events
  - extension hooks
  - custom tool rendering
  - attachment/artifact UX
  - TUI composition

How to apply it in Bosun:

- Build `bosun/agent/internal-coding-harness/` around a Bosun-native port of the `agent-loop.ts` lifecycle:
  - `agent_start`
  - `turn_start`
  - `message_start`
  - `message_end`
  - `turn_end`
  - `agent_end`
- Introduce a Bosun extension API for:
  - permission gates
  - protected paths
  - destructive action confirmation
  - dynamic tools
  - custom renderers
  - follow-up/steering messages
- Upgrade `bosun/bosun-tui.mjs` and `bosun/tui/*` using `pi-tui` ideas:
  - differential rendering
  - overlays/modals
  - richer editor component
  - better keyboard handling
  - status/footer/header composition
- Upgrade Bosun web chat UI with:
  - artifact side panel
  - attachment-aware tools
  - runtime provider abstraction for artifacts/attachments

Concrete Bosun landing zones:

- `bosun/agent/`
- `bosun/ui/modules/agent-events.js`
- `bosun/ui/modules/session-api.js`
- `bosun/ui/modules/streaming.js`
- `bosun/bosun-tui.mjs`
- `bosun/tui/*`
- `bosun/ui/` and `bosun/site/ui/`

Porting stance:

- Strong candidate for direct TypeScript/JavaScript-to-`.mjs` refactor.
- Best used as a base for Bosun's internal coding harness, not as an embedded dependency.

### 3. `paperclip-master`

Recommendation: high-priority donor for organization-level planning and durable heartbeat accounting.

What is worth adopting:

- Goal tree model in `packages/shared/src/types/goal.ts`
- Heartbeat run, runtime state, and wakeup request models in `packages/shared/src/types/heartbeat.ts`
- Broader service model visible in `server/src/services/*`:
  - goals
  - budgets
  - heartbeats
  - approvals
  - live events
  - execution workspace
  - org chart rendering

Why it fits Bosun:

- Bosun is already operationally strong, but still more execution-centric than company/goal-centric.
- Paperclip has explicit ancestry from mission -> goal -> issue -> agent action.
- Bosun can use that ancestry without inheriting Paperclip's full "run a company" framing.

How to apply it in Bosun:

- Add optional goal ancestry above task/workflow level:
  - strategic goal
  - project goal
  - task
  - run
- Add durable heartbeat-run records for every automated wakeup:
  - invocation source
  - trigger detail
  - status
  - stdout/stderr excerpts
  - usage/cost
  - retry lineage
  - context snapshot
- Add per-agent or per-workflow budget windows and operator-visible spend controls.
- Add organization metadata and team charts where useful for multi-agent supervision, but keep Bosun focused on engineering operations rather than generic business orchestration.

Concrete Bosun landing zones:

- `bosun/workflow/`
- `bosun/task/`
- `bosun/infra/monitor.mjs`
- `bosun/agent/fleet-coordinator.mjs`
- `bosun/server/ui-server.mjs`
- `bosun/ui/modules/settings-schema.js`

Porting stance:

- Borrow schemas, service boundaries, and event/accounting model.
- Do not import Paperclip wholesale.

### 4. `usezombie-main`

Recommendation: targeted donor for harness validation, retries, and observability hardening.

What is worth adopting:

- Harness markdown compiler/validator in `src/harness/control_plane.zig`
- Retry wrapper in `src/reliability/reliable_call.zig`
- Broader reliability/observability modules:
  - `error_classify.zig`
  - `backoff.zig`
  - `metrics*.zig`
  - queue and pubsub modules

Why it fits Bosun:

- Bosun is already moving toward self-improvement and internal harnessing.
- `control_plane.zig` shows a strong "spec -> compiled profile -> validation report" model.
- The retry wrapper is small, disciplined, and immediately portable.

How to apply it in Bosun:

- Add a Bosun harness compiler that converts markdown/json agent profiles into validated internal executor profiles.
- Run preflight validation for:
  - secrets in prompt/profile payloads
  - prompt injection patterns
  - unsafe execution patterns
  - invalid topology/schema
- Port the retry policy ideas into Bosun wrappers for external actions:
  - GitHub
  - Jira
  - model providers
  - webhook delivery
  - workflow triggers
- Add better classified retry metrics to Bosun telemetry.

Concrete Bosun landing zones:

- `bosun/agent/`
- `bosun/config/`
- `bosun/infra/`
- `bosun/workflow/`

Porting stance:

- Port specific algorithms and validation rules.
- Do not attempt Zig embedding.

### 5. `abtop-main`

Recommendation: medium-priority donor for observability UX.

What is worth adopting:

- Codex/Claude session collectors in `src/collector/*.rs`
- Session model in `src/model/session.rs`
- Operator-focused metrics:
  - token usage
  - context percent
  - current task
  - child processes
  - ports
  - rate limits
  - orphan detection

Why it fits Bosun:

- Bosun already has a TUI and monitor, but it does not yet expose all live executor-state signals in one operator-first surface.
- `abtop` is focused and practical, not abstract.

How to apply it in Bosun:

- Add a "live sessions" screen in Bosun TUI.
- Add executor process tree, open-port, and context-window views.
- Add rate-limit and context saturation warnings per executor.
- Add a compact agent/session health strip to the web UI and Telegram summaries.

Concrete Bosun landing zones:

- `bosun/bosun-tui.mjs`
- `bosun/tui/screens/*`
- `bosun/infra/monitor.mjs`
- `bosun/ui/modules/agent-events.js`
- `bosun/ui/modules/session-api.js`

Porting stance:

- Recreate the collector logic in Node against Bosun's session stores plus local process inspection.
- Do not port the Rust TUI directly.

### 6. `OpenHands-main`

Recommendation: medium-priority pattern donor, low-priority code donor.

What is worth adopting:

- The clean separation in `openhands/README.md`:
  - Agent
  - AgentController
  - State
  - EventStream
  - Runtime
  - Session
  - ConversationManager
- Frontend real-time architecture shape from `frontend/README.md`

Why it fits Bosun:

- Bosun already has equivalent pieces, but not always with the same conceptual clarity.
- OpenHands' event-stream-first architecture is a useful reference model for cleaning Bosun session/event paths.

How to apply it in Bosun:

- Tighten Bosun's internal event taxonomy around action/observation/run-state events.
- Standardize session routing and event delivery semantics.
- Make the "controller vs runtime vs session state" separation more explicit in docs and code layout.

Concrete Bosun landing zones:

- `bosun/ui/modules/session-api.js`
- `bosun/ui/modules/agent-events.js`
- `bosun/workflow/`
- `bosun/server/ui-server.mjs`

Porting stance:

- Use as architecture guidance, not as a direct code import.

### 7. `agentfield`

Recommendation: future-facing donor for trust, policy, and externalized execution state.

What is worth adopting:

- Generic event bus in `control-plane/internal/events/event_bus.go`
- DID/VC service model in `control-plane/internal/services/vc_service.go`
- Presence/status/storage/vector-store and webhook service layout

Why it fits Bosun:

- The verifiable credential layer is not core to Bosun's immediate roadmap, but it is relevant if Bosun needs stronger compliance or non-repudiation around autonomous actions.
- Event bus and status services are useful references for decoupling Bosun telemetry.

How to apply it in Bosun:

- Near term: borrow event bus and status/presence patterns only.
- Medium term: add optional signed execution attestations for sensitive workflows and merges.
- Keep any credential/attestation feature opt-in and off by default.

Concrete Bosun landing zones:

- `bosun/infra/`
- `bosun/workflow/`
- `bosun/server/`

Porting stance:

- Use patterns, not direct code, unless Bosun explicitly moves into compliance-heavy workflows.

### 8. `attractor`

Recommendation: documentation/spec donor, not code donor.

What is worth adopting:

- The NLSpec approach from `coding-agent-loop-spec.md` and `unified-llm-spec.md`

Why it fits Bosun:

- Bosun's self-improvement workflows need stable natural-language implementation targets.
- Attractor provides a way to turn desired runtime behavior into auditable specs that coding agents can implement against.

How to apply it in Bosun:

- Define Bosun-native NLSpecs for:
  - internal coding harness contract
  - execution journal contract
  - scope locks
  - approval gates
  - liveness supervisor
  - self-improvement workflow rules

Porting stance:

- Use as a spec-writing method only.

## Recommended implementation order

### Phase 1: immediate, high-confidence

- Bosun internal coding harness architecture from `pi-mono`
- Retry and harness-validation layer from `usezombie`
- Approval gate, scope locks, and liveness nudge from `bridge`
- `abtop`-style live session telemetry in Bosun TUI

### Phase 2: structural upgrades

- Paperclip-style goal ancestry and durable heartbeat-run records
- Bridge execution journal and capability routing
- Pi-style artifact/attachment UX in Bosun web UI

### Phase 3: optional and advanced

- AgentField-style signed execution attestations
- Attractor-style NLSpec workflow specs
- OpenHands-inspired cleanup of Bosun event/session architecture docs and APIs

## Suggested Bosun work items

1. Create `bosun/agent/internal-harness/` and port the `pi-mono` loop + extension model into Bosun-native `.mjs`.
2. Create `bosun/agent/approval-gate.mjs` based on Bridge's approval queue semantics.
3. Create `bosun/workspace/scope-locks.mjs` based on Bridge's path-lock design and persist under Bosun private storage.
4. Create `bosun/workspace/execution-journal.mjs` for durable step/artifact journaling.
5. Add a `Live Sessions` screen to `bosun/tui/` modeled on `abtop` metrics.
6. Add `goalId`, `parentGoalId`, and `budgetWindow` concepts to Bosun task/workflow metadata.
7. Add an optional harness-profile compiler and validator to Bosun setup/config flows.

## What not to do

- Do not replace Bosun's current claim/lease/fleet core with Git-polled or hierarchy-only coordination.
- Do not import Bridge or Paperclip as a full runtime dependency.
- Do not move Bosun's high-churn runtime state into Git history.
- Do not make any of the new backend/attestation/hierarchy features default-on.

## Final opinion

If the goal is to improve Bosun in-house, the best composite strategy is:

- `pi-mono` for the internal coding harness and UI/TUI base
- `bridge-ide` for coordination discipline and operator controls
- `paperclip` for goals, budgets, and heartbeat accounting
- `usezombie` for harness validation and reliability policy
- `abtop` for operator visibility

That combination fits Bosun's existing shape and can be implemented incrementally in `.mjs` without surrendering Bosun's current runtime model.
