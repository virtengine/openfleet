# Bosun.ai Competitive Analysis — UI/UX Improvement Plan

> **Date:** 2025-07-16
> **Context:** Comparison of [docs.bosun.ai](https://docs.bosun.ai) (Bosun B.V., Netherlands — pre-launch SaaS) vs our VirtEngine Bosun (Telegram Mini App + CLI agent orchestrator)

---

## 1. Executive Summary

Bosun.ai is a **SaaS platform for automated code maintenance** — migrations, refactors, linter fixes, dependency upgrades — delivered through a polished **desktop-first web app** with YAML task manifests. They focus on *repeatability* (define once, run many times) and *team collaboration* (PR visibility, artifact sharing, audit trails).

Our Bosun is an **autonomous agent orchestrator** primarily consumed through a **Telegram Mini App** and CLI. We are stronger in real-time agent interaction, but significantly weaker in desktop ergonomics, workflow visualization, and structured output management.

**Key takeaway:** Their strongest concepts are directly applicable as UI improvements for our desktop experience.

---

## 2. Bosun.ai — Solid Concepts Worth Adopting

### 2.1 :chart: Task Graph Visualization
**What they do:** Tasks are expressed as DAGs (directed acyclic graphs) with visual flow diagrams showing step connections, branching on success/failure, and edge conditions. Users see a clear flow: `run-tests → [success] → open-pr` / `[failure] → try-fix → run-tests`.

**Why it's solid:** Makes complex multi-step agent workflows immediately comprehensible. Users can reason about branching and error recovery visually.

**Our gap:** Tasks are flat lists in a kanban board. No visual flow between subtasks/steps. Agent chains are invisible.

### 2.2 :edit: Interactive Task Editor with AI Copilot
**What they do:** YAML manifest editor with a side-panel AI copilot that reads the current manifest, proposes diffs, validates against schema, and lets you apply/reject changes inline.

**Why it's solid:** Tight feedback loop — edit, ask AI, see diff, apply. Never leaves the editor context.

**Our gap:** Task creation/editing is a basic form. No manifest/config editor. No AI-assisted workflow design.

### 2.3 :file: Live Diff Preview During Execution
**What they do:** Session log shows real-time diffs as agents edit files. Diff snapshots are recorded per-step with shortstats (additions/deletions/file counts). A timeline overlay lets you navigate between step diffs.

**Why it's solid:** You see *exactly what changed* without waiting for a PR. Makes agent work transparent and auditable.

**Our gap:** Chat view shows text messages but no structured diff output. Agent file changes are invisible until committed.

### 2.4 :box: Artifact System
**What they do:** Any step can save artifacts (Markdown/text documents) with provenance tracking (session, task run, step). Artifacts show in a project-wide library, can be searched, and injected into future task inputs.

**Why it's solid:** Captures institutional knowledge. Regression reports, migration guides, changelogs become reusable across runs.

**Our gap:** Session messages are ephemeral. No artifact persistence or cross-session reference.

### 2.5 :settings: Structured Agent Outcomes (stop/fail schemas)
**What they do:** Agents return structured JSON payloads on completion (`stop_schema`) or failure (`fail_schema`). These are schema-validated, stored in `outputs.<step>`, and available for templating in downstream steps.

**Why it's solid:** Makes agent results machine-readable, not just prose. Enables reliable branching and automation.

**Our gap:** Agent responses are free-form chat messages. No structured output extraction or validation.

### 2.6 :lock: Toolbox Permission Model
**What they do:** Agents get capabilities through named toolboxes: `repository_read`, `repository_write`, `dangerous` (shell/git), `research` (web search/URL fetch). Each step explicitly declares what it can do.

**Why it's solid:** Principle of least privilege. Users understand exactly what each agent can do.

**Our gap:** Agents have implicit access to everything. No per-task/per-step capability gating.

### 2.7 :user:‍:users:‍:user: PR Visibility Cards
**What they do:** Pull requests created by a task show as dedicated cards in the run view — title, number, state, additions/deletions, direct GitHub link. Auto-refreshes as the same PR is updated.

**Why it's solid:** Bridges the gap between automation and code review. Team members can monitor PR state without leaving the tool.

**Our gap:** PRs are mentioned in chat messages but not tracked as first-class entities.

### 2.8 :clipboard: Onboarding Checklist with Resume
**What they do:** Step-by-step onboarding (login → provider → repo sync → secrets → create task → run) with real-time progress. Safe to abandon mid-flow — resumes exactly where you stopped.

**Why it's solid:** Reduces drop-off. Complex setup becomes progressive disclosure.

**Our gap:** No onboarding flow. Users must understand CLI + Telegram setup from docs.

### 2.9 :search: Context Compression / Audit Summaries
**What they do:** After several completions, a summarizer auto-generates structured markdown (task semantics, decision log, audit trail, outcome summaries, relevant files, open issues). Lives in session history as searchable checkpoints.

**Why it's solid:** Long-running tasks stay navigable. New team members can understand what happened without reading every message.

**Our gap:** Chat history is linear. No summarization or checkpoint markers.

---

## 3. Our Bosun — Strengths to Preserve

| Strength | Details |
|----------|---------|
| **Real-time agent interaction** | Live chat with agent, streaming responses, WebSocket push |
| **Telegram integration** | Mobile-first, always accessible, notification push, haptic feedback |
| **Multi-agent support** | Multiple agent backends (Claude, GPT, Codex, Copilot), agent selector |
| **Kanban board** | Visual task management with drag-and-drop, filters, priorities |
| **Command palette** | Keyboard-first power user access (Ctrl+K) |
| **Session management** | Multiple concurrent sessions, session archiving |
| **Telemetry/monitoring** | Built-in observability tab with metrics |
| **Infrastructure management** | Infra tab for provider/deployment management |

---

## 4. Gap Analysis — Desktop UI Priorities

| Priority | Gap | bosun.ai Has | Effort | Impact |
|----------|-----|-------------|--------|--------|
| :dot: P0 | **Desktop layout is cramped** | Polished desktop-first layout with sidebar, panels, overlays | High | Massive |
| :dot: P0 | **No workflow visualization** | Task graph DAG with flow diagrams | Medium | High |
| :u1f7e0: P1 | **No diff viewer integration** | Live diff preview with timeline overlay | Medium | High |
| :u1f7e0: P1 | **No structured agent output** | JSON schema validated stop/fail payloads | Medium | High |
| :dot: P2 | **No artifact system** | Artifact library with provenance and search | High | Medium |
| :dot: P2 | **No AI-assisted task editor** | Side-panel copilot for manifest editing | Medium | Medium |
| :dot: P2 | **No onboarding flow** | Progressive checklist with resume | Low | Medium |
| :dot: P3 | **No audit summaries** | Context compression with structured checkpoints | Medium | Medium |
| :dot: P3 | **No PR tracking cards** | First-class PR entity cards in run view | Low | Low |
| :dot: P3 | **No toolbox permission model** | Named capability sets per step | Low | Low |

---

## 5. Implementation Plan

### Phase 1: Desktop Layout Overhaul (P0) — ~2-3 weeks

The single biggest gap. Our UI was built mobile-first for Telegram and the desktop experience is a stretched phone UI.

**5.1.1 Three-Column Desktop Layout**
```
┌──────────┬────────────────────────────────┬──────────────┐
│ Sidebar  │  Main Content                  │ Inspector    │
│ (nav +   │  (active tab content)          │ (context     │
│  session │                                │  panel)      │
│  list)   │                                │              │
└──────────┴────────────────────────────────┴──────────────┘
```
- **Sidebar (240px):** Navigation tabs as vertical list + session rail (already partially implemented as `SessionRail` in app.js)
- **Main Content (flex-1):** Tab content with proper min-width constraints
- **Inspector (320px, collapsible):** Already exists as `InspectorPanel` — make it persistent and useful
- **Breakpoints:** Desktop (≥1200px) → 3-col. Tablet (≥768px) → 2-col (sidebar + main). Mobile (<768px) → current layout

**5.1.2 Resizable Panels**
- Drag handles between columns (CSS resize or JS-based)
- Remember panel widths in localStorage
- Collapse/expand buttons for sidebar and inspector

**5.1.3 Header Optimization for Desktop**
- Move breadcrumbs/context bar to header (current tab name, active session, connection status)
- Reuse bottom nav space as status bar on desktop
- Keyboard shortcut hints in nav items

**Files to modify:**
- `ui/styles/layout.css` — grid system, breakpoint overrides
- `ui/app.js` — layout rendering, panel state management
- `ui/styles/variables.css` — spacing constants for desktop

### Phase 2: Workflow Visualization (P0) — ~1-2 weeks

**5.2.1 Task Graph Component**
- New component: `ui/components/task-graph.js`
- Render task steps as a DAG using an SVG-based mini graph renderer (no external deps)
- Show edges between steps with labels (success/failure)
- Highlight current executing step
- Click step node → jump to that step's output in the chat/log view

**5.2.2 Step Progress Timeline**
- Horizontal timeline showing step sequence with status indicators
- Appears at top of chat view when a task is running
- States: pending (gray), running (pulsing accent), success (green), failed (red), skipped (dim)

**Files to create:**
- `ui/components/task-graph.js` — DAG renderer
- `ui/styles/task-graph.css` — graph styling

### Phase 3: Live Diff Viewer (P1) — ~1-2 weeks

**5.3.1 Enhance Existing DiffViewer**
- We already have `ui/components/diff-viewer.js` — extend it
- Show diffs inline in chat messages when agent modifies files
- Add a diff timeline overlay (button in header to see all diffs chronologically)
- Support unified and side-by-side views

**5.3.2 File Change Tracking**
- Track files modified by agent during session
- Show file change summary card after each agent action
- Quick link to open diff for any modified file

### Phase 4: Structured Agent Output (P1) — ~1 week

**5.4.1 Output Schema Definition**
- Allow tasks to define expected output schema (JSON)
- When agent returns structured data, validate and store separately from chat
- Render structured outputs in a formatted card (not just raw text)

**5.4.2 Output Panel in Inspector**
- When a step completes, show parsed output in the inspector panel
- Support nested object/array display, copy-to-clipboard
- Use in downstream task templates

### Phase 5: AI Task Editor (P2) — ~2 weeks

**5.5.1 YAML/Config Editor Component**
- New component: `ui/components/task-editor.js`
- Code editor with syntax highlighting (lightweight — use `<textarea>` with overlay or a minimal highlighter)
- Schema validation for task definitions
- Error gutter with inline error messages

**5.5.2 AI Copilot Side Panel**
- Dedicated chat panel in the task editor that understands task schema
- "Describe your workflow" → generates task YAML
- Shows proposed changes as diffs before applying

### Phase 6: Quality of Life (P2-P3) — ongoing

**5.6.1 Onboarding Checklist**
- New component: `ui/components/onboarding.js`
- Steps: connect Telegram → verify agent access → create first session → run first task
- localStorage-based progress tracking
- Show on first visit or from settings

**5.6.2 Session Audit Summaries**
- Auto-generate summary after N messages or on session idle
- Render as collapsible checkpoint card in chat
- Include: task progress, files changed, decisions made, errors

**5.6.3 PR Tracking Cards**
- When agent mentions PR creation, auto-extract PR URL
- Render inline card with PR metadata (title, state, diff stats)
- Auto-refresh via polling or PR webhook

---

## 6. Technical Constraints

| Constraint | Impact |
|-----------|--------|
| **No build step** — all JS loaded via ES modules + import maps from CDN | Can't use React/Vue/Svelte. Must stay Preact + HTM. Keep dependencies minimal. |
| **Telegram WebView** — must remain functional in Telegram's webview | Desktop improvements must not break mobile. Use progressive enhancement. |
| **No backend changes for UI** — all changes are frontend-only initially | Structured output and artifacts need server support later. Start with frontend patterns. |
| **Performance** — Telegram WebView is resource-constrained | Desktop features should lazy-load. Don't import heavy components on mobile. |

---

## 7. Quick Wins (can start immediately)

1. **Desktop nav as vertical sidebar** — Already have TAB_CONFIG and icons. Render as vertical list at ≥1200px instead of bottom bar.
2. **Persistent inspector panel** — Already exists. Make it always visible on desktop with session context, agent status, and task details.
3. **Keyboard shortcut overlay** — Already have command palette. Add "?" shortcut to show all keyboard shortcuts.
4. **Breadcrumb header** — Show active tab > session name > task name in header on desktop.
5. **Widen chat input** — On desktop, chat input should be wider with better formatting toolbar.

---

## 8. Competitive Positioning

| Feature | bosun.ai | Our Bosun | Winner |
|---------|----------|-----------|--------|
| Desktop UI | :star::star::star::star::star: (purpose-built) | :star::star:☆☆☆ (stretched mobile) | bosun.ai |
| Mobile access | :star::star:☆☆☆ (web only) | :star::star::star::star::star: (native Telegram) | **Ours** |
| Real-time interaction | :star::star::star:☆☆ (async workflow) | :star::star::star::star::star: (live chat + WS) | **Ours** |
| Workflow definition | :star::star::star::star::star: (YAML manifests) | :star::star::star:☆☆ (task CRUD forms) | bosun.ai |
| Agent transparency | :star::star::star::star:☆ (diffs, outcomes) | :star::star::star:☆☆ (chat only) | bosun.ai |
| Multi-agent | :star::star:☆☆☆ (Coding + PR) | :star::star::star::star::star: (Claude/GPT/Codex/Copilot) | **Ours** |
| Self-hosted | :star:☆☆☆☆ (SaaS only) | :star::star::star::star::star: (fully self-hosted) | **Ours** |
| Team collaboration | :star::star::star::star:☆ (artifacts, PRs) | :star::star:☆☆☆ (single-user focused) | bosun.ai |

**Strategy:** We don't need to replicate their SaaS model. We should cherry-pick their best UI patterns and bolt them onto our existing real-time, self-hosted, multi-agent architecture. The result would be a tool that's both more powerful *and* more usable than either product alone.
