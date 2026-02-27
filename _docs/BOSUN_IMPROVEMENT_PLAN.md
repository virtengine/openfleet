# BOSUN Improvement Plan (Prototype)

Date: 2026-02-23
Owner: VirtEngine / Bosun
Scope: UX, reliability, setup, task planning, multi-agent orchestration

## Goals
1. Make setup and configuration resilient, resumable, and discoverable.
2. Make multi-agent work visible, controllable, and safe by default.
3. Improve task planning and repeatability without surprising users.
4. Reduce operational failures (updates, credentials, background services).
5. Raise UI clarity and decision support for real-world ops.

## Source Signals (What We Borrow)
1. Spacebot: process separation (Channels, Branches, Workers, Cortex) and memory bulletin model.
2. Spacebot: event-driven status updates and “fresh prompt for workers”.
3. VS Code background agents: isolated workspaces and an Agent HQ for sessions.
4. bosun.ai: repeatable, instruction-driven tasks and inline copilot assistance for manifests.

## Principles
1. Default safe, opt-in for automation and repeat tasks.
2. Users always see what is running, what changed, and why.
3. Workspaces are isolated and named; actions scoped to a workspace.
4. Task planning is draft-first: preview before creating work.
5. Configuration is always discoverable from CLI and UI.

## Workstreams

### 1) Agent HQ (Sessions + Worktrees)
Goal: A single control plane for all agents and background sessions.
Features:
1. Session list with status, workspace, branch, PR link, and current activity.
2. Session actions: pause, stop, reassign, rebase, or archive.
3. Worktree-aware “agent context” panel with repo paths and last 3 commands.
4. Session timeline: task claims, handoffs, failures, merges.
MVP:
1. New Portal tab: Agent HQ.
2. Sessions list + detail panel + stop/restart.
3. Show worktree path and task metadata.
Success:
1. Operators can tell what is running in under 10 seconds.
2. 90% fewer “ghost” sessions after crashes.

### 2) Channel / Branch / Worker Model (Borrowed Concepts)
Goal: Split reasoning, execution, and memory so tasks don’t block each other.
Features:
1. Channels: user-facing conversations (Portal/Telegram).
2. Branches: forked analysis for risk checks and alternatives.
3. Workers: task execution with minimal context and scoped tools.
4. Cortex: system memory + briefings injected into sessions.
MVP:
1. Add “branch” tasks for preflight checks (risk scan, dependency scan).
2. Worker prompt stripped of chat backlog; only task + context pack.
3. Cortex briefing cached to session (summary, recent failures, open PRs).
Success:
1. Faster task completion with fewer long-context failures.
2. Less context overflow in long-running threads.

### 3) Context Packs (Explicit Attachments)
Goal: Make context explicit and repeatable.
Features:
1. Attach files, diffs, logs, and test outputs as a “context pack”.
2. Pack shows up in Agent HQ and task metadata.
3. Pack can be reused for follow-up tasks.
MVP:
1. “Create Context Pack” button in Portal and CLI.
2. Pack is stored in config dir cache and referenced by ID.
Success:
1. Reduced “missing file” errors.
2. Fewer ambiguous tasks.

### 4) Repeatable Tasks and Task Templates (Draft-First)
Goal: Build safe automation without surprise.
Features:
1. Templates are drafts by default.
2. Users enable a template with schedule, repo scope, and limits.
3. Task planner generates drafts; requires approval to post to board.
4. Rate limits and hard caps (per day, per repo, per priority).
MVP:
1. Template editor in Portal.
2. “Generate Drafts” button with review/approve flow.
3. Planner OFF by default.
Success:
1. Zero unintended task floods.
2. Repeat tasks become reliable maintenance.

### 5) Setup and Configuration UX
Goal: Make setup unbreakable and resumable.
Features:
1. Wizard resume at every step with snapshot at step start.
2. Clear config location: CLI `--where`, Portal “Config” card.
3. GUI setup flow in Portal; CLI becomes fallback.
4. Dedicated “workspace selection” step: one board per workspace.
MVP:
1. Wizard resume and config location output.
2. Portal setup panel with progress tracker.
3. “Check GH auth/scopes” button in Portal.
Success:
1. 80% fewer “setup died” reports.
2. Users can resume within 30 seconds.

### 6) Reliability and Update Safety
Goal: Eliminate auto-update crashes and noisy failures.
Features:
1. Staged update: download → verify → prompt to apply.
2. Health check after update; automatic rollback on failure.
3. Windows-friendly npm / nvm detection with fallback.
4. Clear “last crash is stale” indicator in bot/portal.
MVP:
1. Detect EINVAL and disable auto-update until manual action.
2. Bot messages include “crash timestamp” and “current status.”
Success:
1. Fewer auto-update failures.
2. No ghost crash alerts.

### 7) Task Board + Workspace Integration
Goal: One board per workspace, not per repo.
Features:
1. Workspace-level board selection and policies.
2. Task-level repo overrides with a repo picker.
3. GitHub Issues and Projects mode per workspace.
MVP:
1. Workspace board selection in setup.
2. Filter repo choices to active workspace.
Success:
1. Cleaner task routing in multi-repo setups.

### 8) Memory Bulletin and Briefing
Goal: Short, structured memory that’s injected into sessions.
Features:
1. Periodic “briefing” with open PRs, recent failures, and top tasks.
2. Per-workspace memory bulletin.
3. Debuggable and visible in Portal.
MVP:
1. Generate a daily briefing and show in Agent HQ.
Success:
1. Fewer repeated mistakes.
2. Faster onboarding.

### 9) UI Quality Improvements
Goal: Make the portal feel intentional and operator-grade.
Features:
1. Dashboard shows health, queue depth, failures, and last action.
2. “Why this action” tooltips for planner-generated tasks.
3. Diff viewer inline in chat and per-task “changes summary.”
MVP:
1. Add metrics cards and recent activity panel.
2. Show “last command + exit code.”
Success:
1. Faster troubleshooting.

## Phased Roadmap

### Phase 0 (1–2 weeks)
1. Config discoverability + setup resume hardening.
2. Workspace-level board selection.
3. Draft-only task templates.
4. Fix auto-update failure handling.

### Phase 1 (2–6 weeks)
1. Agent HQ tab with sessions list and detail panel.
2. Context pack workflow (CLI + Portal).
3. Task template approval flow.

### Phase 2 (6–12 weeks)
1. Branch/Worker separation in runtime.
2. Memory bulletin + briefing injection.
3. Full GUI setup with validations.

## Metrics
1. Setup completion rate.
2. Crash-free hours per instance.
3. Task success rate.
4. Mean time to identify stuck agents.
5. Planner-generated task approval rate.

## Risks
1. Too much automation surprises users.
2. Workspaces become confused with repo overrides.
3. Overloading Portal with “everything at once.”

## Open Questions
1. Which UI surface is primary: Telegram, Portal, or both?
2. Should Agent HQ also own executor routing and load balancing?
3. Do we require explicit approvals for all automated tasks?

