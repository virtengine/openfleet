/**
 * task-batch.mjs — Task Batch Processor Workflow Template
 *
 * Picks up multiple tasks from the kanban backlog and dispatches them in
 * parallel using the loop.for_each fan-out node. Each task lifecycle is
 * dispatched without blocking the batch run on full child completion.
 *
 * Templates:
 *   - TASK_BATCH_PROCESSOR_TEMPLATE (primary batch dispatch)
 *   - TASK_BATCH_PR_TEMPLATE (batch → agent → PR shortcut)
 *
 * DAG overview:
 *   trigger.task_available
 *     → condition.expression (is coordinator or solo?)
 *       → action.run_command (list todo tasks)
 *         → loop.for_each (fan-out, maxConcurrent dispatches at a time)
 *           → dispatch sub-workflow: template-task-lifecycle per task
 *         → action.set_variable (record batch results)
 *           → condition.expression (any failures?)
 *             → notify.telegram (failure alert)
 *             → notify.log (summary)
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Task Batch Processor — Parallel Task Dispatch
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const TASK_BATCH_PROCESSOR_TEMPLATE = {
  id: "template-task-batch-processor",
  name: "Task Batch Processor",
  description:
    "Monitors the task backlog and dispatches multiple tasks in parallel " +
    "using the Task Lifecycle sub-workflow. Automatically picks up tasks " +
    "when backlog drops below threshold, fans out execution across " +
    "available slots, and reports batch results.",
  category: "task-execution",
  enabled: true,
  core: true,
  recommended: true,
  trigger: "trigger.task_available",
  variables: {
    maxConcurrent: 3,
    pollStatus: "todo",
    maxBatchSize: 10,
    subWorkflow: "template-task-lifecycle",
    notifyChannel: "telegram",
  },
  nodes: [
    // ── Trigger: Tasks available for processing ──────────────────────────
    node("trigger", "trigger.task_available", "Tasks Available?", {
      maxParallel: "{{maxConcurrent}}",
      pollIntervalMs: 15000,
      status: "{{pollStatus}}",
    }, { x: 400, y: 50 }),

    // ── Gate: Fleet coordinator check (skip if not coordinator) ──────────
    node("check-coordinator", "condition.expression", "Is Coordinator?", {
      expression: "$data?.isCoordinator !== false",
    }, { x: 400, y: 180 }),

    // ── Query kanban for available tasks ─────────────────────────────────
    node("query-tasks", "action.run_command", "Query Task Backlog", {
      command: "node",
      args: ["-e", `
        const fs = require("node:fs");
        const path = require("node:path");
        const { pathToFileURL } = require("node:url");
        const cwd = process.cwd();
        const mirrorMarker = (path.sep + ".bosun" + path.sep + "workspaces" + path.sep).toLowerCase();
        let repoRoot = cwd;
        if (cwd.toLowerCase().includes(mirrorMarker)) {
          const sourceRepoRoot = path.resolve(cwd, "..", "..", "..", "..");
          if (fs.existsSync(path.join(sourceRepoRoot, "kanban", "kanban-adapter.mjs"))) repoRoot = sourceRepoRoot;
        }
        const kanbanModuleUrl = pathToFileURL(path.join(repoRoot, "kanban", "kanban-adapter.mjs")).href;
        import(kanbanModuleUrl)
          .then(k => k.listTasks(undefined, { status: "todo" }))
          .then(tasks => {
            const filtered = (tasks || []).filter((task) => task && task.status === "todo" && !task.draft);
            const batch = filtered.slice(0, parseInt(process.env.MAX_BATCH || "10"));
            console.log(JSON.stringify(batch.map(t => ({
              taskId: t.id,
              taskTitle: t.title || t.id,
              status: t.status,
              branch: t.branch || t.metadata?.branch || null,
              scope: t.scope || t.metadata?.scope || null,
              repository: typeof t?.repository === "string" ? t.repository.trim() : null,
              workspace: typeof t?.workspace === "string" ? t.workspace.trim() : null,
            }))));
          })
          .catch(e => { console.error(e.message); process.exit(1); });
      `],
      env: { MAX_BATCH: "{{maxBatchSize}}" },
      parseJson: true,
    }, { x: 400, y: 310 }),

    // ── Fan-out: dispatch each task to the lifecycle workflow ─────────────
    node("dispatch-tasks", "loop.for_each", "Dispatch Tasks", {
      items: "$ctx.getNodeOutput('query-tasks')?.output || []",
      itemVariable: "currentTask",
      indexVariable: "taskIndex",
      maxConcurrent: "{{maxConcurrent}}",
      workflowId: "{{subWorkflow}}",
      mode: "dispatch",
    }, { x: 400, y: 440 }),

    node("join-dispatch", "flow.join", "Join Dispatch Branches", {
      mode: "all",
      sourceNodeIds: ["dispatch-tasks"],
      includeSkipped: true,
    }, { x: 400, y: 505 }),

    // ── Record batch results ─────────────────────────────────────────────
    node("record-results", "action.set_variable", "Record Results", {
      key: "batchResult",
      value: "{{dispatch-tasks}}",
    }, { x: 400, y: 570 }),

    node("has-batch-failures", "condition.expression", "Any Batch Failures?", {
      expression: "Number($data?.batchResult?.failCount || 0) > 0",
    }, { x: 400, y: 700 }),

    node("notify-failures", "notify.telegram", "Batch Failure Alert", {
      channel: "{{notifyChannel}}",
      message: "Task batch needs attention: {{batchResult.failCount}} failed out of {{batchResult.totalItems}} ({{batchResult.successCount}} succeeded)",
    }, { x: 220, y: 830 }),

    node("log-summary", "notify.log", "Batch Summary", {
      message: "Task batch completed: {{batchResult.successCount}}/{{batchResult.totalItems}} succeeded ({{batchResult.failCount}} failed)",
      level: "info",
    }, { x: 580, y: 830 }),
  ],
  edges: [
    edge("trigger", "check-coordinator"),
    edge("check-coordinator", "query-tasks", { condition: "$output === true || $output?.result === true || $output?.value === true" }),
    edge("query-tasks", "dispatch-tasks"),
    edge("dispatch-tasks", "join-dispatch"),
    edge("join-dispatch", "record-results"),
    edge("record-results", "has-batch-failures"),
    edge("has-batch-failures", "notify-failures", { condition: "$output?.result === true" }),
    edge("has-batch-failures", "log-summary", { condition: "$output?.result !== true" }),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-03-15T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["task", "batch", "parallel", "dispatch", "lifecycle"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Task Batch → PR Shortcut — Pick tasks, run agent, create PRs
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const TASK_BATCH_PR_TEMPLATE = {
  id: "template-task-batch-pr",
  name: "Task Batch → PR",
  description:
    "Simplified batch processor that picks todo tasks, runs the agent on " +
    "each, and creates pull requests for any that produce commits. Ideal " +
    "for autonomous mode where tasks should flow straight to PRs.",
  category: "task-execution",
  enabled: true,
  recommended: false,
  trigger: "trigger.task_available",
  variables: {
    maxConcurrent: 2,
    pollStatus: "todo",
    maxBatchSize: 5,
    defaultBaseBranch: "main",
    draftPR: true,
  },
  nodes: [
    // ── Trigger ──────────────────────────────────────────────────────────
    node("trigger", "trigger.task_available", "Tasks Available?", {
      maxParallel: "{{maxConcurrent}}",
      pollIntervalMs: 15000,
      status: "{{pollStatus}}",
    }, { x: 400, y: 50 }),

    // ── Query for tasks ──────────────────────────────────────────────────
    node("query-tasks", "action.run_command", "List Todo Tasks", {
      command: "node",
      args: ["-e", `
        const fs = require("node:fs");
        const path = require("node:path");
        const { pathToFileURL } = require("node:url");
        const cwd = process.cwd();
        const mirrorMarker = (path.sep + ".bosun" + path.sep + "workspaces" + path.sep).toLowerCase();
        let repoRoot = cwd;
        if (cwd.toLowerCase().includes(mirrorMarker)) {
          const sourceRepoRoot = path.resolve(cwd, "..", "..", "..", "..");
          if (fs.existsSync(path.join(sourceRepoRoot, "kanban", "kanban-adapter.mjs"))) repoRoot = sourceRepoRoot;
        }
        const kanbanModuleUrl = pathToFileURL(path.join(repoRoot, "kanban", "kanban-adapter.mjs")).href;
        import(kanbanModuleUrl)
          .then(k => k.listTasks(undefined, { status: "todo" }))
          .then(tasks => {
            const filtered = (tasks || []).filter((task) => task && task.status === "todo" && !task.draft);
            const batch = filtered.slice(0, parseInt(process.env.MAX_BATCH || "5"));
            console.log(JSON.stringify(batch.map(t => ({
              taskId: t.id,
              taskTitle: t.title || t.id,
              branch: t.branch || t.metadata?.branch || null,
              repository: t.repository || null,
              workspace: t.workspace || null,
            }))));
          })
          .catch(e => { console.error(e.message); process.exit(1); });
      `],
      env: { MAX_BATCH: "{{maxBatchSize}}" },
      parseJson: true,
    }, { x: 400, y: 180 }),

    // ── Fan-out: per-task agent + PR ─────────────────────────────────────
    node("for-each-task", "loop.for_each", "Process Each Task", {
      items: "$ctx.getNodeOutput('query-tasks')?.output || []",
      variable: "task",
      indexVariable: "idx",
      maxConcurrent: "{{maxConcurrent}}",
    }, { x: 400, y: 310 }),

    // ── Per-task: set status to inprogress ───────────────────────────────
    node("set-inprogress", "action.update_task_status", "Mark In-Progress", {
      taskId: "{{task.taskId}}",
      status: "inprogress",
    }, { x: 400, y: 440 }),

    // ── Per-task: run agent ──────────────────────────────────────────────
    node("run-agent", "action.run_agent", "Run Agent", {
      taskId: "{{task.taskId}}",
      taskTitle: "{{task.taskTitle}}",
      branch: "{{task.branch}}",
    }, { x: 400, y: 570 }),

    // ── Per-task: detect commits ─────────────────────────────────────────
    node("detect-commits", "action.detect_new_commits", "Check Commits", {
      taskId: "{{task.taskId}}",
      worktreePath: "{{worktreePath}}",
      failOnError: false,
    }, { x: 400, y: 700 }),

    // ── Per-task: push + create PR ───────────────────────────────────────
    node("push-branch", "action.git_operations", "Push Branch", {
      operation: "push",
      cwd: "{{worktreePath}}",
    }, { x: 400, y: 830 }),

    node("create-pr", "action.create_pr", "Create PR", {
      title: "{{task.taskTitle}}",
      body: "Task-ID: {{task.taskId}}\n\nAutomated PR for task {{task.taskId}}",
      base: "{{defaultBaseBranch}}",
      branch: "{{task.branch}}",
      draft: "{{draftPR}}",
    }, { x: 400, y: 960 }),

    // ── Per-task: mark review ────────────────────────────────────────────
    node("set-inreview", "action.update_task_status", "Mark In-Review", {
      taskId: "{{task.taskId}}",
      status: "inreview",
    }, { x: 400, y: 1090 }),

    node("handoff-pr-progressor", "action.execute_workflow", "Dispatch PR Progressor", {
      workflowId: "template-bosun-pr-progressor",
      mode: "dispatch",
      input: {
        taskId: "{{task.taskId}}",
        taskTitle: "{{task.taskTitle}}",
        branch: "{{task.branch}}",
        baseBranch: "{{defaultBaseBranch}}",
        prNumber: "{{$ctx.getNodeOutput('create-pr')?.prNumber ?? null}}",
        prUrl: "{{$ctx.getNodeOutput('create-pr')?.prUrl || ''}}",
        repo: "{{$ctx.getNodeOutput('create-pr')?.repoSlug || $data?.repo || $data?.repoSlug || $data?.repository || ''}}",
      },
    }, { x: 400, y: 1160 }),

    node("join-batch-outcomes", "flow.join", "Join Batch Outcomes", {
      mode: "all",
      sourceNodeIds: ["detect-commits", "handoff-pr-progressor"],
      includeSkipped: true,
    }, { x: 400, y: 1230 }),

    // ── Batch complete notification ──────────────────────────────────────
    node("notify", "notify.log", "Batch Complete", {
      message: "Task batch PR pipeline complete",
      level: "info",
    }, { x: 400, y: 1220 }),
  ],
  edges: [
    edge("trigger", "query-tasks"),
    edge("query-tasks", "for-each-task"),
    edge("for-each-task", "set-inprogress"),
    edge("set-inprogress", "run-agent"),
    edge("run-agent", "detect-commits"),
    edge("detect-commits", "push-branch", { condition: "result.hasNewCommits === true" }),
    edge("push-branch", "create-pr"),
    edge("create-pr", "set-inreview"),
    edge("detect-commits", "join-batch-outcomes", { condition: "result.hasNewCommits !== true" }),
    edge("set-inreview", "handoff-pr-progressor"),
    edge("handoff-pr-progressor", "join-batch-outcomes"),
    edge("join-batch-outcomes", "notify"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-03-15T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["task", "batch", "pr", "agent", "autonomous"],
    requiredTemplates: ["template-bosun-pr-progressor"],
  },
};
