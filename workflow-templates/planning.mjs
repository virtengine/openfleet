/**
 * planning.mjs — Planning & reporting workflow templates.
 *
 * Templates:
 *   - Task Planner (recommended)
 *   - Task Replenish (Scheduled)
 *   - Nightly Report
 *   - Sprint Retrospective
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Task Planner (auto-replenish backlog)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const TASK_PLANNER_TEMPLATE = {
  id: "template-task-planner",
  name: "Task Planner",
  description:
    "Automatically generates new backlog tasks when the todo count drops " +
    "below a configurable threshold. Replaces the previous hardcoded " +
    "TASK_PLANNER_MODE / REPLENISH_ENABLED env-var system.",
  category: "planning",
  enabled: true,
  recommended: true,
  trigger: "trigger.task_low",
  variables: {
    minTodoCount: 3,
    taskCount: 5,
    dedupHours: 24,
  },
  nodes: [
    node("trigger", "trigger.task_low", "Backlog Low?", {
      threshold: 3,
      status: "todo",
    }, { x: 400, y: 50 }),

    node("check-dedup", "condition.expression", "Dedup Window", {
      expression: "(Date.now() - ($data?._lastPlannerRun || 0)) > (($data?.dedupHours || 24) * 3600000)",
    }, { x: 400, y: 180 }),

    node("log-start", "notify.log", "Log Planner Start", {
      message: "Task planner triggered: {{todoCount}} tasks remaining (threshold: {{minTodoCount}})",
      level: "info",
    }, { x: 400, y: 310 }),

    node("run-planner", "agent.run_planner", "Generate Tasks", {
      taskCount: 5,
      context: "Focus on high-value implementation work. Avoid duplicating existing tasks.",
      dedup: true,
    }, { x: 400, y: 440 }),

    node("materialize-tasks", "action.materialize_planner_tasks", "Create Tasks", {
      plannerNodeId: "run-planner",
      maxTasks: 5,
      status: "todo",
      dedup: true,
      failOnZero: true,
      minCreated: 1,
    }, { x: 400, y: 570 }),

    node("check-result", "condition.expression", "Planner Succeeded?", {
      expression: "$ctx.getNodeOutput('materialize-tasks')?.success === true && ($ctx.getNodeOutput('materialize-tasks')?.createdCount || 0) > 0",
    }, { x: 400, y: 700 }),

    node("set-timestamp", "action.set_variable", "Update Last Run", {
      key: "_lastPlannerRun",
      value: "Date.now()",
      isExpression: true,
    }, { x: 200, y: 830 }),

    node("notify-done", "notify.telegram", "Notify Tasks Created", {
      message: "🗂️ Task planner created {{materialize-tasks.createdCount}} backlog tasks (skipped {{materialize-tasks.skippedCount}} duplicates).",
      silent: true,
    }, { x: 200, y: 960 }),

    node("notify-skip", "notify.log", "Log Dedup Skip", {
      message: "Task planner skipped: within dedup window",
      level: "info",
    }, { x: 650, y: 180 }),

    node("notify-fail", "notify.log", "Log Planner Failure", {
      message: "Task planner failed to materialize tasks from planner output",
      level: "warn",
    }, { x: 600, y: 830 }),
  ],
  edges: [
    edge("trigger", "check-dedup"),
    edge("check-dedup", "log-start", { condition: "$output?.result === true" }),
    edge("check-dedup", "notify-skip", { condition: "$output?.result !== true" }),
    edge("log-start", "run-planner"),
    edge("run-planner", "materialize-tasks"),
    edge("materialize-tasks", "check-result"),
    edge("check-result", "set-timestamp", { condition: "$output?.result === true" }),
    edge("check-result", "notify-fail", { condition: "$output?.result !== true" }),
    edge("set-timestamp", "notify-done"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["planner", "backlog", "automation"],
    replaces: {
      module: "monitor.mjs",
      functions: ["startTaskPlannerStatusLoop"],
      calledFrom: ["monitor.mjs:startProcess"],
      description: "Replaces the hardcoded task planner status loop. " +
        "Task counting, gap analysis, and replenishment are visual workflow steps.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Task Replenish (periodic/schedule-based)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const TASK_REPLENISH_TEMPLATE = {
  id: "template-task-replenish",
  name: "Task Replenish (Scheduled)",
  description:
    "Periodically checks backlog and replenishes tasks on a schedule. " +
    "This replaces the previous INTERNAL_EXECUTOR_REPLENISH_ENABLED env var " +
    "with a configurable visual workflow.",
  category: "planning",
  enabled: false,
  trigger: "trigger.schedule",
  variables: {
    intervalMs: 3600000,
    minTodoCount: 5,
    taskCount: 8,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Hourly Check", {
      intervalMs: 3600000,
    }, { x: 400, y: 50 }),

    node("check-backlog", "trigger.task_low", "Check Backlog Level", {
      threshold: 5,
    }, { x: 400, y: 180 }),

    node("needs-tasks", "condition.expression", "Needs Replenishment?", {
      expression: "$ctx.getNodeOutput('check-backlog')?.triggered === true",
    }, { x: 400, y: 310 }),

    node("run-planner", "agent.run_planner", "Generate Tasks", {
      taskCount: 8,
      context: "Scheduled replenishment run. Prioritize implementation tasks that build on recent PRs.",
    }, { x: 400, y: 440 }),

    node("materialize-tasks", "action.materialize_planner_tasks", "Create Tasks", {
      plannerNodeId: "run-planner",
      maxTasks: 8,
      status: "todo",
      dedup: true,
      failOnZero: true,
      minCreated: 1,
    }, { x: 400, y: 570 }),

    node("notify", "notify.telegram", "Notify", {
      message: "🔄 Scheduled replenishment created {{materialize-tasks.createdCount}} tasks (skipped {{materialize-tasks.skippedCount}}).",
      silent: true,
    }, { x: 400, y: 700 }),

    node("skip-log", "notify.log", "No Replenish Needed", {
      message: "Scheduled replenishment check: backlog sufficient, skipping",
    }, { x: 700, y: 310 }),
  ],
  edges: [
    edge("trigger", "check-backlog"),
    edge("check-backlog", "needs-tasks"),
    edge("needs-tasks", "run-planner", { condition: "$output?.result === true" }),
    edge("needs-tasks", "skip-log", { condition: "$output?.result !== true" }),
    edge("run-planner", "materialize-tasks"),
    edge("materialize-tasks", "notify"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["replenish", "schedule", "backlog"],
    replaces: {
      module: "monitor.mjs",
      functions: ["startTaskPlannerStatusLoop (scheduled variant)"],
      calledFrom: ["monitor.mjs:startProcess"],
      description: "Replaces the cron-based task replenishment loop in monitor. " +
        "Backlog scanning and planner execution become visual workflow steps.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Nightly Report
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const NIGHTLY_REPORT_TEMPLATE = {
  id: "template-nightly-report",
  name: "Nightly Report",
  description:
    "Generates a daily summary of agent activity: tasks completed, " +
    "PRs merged, errors encountered, and token usage. Sends to Telegram.",
  category: "planning",
  enabled: false,
  trigger: "trigger.schedule",
  variables: {
    reportHour: 23,
    reportTimezone: "UTC",
  },
  nodes: [
    node("trigger", "trigger.schedule", "Nightly at 11pm", {
      intervalMs: 86400000,
      cron: "0 23 * * *",
    }, { x: 400, y: 50 }),

    node("get-task-stats", "action.run_command", "Get Task Stats", {
      command: "bosun task stats --json",
      continueOnError: true,
    }, { x: 150, y: 200 }),

    node("get-pr-stats", "action.run_command", "Get PR Stats", {
      command: "gh pr list --state all --json number,state,mergedAt --limit 50",
      continueOnError: true,
    }, { x: 400, y: 200 }),

    node("get-agent-stats", "action.run_command", "Get Agent Stats", {
      command: "bosun agent stats --json 2>/dev/null || echo '{}'",
      continueOnError: true,
    }, { x: 650, y: 200 }),

    node("generate-report", "action.run_agent", "Generate Report", {
      prompt: `Generate a concise daily activity report from the following data.

## Task Stats
{{taskStats}}

## PR Activity
{{prStats}}

## Agent Activity
{{agentStats}}

Format as a Telegram-friendly message with emoji headers. Include:
- Tasks completed today vs yesterday
- PRs merged / opened / closed
- Agent success rate
- Notable errors or anomalies
- Recommendations for tomorrow`,
      timeoutMs: 300000,
    }, { x: 400, y: 380 }),

    node("send-report", "notify.telegram", "Send Report", {
      message: "📊 **Daily Bosun Report**\n\n{{reportOutput}}",
    }, { x: 400, y: 540 }),
  ],
  edges: [
    edge("trigger", "get-task-stats"),
    edge("trigger", "get-pr-stats"),
    edge("trigger", "get-agent-stats"),
    edge("get-task-stats", "generate-report"),
    edge("get-pr-stats", "generate-report"),
    edge("get-agent-stats", "generate-report"),
    edge("generate-report", "send-report"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["report", "daily", "telegram", "analytics"],
    replaces: {
      module: "telegram-sentinel.mjs",
      functions: ["dailyDigest", "sendStatusReport"],
      calledFrom: ["monitor.mjs:startSentinelBridge"],
      description: "Replaces ad-hoc Telegram status reporting with a scheduled " +
        "nightly report workflow. Stats gathering runs in parallel, then " +
        "an agent generates a formatted summary.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Sprint Retrospective
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const SPRINT_RETROSPECTIVE_TEMPLATE = {
  id: "template-sprint-retrospective",
  name: "Sprint Retrospective",
  description:
    "Weekly automated retrospective: gathers metrics on tasks completed, " +
    "PRs merged, agent success rates, and common failure patterns. " +
    "Generates improvement suggestions and creates action item tasks.",
  category: "planning",
  enabled: true,
  trigger: "trigger.schedule",
  variables: {
    lookbackDays: 7,
    createImprovementTasks: true,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Weekly Retro", {
      intervalMs: 604800000,
      cron: "0 9 * * 1",
    }, { x: 400, y: 50 }),

    node("task-metrics", "action.bosun_cli", "Gather Task Metrics", {
      command: "task list --format json --since {{lookbackDays}}d",
      continueOnError: true,
    }, { x: 200, y: 200 }),

    node("pr-metrics", "action.run_command", "Gather PR Metrics", {
      command: "gh pr list --state all --json number,title,state,createdAt,mergedAt,closedAt --limit 50",
      continueOnError: true,
    }, { x: 600, y: 200 }),

    node("error-analysis", "action.analyze_errors", "Analyze Error Patterns", {
      lookbackHours: "{{ lookbackDays * 24 }}",
      groupBy: "category",
    }, { x: 200, y: 350 }),

    node("agent-stats", "action.bosun_cli", "Agent Performance", {
      command: "status --json",
      continueOnError: true,
    }, { x: 600, y: 350 }),

    node("generate-retro", "action.run_agent", "Generate Retrospective", {
      prompt: `# Sprint Retrospective Analysis

Analyze the following data from the past {{lookbackDays}} days:

## Task Metrics
{{taskMetrics}}

## PR Metrics
{{prMetrics}}

## Error Patterns
{{errorAnalysis}}

## Agent Performance
{{agentStats}}

Generate a retrospective report with these sections:

### 📊 Key Metrics
- Tasks completed vs created
- Average task cycle time
- PR merge rate and average review time
- Agent success rate

### ✅ What Went Well
- Highlight successful patterns and wins

### ❌ What Didn't Go Well
- Identify bottlenecks and recurring issues

### 🎯 Action Items
For each improvement suggestion, output a line:
ACTION: [title] | [description]

Be specific and actionable. Limit to 3-5 improvement items.`,
      sdk: "auto",
      timeoutMs: 600000,
    }, { x: 400, y: 520 }),

    node("has-actions", "condition.expression", "Has Action Items?", {
      expression: "($ctx.getNodeOutput('generate-retro')?.output || '').includes('ACTION:')",
    }, { x: 400, y: 680, outputs: ["yes", "no"] }),

    node("create-tasks", "action.run_agent", "Create Improvement Tasks", {
      prompt: `# Create Improvement Tasks

From the retrospective output, extract all lines starting with ACTION:
and create a bosun task for each one.

Use the CLI: bosun task create --title "[title]" --description "[description]" --tag improvement --tag retro

Only create tasks if {{createImprovementTasks}} is true.`,
      sdk: "auto",
      timeoutMs: 300000,
    }, { x: 250, y: 830 }),

    node("send-report", "notify.telegram", "Send Retro Report", {
      message: "📋 **Weekly Retrospective** (past {{lookbackDays}} days)\n\n{{retroOutput}}",
    }, { x: 400, y: 980 }),

    node("log-no-actions", "notify.log", "No Actions Needed", {
      message: "Sprint retrospective complete — no action items generated",
      level: "info",
    }, { x: 600, y: 830 }),
  ],
  edges: [
    edge("trigger", "task-metrics"),
    edge("trigger", "pr-metrics"),
    edge("task-metrics", "error-analysis"),
    edge("pr-metrics", "agent-stats"),
    edge("error-analysis", "generate-retro"),
    edge("agent-stats", "generate-retro"),
    edge("generate-retro", "has-actions"),
    edge("has-actions", "create-tasks", { condition: "$output?.result === true", port: "yes" }),
    edge("has-actions", "log-no-actions", { condition: "$output?.result !== true", port: "no" }),
    edge("create-tasks", "send-report"),
    edge("log-no-actions", "send-report"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["planning", "retrospective", "metrics", "improvement", "weekly"],
    replaces: {
      module: "telegram-sentinel.mjs",
      functions: ["weeklyDigest"],
      calledFrom: ["monitor.mjs:scheduleWeeklyDigest"],
      description:
        "Replaces simple weekly digest with a comprehensive retrospective " +
        "workflow. Metrics gathering, AI analysis, action item creation, " +
        "and reporting are structured as workflow stages.",
    },
  },
};
