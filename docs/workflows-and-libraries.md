# Workflows & Libraries

**Bosun** ships a visual, DAG-based workflow engine and a centralised library system for prompts, agent profiles, and skills. This reference covers both in detail.

---

## Table of Contents

1. [Workflow Engine Overview](#workflow-engine-overview)
2. [Workflow JSON Structure](#workflow-json-structure)
3. [Node Types Reference](#node-types-reference)
4. [Edge / Connection Reference](#edge--connection-reference)
5. [Context API (`$ctx`)](#context-api-ctx)
6. [Template Variable Interpolation](#template-variable-interpolation)
7. [Pre-Built Template Library](#pre-built-template-library)
   - [GitHub Templates](#github-templates)
   - [Agent Templates](#agent-templates)
   - [Planning Templates](#planning-templates)
   - [CI/CD Templates](#cicd-templates)
   - [Reliability Templates](#reliability-templates)
   - [Security Templates](#security-templates)
8. [Library Manager](#library-manager)
   - [Prompts](#prompts)
   - [Agent Profiles](#agent-profiles)
   - [Skills](#skills)
   - [Manifest Format](#manifest-format)
9. [Using the Visual Builder](#using-the-visual-builder)
10. [Creating Custom Workflows](#creating-custom-workflows)
11. [Creating Custom Library Entries](#creating-custom-library-entries)

---

## Workflow Engine Overview

Workflows are **directed acyclic graphs (DAGs)** defined as JSON and executed by `workflow-engine.mjs`. Each workflow consists of **nodes** (units of work) connected by **edges** (transitions). Execution is event-driven: a trigger node fires when its event condition is met, then the engine fans out and runs all connected downstream nodes.

### Key Execution Limits

| Setting | Default | Env var override |
|---|---|---|
| Max concurrent branches | 8 | `MAX_CONCURRENT_BRANCHES` |
| Per-node timeout | 10 minutes | — |
| Max retries per node | 3 | — |
| Max persisted run history | 200 runs | — |

### Status Enumerations

**WorkflowStatus** (workflow-level):
- `IDLE` — registered but never triggered
- `RUNNING` — currently executing
- `COMPLETED` — all terminal nodes finished successfully
- `FAILED` — one or more nodes hit a terminal error
- `CANCELLED` — manually cancelled
- `PAUSED` — execution suspended pending external event

**NodeStatus** (per-node):
- `PENDING` — waiting to be scheduled
- `RUNNING` — currently executing
- `COMPLETED` — finished successfully
- `FAILED` — error after all retries exhausted
- `SKIPPED` — bypassed by conditional edge
- `WAITING` — blocked on an upstream dependency

### Public API

```js
import {
  loadWorkflows, saveWorkflow, deleteWorkflow, listWorkflows,
  getWorkflow, executeWorkflow, registerNodeType,
} from './workflow-engine.mjs';

// Register a custom node type
registerNodeType('my.node', async (node, ctx) => {
  const output = await doSomething(node.config);
  return { result: output };
});

// Trigger a workflow programmatically
await executeWorkflow('my-workflow-id', { prNumber: 42 });
```

---

## Workflow JSON Structure

```jsonc
{
  "id": "my-workflow",            // Unique slug (kebab-case)
  "name": "My Workflow",          // Human-readable display name
  "description": "...",           // Multi-line description shown in the UI
  "category": "github",           // github | agents | planning | ci-cd | reliability | security
  "enabled": true,                // false = loaded but never triggered
  "recommended": false,           // Shown with ⭐ in the template picker
  "trigger": "trigger.pr_event",  // Node type string of the trigger node

  "variables": {                  // Workflow-level default values
    "baseBranch": "main",
    "ciTimeoutMs": 300000
  },

  "nodes": [
    {
      "id": "my-node",              // Unique within this workflow
      "type": "action.run_command", // Node type (see reference below)
      "label": "Human-readable label",
      "config": { /* type-specific config */ },
      "position": { "x": 400, "y": 200 }  // Canvas coordinates for visual builder
    }
  ],

  "edges": [
    {
      "id": "edge-1",              // Auto-generated if omitted
      "source": "node-a",          // Source node id
      "target": "node-b",          // Target node id
      "condition": "$output?.result === true",  // Optional JS expression
      "port": "yes"                // Named output port (for condition.switch)
    }
  ],

  "metadata": {                   // Optional — shown in the template picker UI
    "author": "bosun",
    "version": 1,
    "tags": ["github", "pr"]
  }
}
```

> **Tip:** The `variables` block provides defaults. At runtime you can pass an override map to `executeWorkflow(id, overrides)`. Node configs can reference any variable as `{{variableName}}`.

---

## Node Types Reference

Nodes are identified by a `type` string in `"namespace.verb"` format.

### Trigger Nodes

These nodes start a workflow. A workflow must have exactly one trigger node.

#### `trigger.pr_event`

Fires on GitHub Pull Request events.

| Config field | Type | Description |
|---|---|---|
| `event` | string | GitHub event: `opened`, `review_requested`, `closed`, `merged`, `synchronize` |

**Example:**
```json
{ "type": "trigger.pr_event", "config": { "event": "review_requested" } }
```

#### `trigger.schedule`

Fires on a cron schedule.

| Config field | Type | Description |
|---|---|---|
| `cron` | string | Standard cron expression, e.g. `"0 2 * * *"` (2 AM daily) |

#### `trigger.webhook`

Fires when Bosun's webhook endpoint receives a matching payload.

| Config field | Type | Description |
|---|---|---|
| `event` | string | Event name to match, e.g. `"agent.anomaly"`, `"task.failed"` |

#### `trigger.manual`

Never auto-fires. Executes only via explicit UI button or API call.

---

### Action Nodes

Action nodes perform work and return output that downstream nodes can read.

#### `action.run_command`

Runs a shell command in the repository root.

| Config field | Type | Description |
|---|---|---|
| `command` | string | Shell command to execute. Supports `{{variable}}` interpolation. |
| `workdir` | string | (optional) Working directory override |

**Returns:** `{ exitCode, output, stderr }` — `output` is the trimmed stdout string.

**Example:**
```json
{
  "type": "action.run_command",
  "config": { "command": "gh pr merge {{prNumber}} --auto --squash" }
}
```

#### `action.run_agent`

Dispatches a task to a Bosun agent (Copilot, Codex, or Claude Code).

| Config field | Type | Description |
|---|---|---|
| `prompt` | string | Instruction for the agent. Supports `{{variable}}` and `$ctx.*` interpolation. |
| `timeoutMs` | number | Maximum wait time in ms (default: `600000` = 10 min) |
| `sdk` | string | (optional) Force a specific SDK: `copilot`, `codex`, `claude` |
| `model` | string | (optional) Override model for this node |

**Returns:** `{ output, exitCode }` — `output` is the agent's response text.

**Example:**
```json
{
  "type": "action.run_agent",
  "config": {
    "prompt": "Review PR #{{prNumber}} and summarise the changes.",
    "timeoutMs": 900000
  }
}
```

#### `action.delay`

Pauses execution for a configurable duration.

| Config field | Type | Description |
|---|---|---|
| `delayMs` | number / string | Milliseconds to wait. Supports `{{variable}}`. |
| `reason` | string | (optional) Human-readable reason shown in logs |

---

### Condition Nodes

Condition nodes branch the execution graph.

#### `condition.expression`

Evaluates a JavaScript expression and routes to `yes` or `no` output ports.

| Config field | Type | Description |
|---|---|---|
| `expression` | string | JS expression that evaluates to `true` or `false`. Has access to `$ctx` and `$output`. |

**Output ports:** `yes` (truthy), `no` (falsy)

**Example:**
```json
{
  "type": "condition.expression",
  "config": {
    "expression": "$ctx.getNodeOutput('check-ci')?.passed === true"
  }
}
```

#### `condition.switch`

Multi-way branch based on a field value from the previous node's output.

| Config field | Type | Description |
|---|---|---|
| `field` | string | Field name to read from the previous node's output |
| `expression` | string | (alternative to `field`) JS expression returning a string |
| `cases` | object | Map of value → output port name |
| `default` | string | (optional) Fallback port if no case matches |

**Output ports:** each key in `cases`, plus `default`.

**Example:**
```json
{
  "type": "condition.switch",
  "config": {
    "field": "action",
    "cases": {
      "merge_after_ci_pass": "merge",
      "close_pr": "close",
      "manual_review": "escalate"
    },
    "default": "wait-for-ci"
  }
}
```

---

### Validation Nodes

Validation nodes check external state and produce a boolean result.

#### `validation.build`

Checks the CI status of a PR or commit.

| Config field | Type | Description |
|---|---|---|
| `command` | string | Command whose output is JSON array of `{ name, state }` checks |

**Returns:** `{ passed: boolean, checks: array }`

---

### Notify Nodes

Notify nodes send messages — they do not branch the graph.

#### `notify.telegram`

Sends a Telegram message via the configured bot.

| Config field | Type | Description |
|---|---|---|
| `message` | string | Message text. Markdown is supported. Supports `{{variable}}` interpolation. |

#### `notify.log`

Writes a structured log entry visible in the Bosun dashboard.

| Config field | Type | Description |
|---|---|---|
| `message` | string | Log message |
| `level` | string | `info`, `warn`, or `error` (default: `info`) |

---

### Transform Nodes

Transform nodes reshape data without side effects.

#### `transform.json_extract`

Parses JSON from a previous node's output and extracts a field.

| Config field | Type | Description |
|---|---|---|
| `source` | string | Node id to read output from |
| `path` | string | Dot-notation path, e.g. `"result.score"` |

---

## Edge / Connection Reference

Edges define transitions between nodes.

```jsonc
{
  "source": "node-a",
  "target": "node-b",

  // Optional: JS expression gating this edge.
  // $output is the source node's return value.
  "condition": "$output?.exitCode === 0",

  // Optional: named output port (required for condition.switch)
  "port": "merge"
}
```

- An edge **without** a `condition` always activates.
- An edge with `condition` activates only when the expression is truthy.
- `condition.expression` nodes expose `yes` / `no` ports — connect edges with `port: "yes"` or `port: "no"`.
- `condition.switch` nodes expose one port per `cases` key plus `default`.

---

## Context API (`$ctx`)

Inside `condition.expression` expressions, `action.run_agent` prompts, and `condition.switch` expressions, you have access to `$ctx`:

```js
// Get the output object of a previously-executed node
$ctx.getNodeOutput('node-id')      // returns the node's return value or null

// Access workflow-level variables
$ctx.variables.baseBranch           // e.g. "main"

// Access the trigger payload
$ctx.triggerPayload.prNumber        // e.g. 42
$ctx.triggerPayload.branch          // e.g. "feat/my-feature"
```

Inside edge `condition` expressions, `$output` is shorthand for the source node's last output:

```js
condition: "$output?.exitCode === 0"
// equivalent to:
condition: "$ctx.getNodeOutput('source-node-id')?.exitCode === 0"
```

---

## Template Variable Interpolation

Anywhere a config string is used, you can interpolate values using double-brace syntax:

| Syntax | Resolves to |
|---|---|
| `{{prNumber}}` | Workflow variable or trigger payload field `prNumber` |
| `{{baseBranch}}` | Workflow variable `baseBranch` |
| `{{prompt:my-prompt}}` | Contents of library prompt with id `my-prompt` |
| `{{agent:frontend-agent}}` | Agent profile definition with id `frontend-agent` |
| `{{skill:code-review}}` | Skill document with id `code-review` |

Library references (`{{prompt:*}}`, `{{agent:*}}`, `{{skill:*}}`) are resolved from `.bosun/library.json` at runtime.

---

## Pre-Built Template Library

Install any template from the **Workflows → Templates** tab in the web UI. Templates are opinionated but fully editable once installed.

### GitHub Templates

#### PR Merge Strategy ⭐ (recommended)

> `template-pr-merge-strategy`

Automates merge decisions for every PR. After review is requested, it checks CI status, collects diff stats, and asks an agent to choose one of 7 outcomes:

| Decision | Action |
|---|---|
| `merge_after_ci_pass` | `gh pr merge --auto --squash` |
| `prompt` | Agent continues working on the PR |
| `close_pr` | PR is closed with a reason comment |
| `re_attempt` | Agent re-starts the task from scratch |
| `manual_review` | Telegram notification to a human |
| `wait` | Delay then re-evaluate |
| `noop` | No action |

**Trigger:** `pr.review_requested`  
**Key variables:** `ciTimeoutMs` (default 5 min), `cooldownSec` (60), `maxRetries` (3), `baseBranch`

---

#### PR Triage & Labels

> `template-pr-triage`

Classifies each new PR by change size (S/M/L based on additions+deletions), detects breaking changes, adds labels, and assigns reviewers from CODEOWNERS.

**Trigger:** `pr.opened`  
**Key variables:** `smallThreshold` (50), `largeThreshold` (500)

---

#### PR Conflict Resolver ⭐ (recommended)

> `template-pr-conflict-resolver`

Detects merge conflicts on open PRs, attempts an automated rebase, and escalates to human review via Telegram if the rebase fails.

**Trigger:** `pr.synchronize`  
**Key variables:** `baseBranch`, `telegramChatId`

---

#### Stale PR Reaper

> `template-stale-pr-reaper`

Scheduled job that finds PRs with no activity for a configurable number of days, adds a `stale` label, and (optionally) closes them.

**Trigger:** `trigger.schedule` (daily)  
**Key variables:** `staleDays` (14), `closeStaleDays` (21), `exemptLabels`

---

#### Release Drafter

> `template-release-drafter`

When a PR is merged to the base branch, automatically groups it by label into a draft release changelog (features, fixes, breaking changes).

**Trigger:** `pr.merged`  
**Key variables:** `baseBranch`, `changelogHeader`

---

### Agent Templates

#### Frontend Agent

> `template-frontend-agent`

A full-cycle agent workflow for frontend tasks: picks up a task, implements it, runs `npm run build` validation, creates a PR, and reports outcomes.

**Trigger:** `trigger.manual` (or task assignment)

---

#### Review Agent

> `template-review-agent`

Pairs a secondary agent with every open PR to perform automated code review: checks style, tests, security, and posts a structured review comment.

**Trigger:** `pr.opened`

---

#### Custom Agent

> `template-custom-agent`

Blank-slate agent template with a single configurable prompt node. Start here for new agent behaviours.

**Trigger:** `trigger.manual`  
**Key variables:** `agentPrompt`, `agentSdk`, `agentModel`

---

#### Agent Session Monitor

> `template-agent-session-monitor`

Watches running agent sessions, detects stalls (no output in `stallThresholdMs`), and either re-prompts or escalates.

**Trigger:** `trigger.schedule` (every 5 min)  
**Key variables:** `stallThresholdMs` (300000)

---

#### Backend Agent

> `template-backend-agent`

Like Frontend Agent but for backend tasks — runs `npm test` and database migration checks as validation gates.

**Trigger:** `trigger.manual`

---

### Planning Templates

#### Task Planner

> `template-task-planner`

Takes a high-level natural-language goal and breaks it into atomic Kanban tasks, creating GitHub Issues or Vibe Kanban cards via the configured backend.

**Trigger:** `trigger.manual`  
**Key variables:** `projectGoal`, `maxTasks` (10)

---

#### Task Replenish

> `template-task-replenish`

Scheduled job that monitors the task backlog. When open task count drops below `minTasks`, asks an agent to generate `batchSize` new tasks based on project history.

**Trigger:** `trigger.schedule`  
**Key variables:** `minTasks` (3), `batchSize` (5)

---

#### Nightly Report

> `template-nightly-report`

At the end of each day, collects all completed tasks, merged PRs, and agent activity and generates a Markdown summary posted to Telegram.

**Trigger:** `trigger.schedule` (`0 23 * * *`)

---

#### Sprint Retrospective

> `template-sprint-retrospective`

Weekly report: velocity, blockers per category, PR cycle time, and agent utilisation stats.

**Trigger:** `trigger.schedule` (`0 9 * * 1` — Monday 9 AM)

---

### CI/CD Templates

#### Build & Deploy

> `template-build-deploy`

Standard build pipeline: install dependencies, run tests, build, deploy to a configurable target command, notify on Telegram.

**Trigger:** `pr.merged`  
**Key variables:** `installCmd`, `testCmd`, `buildCmd`, `deployCmd`

---

#### Release Pipeline

> `template-release-pipeline`

Orchestrates a full release: bump semver (`bumpType`: patch/minor/major), create git tag, push, trigger deploy, draft GitHub release notes.

**Trigger:** `trigger.manual`  
**Key variables:** `bumpType` (patch), `branch`

---

#### Canary Deploy

> `template-canary-deploy`

Deploys to a canary environment, waits for `stabilisationMs`, checks error rates, and either promotes to production or rolls back automatically.

**Trigger:** `pr.merged`  
**Key variables:** `canaryDeployCmd`, `productionDeployCmd`, `rollbackCmd`, `stabilisationMs` (120000)

---

### Reliability Templates

#### Error Recovery

> `template-error-recovery`

Listens for `task.failed` events. Performs diagnosis (reads recent logs), applies a fix strategy, and re-queues the task with corrective context.

**Trigger:** `trigger.webhook` (`event: "task.failed"`)

---

#### Anomaly Watchdog

> `template-anomaly-watchdog`

Listens for `agent.anomaly` events from the anomaly detector. Routes to one of: auto-fix, re-start agent, or human escalation, based on anomaly severity.

**Trigger:** `trigger.webhook` (`event: "agent.anomaly"`)

---

#### Workspace Hygiene

> `template-workspace-hygiene`

Periodic cleanup: archives completed workspaces, removes stale branches, and compacts the SQLite task store.

**Trigger:** `trigger.schedule` (weekly)

---

#### Health Check

> `template-health-check`

Runs a battery of health checks (build, tests, disk space, API reachability) and posts results to Telegram. Red = alert, green = summary.

**Trigger:** `trigger.schedule` (daily)

---

#### Incident Response

> `template-incident-response`

Structures a runbook-style incident response: collect diagnostics, notify on-call via Telegram, create incident issue, track resolution steps.

**Trigger:** `trigger.webhook` (`event: "incident.detected"`)

---

### Security Templates

#### Dependency Audit

> `template-dependency-audit`

Runs `npm audit` (or equivalent), filters results by severity, opens GitHub Issues for high/critical vulnerabilities, and schedules a follow-up.

**Trigger:** `trigger.schedule` (weekly)  
**Key variables:** `auditCmd`, `severityThreshold` (high)

---

#### Secret Scanner

> `template-secret-scanner`

On every PR, scans diff for accidentally committed secrets using pattern matching and a configurable blocklist. Fails the branch if secrets are found.

**Trigger:** `pr.opened`  
**Key variables:** `blocklist` (array of regex patterns)

---

## Library Manager

The Library Manager (`library-manager.mjs`) is a unified in-repo registry for three types of reusable AI artefacts.

### Storage Layout

```
.bosun/
  library.json         ← manifest index (all entries)
  agents/              ← agent prompt markdown files
    frontend.md
    backend.md
  skills/              ← skill/knowledge document files
    code-review.md
    git-workflow.md
  profiles/            ← agent profile JSON files
    frontend-agent.json
    review-agent.json
```

A global fallback at `BOSUN_HOME` (default `~/bosun`) is consulted when a per-repo entry is absent.

---

### Prompts

A **prompt** is a freeform Markdown file that defines an agent's personality, specialisation, or task-specific instruction set. Prompts are stored under `.bosun/agents/` and referenced from workflow nodes or agent profiles.

**When to use prompts:**
- Overriding the default coding agent behaviour for a specific domain
- Providing role-specific context ("You are a security-focused reviewer...")
- Adding project-specific conventions to any agent call

**Create a prompt:**
```bash
# Via CLI
bosun library add --type prompt --name "Security Reviewer" --file .bosun/agents/security.md

# Or create the file and upsert via API
```

**Reference a prompt in a workflow:**
```json
{
  "type": "action.run_agent",
  "config": {
    "prompt": "{{prompt:security-reviewer}}\n\nNow review PR #{{prNumber}}."
  }
}
```

---

### Agent Profiles

An **agent profile** is a JSON configuration object that fully describes how an agent should be instantiated for a category of tasks. Profiles are stored under `.bosun/profiles/`.

**Agent Profile fields:**

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique slug, e.g. `"frontend-agent"` |
| `name` | string | Display name |
| `description` | string | What this agent is for |
| `titlePatterns` | `string[]` | Regex patterns matched against task titles to auto-assign this profile |
| `scopes` | `string[]` | Repository paths this agent is authorised to touch |
| `sdk` | string | `"copilot"`, `"codex"`, or `"claude"` |
| `model` | string | Model override, e.g. `"claude-opus-4.6"` |
| `promptOverride` | string | Library prompt ID or inline instruction |
| `skills` | `string[]` | Skill IDs to inject into every session |
| `hookProfile` | object | Override hook scripts for this profile |
| `env` | object | Extra environment variables for this agent |

**Example profile (`.bosun/profiles/frontend-agent.json`):**
```json
{
  "id": "frontend-agent",
  "name": "Frontend Specialist",
  "description": "Handles React/TypeScript UI tasks",
  "titlePatterns": ["^\\[UI\\]", "^feat.*component", "^fix.*style"],
  "scopes": ["site/", "packages/ui/"],
  "sdk": "copilot",
  "model": "claude-opus-4.6",
  "promptOverride": "frontend-specialist",
  "skills": ["react-patterns", "accessibility", "tailwind"],
  "env": { "NODE_ENV": "development" }
}
```

---

### Skills

A **skill** is a Markdown document that provides reusable domain knowledge injected into agent context at session start. Think of skills as "background reading" that every agent gets before starting a task.

**When to use skills:**
- Encoding project coding conventions (naming patterns, folder structure)
- Domain-specific knowledge (e.g. "how our API authentication works")
- Shared checklists ("before you open a PR, always...")
- Tooling guides (e.g. "how to run the integration tests locally")

**Create a skill:**
```bash
# Create the markdown file
cat > .bosun/skills/testing-conventions.md << 'EOF'
# Testing Conventions

- All tests live in `__tests__/` adjacent to the file under test.
- Use `describe` blocks to group related assertions.
- Mock only network and filesystem boundaries.
- Run tests with `npm run test:watch` during development.
EOF

# Register it in the manifest
bosun library add --type skill --name "Testing Conventions" --file .bosun/skills/testing-conventions.md
```

**Reference a skill in a workflow:**
```json
{
  "type": "action.run_agent",
  "config": {
    "prompt": "{{skill:testing-conventions}}\n\nWrite tests for the changed files in PR #{{prNumber}}."
  }
}
```

---

### Manifest Format

`.bosun/library.json` is the authoritative index. Bosun reads it on startup and when library CLI commands modify an entry.

```jsonc
{
  "version": 1,
  "updatedAt": "2025-02-24T00:00:00Z",
  "entries": [
    {
      "id": "frontend-specialist",        // Unique slug
      "type": "prompt",                    // "prompt" | "agent" | "skill"
      "name": "Frontend Specialist",
      "description": "Full-stack React/TS agent",
      "filename": "agents/frontend.md",    // Relative to .bosun/
      "tags": ["frontend", "react", "typescript"],
      "scope": "repo",                     // "repo" | "global"
      "workspace": null,                   // Workspace ID if workspace-scoped
      "meta": {},                          // Arbitrary metadata
      "createdAt": "2025-02-24T00:00:00Z",
      "updatedAt": "2025-02-24T00:00:00Z"
    }
  ]
}
```

**Programmatic access:**

```js
import {
  listEntries, getEntry, getEntryContent,
  upsertEntry, deleteEntry,
} from './library-manager.mjs';

// List all prompts
const prompts = await listEntries({ type: 'prompt' });

// Get a specific entry's Markdown content
const content = await getEntryContent('frontend-specialist');

// Create or update an entry
await upsertEntry({
  id: 'my-prompt',
  type: 'prompt',
  name: 'My Custom Prompt',
  filename: 'agents/my-prompt.md',
}, markdownContent);
```

---

## Using the Visual Builder

Access the visual builder at **http://localhost:3456/workflows** (or your configured port) after starting Bosun.

1. **Create a new workflow:** click **+ New Workflow**, enter a name, pick a trigger.
2. **Add nodes:** drag node types from the left panel onto the canvas.
3. **Connect nodes:** click a node's output handle and drag to another node's input handle.
4. **Configure a node:** click a node to open the config panel on the right.
5. **Add variables:** click the **Variables** tab to define workflow-level default values.
6. **Install a template:** click **Templates**, browse categories, click **Install**.  
   Installed templates are editable copies — changes do not affect the original.
7. **Enable/disable:** toggle the switch on any workflow card to pause execution without deleting.
8. **Run now:** click the **▶ Run** button on a workflow to trigger it immediately (useful for `trigger.manual` workflows).
9. **Execution history:** click the clock icon to see recent runs, node timings, and per-node output.

---

## Creating Custom Workflows

**Option A — Visual Builder:** Use the UI as described above.

**Option B — JSON file:**

1. Create a JSON file following the [Workflow JSON Structure](#workflow-json-structure) spec.
2. Place it anywhere accessible, then import via the UI **Import** button.
3. Or call `saveWorkflow(workflowObject)` from code.

**Option C — Extend a template:**

1. Install the template closest to your need from the Templates panel.
2. Edit the installed copy in the visual builder.
3. Rename it with a unique id to prevent conflicts with future template updates.

---

## Creating Custom Library Entries

### Via CLI

```bash
# Add a prompt
bosun library add --type prompt --id my-prompt \
  --name "My Prompt" \
  --description "Does X" \
  --file .bosun/agents/my-prompt.md

# List all entries
bosun library list

# Show details of an entry
bosun library show my-prompt

# Remove an entry
bosun library remove my-prompt
```

### Via the Web UI

Navigate to **Library** in the sidebar:
- **Prompts tab** — create/edit/delete prompt markdown
- **Agents tab** — create/edit agent profiles with a form UI
- **Skills tab** — create/edit skill documents

### Multi-workspace scoping

Entries with `"scope": "global"` live under `BOSUN_HOME` and are shared across all projects. Entries with `"scope": "repo"` live under the project's `.bosun/` and override globals of the same `id`. This lets you share a common skill library while allowing per-repo overrides.
