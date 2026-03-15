/**
 * task-lifecycle.mjs — Core Task Lifecycle Workflow Template
 *
 * This template replaces the monolithic TaskExecutor.executeTask() flow with
 * a composable DAG workflow. It is the centrepiece of the workflow-first
 * architecture: every step from task polling through PR creation runs as a
 * workflow node.
 *
 * Templates:
 *   - Task Lifecycle (full task execution pipeline)
 *   - VE Orchestrator Lite (simplified task lifecycle for ve-orchestrator)
 *
 * DAG overview (full):
 *   trigger.task_available
 *     → condition.slot_available
 *       → action.allocate_slot
 *         → action.claim_task
 *           → [claim OK?]
 *             YES → action.update_task_status (→ inprogress)
 *               → action.acquire_worktree
 *                 → [worktree OK?]
 *                   YES → action.resolve_executor
 *                     → record HEAD
 *                     → action.build_task_prompt
 *                       → action.run_agent
 *                         → [claim stolen?]
 *                           NO → action.detect_new_commits
 *                             → [has commits?]
 *                               YES → action.push_branch → action.create_pr
 *                                     → set inreview
 *                               NO  → set todo (cooldown)
 *                           YES → log & set todo
 *                         → release-worktree → release-claim → release-slot
 *                   NO  → release-claim → set todo → release-slot → notify
 *             NO → release-slot → log skipped
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Task Lifecycle — Full Task Execution Pipeline
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const TASK_LIFECYCLE_TEMPLATE = {
  id: "template-task-lifecycle",
  name: "Task Lifecycle",
  description:
    "Complete task execution pipeline: poll for tasks → claim → worktree → " +
    "agent dispatch → commit detection → PR creation → status transition. " +
    "Replaces the monolithic TaskExecutor.executeTask() method with a " +
    "composable workflow DAG.",
  category: "task-execution",
  enabled: true,
  core: true,
  recommended: true,
  trigger: "trigger.task_available",
  variables: {
    maxParallel: 3,
    baseBranchLimit: 0,
    pollIntervalMs: 30000,
    claimTtlMinutes: 180,
    claimRenewIntervalMs: 60000,
    defaultSdk: "auto",
    defaultTargetBranch: "origin/main",
    taskTimeoutMs: 21600000, // 6 hours
    prePrValidationEnabled: true,
    prePrValidationCommand: "npm run prepush:check",
    autoMergeOnCreate: false,
    autoMergeMethod: "squash",
    maxRetries: 2,
    maxContinues: 3,
    protectedBranches: ["main", "master", "develop", "production"],
  },
  nodes: [
    // ── Trigger: Poll for available tasks ────────────────────────────────
    node("trigger", "trigger.task_available", "Poll for Tasks", {
      maxParallel: "{{maxParallel}}",
      pollIntervalMs: "{{pollIntervalMs}}",
      status: "todo",
      filterCodexScoped: true,
      filterDrafts: true,
    }, { x: 400, y: 50 }),

    // ── Gate: Check slot availability ────────────────────────────────────
    node("check-slots", "condition.slot_available", "Slots Available?", {
      maxParallel: "{{maxParallel}}",
      baseBranchLimit: "{{baseBranchLimit}}",
      baseBranch: "{{defaultTargetBranch}}",
    }, { x: 400, y: 180 }),

    // ── Allocate execution slot (no sdk/model yet — resolved later) ─────
    node("allocate-slot", "action.allocate_slot", "Allocate Slot", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      branch: "{{branch}}",
      baseBranch: "{{baseBranch}}",
    }, { x: 400, y: 310 }),

    // ── Claim task (with auto-renewal) ───────────────────────────────────
    node("claim-task", "action.claim_task", "Claim Task", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      ttlMinutes: "{{claimTtlMinutes}}",
      renewIntervalMs: "{{claimRenewIntervalMs}}",
      branch: "{{branch}}",
    }, { x: 400, y: 440 }),

    // ── Check claim result ───────────────────────────────────────────────
    node("claim-ok", "condition.expression", "Claim Succeeded?", {
      expression: "$ctx.getNodeOutput('claim-task')?.success === true",
    }, { x: 400, y: 570, outputs: ["yes", "no"] }),

    // ── Set status → inprogress ──────────────────────────────────────────
    node("set-inprogress", "action.update_task_status", "Set In-Progress", {
      taskId: "{{taskId}}",
      status: "inprogress",
      taskTitle: "{{taskTitle}}",
    }, { x: 300, y: 700 }),

    // ── Acquire worktree ─────────────────────────────────────────────────
    node("acquire-worktree", "action.acquire_worktree", "Acquire Worktree", {
      repoRoot: "{{repoRoot}}",
      branch: "{{branch}}",
      taskId: "{{taskId}}",
      baseBranch: "{{baseBranch}}",
      defaultTargetBranch: "{{defaultTargetBranch}}",
    }, { x: 300, y: 830 }),

    // ── Check worktree result ────────────────────────────────────────────
    node("worktree-ok", "condition.expression", "Worktree OK?", {
      expression: "$ctx.getNodeOutput('acquire-worktree')?.success === true",
    }, { x: 300, y: 960, outputs: ["yes", "no"] }),

    // ── Resolve executor (SDK + model) — AFTER worktree, BEFORE prompt ──
    node("resolve-executor", "action.resolve_executor", "Resolve Executor", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      taskDescription: "{{taskDescription}}",
      repoRoot: "{{repoRoot}}",
      workspace: "{{workspace}}",
      defaultSdk: "{{defaultSdk}}",
    }, { x: 200, y: 1090 }),

    // ── Record pre-execution HEAD ────────────────────────────────────────
    node("record-head", "action.run_command", "Record HEAD", {
      command: "git rev-parse HEAD",
      cwd: "{{worktreePath}}",
    }, { x: 200, y: 1220 }),

    // ── Optional per-project WORKFLOW.md contract ───────────────────────
    node("read-workflow-contract", "read-workflow-contract", "Read WORKFLOW.md", {
      repoRoot: "{{repoRoot}}",
      worktreePath: "{{worktreePath}}",
    }, { x: 200, y: 1350 }),

    node("workflow-contract-validation", "workflow-contract-validation", "Validate WORKFLOW.md", {
      repoRoot: "{{repoRoot}}",
      worktreePath: "{{worktreePath}}",
    }, { x: 200, y: 1480 }),

    // ── Build agent prompt ───────────────────────────────────────────────
    node("build-prompt", "action.build_task_prompt", "Build Prompt", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      taskDescription: "{{taskDescription}}",
      branch: "{{branch}}",
      baseBranch: "{{baseBranch}}",
      worktreePath: "{{worktreePath}}",
      repoRoot: "{{repoRoot}}",
      repoSlug: "{{repoSlug}}",
      workspace: "{{workspace}}",
      repository: "{{repository}}",
      repositories: "{{repositories}}",
    }, { x: 200, y: 1610 }),
    // ── Execute agent (phase 1: planning) ───────────────────────────────
    node("run-agent-plan", "action.run_agent", "Agent Plan", {
      prompt: "{{_taskPrompt}}\n\nExecution phase: planning. Produce a concrete implementation plan and identify required tests. Do not make code changes in this phase.",
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      failOnError: false,
    }, { x: 200, y: 1740 }),

    // ── Execute agent (phase 2: tests-first) ────────────────────────────
    node("run-agent-tests", "action.run_agent", "Agent Tests", {
      prompt: "{{_taskPrompt}}\n\nExecution phase: tests. Write or update tests first for the target behavior, then validate failures/pass criteria before implementation changes.",
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      failOnError: false,
    }, { x: 200, y: 1545 }),

    // ── Execute agent (phase 3: implementation + verification) ──────────
    node("run-agent-implement", "action.run_agent", "Agent Implement", {
      prompt: "{{_taskPrompt}}\n\nExecution phase: implementation. Complete implementation after tests exist, run required verification (tests/lint/build), then commit, push, and create/update PR.",
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      failOnError: false,
    }, { x: 200, y: 1610 }),

    // ── Check if claim was stolen during agent execution ─────────────────
    node("claim-stolen", "condition.expression", "Claim Stolen?", {
      expression: "$data._claimStolen === true",
    }, { x: 200, y: 1610, outputs: ["yes", "no"] }),

    // ── Detect new commits ───────────────────────────────────────────────
    node("detect-commits", "action.detect_new_commits", "Detect Commits", {
      worktreePath: "{{worktreePath}}",
      baseBranch: "{{baseBranch}}",
    }, { x: 120, y: 1740 }),

    // ── Branch: has new commits? ─────────────────────────────────────────
    node("has-commits", "condition.expression", "Has Commits?", {
      expression: "$ctx.getNodeOutput('detect-commits')?.hasCommits === true",
    }, { x: 120, y: 1870, outputs: ["yes", "no"] }),

    // ── SUCCESS PATH: Local quality gate before push/PR ──────────────────
    node("pre-pr-validation", "action.run_command", "Pre-PR Validation", {
      command: "{{prePrValidationCommand}}",
      cwd: "{{worktreePath}}",
      failOnError: false,
    }, { x: -120, y: 1940 }),

    node("pre-pr-validation-ok", "condition.expression", "Validation Passed?", {
      expression:
        "(() => {" +
        "const enabled = $data?.prePrValidationEnabled !== false;" +
        "if (!enabled) return true;" +
        "const out = $ctx.getNodeOutput('pre-pr-validation');" +
        "if (!out) return false;" +
        "if (out.success === true) return true;" +
        "const code = Number(out.exitCode);" +
        "return Number.isFinite(code) && code === 0;" +
        "})()",
    }, { x: -120, y: 2060, outputs: ["yes", "no"] }),

    node("log-validation-failed", "notify.log", "Log Validation Failed", {
      message: "Task \"{{taskTitle}}\" ({{taskId}}) — pre-PR validation failed, returning to todo",
      level: "warn",
    }, { x: 300, y: 2000 }),

    node("set-todo-validation-failed", "action.update_task_status", "Set Todo (Validation Fail)", {
      taskId: "{{taskId}}",
      status: "todo",
      taskTitle: "{{taskTitle}}",
    }, { x: 300, y: 2130 }),
    // ── SUCCESS PATH: Push branch (with rebase + empty-diff guard) ───────
    node("push-branch", "action.push_branch", "Push Branch", {
      worktreePath: "{{worktreePath}}",
      branch: "{{branch}}",
      baseBranch: "{{baseBranch}}",
      rebaseBeforePush: true,
      skipHooks: true,
      emptyDiffGuard: true,
      protectedBranches: "{{protectedBranches}}",
    }, { x: 0, y: 2000 }),

    // ── SUCCESS PATH: Check push result ──────────────────────────────────
    node("push-ok", "condition.expression", "Push OK?", {
      expression: "$ctx.getNodeOutput('push-branch')?.pushed === true",
    }, { x: 0, y: 2130, outputs: ["yes", "no"] }),

    // ── SUCCESS PATH: Create PR ──────────────────────────────────────────
    node("create-pr", "action.create_pr", "Create PR", {
      title: "{{taskTitle}}",
      body: "Task-ID: {{taskId}}\n\nAutomated PR for task {{taskId}}",
      base: "{{baseBranch}}",
      branch: "{{branch}}",
      cwd: "{{worktreePath}}",
      enableAutoMerge: "{{autoMergeOnCreate}}",
      autoMergeMethod: "{{autoMergeMethod}}",
    }, { x: 0, y: 2260 }),

    node("pr-created", "condition.expression", "PR Linked?", {
      expression: "Boolean($ctx.getNodeOutput('create-pr')?.success === true && ($ctx.getNodeOutput('create-pr')?.prNumber || $ctx.getNodeOutput('create-pr')?.prUrl))",
    }, { x: 0, y: 2325, outputs: ["yes", "no"] }),

    // ── SUCCESS PATH: Set status → inreview ──────────────────────────────
    node("set-inreview", "action.update_task_status", "Set In-Review", {
      taskId: "{{taskId}}",
      status: "inreview",
      taskTitle: "{{taskTitle}}",
    }, { x: 0, y: 2390 }),

    node("handoff-pr-progressor", "action.execute_workflow", "Handoff PR Progressor", {
      workflowId: "template-bosun-pr-progressor",
      mode: "dispatch",
      input: {
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
        prNumber: "{{$ctx.getNodeOutput('create-pr')?.prNumber ?? $data?.prNumber ?? null}}",
        prUrl: "{{$ctx.getNodeOutput('create-pr')?.prUrl || $data?.prUrl || ''}}",
        repo: "{{$ctx.getNodeOutput('create-pr')?.repoSlug || $data?.repo || $data?.repoSlug || $data?.repository || ''}}",
      },
    }, { x: -120, y: 2520 }),

    // ── SUCCESS PATH: Log success ────────────────────────────────────────
    node("log-success", "notify.log", "Log Success", {
      message: "Task \"{{taskTitle}}\" ({{taskId}}) completed — PR created",
      level: "info",
    }, { x: -120, y: 2650 }),

    // ── NO COMMITS PATH: Log no-commit ───────────────────────────────────
    node("log-no-commits", "notify.log", "Log No Commits", {
      message: "Task \"{{taskTitle}}\" ({{taskId}}) — no new commits, returning to todo",
      level: "warn",
    }, { x: 350, y: 2000 }),

    // ── NO COMMITS PATH: Set status → todo (cooldown) ────────────────────
    node("set-todo-cooldown", "action.update_task_status", "Set Todo (Cooldown)", {
      taskId: "{{taskId}}",
      status: "todo",
      taskTitle: "{{taskTitle}}",
    }, { x: 350, y: 2130 }),

    // ── PUSH FAILED PATH: Set status → todo ──────────────────────────────
    node("set-todo-push-failed", "action.update_task_status", "Set Todo (Push Fail)", {
      taskId: "{{taskId}}",
      status: "todo",
      taskTitle: "{{taskTitle}}",
    }, { x: 180, y: 2260 }),

    // ── CLAIM STOLEN PATH: Log ───────────────────────────────────────────
    node("create-pr-retry", "action.create_pr", "Recover PR Link", {
      title: "{{taskTitle}}",
      body: "Task-ID: {{taskId}}\n\nAutomated PR for task {{taskId}}",
      base: "{{baseBranch}}",
      branch: "{{branch}}",
      cwd: "{{worktreePath}}",
      failOnError: false,
      enableAutoMerge: "{{autoMergeOnCreate}}",
      autoMergeMethod: "{{autoMergeMethod}}",
    }, { x: 400, y: 1740 }),

    node("pr-created-stolen", "condition.expression", "PR Linked After Claim Loss?", {
      expression: "Boolean($ctx.getNodeOutput('create-pr-retry')?.success === true && ($ctx.getNodeOutput('create-pr-retry')?.prNumber || $ctx.getNodeOutput('create-pr-retry')?.prUrl))",
    }, { x: 400, y: 1870, outputs: ["yes", "no"] }),

    node("set-inreview-stolen", "action.update_task_status", "Set In-Review (Recovered)", {
      taskId: "{{taskId}}",
      status: "inreview",
      taskTitle: "{{taskTitle}}",
    }, { x: 250, y: 2000 }),

    node("handoff-pr-progressor-stolen", "action.execute_workflow", "Handoff PR Progressor (Recovered)", {
      workflowId: "template-bosun-pr-progressor",
      mode: "dispatch",
      input: {
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
        prNumber: "{{$ctx.getNodeOutput('create-pr-retry')?.prNumber ?? $data?.prNumber ?? null}}",
        prUrl: "{{$ctx.getNodeOutput('create-pr-retry')?.prUrl || $data?.prUrl || ''}}",
        repo: "{{$ctx.getNodeOutput('create-pr-retry')?.repoSlug || $data?.repo || $data?.repoSlug || $data?.repository || ''}}",
      },
    }, { x: 120, y: 2130 }),

    node("log-claim-stolen-recovered", "notify.log", "Log Claim Loss Recovery", {
      message: "Task \"{{taskTitle}}\" ({{taskId}}) — claim lost after PR link recovery, keeping inreview",
      level: "warn",
    }, { x: 120, y: 2260 }),

    node("log-claim-stolen", "notify.log", "Log Claim Stolen", {
      message: "Task \"{{taskTitle}}\" ({{taskId}}) — claim was stolen, aborting",
      level: "warn",
    }, { x: 550, y: 2000 }),

    // ── CLAIM STOLEN PATH: Set todo ──────────────────────────────────────
    node("set-todo-stolen", "action.update_task_status", "Set Todo (Stolen)", {
      taskId: "{{taskId}}",
      status: "todo",
      taskTitle: "{{taskTitle}}",
    }, { x: 550, y: 2130 }),

    node("join-outcomes", "flow.join", "Join Outcome Paths", {
      mode: "all",
      sourceNodeIds: ["log-success", "set-todo-push-failed", "set-todo-cooldown", "set-todo-validation-failed", "set-todo-stolen", "log-claim-stolen-recovered"],
      includeSkipped: true,
    }, { x: 200, y: 2560 }),

    // ── CLEANUP: Release worktree (all paths converge) ───────────────────
    node("release-worktree", "action.release_worktree", "Release Worktree", {
      worktreePath: "{{worktreePath}}",
      repoRoot: "{{repoRoot}}",
      taskId: "{{taskId}}",
    }, { x: 200, y: 2700 }),

    // ── CLEANUP: Release claim ───────────────────────────────────────────
    node("release-claim", "action.release_claim", "Release Claim", {
      taskId: "{{taskId}}",
    }, { x: 200, y: 2830 }),

    // ── CLEANUP: Release slot ────────────────────────────────────────────
    node("release-slot", "action.release_slot", "Release Slot", {
      taskId: "{{taskId}}",
    }, { x: 200, y: 2960 }),

    // ── FAILURE: Claim failed — release slot and skip ────────────────────
    node("release-slot-claim-failed", "action.release_slot", "Release Slot (Claim Fail)", {
      taskId: "{{taskId}}",
    }, { x: 650, y: 700 }),

    node("log-claim-failed", "notify.log", "Log Claim Failed", {
      message: "Task \"{{taskTitle}}\" ({{taskId}}) — already claimed, skipping",
      level: "info",
    }, { x: 650, y: 830 }),

    // ── FAILURE: Worktree failed — release claim, slot ───────────────────
    node("release-claim-wt-failed", "action.release_claim", "Release Claim (WT Fail)", {
      taskId: "{{taskId}}",
    }, { x: 600, y: 1090 }),

    node("wt-failure-blocking", "condition.expression", "Non-Retryable WT Failure?", {
      expression: "$ctx.getNodeOutput('acquire-worktree')?.retryable === false",
    }, { x: 600, y: 1220, outputs: ["yes", "no"] }),

    node("set-blocked-wt-failed", "action.update_task_status", "Set Blocked (WT Fail)", {
      taskId: "{{taskId}}",
      status: "blocked",
      taskTitle: "{{taskTitle}}",
    }, { x: 470, y: 1350 }),
    
    node("annotate-blocked-wt-failed", "action.bosun_function", "Annotate Blocked (WT Fail)", {
      function: "tasks.update",
      args: {
        taskId: "{{taskId}}",
        fields: {
          cooldownUntil: "{{acquire-worktree.retryAt}}",
          blockedReason: "{{acquire-worktree.blockedReason}}",
          meta: "{{(() => { const current = ($data.taskMeta && typeof $data.taskMeta === 'object') ? $data.taskMeta : {}; const output = $ctx.getNodeOutput('acquire-worktree') || {}; return { ...current, autoRecovery: { active: true, reason: 'worktree_failure', failureKind: output.failureKind || 'branch_refresh_conflict', retryAt: output.retryAt || null, recoveryDelayMs: output.autoRecoverDelayMs || null, error: output.error || '', recordedAt: output.recordedAt || null }, worktreeFailure: { failureKind: output.failureKind || 'branch_refresh_conflict', retryable: output.retryable !== false, retryAt: output.retryAt || null, blockedReason: output.blockedReason || '', error: output.error || '', recordedAt: output.recordedAt || null } }; })()}}",
        },
      },
    }, { x: 470, y: 1480 }),

    node("set-todo-wt-failed", "action.update_task_status", "Set Todo (WT Fail)", {
      taskId: "{{taskId}}",
      status: "todo",
      taskTitle: "{{taskTitle}}",
    }, { x: 730, y: 1350 }),

    node("release-slot-wt-failed", "action.release_slot", "Release Slot (WT Fail)", {
      taskId: "{{taskId}}",
    }, { x: 600, y: 1480 }),

    node("notify-wt-failed", "notify.telegram", "Notify WT Failed", {
      message: "⚠️ Worktree failed for \"{{taskTitle}}\" ({{taskId}}){{acquire-worktree.recoveryNote}}",
    }, { x: 600, y: 1740 }),
  ],
  edges: [
    // Main flow
    edge("trigger", "check-slots"),
    edge("check-slots", "allocate-slot", { condition: "$output?.result === true" }),
    edge("allocate-slot", "claim-task"),
    edge("claim-task", "claim-ok"),
    edge("claim-ok", "set-inprogress", { condition: "$output?.result === true", port: "yes" }),
    edge("set-inprogress", "acquire-worktree"),
    edge("acquire-worktree", "worktree-ok"),
    edge("worktree-ok", "resolve-executor", { condition: "$output?.result === true", port: "yes" }),
    edge("resolve-executor", "record-head"),
    edge("record-head", "read-workflow-contract"),
    edge("read-workflow-contract", "workflow-contract-validation"),
    edge("workflow-contract-validation", "build-prompt"),
    edge("build-prompt", "run-agent-plan"),
    edge("run-agent-plan", "run-agent-tests"),
    edge("run-agent-tests", "run-agent-implement"),
    edge("run-agent-implement", "claim-stolen"),

    // Post-agent: check claim
    edge("claim-stolen", "detect-commits", { condition: "$output?.result !== true", port: "no" }),
    edge("detect-commits", "has-commits"),

    // Success path (has commits)
    edge("has-commits", "pre-pr-validation", { condition: "$output?.result === true", port: "yes" }),
    edge("pre-pr-validation", "pre-pr-validation-ok"),
    edge("pre-pr-validation-ok", "push-branch", { condition: "$output?.result === true", port: "yes" }),
    edge("pre-pr-validation-ok", "log-validation-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("log-validation-failed", "set-todo-validation-failed"),
    edge("set-todo-validation-failed", "join-outcomes"),
    edge("push-branch", "push-ok"),
    edge("push-ok", "create-pr", { condition: "$output?.result === true", port: "yes" }),
    edge("create-pr", "pr-created"),
    edge("pr-created", "set-inreview", { condition: "$output?.result === true", port: "yes" }),
    edge("pr-created", "set-todo-push-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("set-inreview", "handoff-pr-progressor"),
    edge("handoff-pr-progressor", "log-success"),
    edge("log-success", "join-outcomes"),

    // Push failed path
    edge("push-ok", "set-todo-push-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("set-todo-push-failed", "join-outcomes"),

    // No-commits path
    edge("has-commits", "log-no-commits", { condition: "$output?.result !== true", port: "no" }),
    edge("log-no-commits", "set-todo-cooldown"),
    edge("set-todo-cooldown", "join-outcomes"),

    // Claim stolen path
    edge("claim-stolen", "create-pr-retry", { condition: "$output?.result === true", port: "yes" }),
    edge("create-pr-retry", "pr-created-stolen"),
    edge("pr-created-stolen", "set-inreview-stolen", { condition: "$output?.result === true", port: "yes" }),
    edge("set-inreview-stolen", "handoff-pr-progressor-stolen"),
    edge("handoff-pr-progressor-stolen", "log-claim-stolen-recovered"),
    edge("log-claim-stolen-recovered", "join-outcomes"),
    edge("pr-created-stolen", "log-claim-stolen", { condition: "$output?.result !== true", port: "no" }),
    edge("log-claim-stolen", "set-todo-stolen"),
    edge("set-todo-stolen", "join-outcomes"),

    // Shared cleanup (all outcome paths converge here)
    edge("join-outcomes", "release-worktree"),
    edge("release-worktree", "release-claim"),
    edge("release-claim", "release-slot"),

    // Claim failed path
    edge("claim-ok", "release-slot-claim-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("release-slot-claim-failed", "log-claim-failed"),

    // Worktree failed path
    edge("worktree-ok", "release-claim-wt-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("release-claim-wt-failed", "wt-failure-blocking"),
    edge("wt-failure-blocking", "set-blocked-wt-failed", { condition: "$output?.result === true", port: "yes" }),
    edge("wt-failure-blocking", "set-todo-wt-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("set-blocked-wt-failed", "annotate-blocked-wt-failed"),
    edge("annotate-blocked-wt-failed", "release-slot-wt-failed"),
    edge("set-todo-wt-failed", "release-slot-wt-failed"),
    edge("release-slot-wt-failed", "notify-wt-failed"),
  ],
  metadata: {
    author: "bosun",
    version: 2,
    createdAt: "2026-03-01T00:00:00Z",
    templateVersion: "2.0.0",
    tags: ["task", "lifecycle", "executor", "workflow-first", "core"],
    requiredTemplates: ["template-bosun-pr-progressor"],
    replaces: {
      module: "task-executor.mjs",
      functions: [
        "executeTask",
        "_pollLoop",
        "_handleTaskResult",
        "_buildTaskPrompt",
        "_processBacklogReplenishment",
      ],
      calledFrom: ["monitor.mjs:startProcess", "monitor.mjs:runMonitorMonitorCycle"],
      description:
        "Replaces the entire TaskExecutor.executeTask() monolith with a " +
        "composable DAG workflow. Each step (claim, worktree, agent, PR) " +
        "is an independent workflow node with explicit success/failure branches.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  VE Orchestrator Lite — Simplified Task Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const VE_ORCHESTRATOR_LITE_TEMPLATE = {
  id: "template-ve-orchestrator-lite",
  name: "VE Orchestrator Lite",
  description:
    "Simplified task lifecycle for lightweight deployments. Same core " +
    "flow as the full Task Lifecycle (slot → claim → worktree → agent → " +
    "push → PR) but with fewer failure branches and no anti-thrash.",
  category: "task-execution",
  enabled: true,
  recommended: false,
  trigger: "trigger.task_available",
  variables: {
    maxParallel: 2,
    pollIntervalMs: 30000,
    defaultSdk: "auto",
    defaultTargetBranch: "origin/main",
    taskTimeoutMs: 21600000,
    maxRetries: 1,
    protectedBranches: ["main", "master", "develop", "production"],
  },
  nodes: [
    // ── Trigger ──────────────────────────────────────────────────────────
    node("trigger", "trigger.task_available", "Poll Tasks", {
      maxParallel: "{{maxParallel}}",
      pollIntervalMs: "{{pollIntervalMs}}",
      status: "todo",
    }, { x: 400, y: 50 }),

    // ── Slot check ───────────────────────────────────────────────────────
    node("check-slots", "condition.slot_available", "Slots?", {
      maxParallel: "{{maxParallel}}",
    }, { x: 400, y: 180 }),

    // ── Allocate slot ────────────────────────────────────────────────────
    node("allocate-slot", "action.allocate_slot", "Allocate Slot", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      branch: "{{branch}}",
      baseBranch: "{{defaultTargetBranch}}",
    }, { x: 400, y: 310 }),

    // ── Claim ────────────────────────────────────────────────────────────
    node("claim", "action.claim_task", "Claim Task", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
    }, { x: 400, y: 440 }),

    // ── Claim check ──────────────────────────────────────────────────────
    node("claim-check", "condition.expression", "Claimed?", {
      expression: "$ctx.getNodeOutput('claim')?.success === true",
    }, { x: 400, y: 570, outputs: ["yes", "no"] }),

    // ── Set inprogress ───────────────────────────────────────────────────
    node("set-inprogress", "action.update_task_status", "In-Progress", {
      taskId: "{{taskId}}",
      status: "inprogress",
    }, { x: 300, y: 700 }),

    // ── Acquire worktree ─────────────────────────────────────────────────
    node("acquire-worktree", "action.acquire_worktree", "Worktree", {
      repoRoot: "{{repoRoot}}",
      branch: "{{branch}}",
      taskId: "{{taskId}}",
      baseBranch: "{{defaultTargetBranch}}",
    }, { x: 300, y: 830 }),

    // ── Resolve executor ─────────────────────────────────────────────────
    node("resolve", "action.resolve_executor", "Resolve SDK", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      taskDescription: "{{taskDescription}}",
      repoRoot: "{{repoRoot}}",
      workspace: "{{workspace}}",
      defaultSdk: "{{defaultSdk}}",
    }, { x: 300, y: 960 }),

    // ── Record HEAD ──────────────────────────────────────────────────────
    node("record-head", "action.run_command", "Record HEAD", {
      command: "git rev-parse HEAD",
      cwd: "{{worktreePath}}",
    }, { x: 300, y: 1090 }),

    node("read-workflow-contract", "read-workflow-contract", "Read WORKFLOW.md", {
      repoRoot: "{{repoRoot}}",
      worktreePath: "{{worktreePath}}",
    }, { x: 300, y: 1220 }),

    node("workflow-contract-validation", "workflow-contract-validation", "Validate WORKFLOW.md", {
      repoRoot: "{{repoRoot}}",
      worktreePath: "{{worktreePath}}",
    }, { x: 300, y: 1350 }),

    // ── Build prompt ─────────────────────────────────────────────────────
    node("prompt", "action.build_task_prompt", "Build Prompt", {
      taskTitle: "{{taskTitle}}",
      taskDescription: "{{taskDescription}}",
      worktreePath: "{{worktreePath}}",
      repoRoot: "{{repoRoot}}",
      workspace: "{{workspace}}",
      repository: "{{repository}}",
      repositories: "{{repositories}}",
    }, { x: 300, y: 1480 }),

    // ── Run agent ────────────────────────────────────────────────────────
    node("agent", "action.run_agent", "Run Agent", {
      prompt: "{{_taskPrompt}}",
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      failOnError: false,
    }, { x: 300, y: 1610 }),

    // ── Detect commits ───────────────────────────────────────────────────
    node("commits", "action.detect_new_commits", "Check Commits", {
      worktreePath: "{{worktreePath}}",
      baseBranch: "{{defaultTargetBranch}}",
    }, { x: 300, y: 1480 }),

    // ── Has commits? ─────────────────────────────────────────────────────
    node("has-commits", "condition.expression", "Commits?", {
      expression: "$ctx.getNodeOutput('commits')?.hasCommits === true",
    }, { x: 300, y: 1610, outputs: ["yes", "no"] }),

    // ── Push branch ──────────────────────────────────────────────────────
    node("push", "action.push_branch", "Push", {
      worktreePath: "{{worktreePath}}",
      branch: "{{branch}}",
      baseBranch: "{{defaultTargetBranch}}",
      protectedBranches: "{{protectedBranches}}",
    }, { x: 180, y: 1740 }),

    // ── PR creation ──────────────────────────────────────────────────────
    node("pr", "action.create_pr", "Create PR", {
      title: "{{taskTitle}}",
      body: "Task-ID: {{taskId}}\n\nAutomated PR for task {{taskId}}",
      base: "{{defaultTargetBranch}}",
      branch: "{{branch}}",
      cwd: "{{worktreePath}}",
    }, { x: 180, y: 1870 }),

    node("pr-created", "condition.expression", "PR Linked?", {
      expression: "Boolean($ctx.getNodeOutput('pr')?.success === true && ($ctx.getNodeOutput('pr')?.prNumber || $ctx.getNodeOutput('pr')?.prUrl))",
    }, { x: 180, y: 1935, outputs: ["yes", "no"] }),

    // ── Set inreview ─────────────────────────────────────────────────────
    node("set-inreview", "action.update_task_status", "In-Review", {
      taskId: "{{taskId}}",
      status: "inreview",
    }, { x: 180, y: 2000 }),

    // ── No commits → todo ────────────────────────────────────────────────
    node("set-todo", "action.update_task_status", "Back to Todo", {
      taskId: "{{taskId}}",
      status: "todo",
    }, { x: 480, y: 1740 }),

    node("join-outcomes", "flow.join", "Join Outcome Paths", {
      mode: "all",
      sourceNodeIds: ["set-inreview", "set-todo"],
      includeSkipped: true,
    }, { x: 300, y: 2040 }),

    // ── Cleanup: release worktree ────────────────────────────────────────
    node("release-worktree", "action.release_worktree", "Release WT", {
      worktreePath: "{{worktreePath}}",
      repoRoot: "{{repoRoot}}",
      taskId: "{{taskId}}",
    }, { x: 300, y: 2180 }),

    // ── Cleanup: release claim ───────────────────────────────────────────
    node("release-claim", "action.release_claim", "Release Claim", {
      taskId: "{{taskId}}",
    }, { x: 300, y: 2310 }),

    // ── Cleanup: release slot ────────────────────────────────────────────
    node("release-slot", "action.release_slot", "Release Slot", {
      taskId: "{{taskId}}",
    }, { x: 300, y: 2440 }),

    // ── Skip (already claimed) ───────────────────────────────────────────
    node("release-slot-skip", "action.release_slot", "Release (Skip)", {
      taskId: "{{taskId}}",
    }, { x: 600, y: 700 }),

    node("skip-log", "notify.log", "Log Skipped", {
      message: "Task {{taskTitle}} already claimed — skipping",
      level: "info",
    }, { x: 600, y: 830 }),
  ],
  edges: [
    // Main flow
    edge("trigger", "check-slots"),
    edge("check-slots", "allocate-slot", { condition: "$output?.result === true" }),
    edge("allocate-slot", "claim"),
    edge("claim", "claim-check"),
    edge("claim-check", "set-inprogress", { condition: "$output?.result === true", port: "yes" }),
    edge("set-inprogress", "acquire-worktree"),
    edge("acquire-worktree", "resolve"),
    edge("resolve", "record-head"),
    edge("record-head", "read-workflow-contract"),
    edge("read-workflow-contract", "workflow-contract-validation"),
    edge("workflow-contract-validation", "prompt"),
    edge("prompt", "agent"),
    edge("agent", "commits"),
    edge("commits", "has-commits"),

    // Success path
    edge("has-commits", "push", { condition: "$output?.result === true", port: "yes" }),
    edge("push", "pr"),
    edge("pr", "pr-created"),
    edge("pr-created", "set-inreview", { condition: "$output?.result === true", port: "yes" }),
    edge("pr-created", "set-todo", { condition: "$output?.result !== true", port: "no" }),
    edge("set-inreview", "join-outcomes"),

    // No commits path
    edge("has-commits", "set-todo", { condition: "$output?.result !== true", port: "no" }),
    edge("set-todo", "join-outcomes"),

    // Shared cleanup
    edge("join-outcomes", "release-worktree"),
    edge("release-worktree", "release-claim"),
    edge("release-claim", "release-slot"),

    // Claim failed
    edge("claim-check", "release-slot-skip", { condition: "$output?.result !== true", port: "no" }),
    edge("release-slot-skip", "skip-log"),
  ],
  metadata: {
    author: "bosun",
    version: 2,
    createdAt: "2026-03-01T00:00:00Z",
    templateVersion: "2.0.0",
    tags: ["task", "lifecycle", "lite", "ve-orchestrator"],
    replaces: {
      module: "ve-orchestrator.mjs",
      functions: [
        "fillCapacity",
        "reconcileMergedAttempts",
      ],
      calledFrom: ["ve-orchestrator.mjs:main"],
      description:
        "Replaces the lightweight ve-orchestrator.mjs with a workflow-first " +
        "equivalent. Same execution model, fewer branches.",
    },
  },
};

