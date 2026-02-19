import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

function toEnvSuffix(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();
}

export const PROMPT_WORKSPACE_DIR = ".openfleet/agents";

const PROMPT_DEFS = [
  {
    key: "orchestrator",
    filename: "orchestrator.md",
    description: "Primary task execution prompt for autonomous task agents.",
  },
  {
    key: "planner",
    filename: "task-planner.md",
    description: "Backlog planning prompt used by task planner runs.",
  },
  {
    key: "monitorMonitor",
    filename: "monitor-monitor.md",
    description: "Long-running reliability monitor prompt used in devmode.",
  },
  {
    key: "taskExecutor",
    filename: "task-executor.md",
    description: "Task execution prompt used for actual implementation runs.",
  },
  {
    key: "taskExecutorRetry",
    filename: "task-executor-retry.md",
    description: "Recovery prompt after a failed task execution attempt.",
  },
  {
    key: "taskExecutorContinueHasCommits",
    filename: "task-executor-continue-has-commits.md",
    description:
      "Continue prompt when edits were committed but not fully finalized.",
  },
  {
    key: "taskExecutorContinueHasEdits",
    filename: "task-executor-continue-has-edits.md",
    description: "Continue prompt when uncommitted edits exist.",
  },
  {
    key: "taskExecutorContinueNoProgress",
    filename: "task-executor-continue-no-progress.md",
    description:
      "Continue prompt when the task stalled without meaningful progress.",
  },
  {
    key: "reviewer",
    filename: "reviewer.md",
    description: "Prompt used by automated review agent.",
  },
  {
    key: "conflictResolver",
    filename: "conflict-resolver.md",
    description: "Prompt used for rebase conflict follow-up guidance.",
  },
  {
    key: "sdkConflictResolver",
    filename: "sdk-conflict-resolver.md",
    description: "Prompt for SDK-driven merge conflict resolution sessions.",
  },
  {
    key: "mergeStrategy",
    filename: "merge-strategy.md",
    description: "Prompt for merge strategy analysis and decisioning.",
  },
  {
    key: "mergeStrategyFix",
    filename: "merge-strategy-fix.md",
    description:
      "Prompt used when merge strategy decides to send a fix message.",
  },
  {
    key: "mergeStrategyReAttempt",
    filename: "merge-strategy-reattempt.md",
    description:
      "Prompt used when merge strategy decides to re-attempt the task.",
  },
  {
    key: "autofixFix",
    filename: "autofix-fix.md",
    description:
      "Prompt used by crash autofix when structured error data is available.",
  },
  {
    key: "autofixFallback",
    filename: "autofix-fallback.md",
    description:
      "Prompt used by crash autofix when only log-tail context is available.",
  },
  {
    key: "autofixLoop",
    filename: "autofix-loop.md",
    description: "Prompt used by repeating-error loop fixer.",
  },
  {
    key: "monitorCrashFix",
    filename: "monitor-crash-fix.md",
    description: "Prompt used when monitor process crashes unexpectedly.",
  },
  {
    key: "monitorRestartLoopFix",
    filename: "monitor-restart-loop-fix.md",
    description: "Prompt used when monitor/orchestrator enters restart loops.",
  },
];

export const AGENT_PROMPT_DEFINITIONS = Object.freeze(
  PROMPT_DEFS.map((item) =>
    Object.freeze({
      ...item,
      envVar: `OPENFLEET_PROMPT_${toEnvSuffix(item.key)}`,
      defaultRelativePath: `${PROMPT_WORKSPACE_DIR}/${item.filename}`,
    }),
  ),
);

const DEFAULT_PROMPTS = {
  orchestrator: `# Task Orchestrator Agent

You are an autonomous task orchestrator agent. You receive implementation tasks and execute them end-to-end.

## Prime Directives

1. Never ask for human input for normal engineering decisions.
2. Complete the assigned scope fully before stopping.
3. Keep changes minimal, correct, and production-safe.
4. Run relevant verification (tests/lint/build) before finalizing.
5. Use conventional commit messages.

## Completion Criteria

- Implementation matches requested behavior.
- Existing functionality is preserved.
- Relevant checks pass.
- Branch is pushed and ready for PR/review flow.
`,
  planner: `# Codex-Task-Planner Agent

You generate production-grade backlog tasks for autonomous executors.

## Mission

1. Analyze current repo and delivery state.
2. Identify highest-value next work.
3. Create concrete, execution-ready tasks.

## Requirements

- Avoid vague tasks and duplicate work.
- Balance reliability fixes, feature delivery, and debt reduction.
- Every task includes implementation steps, acceptance criteria, and verification plan.
- Every task title starts with one size label: [xs], [s], [m], [l], [xl], [xxl].
- Prefer task sets that can run in parallel with low file overlap.
- Do not call any kanban API, CLI, or external service to create tasks.
- Output must be machine-parseable JSON in a fenced json block.

## Output Contract (Mandatory)

Return exactly one fenced json block with this shape:

\`\`\`json
{
  "tasks": [
    {
      "title": "[m] Example task title",
      "description": "Problem statement and scope",
      "implementation_steps": ["step 1", "step 2"],
      "acceptance_criteria": ["criterion 1", "criterion 2"],
      "verification": ["test/check 1", "test/check 2"]
    }
  ]
}
\`\`\`

Rules:
- Provide at least the requested task count unless blocked by duplicate safeguards.
- Keep titles unique and specific.
- Keep file overlap low across tasks to maximize parallel execution.
`,
  monitorMonitor: `# OpenFleet-Monitor Agent

You are the always-on reliability guardian for openfleet in devmode.

## Core Role

- Monitor logs, failures, and agent/orchestrator behavior continuously.
- Immediately fix reliability regressions and execution blockers.
- Improve prompt/tool/executor reliability to reduce failure loops.
- Only when runtime is healthy, perform code-analysis improvements.

## Constraints

- Operate only in devmode.
- Do not commit/push/open PRs in this context.
- Apply focused fixes, run focused validation, and keep monitoring.
`,
  taskExecutor: `# {{TASK_ID}} — {{TASK_TITLE}}

## Description
{{TASK_DESCRIPTION}}

## Environment
- Working Directory: {{WORKTREE_PATH}}
- Branch: {{BRANCH}}
- Repository: {{REPO_SLUG}}

## Instructions
1. Read task requirements carefully.
2. Implement required code changes.
3. Run relevant tests/lint/build checks.
4. Commit with conventional commit format.
5. Push branch updates.

## Critical Rules
- Do not ask for manual confirmation.
- No placeholders/stubs/TODO-only output.
- Keep behavior stable and production-safe.

## Agent Status Endpoint
- URL: http://127.0.0.1:{{ENDPOINT_PORT}}/api/tasks/{{TASK_ID}}
- POST /status {"status":"inreview"} after PR-ready push
- POST /heartbeat {} while running
- POST /error {"error":"..."} on fatal failure
- POST /complete {"hasCommits":true} when done

## Task Reference
{{TASK_URL_LINE}}

## Repository Context
{{REPO_CONTEXT}}
`,
  taskExecutorRetry: `# {{TASK_ID}} — ERROR RECOVERY (Attempt {{ATTEMPT_NUMBER}})

Your previous attempt on task "{{TASK_TITLE}}" encountered an issue:

\`\`\`
{{LAST_ERROR}}
\`\`\`

Error classification: {{CLASSIFICATION_PATTERN}} (confidence: {{CLASSIFICATION_CONFIDENCE}})

Please:
1. Diagnose the failure root cause.
2. Fix the issue with minimal safe changes.
3. Re-run verification checks.
4. Commit and push the fix.

Original task description:
{{TASK_DESCRIPTION}}
`,
  taskExecutorContinueHasCommits: `# {{TASK_ID}} — CONTINUE (Verify and Push)

You were working on "{{TASK_TITLE}}" and appear to have stopped.
You already made commits.

1. Run tests to verify changes.
2. If passing, push: git push origin HEAD
3. If failing, fix issues, commit, and push.
4. Task is not complete until push succeeds.
`,
  taskExecutorContinueHasEdits: `# {{TASK_ID}} — CONTINUE (Commit and Push)

You were working on "{{TASK_TITLE}}" and appear to have stopped.
You made file edits but no commit yet.

1. Review edits for correctness.
2. Run relevant tests.
3. Commit with conventional format.
4. Push: git push origin HEAD
`,
  taskExecutorContinueNoProgress: `# CONTINUE - Resume Implementation

You were working on "{{TASK_TITLE}}" but stopped without meaningful progress.

Execute now:
1. Read relevant source files.
2. Implement required changes.
3. Run verification checks.
4. Commit with conventional format.
5. Push to current branch.

Task: {{TASK_TITLE}}
Description: {{TASK_DESCRIPTION}}
`,
  reviewer: `You are a senior code reviewer for a production software project.

Review the following PR diff for CRITICAL issues ONLY.

## What to flag
1. Security vulnerabilities
2. Bugs / correctness regressions
3. Missing implementations
4. Broken functionality

## What to ignore
- Style-only concerns
- Naming-only concerns
- Minor refactor ideas
- Non-critical perf suggestions
- Documentation-only gaps

## PR Diff
\`\`\`diff
{{DIFF}}
\`\`\`

## Task Description
{{TASK_DESCRIPTION}}

## Response Format
Respond with JSON only:
{
  "verdict": "approved" | "changes_requested",
  "issues": [
    {
      "severity": "critical" | "major",
      "category": "security" | "bug" | "missing_impl" | "broken",
      "file": "path/to/file",
      "line": 123,
      "description": "..."
    }
  ],
  "summary": "One sentence overall assessment"
}
`,
  conflictResolver: `Conflicts detected while rebasing onto {{UPSTREAM_BRANCH}}.
Auto-resolve summary: {{AUTO_RESOLVE_SUMMARY}}.

{{MANUAL_CONFLICTS_SECTION}}

Use 'git checkout --theirs <file>' for lockfiles and 'git checkout --ours <file>' for CHANGELOG.md/coverage.txt/results.txt.
`,
  sdkConflictResolver: `# Merge Conflict Resolution

You are resolving merge conflicts in a git worktree.

## Context
- Working directory: {{WORKTREE_PATH}}
- PR branch (HEAD): {{BRANCH}}
- Base branch (incoming): origin/{{BASE_BRANCH}}
{{PR_LINE}}
{{TASK_TITLE_LINE}}
{{TASK_DESCRIPTION_LINE}}

## Merge State
A merge is already in progress. Do not start a new merge or rebase.

{{AUTO_FILES_SECTION}}

{{MANUAL_FILES_SECTION}}

## After Resolving All Files
1. Ensure no conflict markers remain.
2. Commit merge result.
3. Push: git push origin HEAD:{{BRANCH}}

## Critical Rules
- Do not abort merge.
- Do not run merge again.
- Do not use rebase for this recovery.
- Preserve behavior from both sides where possible.
`,
  mergeStrategy: `# Merge Strategy Decision

You are a senior engineering reviewer. An AI agent has completed (or attempted) a task.
Review the context and decide the next action.

{{TASK_CONTEXT_BLOCK}}
{{AGENT_LAST_MESSAGE_BLOCK}}
{{PULL_REQUEST_BLOCK}}
{{CHANGES_BLOCK}}
{{CHANGED_FILES_BLOCK}}
{{DIFF_STATS_BLOCK}}
{{WORKTREE_BLOCK}}

## Decision Rules
Return exactly one action:
- merge_after_ci_pass
- prompt
- close_pr
- re_attempt
- manual_review
- wait
- noop

Respond with JSON only.
`,
  mergeStrategyFix: `# Fix Required

{{TASK_CONTEXT_BLOCK}}

## Fix Instruction
{{FIX_MESSAGE}}

{{CI_STATUS_LINE}}

After fixing:
1. Run relevant checks.
2. Commit with clear message.
3. Push updates.
`,
  mergeStrategyReAttempt: `# Task Re-Attempt

A previous attempt failed.

{{TASK_CONTEXT_BLOCK}}

Failure reason: {{FAILURE_REASON}}

Start fresh, complete task, verify, commit, and push.
`,
  autofixFix: `You are a PowerShell expert fixing a crash in a running orchestrator script.

## Error
Type: {{ERROR_TYPE}}
File: {{ERROR_FILE}}
Line: {{ERROR_LINE}}
{{ERROR_COLUMN_LINE}}
Message: {{ERROR_MESSAGE}}
{{ERROR_CODE_LINE}}
Crash reason: {{CRASH_REASON}}

## Source context around line {{ERROR_LINE}}
\`\`\`powershell
{{SOURCE_CONTEXT}}
\`\`\`
{{RECENT_MESSAGES_CONTEXT}}
## Instructions
1. Read file {{ERROR_FILE}}.
2. Identify root cause.
3. Apply minimal safe fix only.
4. Preserve existing behavior.
5. Write fix directly in file.
`,
  autofixFallback: `You are a PowerShell expert analyzing an orchestrator crash.
No structured error was extracted. Termination reason: {{FALLBACK_REASON}}

## Error indicators from log tail
{{FALLBACK_ERROR_LINES}}

## Last {{FALLBACK_LINE_COUNT}} lines of crash log
\`\`\`
{{FALLBACK_TAIL}}
\`\`\`
{{RECENT_MESSAGES_CONTEXT}}
## Instructions
1. Analyze likely root cause.
2. Main script: scripts/openfleet/ve-orchestrator.ps1
3. If fixable bug exists, apply minimal safe fix.
4. If crash is external only (OOM/SIGKILL), do not modify code.
`,
  autofixLoop: `You are a PowerShell expert fixing a loop bug in a running orchestrator script.

## Problem
This error repeats {{REPEAT_COUNT}} times:
"{{ERROR_LINE}}"

{{RECENT_MESSAGES_CONTEXT}}

## Instructions
1. Main script: scripts/openfleet/ve-orchestrator.ps1
2. Find where this error is emitted.
3. Fix loop root cause (missing state change, missing stop condition, etc).
4. Apply minimal safe fix only.
5. Write fix directly in file.
`,
  monitorCrashFix: `You are debugging {{PROJECT_NAME}} openfleet.

The monitor process hit an unexpected exception and needs a fix.
Inspect and fix code in openfleet modules.

Crash info:
{{CRASH_INFO}}

Recent log context:
{{LOG_TAIL}}

Instructions:
1. Identify root cause.
2. Apply minimal production-safe fix.
3. Do not refactor unrelated code.
`,
  monitorRestartLoopFix: `You are a reliability engineer debugging a crash loop in {{PROJECT_NAME}} automation.

The orchestrator is restarting repeatedly within minutes.
Diagnose likely root cause and apply a minimal fix.

Targets (edit only if needed):
- {{SCRIPT_PATH}}
- openfleet/monitor.mjs
- openfleet/autofix.mjs
- openfleet/maintenance.mjs

Recent log excerpt:
{{LOG_TAIL}}

Constraints:
1. Prevent rapid restart loops.
2. Keep behavior stable and production-safe.
3. Avoid unrelated refactors.
4. Prefer small guardrails.
`,
};

function normalizeTemplateValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asPathCandidates(pathValue, configDir, repoRoot) {
  if (!pathValue || typeof pathValue !== "string") return [];
  const raw = pathValue.trim();
  if (!raw) return [];
  if (raw.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return [resolve(home, raw.slice(1))];
  }
  if (isAbsolute(raw)) return [resolve(raw)];

  const candidates = [];
  if (repoRoot) candidates.push(resolve(repoRoot, raw));
  if (configDir) candidates.push(resolve(configDir, raw));
  candidates.push(resolve(process.cwd(), raw));

  return candidates.filter((p, idx, arr) => p && arr.indexOf(p) === idx);
}

function readTemplateFile(candidates) {
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      return { content: readFileSync(filePath, "utf8"), path: filePath };
    } catch {
      // Continue to next candidate.
    }
  }
  return null;
}

export function getAgentPromptDefinitions() {
  return AGENT_PROMPT_DEFINITIONS;
}

export function getDefaultPromptWorkspace(repoRoot) {
  const override = String(
    process.env.OPENFLEET_PROMPT_WORKSPACE || "",
  ).trim();
  if (override) {
    return isAbsolute(override)
      ? override
      : resolve(repoRoot || process.cwd(), override);
  }
  return resolve(repoRoot || process.cwd(), PROMPT_WORKSPACE_DIR);
}

export function getDefaultPromptTemplate(key) {
  return DEFAULT_PROMPTS[key] || "";
}

export function renderPromptTemplate(template, values = {}) {
  if (typeof template !== "string") return "";
  const normalized = {};
  for (const [k, v] of Object.entries(values || {})) {
    normalized[String(k).trim().toUpperCase()] = normalizeTemplateValue(v);
  }

  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (full, key) => {
    const hit = normalized[String(key).toUpperCase()];
    return hit == null ? "" : hit;
  });
}

export function resolvePromptTemplate(template, values, fallback) {
  const base = typeof fallback === "string" ? fallback : "";
  if (typeof template !== "string" || !template.trim()) return base;
  const rendered = renderPromptTemplate(template, {
    ...(values || {}),
    DEFAULT_PROMPT: base,
  });
  return rendered && rendered.trim() ? rendered : base;
}

export function ensureAgentPromptWorkspace(repoRoot) {
  const root = resolve(repoRoot || process.cwd());
  let workspaceDir = getDefaultPromptWorkspace(root);

  try {
    mkdirSync(workspaceDir, { recursive: true });
  } catch (err) {
    const fallbackRoot = resolve(
      process.env.OPENFLEET_HOME ||
        process.env.HOME ||
        process.env.USERPROFILE ||
        homedir(),
    );
    const fallbackDir = resolve(fallbackRoot, PROMPT_WORKSPACE_DIR);
    process.env.OPENFLEET_PROMPT_WORKSPACE = fallbackDir;
    workspaceDir = fallbackDir;
    mkdirSync(workspaceDir, { recursive: true });
    console.warn(
      `[agent-prompts] prompt workspace fallback enabled: ${workspaceDir} (primary path failed: ${err?.code || err?.message || err})`,
    );
  }

  const written = [];
  for (const def of AGENT_PROMPT_DEFINITIONS) {
    const filePath = resolve(workspaceDir, def.filename);
    if (existsSync(filePath)) continue;

    const body = [
      `<!-- openfleet prompt: ${def.key} -->`,
      `<!-- ${def.description} -->`,
      "",
      DEFAULT_PROMPTS[def.key] || "",
      "",
    ].join("\n");

    writeFileSync(filePath, body, "utf8");
    written.push(filePath);
  }

  return {
    workspaceDir,
    written,
  };
}

export function resolveAgentPrompts(configDir, repoRoot, configData = {}) {
  const workspaceDir = getDefaultPromptWorkspace(repoRoot);
  const configured =
    configData && typeof configData.agentPrompts === "object"
      ? configData.agentPrompts
      : {};

  const prompts = {};
  const sources = {};

  for (const def of AGENT_PROMPT_DEFINITIONS) {
    const fallback = DEFAULT_PROMPTS[def.key] || "";
    const envPath = process.env[def.envVar];
    const configuredPath = configured?.[def.key];

    const candidates = [
      ...asPathCandidates(envPath, configDir, repoRoot),
      ...asPathCandidates(configuredPath, configDir, repoRoot),
      resolve(workspaceDir, def.filename),
    ];

    const loaded = readTemplateFile(candidates);
    prompts[def.key] = loaded?.content || fallback;
    sources[def.key] = {
      source: loaded
        ? envPath
          ? "env"
          : configuredPath
            ? "config"
            : "workspace"
        : "builtin",
      path: loaded?.path || null,
      envVar: def.envVar,
      filename: def.filename,
    };
  }

  return {
    prompts,
    sources,
    workspaceDir,
  };
}
