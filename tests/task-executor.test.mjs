import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("../kanban-adapter.mjs", () => ({
  getKanbanAdapter: vi.fn(),
  getKanbanBackendName: vi.fn(() => "vk"),
  listTasks: vi.fn(() => []),
  listProjects: vi.fn(() => [{ id: "proj-1", name: "Test Project" }]),
  getTask: vi.fn(),
  updateTaskStatus: vi.fn(() => Promise.resolve()),
  addComment: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../agent-pool.mjs", () => ({
  launchOrResumeThread: vi.fn(),
  execWithRetry: vi.fn(() =>
    Promise.resolve({ success: true, output: "done", attempts: 1 }),
  ),
  invalidateThread: vi.fn(),
  getActiveThreads: vi.fn(() => []),
  getPoolSdkName: vi.fn(() => "codex"),
  pruneAllExhaustedThreads: vi.fn(() => 0),
  ensureThreadRegistryLoaded: vi.fn(() => Promise.resolve()),
}));

vi.mock("../worktree-manager.mjs", () => {
  const acquireWorktree = vi.fn(() =>
    Promise.resolve({ path: "/fake/worktree", created: true }),
  );
  const releaseWorktree = vi.fn(() => Promise.resolve());
  const getWorktreeStats = vi.fn(() => ({
    active: 0,
    total: 0,
    stale: 0,
    byOwner: {},
  }));

  class WorktreeManager {
    acquireWorktree = acquireWorktree;
    releaseWorktree = releaseWorktree;
    getStats = getWorktreeStats;
  }

  return {
    WorktreeManager,
    acquireWorktree,
    releaseWorktree,
    getWorktreeStats,
  };
});

vi.mock("../task-claims.mjs", () => ({
  initTaskClaims: vi.fn(() => Promise.resolve()),
  claimTask: vi.fn(() => Promise.resolve({ success: true, token: "claim-1" })),
  renewClaim: vi.fn(() => Promise.resolve({ success: true })),
  releaseTask: vi.fn(() => Promise.resolve({ success: true })),
}));

vi.mock("../presence.mjs", () => ({
  initPresence: vi.fn(() => Promise.resolve()),
  getPresenceState: vi.fn(() => ({
    instance_id: "presence-instance-1",
    coordinator_priority: 100,
  })),
}));

vi.mock("../config.mjs", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../git-safety.mjs", () => ({
  evaluateBranchSafetyForPush: vi.fn(() => ({ safe: true })),
  normalizeBaseBranch: vi.fn((baseBranch = "main", remote = "origin") => {
    let branch = String(baseBranch || "main").trim();
    if (!branch) branch = "main";
    branch = branch.replace(/^refs\/heads\//, "");
    branch = branch.replace(/^refs\/remotes\//, "");
    while (branch.startsWith(`${remote}/`)) {
      branch = branch.slice(remote.length + 1);
    }
    if (!branch) branch = "main";
    return { branch, remoteRef: `${remote}/${branch}` };
  }),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  TaskExecutor,
  getTaskExecutor,
  loadExecutorOptionsFromConfig,
  isInternalExecutorEnabled,
  getExecutorMode,
} from "../task-executor.mjs";
import {
  listTasks,
  listProjects,
  getKanbanBackendName,
  updateTaskStatus,
  addComment,
} from "../kanban-adapter.mjs";
import {
  execWithRetry,
  getPoolSdkName,
  getActiveThreads,
  ensureThreadRegistryLoaded,
  invalidateThread,
} from "../agent-pool.mjs";
import { acquireWorktree, releaseWorktree } from "../worktree-manager.mjs";
import {
  claimTask,
  renewClaim,
  releaseTask as releaseTaskClaim,
} from "../task-claims.mjs";
import { initPresence, getPresenceState } from "../presence.mjs";
import { loadConfig } from "../config.mjs";
import { evaluateBranchSafetyForPush } from "../git-safety.mjs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// ── Helpers ─────────────────────────────────────────────────────────────────

const mockTask = {
  id: "task-123-uuid",
  title: "Fix the bug",
  description: "There is a bug that needs fixing",
  status: "todo",
  branchName: "ve/task-123-fix-the-bug",
};

/** Saved env vars to restore after each test. */
const ENV_KEYS = [
  "EXECUTOR_MODE",
  "INTERNAL_EXECUTOR_PARALLEL",
  "INTERNAL_EXECUTOR_POLL_MS",
  "INTERNAL_EXECUTOR_SDK",
  "INTERNAL_EXECUTOR_TIMEOUT_MS",
  "INTERNAL_EXECUTOR_MAX_RETRIES",
  "INTERNAL_EXECUTOR_PROJECT_ID",
  "COPILOT_MODEL",
  "COPILOT_SDK_MODEL",
  "CLAUDE_MODEL",
  "CLAUDE_CODE_MODEL",
  "ANTHROPIC_MODEL",
  "VE_INSTANCE_ID",
  "BOSUN_INSTANCE_ID",
  "INTERNAL_EXECUTOR_REPLENISH_ENABLED",
  "INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS",
  "INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS",
  "PROJECT_REQUIREMENTS_PROFILE",
  "PROJECT_REQUIREMENTS_NOTES",
  "BOSUN_COAUTHOR_MODE",
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe("task-executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  // ────────────────────────────────────────────────────────────────────────
  // Constructor
  // ────────────────────────────────────────────────────────────────────────

  describe("TaskExecutor constructor", () => {
    it("sets default options when none provided", () => {
      const ex = new TaskExecutor();
      expect(ex.mode).toBe("internal");
      expect(ex.maxParallel).toBe(3);
      expect(ex.pollIntervalMs).toBe(30_000);
      expect(ex.sdk).toBe("auto");
      expect(ex.taskTimeoutMs).toBe(6 * 60 * 60 * 1000);
      expect(ex.maxRetries).toBe(2);
      expect(ex.autoCreatePr).toBe(true);
      expect(ex.projectId).toBeNull();
    });

    it("overrides defaults with provided options", () => {
      const ex = new TaskExecutor({
        mode: "internal",
        maxParallel: 5,
        sdk: "copilot",
        projectId: "proj-42",
      });
      expect(ex.mode).toBe("internal");
      expect(ex.maxParallel).toBe(5);
      expect(ex.sdk).toBe("copilot");
      expect(ex.projectId).toBe("proj-42");
      // untouched defaults
      expect(ex.pollIntervalMs).toBe(30_000);
    });

    it("initializes empty _activeSlots Map", () => {
      const ex = new TaskExecutor();
      expect(ex._activeSlots).toBeInstanceOf(Map);
      expect(ex._activeSlots.size).toBe(0);
    });

    it("sets _running to false initially", () => {
      const ex = new TaskExecutor();
      expect(ex._running).toBe(false);
    });

    it("initializes backlog replenishment config and project requirements", () => {
      const ex = new TaskExecutor({
        backlogReplenishment: {
          enabled: true,
          minNewTasks: 2,
          maxNewTasks: 3,
        },
        projectRequirements: {
          profile: "system",
          notes: "cross-module coordination",
        },
      });
      const cfg = ex.getBacklogReplenishmentConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.minNewTasks).toBe(2);
      expect(cfg.maxNewTasks).toBe(3);
      expect(cfg.projectRequirements.profile).toBe("system");
    });

    it("_ensureTaskClaimsInitialized returns false (legacy stub)", async () => {
      const ex = new TaskExecutor();
      const result = await ex._ensureTaskClaimsInitialized();
      expect(result).toBe(false);
    });

    it("keeps explicit instance id when provided in env", () => {
      process.env.VE_INSTANCE_ID = "explicit-instance-1";
      const ex = new TaskExecutor();
      expect(ex._instanceId).toBe("explicit-instance-1");
    });

    it("defaults workflowOwnsTaskLifecycle to true", () => {
      const ex = new TaskExecutor();
      expect(ex.workflowOwnsTaskLifecycle).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // getStatus
  // ────────────────────────────────────────────────────────────────────────

  describe("getStatus", () => {
    it("returns running state", () => {
      const ex = new TaskExecutor();
      expect(ex.getStatus().running).toBe(false);
      ex._running = true;
      expect(ex.getStatus().running).toBe(true);
    });

    it("returns correct mode, maxParallel, sdk", () => {
      const ex = new TaskExecutor({ mode: "hybrid", maxParallel: 7 });
      const status = ex.getStatus();
      expect(status.mode).toBe("hybrid");
      expect(status.maxParallel).toBe(7);
      // sdk "auto" delegates to getPoolSdkName()
      expect(status.sdk).toBe("codex");
      expect(getPoolSdkName).toHaveBeenCalled();
    });

    it("returns empty slots when none active", () => {
      const ex = new TaskExecutor();
      const status = ex.getStatus();
      expect(status.activeSlots).toBe(0);
      expect(status.slots).toEqual([]);
    });

    it("returns correct slot info when tasks are running", () => {
      const ex = new TaskExecutor();
      ex._activeSlots.set("task-abc", {
        taskId: "task-abc",
        taskTitle: "Some task",
        branch: "ve/task-abc-some-task",
        sdk: "codex",
        attempt: 1,
        startedAt: Date.now() - 5000,
        status: "running",
      });

      const status = ex.getStatus();
      expect(status.activeSlots).toBe(1);
      expect(status.slots).toHaveLength(1);
      expect(status.slots[0].taskId).toBe("task-abc");
      expect(status.slots[0].taskTitle).toBe("Some task");
      expect(status.slots[0].status).toBe("running");
      expect(status.slots[0].agentInstanceId).toBeNull();
      expect(status.slots[0].runningFor).toBeGreaterThanOrEqual(4);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // start / stop
  // ────────────────────────────────────────────────────────────────────────

  describe("start / stop", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("start() sets _running to true; skips poll timer when workflow-owned", () => {
      const ex = new TaskExecutor({ pollIntervalMs: 10_000 });
      ex.start();
      expect(ex._running).toBe(true);
      // workflowOwnsTaskLifecycle defaults to true — no poll timer
      expect(ex._pollTimer).toBeNull();
      ex._running = false;
    });

    it("start() creates poll timer when workflowOwnsTaskLifecycle is false", () => {
      const ex = new TaskExecutor({ pollIntervalMs: 10_000, workflowOwnsTaskLifecycle: false });
      ex.start();
      expect(ex._running).toBe(true);
      expect(ex._pollTimer).not.toBeNull();
      ex._running = false;
      clearInterval(ex._pollTimer);
    });

    it("start() waits for thread registry load before in-progress recovery", async () => {
      const ex = new TaskExecutor({ pollIntervalMs: 10_000 });
      let releaseRegistryLoad = null;
      const registryLoadGate = new Promise((resolve) => {
        releaseRegistryLoad = resolve;
      });
      ensureThreadRegistryLoaded.mockReturnValueOnce(registryLoadGate);
      const recoverySpy = vi
        .spyOn(ex, "_recoverInterruptedInProgressTasks")
        .mockResolvedValue(undefined);

      ex.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(recoverySpy).not.toHaveBeenCalled();

      releaseRegistryLoad?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(recoverySpy).toHaveBeenCalledTimes(1);

      ex._running = false;
      clearInterval(ex._pollTimer);
    });

    it("stop() sets _running to false and clears poll timer", async () => {
      const ex = new TaskExecutor({ pollIntervalMs: 60_000 });
      ex.start();
      expect(ex._running).toBe(true);

      const stopPromise = ex.stop();
      // No active slots, should resolve quickly
      await stopPromise;

      expect(ex._running).toBe(false);
      expect(ex._pollTimer).toBeNull();
    });

    it("stop() waits for active slots gracefully", async () => {
      const ex = new TaskExecutor({ pollIntervalMs: 60_000 });
      ex.start();

      // Simulate an active slot
      ex._activeSlots.set("slot-1", {
        taskId: "slot-1",
        taskTitle: "test",
        startedAt: Date.now(),
        status: "running",
      });

      const stopPromise = ex.stop();

      // Advance timers to trigger the 1-second check intervals
      // Then remove the active slot to let stop() finish
      await vi.advanceTimersByTimeAsync(2000);
      ex._activeSlots.delete("slot-1");
      await vi.advanceTimersByTimeAsync(2000);

      await stopPromise;
      expect(ex._running).toBe(false);
    });
  });

  describe("in-progress recovery", () => {
    it("resumes fresh in-progress tasks on startup recovery", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2 });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "resume-1",
          title: "Resume this",
          status: "inprogress",
          updated_at: new Date().toISOString(),
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);

      await ex._recoverInterruptedInProgressTasks();

      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: "resume-1" }),
        expect.objectContaining({ recoveredFromInProgress: true }),
      );
    });

    it("moves stale in-progress tasks back to todo when no resumable thread exists", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2 });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);
      const staleTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

      listTasks.mockResolvedValueOnce([
        {
          id: "stale-1",
          title: "Old in-progress task",
          status: "inprogress",
          updated_at: staleTs,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).toHaveBeenCalledWith(
        "stale-1",
        "todo",
        expect.any(Object),
      );
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("does not resume in-progress tasks already blocked for no-commit thrash", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2 });
      ex._running = true;
      ex._noCommitCounts.set("blocked-1", 3);
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "blocked-1",
          title: "Blocked task",
          status: "inprogress",
          updated_at: new Date().toISOString(),
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).toHaveBeenCalledWith(
        "blocked-1",
        "todo",
        expect.any(Object),
      );
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("still resumes in-progress tasks when no-commit count is below block threshold", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2 });
      ex._running = true;
      ex._noCommitCounts.set("resume-2", 2);
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "resume-2",
          title: "Still eligible",
          status: "inprogress",
          updated_at: new Date().toISOString(),
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);

      await ex._recoverInterruptedInProgressTasks();

      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: "resume-2" }),
        expect.objectContaining({ recoveredFromInProgress: true }),
      );
      expect(updateTaskStatus).not.toHaveBeenCalledWith(
        "resume-2",
        "todo",
        expect.any(Object),
      );
    });

    it("keeps no-commit block precedence even when a resumable thread exists", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2 });
      ex._running = true;
      ex._noCommitCounts.set("blocked-thread-1", 3);
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "blocked-thread-1",
          title: "Blocked with thread",
          status: "inprogress",
          updated_at: new Date().toISOString(),
        },
      ]);
      getActiveThreads.mockReturnValueOnce([
        { taskKey: "blocked-thread-1" },
      ]);

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).toHaveBeenCalledWith(
        "blocked-thread-1",
        "todo",
        expect.any(Object),
      );
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("does not crash recovery when resetting blocked no-commit task fails", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2 });
      ex._running = true;
      ex._noCommitCounts.set("blocked-err-1", 3);
      ex._slotRuntimeState.set("blocked-err-1", {
        taskId: "blocked-err-1",
        taskTitle: "Blocked task",
        branch: "ve/blocked-err-1",
        sdk: "codex",
        attempt: 0,
        startedAt: Date.now(),
        status: "running",
      });
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);
      updateTaskStatus.mockRejectedValueOnce(new Error("VK unavailable"));

      listTasks.mockResolvedValueOnce([
        {
          id: "blocked-err-1",
          title: "Blocked task",
          status: "inprogress",
          updated_at: new Date().toISOString(),
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);

      await expect(ex._recoverInterruptedInProgressTasks()).resolves.toBeUndefined();

      expect(updateTaskStatus).toHaveBeenCalledWith(
        "blocked-err-1",
        "todo",
        expect.any(Object),
      );
      expect(ex._slotRuntimeState.has("blocked-err-1")).toBe(false);
      expect(executeSpy).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // _pollLoop guards
  // [LEGACY TESTS REMOVED] "_pollLoop guards" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  // [LEGACY TESTS REMOVED] "claim renewal helpers" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  // ────────────────────────────────────────────────────────────────────────
  // executeTask
  // [LEGACY TESTS REMOVED] "executeTask" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  // [LEGACY TESTS REMOVED] "prompt enrichment" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  // [LEGACY TESTS REMOVED] "backlog replenishment diagnostics" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  // [LEGACY TESTS REMOVED] "planner result handling" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  // ────────────────────────────────────────────────────────────────────────
  // loadExecutorOptionsFromConfig
  // [LEGACY TESTS REMOVED] "anti-thrash key normalization" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  describe("loadExecutorOptionsFromConfig", () => {
    it("returns defaults when nothing configured", () => {
      loadConfig.mockReturnValue({});
      const opts = loadExecutorOptionsFromConfig();
      expect(opts.mode).toBe("internal");
      expect(opts.maxParallel).toBe(3);
      expect(opts.sdk).toBe("auto");
      expect(opts.maxRetries).toBe(2);
    });

    it("reads from env vars", () => {
      process.env.EXECUTOR_MODE = "internal";
      process.env.INTERNAL_EXECUTOR_PARALLEL = "8";
      process.env.INTERNAL_EXECUTOR_SDK = "copilot";
      loadConfig.mockReturnValue({});

      const opts = loadExecutorOptionsFromConfig();
      expect(opts.mode).toBe("internal");
      expect(opts.maxParallel).toBe(8);
      expect(opts.sdk).toBe("copilot");
    });

    it("reads from config.internalExecutor", () => {
      loadConfig.mockReturnValue({
        internalExecutor: {
          mode: "hybrid",
          maxParallel: 4,
          sdk: "claude",
          maxRetries: 5,
        },
      });

      const opts = loadExecutorOptionsFromConfig();
      expect(opts.mode).toBe("hybrid");
      expect(opts.maxParallel).toBe(4);
      expect(opts.sdk).toBe("claude");
      expect(opts.maxRetries).toBe(5);
    });

    it("env vars take priority over config", () => {
      process.env.EXECUTOR_MODE = "internal";
      process.env.INTERNAL_EXECUTOR_PARALLEL = "10";
      loadConfig.mockReturnValue({
        internalExecutor: {
          mode: "hybrid",
          maxParallel: 2,
        },
      });

      const opts = loadExecutorOptionsFromConfig();
      expect(opts.mode).toBe("internal");
      expect(opts.maxParallel).toBe(10);
    });

    it("validates mode values — uses env when set", () => {
      process.env.EXECUTOR_MODE = "vk";
      loadConfig.mockReturnValue({
        internalExecutor: { mode: "internal" },
      });

      const opts = loadExecutorOptionsFromConfig();
      expect(opts.mode).toBe("vk");
    });

    it("reads from config.taskExecutor as fallback key", () => {
      loadConfig.mockReturnValue({
        taskExecutor: { mode: "internal", maxParallel: 6 },
      });

      const opts = loadExecutorOptionsFromConfig();
      expect(opts.mode).toBe("internal");
      expect(opts.maxParallel).toBe(6);
    });

    it("handles loadConfig throwing", () => {
      loadConfig.mockImplementation(() => {
        throw new Error("config missing");
      });

      const opts = loadExecutorOptionsFromConfig();
      expect(opts.mode).toBe("internal");
      expect(opts.maxParallel).toBe(3);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // isInternalExecutorEnabled
  // ────────────────────────────────────────────────────────────────────────

  describe("isInternalExecutorEnabled", () => {
    it("returns true for EXECUTOR_MODE=internal", () => {
      process.env.EXECUTOR_MODE = "internal";
      expect(isInternalExecutorEnabled()).toBe(true);
    });

    it("returns true for EXECUTOR_MODE=hybrid", () => {
      process.env.EXECUTOR_MODE = "hybrid";
      expect(isInternalExecutorEnabled()).toBe(true);
    });

    it("returns false for EXECUTOR_MODE=vk", () => {
      process.env.EXECUTOR_MODE = "vk";
      expect(isInternalExecutorEnabled()).toBe(false);
    });

    it("falls back to config when env var not set", () => {
      loadConfig.mockReturnValue({
        internalExecutor: { mode: "internal" },
      });
      expect(isInternalExecutorEnabled()).toBe(true);
    });

    it("falls back to config.taskExecutor", () => {
      loadConfig.mockReturnValue({
        taskExecutor: { mode: "hybrid" },
      });
      expect(isInternalExecutorEnabled()).toBe(true);
    });

    it("returns false when nothing configured", () => {
      loadConfig.mockReturnValue({});
      expect(isInternalExecutorEnabled()).toBe(false);
    });

    it("returns false when loadConfig throws", () => {
      loadConfig.mockImplementation(() => {
        throw new Error("oops");
      });
      expect(isInternalExecutorEnabled()).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // getExecutorMode
  // ────────────────────────────────────────────────────────────────────────

  describe("getExecutorMode", () => {
    it("returns env EXECUTOR_MODE when valid", () => {
      process.env.EXECUTOR_MODE = "internal";
      expect(getExecutorMode()).toBe("internal");
    });

    it("returns hybrid from env", () => {
      process.env.EXECUTOR_MODE = "hybrid";
      expect(getExecutorMode()).toBe("hybrid");
    });

    it("falls through to config when env invalid", () => {
      process.env.EXECUTOR_MODE = "bogus";
      loadConfig.mockReturnValue({
        internalExecutor: { mode: "internal" },
      });
      expect(getExecutorMode()).toBe("internal");
    });

    it("returns 'internal' as default", () => {
      loadConfig.mockReturnValue({});
      expect(getExecutorMode()).toBe("internal");
    });

    it("returns 'internal' when loadConfig throws", () => {
      loadConfig.mockImplementation(() => {
        throw new Error("fail");
      });
      expect(getExecutorMode()).toBe("internal");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // branch safety guard
  // [LEGACY TESTS REMOVED] "branch safety guard" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  // ────────────────────────────────────────────────────────────────────────
  // getTaskExecutor singleton
  // ────────────────────────────────────────────────────────────────────────

  describe("getTaskExecutor singleton", () => {
    // The module-level _instance can't be reset without vi.resetModules().
    // We test basic behavior and then re-import for isolation.

    it("returns a TaskExecutor instance", async () => {
      // Use dynamic import with resetModules to get a fresh module
      vi.resetModules();

      // Re-apply mocks for the fresh module
      vi.doMock("../kanban-adapter.mjs", () => ({
        getKanbanAdapter: vi.fn(),
        listTasks: vi.fn(() => []),
        listProjects: vi.fn(() => []),
        getTask: vi.fn(),
        updateTaskStatus: vi.fn(),
      }));
      vi.doMock("../agent-pool.mjs", () => ({
        launchOrResumeThread: vi.fn(),
        execWithRetry: vi.fn(() => Promise.resolve({ success: true })),
        invalidateThread: vi.fn(),
        getActiveThreads: vi.fn(() => []),
        getPoolSdkName: vi.fn(() => "codex"),
      }));
      vi.doMock("../worktree-manager.mjs", () => ({
        acquireWorktree: vi.fn(),
        releaseWorktree: vi.fn(),
        getWorktreeStats: vi.fn(() => ({ active: 0, total: 0 })),
      }));
      vi.doMock("../config.mjs", () => ({
        loadConfig: vi.fn(() => ({})),
      }));
      vi.doMock("node:child_process", () => ({
        execSync: vi.fn(() => ""),
        spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      }));
      vi.doMock("node:fs", () => ({
        readFileSync: vi.fn(() => ""),
        existsSync: vi.fn(() => false),
      }));

      const mod = await import("../task-executor.mjs");
      const inst = mod.getTaskExecutor({ mode: "vk" });
      expect(inst).toBeInstanceOf(mod.TaskExecutor);
    });

    it("returns same instance on second call", async () => {
      vi.resetModules();

      vi.doMock("../kanban-adapter.mjs", () => ({
        getKanbanAdapter: vi.fn(),
        listTasks: vi.fn(() => []),
        listProjects: vi.fn(() => []),
        getTask: vi.fn(),
        updateTaskStatus: vi.fn(),
      }));
      vi.doMock("../agent-pool.mjs", () => ({
        launchOrResumeThread: vi.fn(),
        execWithRetry: vi.fn(() => Promise.resolve({ success: true })),
        invalidateThread: vi.fn(),
        getActiveThreads: vi.fn(() => []),
        getPoolSdkName: vi.fn(() => "codex"),
      }));
      vi.doMock("../worktree-manager.mjs", () => ({
        acquireWorktree: vi.fn(),
        releaseWorktree: vi.fn(),
        getWorktreeStats: vi.fn(() => ({ active: 0, total: 0 })),
      }));
      vi.doMock("../config.mjs", () => ({
        loadConfig: vi.fn(() => ({})),
      }));
      vi.doMock("node:child_process", () => ({
        execSync: vi.fn(() => ""),
        spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      }));
      vi.doMock("node:fs", () => ({
        readFileSync: vi.fn(() => ""),
        existsSync: vi.fn(() => false),
      }));

      const mod = await import("../task-executor.mjs");
      const first = mod.getTaskExecutor({ mode: "internal" });
      const second = mod.getTaskExecutor({ mode: "hybrid" });
      expect(first).toBe(second);
      // Mode should be from the first call
      expect(first.mode).toBe("internal");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Legacy stubs — verify gutted methods return expected no-op values
  // ────────────────────────────────────────────────────────────────────────

  describe("legacy method stubs", () => {
    it("executeTask returns legacy_removed stub", async () => {
      const ex = new TaskExecutor();
      const result = await ex.executeTask({ id: "test-1", title: "Test" });
      expect(result).toEqual({ skipped: true, reason: "legacy_removed" });
    });

    it("_pollLoop is a no-op", async () => {
      const ex = new TaskExecutor();
      ex._running = true;
      await ex._pollLoop();
      // Should return without error
      expect(listTasks).not.toHaveBeenCalled();
    });

    it("_buildTaskPrompt returns empty string", () => {
      const ex = new TaskExecutor();
      expect(ex._buildTaskPrompt({}, "/fake")).toBe("");
    });

    it("_pushBranch returns legacy_removed", () => {
      const ex = new TaskExecutor();
      const result = ex._pushBranch("/fake", "branch");
      expect(result).toEqual({ success: false, reason: "legacy_removed" });
    });

    it("_hasUnpushedCommits returns false", () => {
      const ex = new TaskExecutor();
      expect(ex._hasUnpushedCommits("/fake")).toBe(false);
    });

    it("_shouldAutoResume returns false", () => {
      const ex = new TaskExecutor();
      expect(ex._shouldAutoResume("t1", "test")).toBe(false);
    });

    it("_createPR returns null", async () => {
      const ex = new TaskExecutor();
      expect(await ex._createPR({}, "/fake")).toBeNull();
    });
  });

  // [LEGACY TESTS REMOVED] — All execution pipeline tests have been replaced
  // by comprehensive workflow node tests in tests/workflow-task-lifecycle.test.mjs
});
