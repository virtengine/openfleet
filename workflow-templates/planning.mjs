/**
 * planning.mjs — Planning & reporting workflow templates.
 *
 * Templates:
 *   - Task Planner (recommended)
 *   - Task Replenish (Scheduled)
 *   - Nightly Report
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

    node("check-result", "condition.expression", "Planner Succeeded?", {
      expression: "$output?.run_planner?.success === true || $ctx.getNodeOutput('run-planner')?.success === true",
    }, { x: 400, y: 570 }),

    node("set-timestamp", "action.set_variable", "Update Last Run", {
      key: "_lastPlannerRun",
      value: "Date.now()",
      isExpression: true,
    }, { x: 200, y: 700 }),

    node("notify-done", "notify.telegram", "Notify Tasks Created", {
      message: "🗂️ Task planner generated new backlog tasks. Todo count was {{todoCount}}.",
      silent: true,
    }, { x: 200, y: 830 }),

    node("notify-skip", "notify.log", "Log Dedup Skip", {
      message: "Task planner skipped: within dedup window",
      level: "info",
    }, { x: 650, y: 180 }),

    node("notify-fail", "notify.log", "Log Planner Failure", {
      message: "Task planner failed to generate tasks",
      level: "warn",
    }, { x: 600, y: 700 }),
  ],
  edges: [
    edge("trigger", "check-dedup"),
    edge("check-dedup", "log-start", { condition: "$output?.result === true" }),
    edge("check-dedup", "notify-skip", { condition: "$output?.result !== true" }),
    edge("log-start", "run-planner"),
    edge("run-planner", "check-result"),
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

    node("notify", "notify.telegram", "Notify", {
      message: "🔄 Scheduled task replenishment complete.",
      silent: true,
    }, { x: 400, y: 570 }),

    node("skip-log", "notify.log", "No Replenish Needed", {
      message: "Scheduled replenishment check: backlog sufficient, skipping",
    }, { x: 700, y: 310 }),
  ],
  edges: [
    edge("trigger", "check-backlog"),
    edge("check-backlog", "needs-tasks"),
    edge("needs-tasks", "run-planner", { condition: "$output?.result === true" }),
    edge("needs-tasks", "skip-log", { condition: "$output?.result !== true" }),
    edge("run-planner", "notify"),
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
