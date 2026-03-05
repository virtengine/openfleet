/**
 * task-batch.mjs — Task Batch Processor Workflow Template
 *
 * Picks up multiple tasks from the kanban backlog and dispatches them in
 * parallel using the loop.for_each fan-out node. Each task is executed via
 * the Task Lifecycle sub-workflow (template-task-lifecycle).
 *
 * Templates:
 *   - TASK_BATCH_PROCESSOR_TEMPLATE (primary batch dispatch)
 *   - TASK_BATCH_PR_TEMPLATE (batch → agent → PR shortcut)
 *
 * DAG overview:
 *   trigger.task_low
 *     → condition.expression (is coordinator or solo?)
 *       → action.run_command (list todo tasks)
 *         → loop.for_each (fan-out, maxConcurrent tasks at a time)
 *           → sub-workflow: template-task-lifecycle per task
 *         → action.set_variable (record batch results)
 *           → notify.log (summary)
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
  category: "lifecycle",
  enabled: true,
  recommended: true,
  trigger: "trigger.task_low",
  variables: {
    backlogThreshold: 3,
    maxConcurrent: 3,
    pollStatus: "todo",
    maxBatchSize: 10,
    subWorkflow: "template-task-lifecycle",
    notifyChannel: "telegram",
  },
  nodes: [
    // ── Trigger: Backlog drops below threshold ───────────────────────────
    node("trigger", "trigger.task_low", "Backlog Low?", {
      threshold: "{{backlogThreshold}}",
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
        import("./kanban-adapter.mjs")
          .then(k => k.listTasks(undefined, { status: "todo" }))
          .then(tasks => {
            const batch = (tasks || []).slice(0, parseInt(process.env.MAX_BATCH || "10"));
            console.log(JSON.stringify(batch.map(t => ({
              taskId: t.id,
              taskTitle: t.title || t.id,
              status: t.status,
              branch: t.branch || t.metadata?.branch || null,
              scope: t.scope || t.metadata?.scope || null,
            }))));
          })
          .catch(e => { console.error(e.message); process.exit(1); });
      `],
      env: { MAX_BATCH: "{{maxBatchSize}}" },
      parseJson: true,
    }, { x: 400, y: 310 }),

    // ── Fan-out: dispatch each task to the lifecycle workflow ─────────────
    node("dispatch-tasks", "loop.for_each", "Dispatch Tasks", {
      items: "{{queryResult}}",
      itemVariable: "currentTask",
      indexVariable: "taskIndex",
      maxConcurrent: "{{maxConcurrent}}",
      workflowId: "{{subWorkflow}}",
    }, { x: 400, y: 440 }),

    node("join-dispatch", "flow.join", "Join Dispatch Branches", {
      mode: "all",
      sourceNodeIds: ["dispatch-tasks"],
      includeSkipped: true,
    }, { x: 400, y: 505 }),

    // ── Record batch results ─────────────────────────────────────────────
    node("record-results", "action.set_variable", "Record Results", {
      key: "batchResult",
      value: "{{dispatchResult}}",
    }, { x: 400, y: 570 }),

    // ── Notify on completion ─────────────────────────────────────────────
    node("notify-complete", "notify.telegram", "Batch Summary", {
      channel: "{{notifyChannel}}",
      message: "Task batch completed: {{batchResult.successCount}}/{{batchResult.totalItems}} succeeded",
    }, { x: 400, y: 700 }),
  ],
  edges: [
    edge("trigger", "check-coordinator"),
    edge("check-coordinator", "query-tasks", { condition: "result.result === true" }),
    edge("query-tasks", "dispatch-tasks"),
    edge("dispatch-tasks", "join-dispatch"),
    edge("join-dispatch", "record-results"),
    edge("record-results", "notify-complete"),
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
  category: "lifecycle",
  enabled: true,
  recommended: false,
  trigger: "trigger.task_low",
  variables: {
    backlogThreshold: 3,
    maxConcurrent: 2,
    pollStatus: "todo",
    maxBatchSize: 5,
    defaultBaseBranch: "main",
    draftPR: true,
    notifyChannel: "telegram",
  },
  nodes: [
    // ── Trigger ──────────────────────────────────────────────────────────
    node("trigger", "trigger.task_low", "Backlog Low?", {
      threshold: "{{backlogThreshold}}",
      status: "{{pollStatus}}",
    }, { x: 400, y: 50 }),

    // ── Query for tasks ──────────────────────────────────────────────────
    node("query-tasks", "action.run_command", "List Todo Tasks", {
      command: "node",
      args: ["-e", `
        import("./kanban-adapter.mjs")
          .then(k => k.listTasks(undefined, { status: "todo" }))
          .then(tasks => {
            const batch = (tasks || []).slice(0, parseInt(process.env.MAX_BATCH || "5"));
            console.log(JSON.stringify(batch.map(t => ({
              taskId: t.id,
              taskTitle: t.title || t.id,
              branch: t.branch || t.metadata?.branch || null,
            }))));
          })
          .catch(e => { console.error(e.message); process.exit(1); });
      `],
      env: { MAX_BATCH: "{{maxBatchSize}}" },
      parseJson: true,
    }, { x: 400, y: 180 }),

    // ── Fan-out: per-task agent + PR ─────────────────────────────────────
    node("for-each-task", "loop.for_each", "Process Each Task", {
      items: "{{queryResult}}",
      itemVariable: "task",
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
      body: "Automated PR for task {{task.taskId}}",
      base: "{{defaultBaseBranch}}",
      branch: "{{task.branch}}",
      draft: "{{draftPR}}",
    }, { x: 400, y: 960 }),

    // ── Per-task: mark review ────────────────────────────────────────────
    node("set-inreview", "action.update_task_status", "Mark In-Review", {
      taskId: "{{task.taskId}}",
      status: "inreview",
    }, { x: 400, y: 1090 }),

    node("join-batch-outcomes", "flow.join", "Join Batch Outcomes", {
      mode: "all",
      sourceNodeIds: ["detect-commits", "set-inreview"],
      includeSkipped: true,
    }, { x: 400, y: 1160 }),

    // ── Batch complete notification ──────────────────────────────────────
    node("notify", "notify.telegram", "Batch Complete", {
      channel: "{{notifyChannel}}",
      message: "Task batch PR pipeline complete",
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
    edge("set-inreview", "join-batch-outcomes"),
    edge("join-batch-outcomes", "notify"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-03-15T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["task", "batch", "pr", "agent", "autonomous"],
  },
};
