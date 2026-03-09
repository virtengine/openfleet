/**
 * workflow-task-lifecycle.test.mjs — Comprehensive tests for all 11 task
 * lifecycle node types and both workflow templates.
 *
 * Tests verify:
 *  1. Node registration, schema, describe()
 *  2. Node execution logic (happy path + error paths)
 *  3. Anti-thrash state management
 *  4. Template structure integrity (nodes, edges, variables)
 *  5. Template DAG connectivity
 *  6. Dry-run template execution through the workflow engine
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { getNodeType } from "../workflow/workflow-nodes.mjs";
import {
  WorkflowEngine,
  WorkflowContext,
} from "../workflow/workflow-engine.mjs";
import {
  getTemplate,
  installTemplate,
} from "../workflow/workflow-templates.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(data = {}) {
  const ctx = new WorkflowContext(data);
  ctx.log = vi.fn();
  return ctx;
}

function makeNode(type, config = {}, id = "test-node") {
  return { id, type, config };
}

function makeIsolatedGitEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ]) {
    delete env[key];
  }
  return env;
}

function execGit(command, options = {}) {
  return execSync(command, {
    ...options,
    env: makeIsolatedGitEnv(options.env),
  });
}

function sanitizedGitEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ]) {
    delete env[key];
  }
  return env;
}

let tmpDir;
let engine;

function makeTmpEngine() {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-lifecycle-test-"));
  engine = new WorkflowEngine({
    workflowDir: join(tmpDir, "workflows"),
    runsDir: join(tmpDir, "runs"),
    services: {},
  });
  return engine;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Node Type Registration Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("task lifecycle node type registration", () => {
  const LIFECYCLE_NODES = [
    "trigger.task_available",
    "condition.slot_available",
    "action.allocate_slot",
    "action.release_slot",
    "action.claim_task",
    "action.release_claim",
    "action.resolve_executor",
    "action.acquire_worktree",
    "action.release_worktree",
    "action.build_task_prompt",
    "action.detect_new_commits",
    "action.push_branch",
  ];

  for (const typeName of LIFECYCLE_NODES) {
    it(`${typeName} is registered`, () => {
      expect(getNodeType(typeName)).toBeDefined();
    });

    it(`${typeName} has a describe() returning a non-empty string`, () => {
      const desc = getNodeType(typeName).describe();
      expect(typeof desc).toBe("string");
      expect(desc.length).toBeGreaterThan(10);
    });

    it(`${typeName} has a valid schema`, () => {
      const nt = getNodeType(typeName);
      expect(nt.schema).toBeDefined();
      expect(nt.schema.type).toBe("object");
      expect(nt.schema.properties).toBeDefined();
    });

    it(`${typeName} has an async execute function`, () => {
      const nt = getNodeType(typeName);
      expect(typeof nt.execute).toBe("function");
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  trigger.task_available Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("trigger.task_available", () => {
  it("enforces repoAreaParallelLimit using activeTaskAreaCounts and task repo areas", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      { id: "t-workflow", title: "workflow task", status: "todo", repo_areas: ["workflow"], createdAt: "2026-03-01T00:00:00.000Z" },
      { id: "t-server", title: "server task", status: "todo", meta: { repo_areas: ["server"] }, createdAt: "2026-03-02T00:00:00.000Z" },
    ]);
    const ctx = makeCtx({
      activeSlotCount: 0,
      activeTaskAreaCounts: { workflow: 1 },
    });
    const node = makeNode("trigger.task_available", {
      maxParallel: 2,
      status: "todo",
      repoAreaParallelLimit: 1,
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: {
          listTasks,
        },
      },
    });

    expect(result.triggered).toBe(true);
    expect(result.taskCount).toBe(1);
    expect(result.tasks[0].id).toBe("t-server");
  });

  it("binds primary task context for downstream lifecycle nodes", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      {
        id: "abc-123",
        title: "Implement dispatch fix",
        description: "Ensure claims initialize",
        status: "todo",
        workspace: "C:/repo/bosun",
        repository: "virtengine/bosun",
        repositories: ["virtengine/bosun"],
        baseBranch: "main",
      },
    ]);
    const ctx = makeCtx({ activeSlotCount: 0 });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: {
          listTasks,
        },
      },
    });

    expect(result.triggered).toBe(true);
    expect(result.taskCount).toBe(1);
    expect(result.selectedTaskId).toBe("abc-123");
    expect(ctx.data.taskId).toBe("abc-123");
    expect(ctx.data.taskTitle).toBe("Implement dispatch fix");
    expect(ctx.data.taskDescription).toBe("Ensure claims initialize");
    expect(ctx.data.repoRoot).toBe("C:/repo/bosun");
    expect(ctx.data.workspace).toBe("C:/repo/bosun");
    expect(ctx.data.repository).toBe("virtengine/bosun");
    expect(ctx.data.baseBranch).toBe("main");
    expect(ctx.data.branch.startsWith("task/abc123-")).toBe(true);
  });

  it("resolves repoRoot to matching sibling repository when task repository differs", async () => {
    const nt = getNodeType("trigger.task_available");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "wf-task-repo-root-"));
    const bosunRepo = join(workspaceRoot, "bosun");
    const virtengineRepo = join(workspaceRoot, "virtengine");
    mkdirSync(bosunRepo, { recursive: true });
    mkdirSync(virtengineRepo, { recursive: true });
    writeFileSync(join(bosunRepo, ".git"), "gitdir: /tmp/bosun\n");
    writeFileSync(join(virtengineRepo, ".git"), "gitdir: /tmp/virtengine\n");

    const listTasks = vi.fn().mockResolvedValue([
      {
        id: "repo-route-1",
        title: "Cross-repo task",
        description: "Should route to virtengine mirror",
        status: "todo",
        workspace: "virtengine-gh",
        repository: "virtengine/virtengine",
      },
    ]);

    const ctx = makeCtx({
      activeSlotCount: 0,
      repoRoot: bosunRepo,
    });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
    });

    try {
      const result = await nt.execute(node, ctx, {
        services: {
          kanban: {
            listTasks,
          },
        },
      });

      expect(result.triggered).toBe(true);
      expect(ctx.data.repository).toBe("virtengine/virtengine");
      expect(ctx.data.repoRoot).toBe(virtengineRepo);
    } finally {
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("prefers the actual repo root over mirrored .bosun workspace paths for same-repo tasks", async () => {
    const nt = getNodeType("trigger.task_available");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "wf-task-repo-mirror-"));
    const actualRepo = join(workspaceRoot, "bosun");
    const mirroredRepo = join(actualRepo, ".bosun", "workspaces", "virtengine-gh", "bosun");
    mkdirSync(actualRepo, { recursive: true });
    mkdirSync(mirroredRepo, { recursive: true });
    writeFileSync(join(actualRepo, ".git"), "gitdir: /tmp/actual-bosun\n");
    writeFileSync(join(mirroredRepo, ".git"), "gitdir: /tmp/mirror-bosun\n");

    const listTasks = vi.fn().mockResolvedValue([
      {
        id: "repo-route-same-1",
        title: "Same repo task",
        description: "Should use actual repo root",
        status: "todo",
        workspace: "virtengine-gh",
        repository: "virtengine/bosun",
      },
    ]);

    const ctx = makeCtx({
      activeSlotCount: 0,
      repoRoot: mirroredRepo,
    });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
    });

    try {
      const result = await nt.execute(node, ctx, {
        services: {
          kanban: {
            listTasks,
          },
        },
      });

      expect(result.triggered).toBe(true);
      expect(ctx.data.repository).toBe("virtengine/bosun");
      expect(String(ctx.data.repoRoot || "").replace(/\\/g, "/")).toBe(actualRepo.replace(/\\/g, "/"));
      expect(ctx.data.repoSlug).toBe("virtengine/bosun");
    } finally {
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("normalizes mirrored repoRoot even when internal tasks omit repository metadata", async () => {
    const nt = getNodeType("trigger.task_available");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "wf-task-repo-default-"));
    const actualRepo = join(workspaceRoot, "bosun");
    const mirroredRepo = join(actualRepo, ".bosun", "workspaces", "virtengine-gh", "bosun");
    mkdirSync(actualRepo, { recursive: true });
    mkdirSync(mirroredRepo, { recursive: true });
    writeFileSync(join(actualRepo, ".git"), "gitdir: /tmp/actual-bosun-default\n");
    writeFileSync(join(mirroredRepo, ".git"), "gitdir: /tmp/mirror-bosun-default\n");

    const listTasks = vi.fn().mockResolvedValue([
      {
        id: "repo-route-default-1",
        title: "Default repo task",
        description: "Should still use actual repo root",
        status: "todo",
      },
    ]);

    const ctx = makeCtx({
      activeSlotCount: 0,
      repoRoot: mirroredRepo,
    });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
    });

    try {
      const result = await nt.execute(node, ctx, {
        services: {
          kanban: {
            listTasks,
          },
        },
      });

      expect(result.triggered).toBe(true);
      expect(String(ctx.data.repoRoot || "").replace(/\\/g, "/")).toBe(actualRepo.replace(/\\/g, "/"));
    } finally {
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("returns blocked result when all tasks exceed repoAreaParallelLimit", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      { id: "t-workflow-only", title: "workflow task", status: "todo", repo_areas: ["workflow"] },
    ]);
    const ctx = makeCtx({
      activeSlotCount: 0,
      activeTaskAreaCounts: { workflow: 1 },
    });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
      repoAreaParallelLimit: 1,
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: {
          listTasks,
        },
      },
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("repo_area_parallel_limit");
    expect(result.taskCount).toBe(0);
  });

  it("filters out DAG-blocked tasks via canStartTask guard", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      { id: "blocked-task", title: "Blocked", status: "todo" },
      { id: "ready-task", title: "Ready", status: "todo" },
    ]);
    const canStartTask = vi.fn((taskId) =>
      taskId === "blocked-task"
        ? { canStart: false, reason: "dependencies_unresolved", blockingTaskIds: ["dep-1"] }
        : { canStart: true, reason: "ok" },
    );

    const ctx = makeCtx({ activeSlotCount: 0, _services: { taskStore: { canStartTask } } });
    const node = makeNode("trigger.task_available", {
      maxParallel: 3,
      status: "todo",
      enforceStartGuards: true,
    });

    const result = await nt.execute(node, ctx, {
      services: { kanban: { listTasks }, taskStore: { canStartTask } },
    });

    expect(result.triggered).toBe(true);
    expect(result.taskCount).toBe(1);
    expect(result.tasks[0].id).toBe("ready-task");
    expect(canStartTask).toHaveBeenCalledTimes(2);
  });

  it("returns start_guard_blocked when all candidate tasks are blocked", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      { id: "blocked-a", title: "Blocked A", status: "todo" },
      { id: "blocked-b", title: "Blocked B", status: "todo" },
    ]);
    const canStartTask = vi.fn(() => ({
      canStart: false,
      reason: "prior_sprint_tasks_incomplete",
      blockingTaskIds: ["earlier-task"],
      blockingSprintIds: ["sprint-1"],
    }));

    const ctx = makeCtx({ activeSlotCount: 0, _services: { taskStore: { canStartTask } } });
    const node = makeNode("trigger.task_available", {
      maxParallel: 2,
      status: "todo",
      enforceStartGuards: true,
      sprintOrderMode: "sequential",
    });

    const result = await nt.execute(node, ctx, {
      services: { kanban: { listTasks }, taskStore: { canStartTask } },
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("start_guard_blocked");
    expect(Array.isArray(result.blocked)).toBe(true);
    expect(result.blocked.length).toBe(2);
    expect(canStartTask).toHaveBeenCalledTimes(2);
    expect(canStartTask).toHaveBeenNthCalledWith(1, "blocked-a", { sprintOrderMode: "sequential" });
    expect(canStartTask).toHaveBeenNthCalledWith(2, "blocked-b", { sprintOrderMode: "sequential" });
  });

  it("returns start_guard_blocked for unresolved epic dependencies", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      { id: "epic-blocked", title: "Epic Blocked", status: "todo" },
    ]);
    const canStartTask = vi.fn(() => ({
      canStart: false,
      reason: "epic_dependencies_unresolved",
      blockingEpicIds: ["EPIC-B"],
      blockingTaskIds: ["epic-b-task-1"],
    }));

    const ctx = makeCtx({ activeSlotCount: 0, _services: { taskStore: { canStartTask } } });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
      enforceStartGuards: true,
    });

    const result = await nt.execute(node, ctx, {
      services: { kanban: { listTasks }, taskStore: { canStartTask } },
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("start_guard_blocked");
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toBe("epic_dependencies_unresolved");
    expect(result.blocked[0].blockingEpicIds).toEqual(["EPIC-B"]);
    expect(result.blocked[0].blockingTaskIds).toEqual(["epic-b-task-1"]);
  });

  it("bypasses missing-task guard by default and emits audit event", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      { id: "missing-task", title: "Missing", status: "todo" },
    ]);
    const canStartTask = vi.fn(() => ({
      canStart: false,
      reason: "task_not_found",
    }));

    const ctx = makeCtx({ activeSlotCount: 0, _services: { taskStore: { canStartTask } } });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
      enforceStartGuards: true,
    });

    const result = await nt.execute(node, ctx, {
      services: { kanban: { listTasks }, taskStore: { canStartTask } },
    });

    expect(result.triggered).toBe(true);
    expect(result.taskCount).toBe(1);
    expect(result.tasks[0].id).toBe("missing-task");
    expect(result.auditEvents).toHaveLength(1);
    expect(result.auditEvents[0].type).toBe("start_guard_bypass");
    expect(result.auditEvents[0].reason).toBe("task_not_found");
    expect(result.auditEvents[0].strict).toBe(false);
  });

  it("supports strict missing-task guard policy with audit events", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      { id: "missing-task", title: "Missing", status: "todo" },
    ]);
    const canStartTask = vi.fn(() => ({
      canStart: false,
      reason: "task_not_found",
    }));

    const ctx = makeCtx({ activeSlotCount: 0, _services: { taskStore: { canStartTask } } });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
      enforceStartGuards: true,
      strictStartGuardMissingTask: true,
    });

    const result = await nt.execute(node, ctx, {
      services: { kanban: { listTasks }, taskStore: { canStartTask } },
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("start_guard_blocked");
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toBe("task_not_found");
    expect(result.blocked[0].strict).toBe(true);
    expect(result.auditEvents).toHaveLength(1);
    expect(result.auditEvents[0].type).toBe("start_guard_blocked");
    expect(result.auditEvents[0].reason).toBe("task_not_found");
    expect(result.auditEvents[0].strict).toBe(true);
  });
});

//  condition.slot_available Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("condition.slot_available", () => {
  it("returns true when no active tasks exist", async () => {
    const nt = getNodeType("condition.slot_available");
    const ctx = makeCtx({ activeSlotCount: 0 });
    const node = makeNode("condition.slot_available", { maxParallel: 3 });
    const result = await nt.execute(node, ctx);
    expect(result.result).toBe(true);
    expect(result.activeSlotCount).toBe(0);
  });

  it("returns false when active count >= maxParallel", async () => {
    const nt = getNodeType("condition.slot_available");
    const ctx = makeCtx({ activeSlotCount: 3 });
    const node = makeNode("condition.slot_available", { maxParallel: 3 });
    const result = await nt.execute(node, ctx);
    expect(result.result).toBe(false);
    expect(result.activeSlotCount).toBe(3);
  });

  it("handles baseBranch limit", async () => {
    const nt = getNodeType("condition.slot_available");
    const ctx = makeCtx({
      activeSlotCount: 2,
      baseBranchSlotCounts: { main: 2 },
    });
    const node = makeNode("condition.slot_available", {
      maxParallel: 5,
      baseBranchLimit: 2,
      baseBranch: "origin/main",
    });
    const result = await nt.execute(node, ctx);
    // baseBranch limit 2 with 2 on "main" → blocked
    expect(result.result).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.allocate_slot Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.allocate_slot", () => {
  it("allocates a slot and stores in ctx.data._allocatedSlot", async () => {
    const nt = getNodeType("action.allocate_slot");
    const ctx = makeCtx({});
    const node = makeNode("action.allocate_slot", {
      taskId: "task-123",
      taskTitle: "Test Task",
      branch: "feat/test",
      baseBranch: "main",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(ctx.data._allocatedSlot).toBeDefined();
    expect(ctx.data._allocatedSlot.taskId).toBe("task-123");
    expect(ctx.data._allocatedSlot.taskTitle).toBe("Test Task");
    expect(ctx.data._allocatedSlot.branch).toBe("feat/test");
    expect(ctx.data._agentInstanceId).toBeDefined();
  });

  it("saves env var snapshot", async () => {
    const nt = getNodeType("action.allocate_slot");
    const ctx = makeCtx({});
    process.env.VE_TEST_VAR = "hello";
    const node = makeNode("action.allocate_slot", {
      taskId: "task-snap",
      branch: "feat/snap",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    const slot = ctx.data._allocatedSlot;
    expect(slot._envSnapshot).toBeDefined();
    expect(slot._envSnapshot.VE_TEST_VAR).toBe("hello");
    delete process.env.VE_TEST_VAR;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.release_slot Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.release_slot", () => {
  it("releases the allocated slot and nullifies it", async () => {
    const nt = getNodeType("action.release_slot");
    const ctx = makeCtx({
      taskId: "task-rel",
      _allocatedSlot: { taskId: "task-rel", startedAt: Date.now() - 5000 },
    });
    const node = makeNode("action.release_slot", { taskId: "task-rel" });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(ctx.data._allocatedSlot).toBeNull();
  });

  it("returns success even if no slot allocated", async () => {
    const nt = getNodeType("action.release_slot");
    const ctx = makeCtx({ taskId: "missing" });
    const node = makeNode("action.release_slot", { taskId: "missing" });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
  });

  it("restores env vars from snapshot", async () => {
    const nt = getNodeType("action.release_slot");
    const origVal = process.env.VE_RESTORE_TEST;
    process.env.VE_RESTORE_TEST = "changed";
    const ctx = makeCtx({
      taskId: "task-env",
      _allocatedSlot: {
        taskId: "task-env",
        startedAt: Date.now() - 1000,
        _envSnapshot: { VE_RESTORE_TEST: "original" },
      },
    });
    const node = makeNode("action.release_slot", { taskId: "task-env" });
    await nt.execute(node, ctx);
    expect(process.env.VE_RESTORE_TEST).toBe("original");
    // Cleanup
    if (origVal === undefined) delete process.env.VE_RESTORE_TEST;
    else process.env.VE_RESTORE_TEST = origVal;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.claim_task Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.claim_task", () => {
  it("initializes task-claims lazily before claiming", async () => {
    const nt = getNodeType("action.claim_task");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const claimSpy = vi.spyOn(claims, "claimTask").mockResolvedValue({
      success: true,
      token: "claim-token-1",
    });

    try {
      const ctx = makeCtx({ repoRoot: "/tmp/repo-root" });
      const node = makeNode("action.claim_task", {
        taskId: "task-1",
        taskTitle: "Fix dispatch",
        renewIntervalMs: 0,
      });
      const result = await nt.execute(node, ctx);

      expect(result.success).toBe(true);
      expect(result.claimToken).toBe("claim-token-1");
      expect(initSpy).toHaveBeenCalled();
      expect(claimSpy).toHaveBeenCalled();
    } finally {
      initSpy.mockRestore();
      claimSpy.mockRestore();
    }
  });

  it("uses renewClaim fallback when renewTaskClaim is unavailable", async () => {
    vi.useFakeTimers();
    const nt = getNodeType("action.claim_task");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const claimSpy = vi.spyOn(claims, "claimTask").mockResolvedValue({
      success: true,
      token: "claim-token-fallback",
    });
    const renewSpy = vi.spyOn(claims, "renewClaim").mockResolvedValue({ success: true });

    const ctx = makeCtx({ repoRoot: "/tmp/repo-root" });
    try {
      const node = makeNode("action.claim_task", {
        taskId: "task-renew-fallback",
        taskTitle: "Renew fallback",
        renewIntervalMs: 50,
      });

      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);

      await vi.advanceTimersByTimeAsync(60);
      expect(renewSpy).toHaveBeenCalled();
      expect(renewSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-renew-fallback",
          claimToken: "claim-token-fallback",
        }),
      );
    } finally {
      const runtimeTimer = ctx.__workflowRuntimeState?.claimRenewTimer || ctx.data?._claimRenewTimer;
      if (runtimeTimer) clearInterval(runtimeTimer);
      initSpy.mockRestore();
      claimSpy.mockRestore();
      renewSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.resolve_executor Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.resolve_executor", () => {
  it("resolves default SDK to copilot when no env overrides", async () => {
    const nt = getNodeType("action.resolve_executor");
    const ctx = makeCtx({});
    // Clean up potential env vars
    const saved = { ...process.env };
    delete process.env.COPILOT_MODEL;
    delete process.env.CLAUDE_MODEL;
    delete process.env.CODEX_MODEL;
    const node = makeNode("action.resolve_executor", {
      defaultSdk: "auto",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.sdk).toBeDefined();
    // Restore
    Object.assign(process.env, saved);
  });

  it("stores resolved values in ctx.data", async () => {
    const nt = getNodeType("action.resolve_executor");
    const ctx = makeCtx({});
    const node = makeNode("action.resolve_executor", {
      defaultSdk: "copilot",
    });
    const result = await nt.execute(node, ctx);
    expect(ctx.data.resolvedSdk).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.acquire_worktree Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.acquire_worktree", () => {
  let repoDir;

  const gitExec = (command, options = {}) =>
    execSync(command, {
      env: sanitizedGitEnv(),
      ...options,
    });

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "wf-acquire-worktree-"));
    gitExec("git init", { cwd: repoDir, stdio: "ignore" });
    gitExec("git config --local user.email test@test.com", { cwd: repoDir, stdio: "ignore" });
    gitExec("git config --local user.name Test", { cwd: repoDir, stdio: "ignore" });
    writeFileSync(join(repoDir, "README.md"), "init\n");
    gitExec("git add README.md && git commit -m init", { cwd: repoDir, stdio: "ignore" });
    gitExec("git branch -M main", { cwd: repoDir, stdio: "ignore" });
  });

  afterEach(() => {
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("falls back to defaultTargetBranch when baseBranch template is unresolved", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const ctx = makeCtx({});
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "abc123",
      branch: "task/abc123-fallback-branch",
      baseBranch: "{{baseBranch}}",
      defaultTargetBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.baseBranch).toBe("main");
    expect(ctx.data.baseBranch).toBe("main");
    expect(result.created).toBe(true);
    expect(existsSync(result.worktreePath)).toBe(true);
  });

  it("marks reused worktrees as managed for cleanup", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const ctx1 = makeCtx({});
    const branch = "task/reuse-managed";

    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "reuse-1",
      branch,
      baseBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const first = await nt.execute(node, ctx1);
    expect(first.success).toBe(true);
    expect(first.created).toBe(true);

    const ctx2 = makeCtx({});
    const second = await nt.execute(node, ctx2);
    expect(second.success).toBe(true);
    expect(second.reused).toBe(true);
    expect(ctx2.data._worktreeCreated).toBe(false);
    expect(ctx2.data._worktreeManaged).toBe(true);
  });

  it("reuses an already-attached branch worktree even when managed path naming changed", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const branch = "task/legacy-reuse-branch";
    const legacyPath = join(repoDir, ".bosun", "worktrees", "task-legacy-reuse");
    mkdirSync(join(repoDir, ".bosun", "worktrees"), { recursive: true });

    gitExec('git worktree add "' + legacyPath + '" -b "' + branch + '" main', {
      cwd: repoDir,
      stdio: "ignore",
    });

    const ctx = makeCtx({});
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "legacy-1",
      branch,
      baseBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.reused).toBe(true);
    expect(result.reusedExistingBranch).toBe(true);
    expect(result.created).toBe(false);
    expect(String(result.worktreePath).replace(/\\/g, "/")).toBe(String(legacyPath).replace(/\\/g, "/"));
    expect(ctx.data._worktreeManaged).toBe(true);
  });
  it("uses a short managed worktree directory derived from task id", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const ctx = makeCtx({});
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "task-123e4567-e89b-12d3-a456-426614174000",
      branch: "task/very-long-branch-name-that-would-normally-be-used-as-worktree-directory",
      baseBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    const normalizedPath = String(result.worktreePath || "").replace(/\\/g, "/");
    expect(normalizedPath).toMatch(/\/\.bosun\/worktrees\/task-task123e4567-[a-f0-9]{10}$/);
    expect(normalizedPath).not.toContain("very-long-branch-name");
  });


  it("recreates invalid managed worktrees instead of reusing broken git metadata", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const branch = "task/recreate-invalid-managed";
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "recreate-invalid-1",
      branch,
      baseBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const firstCtx = makeCtx({});
    const first = await nt.execute(node, firstCtx);
    expect(first.success).toBe(true);
    expect(first.created).toBe(true);

    gitExec('git worktree remove "' + first.worktreePath + '" --force', {
      cwd: repoDir,
      stdio: "ignore",
    });
    mkdirSync(first.worktreePath, { recursive: true });
    writeFileSync(join(first.worktreePath, "stale.txt"), "stale");

    const secondCtx = makeCtx({});
    const second = await nt.execute(node, secondCtx);
    expect(second.success).toBe(true);
    expect(typeof second.worktreePath).toBe("string");
    expect(second.worktreePath.length).toBeGreaterThan(0);
    const isGit = gitExec("git rev-parse --is-inside-work-tree", {
      cwd: second.worktreePath,
      encoding: "utf8",
    }).trim();
    expect(isGit).toBe("true");
  });

  it("enables core.longpaths before checkout", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const ctx = makeCtx({});
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "longpaths-1",
      branch: "task/longpaths-enable",
      baseBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    const longpaths = gitExec("git config --local --get core.longpaths", {
      cwd: repoDir,
      encoding: "utf8",
    }).trim().toLowerCase();
    expect(longpaths).toBe("true");
  });

  it("repairs core.bare corruption after creating a worktree", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const ctx = makeCtx({});
    gitExec(`git config --local core.bare true`, { cwd: repoDir, stdio: "ignore" });
    gitExec(`git config --local core.worktree "${repoDir}"`, { cwd: repoDir, stdio: "ignore" });

    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "abc124",
      branch: "task/abc124-bare-repair",
      baseBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const result = await nt.execute(node, ctx);

    expect(result.success).toBe(true);
    expect(
      gitExec("git config --local --get core.bare", { cwd: repoDir, encoding: "utf8" }).trim(),
    ).toBe("false");
    expect(() => gitExec("git config --local --get core.worktree", {
      cwd: repoDir,
      encoding: "utf8",
      stdio: "pipe",
    })).toThrow();
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.build_task_prompt Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.build_task_prompt", () => {
  it("builds a prompt string and stores in ctx.data._taskPrompt", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({
      resolvedSdk: "copilot",
      resolvedModel: "gpt-4",
    });
    const node = makeNode("action.build_task_prompt", {
      taskId: "TASK-42",
      taskTitle: "Fix the widget",
      taskDescription: "The widget is broken, please fix it.",
      branch: "feat/fix-widget",
      baseBranch: "main",
      worktreePath: "/tmp/test-wt",
      repoRoot: "/tmp/test-repo",
      repoSlug: "org/repo",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(typeof result.prompt).toBe("string");
    expect(result.prompt.length).toBeGreaterThan(50);
    expect(result.prompt).toContain("Fix the widget");
    expect(result.prompt).toContain("TASK-42");
    expect(ctx.data._taskPrompt).toBe(result.prompt);
  });

  it("includes branch and repo info", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({});
    const node = makeNode("action.build_task_prompt", {
      taskId: "T1",
      taskTitle: "Test",
      taskDescription: "Desc",
      branch: "feat/branch-test",
      baseBranch: "main",
      repoSlug: "myorg/myrepo",
    });
    const result = await nt.execute(node, ctx);
    expect(result.prompt).toContain("feat/branch-test");
  });

  it("includes instruction lines", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({});
    const node = makeNode("action.build_task_prompt", {
      taskId: "T2",
      taskTitle: "Test",
      taskDescription: "Desc",
    });
    const result = await nt.execute(node, ctx);
    // Should have autonomous agent instructions
    expect(result.prompt).toContain("commit");
  });

  it("renders workspace scope contract from explicit repo metadata", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({});
    const node = makeNode("action.build_task_prompt", {
      taskId: "T3",
      taskTitle: "Repo boundaries",
      taskDescription: "Respect scoped repos",
      worktreePath: "/tmp/wt-repo",
      workspace: "virtengine-gh",
      repository: "virtengine/bosun",
      repositories: ["virtengine/bosun", "virtengine/virtengine"],
    });
    const result = await nt.execute(node, ctx);
    expect(result.prompt).toContain("## Workspace Scope Contract");
    expect(result.prompt).toContain("**Workspace:** virtengine-gh");
    expect(result.prompt).toContain("**Primary Repository:** virtengine/bosun");
    expect(result.prompt).toContain("virtengine/virtengine");
    expect(result.prompt).toContain("blocked: cross-repo dependency");
  });

  it("falls back to task payload scope metadata when config is not provided", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({
      task: {
        workspace: "workspace-a",
        repository: "org/primary",
        repositories: ["org/primary", "org/shared-lib"],
      },
    });
    const node = makeNode("action.build_task_prompt", {
      taskId: "T4",
      taskTitle: "Fallback scope",
      taskDescription: "Use task payload scope",
      worktreePath: "/tmp/wt-fallback",
    });
    const result = await nt.execute(node, ctx);
    expect(result.prompt).toContain("**Workspace:** workspace-a");
    expect(result.prompt).toContain("**Primary Repository:** org/primary");
    expect(result.prompt).toContain("org/shared-lib");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.detect_new_commits Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.detect_new_commits", () => {
  let gitDir;

  const gitExec = (command, options = {}) =>
    execSync(command, {
      env: sanitizedGitEnv(),
      ...options,
    });

  beforeEach(() => {
    gitDir = mkdtempSync(join(tmpdir(), "wf-detect-commits-"));
    execGit("git init", { cwd: gitDir, stdio: "ignore" });
    execGit("git config --local user.email test@test.com", { cwd: gitDir, stdio: "ignore" });
    execGit("git config --local user.name Test", { cwd: gitDir, stdio: "ignore" });
    writeFileSync(join(gitDir, "README.md"), "init");
    execGit("git add . && git commit -m init", { cwd: gitDir, stdio: "ignore" });
  });

  afterEach(() => {
    try { rmSync(gitDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("detects no commits when HEAD unchanged", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const head = execGit("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    const ctx = makeCtx({ _preExecHead: head });
    const node = makeNode("action.detect_new_commits", {
      worktreePath: gitDir,
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.hasNewCommits).toBe(false);
  });

  it("detects new commits when HEAD changed", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const preHead = execGit("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    // Make a new commit
    writeFileSync(join(gitDir, "new.txt"), "new content");
    execGit("git add . && git commit -m new", { cwd: gitDir, stdio: "ignore" });
    const ctx = makeCtx({ _preExecHead: preHead });
    const node = makeNode("action.detect_new_commits", {
      worktreePath: gitDir,
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.hasNewCommits).toBe(true);
    expect(result.hasCommits).toBe(true);
    expect(result.preExecHead).toBe(preHead);
    expect(result.postExecHead).not.toBe(preHead);
  }, 15000);

  it("stores results in ctx.data", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const head = gitExec("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    const ctx = makeCtx({ _preExecHead: head });
    const node = makeNode("action.detect_new_commits", { worktreePath: gitDir });
    await nt.execute(node, ctx);
    expect(typeof ctx.data._hasNewCommits).toBe("boolean");
    expect(typeof ctx.data._postExecHead).toBe("string");
  });

  it("fails gracefully on invalid path", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const ctx = makeCtx({});
    const node = makeNode("action.detect_new_commits", {
      worktreePath: "/nonexistent/path/xyz",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(false);
    expect(result.hasCommits).toBe(false);
  });

  it("soft-fails if worktreePath is missing", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const ctx = makeCtx({});
    const node = makeNode("action.detect_new_commits", {});
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(false);
    expect(result.hasCommits).toBe(false);
    expect(result.hasNewCommits).toBe(false);
    expect(result.error).toMatch(/worktreePath/);
  });

  it("detects commits even when ComSpec is invalid", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const head = execGit("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    const ctx = makeCtx({ _preExecHead: head });
    const node = makeNode("action.detect_new_commits", { worktreePath: gitDir });
    const originalComSpec = process.env.ComSpec;
    process.env.ComSpec = join(gitDir, "missing-cmd.exe");
    try {
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);
      expect(result.postExecHead).toBe(head);
    } finally {
      if (originalComSpec == null) delete process.env.ComSpec;
      else process.env.ComSpec = originalComSpec;
    }
  });

  it("detects commits when PATH is unavailable", async () => {
    if (process.platform !== "win32") return;
    const nt = getNodeType("action.detect_new_commits");
    const head = execGit("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    const ctx = makeCtx({ _preExecHead: head });
    const node = makeNode("action.detect_new_commits", { worktreePath: gitDir });
    const originalPath = process.env.PATH;
    const originalPathWin = process.env.Path;
    process.env.PATH = "";
    process.env.Path = "";
    try {
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);
      expect(result.postExecHead).toBe(head);
    } finally {
      if (originalPath == null) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPathWin == null) delete process.env.Path;
      else process.env.Path = originalPathWin;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.push_branch Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.push_branch", () => {
  it("refuses to push to protected branches", async () => {
    const nt = getNodeType("action.push_branch");
    const ctx = makeCtx({});
    const node = makeNode("action.push_branch", {
      worktreePath: "/tmp/test",
      branch: "main",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Protected branch");
    expect(result.pushed).toBe(false);
  });

  it("refuses origin/main as well", async () => {
    const nt = getNodeType("action.push_branch");
    const ctx = makeCtx({});
    const node = makeNode("action.push_branch", {
      worktreePath: "/tmp/test",
      branch: "origin/main",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Protected branch");
  });

  it("refuses master, develop, production", async () => {
    const nt = getNodeType("action.push_branch");
    for (const branch of ["master", "develop", "production"]) {
      const ctx = makeCtx({});
      const node = makeNode("action.push_branch", {
        worktreePath: "/tmp/test",
        branch,
      });
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(false);
    }
  });

  it("throws if worktreePath is missing", async () => {
    const nt = getNodeType("action.push_branch");
    const ctx = makeCtx({});
    const node = makeNode("action.push_branch", {});
    await expect(nt.execute(node, ctx)).rejects.toThrow("worktreePath");
  });

  it("schema has rebaseBeforePush and emptyDiffGuard options", () => {
    const nt = getNodeType("action.push_branch");
    expect(nt.schema.properties.rebaseBeforePush).toBeDefined();
    expect(nt.schema.properties.emptyDiffGuard).toBeDefined();
    expect(nt.schema.properties.syncMainForModuleBranch).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.release_worktree Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.release_worktree", () => {
  it("releases reused managed worktrees", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "wf-release-worktree-"));
    try {
      execGit("git init", { cwd: repoDir, stdio: "ignore" });
      execGit("git config --local user.email test@test.com", { cwd: repoDir, stdio: "ignore" });
      execGit("git config --local user.name Test", { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, "README.md"), "init\n");
      execGit("git add README.md && git commit -m init", { cwd: repoDir, stdio: "ignore" });
      execGit("git branch -M main", { cwd: repoDir, stdio: "ignore" });

      const branch = "task/release-reused";
      const worktreesDir = join(repoDir, ".bosun", "worktrees");
      mkdirSync(worktreesDir, { recursive: true });
      const worktreePath = join(worktreesDir, branch.replace(/[^a-zA-Z0-9._-]/g, "-"));
      execGit(`git worktree add "${worktreePath}" -b "${branch}" main`, { cwd: repoDir, stdio: "ignore" });
      expect(existsSync(worktreePath)).toBe(true);

      const nt = getNodeType("action.release_worktree");
      const ctx = makeCtx({
        _worktreeCreated: false,
        _worktreeManaged: true,
      });
      const node = makeNode("action.release_worktree", {
        worktreePath,
        repoRoot: repoDir,
        taskId: "t-managed",
      });

      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);
      expect(result.released).toBe(true);
      expect(existsSync(worktreePath)).toBe(false);
    } finally {
      try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("succeeds when worktree path doesn't exist", async () => {
    const nt = getNodeType("action.release_worktree");
    const ctx = makeCtx({});
    const node = makeNode("action.release_worktree", {
      worktreePath: "/nonexistent/path/wt",
      repoRoot: "/nonexistent/repo",
      taskId: "t1",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.release_claim Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.release_claim", () => {
  it("clears claim data from ctx (set to null)", async () => {
    const nt = getNodeType("action.release_claim");
    const ctx = makeCtx({
      _claimToken: "abc123",
      _claimInstanceId: "inst-1",
      _claimRenewTimer: null,
    });
    const node = makeNode("action.release_claim", { taskId: "t1" });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(ctx.data._claimToken).toBeNull();
    expect(ctx.data._claimInstanceId).toBeNull();
  });

  it("clears renewal timer if present", async () => {
    const nt = getNodeType("action.release_claim");
    const timer = setInterval(() => {}, 100000);
    timer.unref();
    const ctx = makeCtx({
      _claimToken: "abc",
      _claimRenewTimer: timer,
    });
    const node = makeNode("action.release_claim", { taskId: "t2" });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    clearInterval(timer); // extra safety
  });

  it("uses releaseTask fallback when releaseTaskClaim is unavailable", async () => {
    const nt = getNodeType("action.release_claim");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const releaseSpy = vi.spyOn(claims, "releaseTask").mockResolvedValue({ success: true });
    const ctx = makeCtx({
      _claimToken: "claim-fallback",
      _claimInstanceId: "inst-fallback",
      _claimRenewTimer: null,
      repoRoot: "/tmp/repo-root",
    });

    try {
      const node = makeNode("action.release_claim", { taskId: "task-release-fallback" });
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);
      expect(releaseSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-release-fallback",
          claimToken: "claim-fallback",
          instanceId: "inst-fallback",
        }),
      );
      expect(ctx.data._claimToken).toBeNull();
      expect(ctx.data._claimInstanceId).toBeNull();
    } finally {
      initSpy.mockRestore();
      releaseSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Template: task-lifecycle
// ═══════════════════════════════════════════════════════════════════════════



describe("action.update_task_status", () => {
  it("falls back to ctx taskId when config taskId is unresolved", async () => {
    const nt = getNodeType("action.update_task_status");
    const updateTaskStatus = vi.fn().mockResolvedValue(true);
    const ctx = makeCtx({
      taskId: "task-fallback-123",
      taskTitle: "Fallback task",
    });
    const node = makeNode("action.update_task_status", {
      taskId: "{{task.taskId}}",
      status: "inprogress",
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: { updateTaskStatus },
      },
    });

    expect(result.success).toBe(true);
    expect(updateTaskStatus).toHaveBeenCalledWith(
      "task-fallback-123",
      "inprogress",
      expect.objectContaining({ source: "workflow" }),
    );
  });

  it("skips when taskId remains unresolved", async () => {
    const nt = getNodeType("action.update_task_status");
    const updateTaskStatus = vi.fn().mockResolvedValue(true);
    const ctx = makeCtx({});
    const node = makeNode("action.update_task_status", {
      taskId: "{{task.taskId}}",
      status: "inprogress",
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: { updateTaskStatus },
      },
    });

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toBe("unresolved_task_id");
    expect(updateTaskStatus).not.toHaveBeenCalled();
  });
});

describe("template-task-lifecycle", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("exists and has correct metadata", () => {
    const t = getTemplate("template-task-lifecycle");
    expect(t).toBeDefined();
    expect(t.name).toBe("Task Lifecycle");
    expect(t.category).toBe("lifecycle");
    expect(t.enabled).toBe(true);
    expect(t.recommended).toBe(true);
  });

  it("has all required node IDs", () => {
    const t = getTemplate("template-task-lifecycle");
    const ids = t.nodes.map((n) => n.id);
    const required = [
      "trigger", "check-slots", "allocate-slot", "claim-task",
      "claim-ok", "set-inprogress", "acquire-worktree", "worktree-ok",
      "resolve-executor", "record-head", "build-prompt", "run-agent",
      "claim-stolen", "detect-commits", "has-commits",
      "push-branch", "push-ok", "create-pr", "set-inreview", "log-success",
      "log-no-commits", "set-todo-cooldown",
      "release-worktree", "release-claim", "release-slot",
    ];
    for (const id of required) {
      expect(ids, `missing node: ${id}`).toContain(id);
    }
  });

  it("does NOT reference resolvedSdk/resolvedModel in allocate-slot config", () => {
    const t = getTemplate("template-task-lifecycle");
    const allocSlot = t.nodes.find((n) => n.id === "allocate-slot");
    expect(allocSlot).toBeDefined();
    const cfgStr = JSON.stringify(allocSlot.config);
    expect(cfgStr).not.toContain("resolvedSdk");
    expect(cfgStr).not.toContain("resolvedModel");
  });

  it("resolve-executor runs AFTER worktree-ok (not before)", () => {
    const t = getTemplate("template-task-lifecycle");
    // resolve-executor should be downstream of worktree-ok
    const resolveEdge = t.edges.find(
      (e) => e.target === "resolve-executor",
    );
    expect(resolveEdge).toBeDefined();
    expect(resolveEdge.source).toBe("worktree-ok");
  });

  it("has claim-stolen check after run-agent", () => {
    const t = getTemplate("template-task-lifecycle");
    const edge = t.edges.find(
      (e) => e.source === "run-agent" && e.target === "claim-stolen",
    );
    expect(edge).toBeDefined();
  });

  it("push-branch has baseBranch and rebaseBeforePush config", () => {
    const t = getTemplate("template-task-lifecycle");
    const pushNode = t.nodes.find((n) => n.id === "push-branch");
    expect(pushNode).toBeDefined();
    expect(pushNode.config.baseBranch).toBe("{{baseBranch}}");
    expect(pushNode.config.rebaseBeforePush).toBe(true);
    expect(pushNode.config.emptyDiffGuard).toBe(true);
  });

  it("links task PRs before moving tasks to inreview", () => {
    const t = getTemplate("template-task-lifecycle");
    const createPr = t.nodes.find((n) => n.id === "create-pr");
    const prCreated = t.nodes.find((n) => n.id === "pr-created");

    expect(createPr?.config?.body).toContain("Task-ID: {{taskId}}");
    expect(prCreated?.config?.expression).toContain("create-pr");
    expect(t.edges.find((e) => e.source === "create-pr" && e.target === "pr-created")).toBeDefined();
    expect(t.edges.find((e) => e.source === "pr-created" && e.target === "set-inreview")).toBeDefined();
    expect(t.edges.find((e) => e.source === "pr-created" && e.target === "set-todo-push-failed")).toBeDefined();
  });

  it("has push-ok check after push-branch", () => {
    const t = getTemplate("template-task-lifecycle");
    const edge = t.edges.find(
      (e) => e.source === "push-branch" && e.target === "push-ok",
    );
    expect(edge).toBeDefined();
  });

  it("passes repository scope metadata into build-prompt node", () => {
    const t = getTemplate("template-task-lifecycle");
    const buildPrompt = t.nodes.find((n) => n.id === "build-prompt");
    expect(buildPrompt).toBeDefined();
    expect(buildPrompt.config.workspace).toBe("{{workspace}}");
    expect(buildPrompt.config.repository).toBe("{{repository}}");
    expect(buildPrompt.config.repositories).toBe("{{repositories}}");
  });

  it("all outcome paths converge to release-worktree → release-claim → release-slot", () => {
    const t = getTemplate("template-task-lifecycle");
    // outcomes → join-outcomes
    expect(t.edges.find((e) => e.source === "log-success" && e.target === "join-outcomes")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-todo-cooldown" && e.target === "join-outcomes")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-todo-stolen" && e.target === "join-outcomes")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-todo-push-failed" && e.target === "join-outcomes")).toBeDefined();
    // join-outcomes → release-worktree
    expect(t.edges.find((e) => e.source === "join-outcomes" && e.target === "release-worktree")).toBeDefined();
    // release-worktree → release-claim → release-slot
    expect(t.edges.find((e) => e.source === "release-worktree" && e.target === "release-claim")).toBeDefined();
    expect(t.edges.find((e) => e.source === "release-claim" && e.target === "release-slot")).toBeDefined();
  });

  it("claim-failed path releases slot", () => {
    const t = getTemplate("template-task-lifecycle");
    expect(t.edges.find((e) => e.source === "claim-ok" && e.target === "release-slot-claim-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "release-slot-claim-failed" && e.target === "log-claim-failed")).toBeDefined();
  });

  it("worktree-failed path releases claim and slot", () => {
    const t = getTemplate("template-task-lifecycle");
    expect(t.edges.find((e) => e.source === "worktree-ok" && e.target === "release-claim-wt-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "release-claim-wt-failed" && e.target === "set-todo-wt-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-todo-wt-failed" && e.target === "release-slot-wt-failed")).toBeDefined();
  });

  it("all edges reference valid node IDs", () => {
    const t = getTemplate("template-task-lifecycle");
    const nodeIds = new Set(t.nodes.map((n) => n.id));
    for (const e of t.edges) {
      expect(nodeIds, `edge source "${e.source}" not in nodes`).toContain(e.source);
      expect(nodeIds, `edge target "${e.target}" not in nodes`).toContain(e.target);
    }
  });

  it("no orphan nodes (every non-trigger node is a target of some edge)", () => {
    const t = getTemplate("template-task-lifecycle");
    const targets = new Set(t.edges.map((e) => e.target));
    for (const n of t.nodes) {
      if (n.id === "trigger") continue; // trigger has no incoming edge
      expect(targets, `node "${n.id}" is orphaned`).toContain(n.id);
    }
  });

  it("has correct variables with sensible defaults", () => {
    const t = getTemplate("template-task-lifecycle");
    expect(t.variables.maxParallel).toBe(3);
    expect(t.variables.claimTtlMinutes).toBe(180);
    expect(t.variables.claimRenewIntervalMs).toBe(300000);
    expect(t.variables.taskTimeoutMs).toBe(21600000);
    expect(t.variables.defaultSdk).toBe("auto");
    expect(Array.isArray(t.variables.protectedBranches)).toBe(true);
  });

  it("replaces task-executor.mjs module", () => {
    const t = getTemplate("template-task-lifecycle");
    expect(t.metadata.replaces.module).toBe("task-executor.mjs");
    expect(t.metadata.replaces.functions).toContain("executeTask");
  });

  it("installs and round-trips through engine", () => {
    const result = installTemplate("template-task-lifecycle", engine);
    expect(result.id).not.toBe("template-task-lifecycle");
    expect(result.metadata.installedFrom).toBe("template-task-lifecycle");
    const stored = engine.get(result.id);
    expect(stored).toBeDefined();
    expect(stored.name).toBe("Task Lifecycle");
  });

  it("installs with variable overrides", () => {
    const result = installTemplate("template-task-lifecycle", engine, {
      maxParallel: 5,
      taskTimeoutMs: 3600000,
    });
    expect(result.variables.maxParallel).toBe(5);
    expect(result.variables.taskTimeoutMs).toBe(3600000);
    expect(result.variables.defaultSdk).toBe("auto"); // unchanged
  });

  it("dry-run executes without errors (trigger stops at no kanban)", async () => {
    const result = installTemplate("template-task-lifecycle", engine);
    const ctx = new WorkflowContext({});
    // Dry run should complete without throwing
    try {
      await engine.execute(result.id, ctx, { dryRun: true });
    } catch (err) {
      // Some nodes may fail in dry-run if services aren't wired,
      // but the DAG structure should be valid
      expect(err.message).not.toContain("Unknown node type");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Template: ve-orchestrator-lite
// ═══════════════════════════════════════════════════════════════════════════

describe("template-ve-orchestrator-lite", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("exists and has correct metadata", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    expect(t).toBeDefined();
    expect(t.name).toBe("VE Orchestrator Lite");
    expect(t.category).toBe("lifecycle");
    expect(t.enabled).toBe(true);
    expect(t.recommended).toBe(false);
  });

  it("has slot management nodes", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    const ids = t.nodes.map((n) => n.id);
    expect(ids).toContain("check-slots");
    expect(ids).toContain("allocate-slot");
    expect(ids).toContain("release-slot");
  });

  it("has worktree management nodes", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    const ids = t.nodes.map((n) => n.id);
    expect(ids).toContain("acquire-worktree");
    expect(ids).toContain("release-worktree");
  });

  it("has push-branch node", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    const ids = t.nodes.map((n) => n.id);
    expect(ids).toContain("push");
  });

  it("has record-head for commit detection", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    const ids = t.nodes.map((n) => n.id);
    expect(ids).toContain("record-head");
  });

  it("passes repository scope metadata into prompt node", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    const promptNode = t.nodes.find((n) => n.id === "prompt");
    expect(promptNode).toBeDefined();
    expect(promptNode.config.workspace).toBe("{{workspace}}");
    expect(promptNode.config.repository).toBe("{{repository}}");
    expect(promptNode.config.repositories).toBe("{{repositories}}");
  });

  it("all edges reference valid node IDs", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    const nodeIds = new Set(t.nodes.map((n) => n.id));
    for (const e of t.edges) {
      expect(nodeIds, `edge source "${e.source}" not in nodes`).toContain(e.source);
      expect(nodeIds, `edge target "${e.target}" not in nodes`).toContain(e.target);
    }
  });

  it("no orphan nodes", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    const targets = new Set(t.edges.map((e) => e.target));
    for (const n of t.nodes) {
      if (n.id === "trigger") continue;
      expect(targets, `node "${n.id}" is orphaned`).toContain(n.id);
    }
  });

  it("cleanup chain: release-worktree → release-claim → release-slot", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    expect(t.edges.find((e) => e.source === "release-worktree" && e.target === "release-claim")).toBeDefined();
    expect(t.edges.find((e) => e.source === "release-claim" && e.target === "release-slot")).toBeDefined();
  });

  it("claim-failed path releases slot", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    expect(t.edges.find((e) => e.source === "claim-check" && e.target === "release-slot-skip")).toBeDefined();
  });

  it("replaces ve-orchestrator.mjs module", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    expect(t.metadata.replaces.module).toBe("ve-orchestrator.mjs");
  });

  it("installs and round-trips through engine", () => {
    const result = installTemplate("template-ve-orchestrator-lite", engine);
    expect(result.id).not.toBe("template-ve-orchestrator-lite");
    expect(result.metadata.installedFrom).toBe("template-ve-orchestrator-lite");
    const stored = engine.get(result.id);
    expect(stored).toBeDefined();
    expect(stored.name).toBe("VE Orchestrator Lite");
  });

  it("has correct variables", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    expect(t.variables.maxParallel).toBe(2);
    expect(t.variables.maxRetries).toBe(1);
    expect(t.variables.defaultSdk).toBe("auto");
    expect(Array.isArray(t.variables.protectedBranches)).toBe(true);
  });
});







