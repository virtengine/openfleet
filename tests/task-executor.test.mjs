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

vi.mock("../worktree-manager.mjs", () => ({
  acquireWorktree: vi.fn(() =>
    Promise.resolve({ path: "/fake/worktree", created: true }),
  ),
  releaseWorktree: vi.fn(() => Promise.resolve()),
  getWorktreeStats: vi.fn(() => ({ active: 0, total: 0 })),
}));

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
} from "../agent-pool.mjs";
import { acquireWorktree, releaseWorktree } from "../worktree-manager.mjs";
import { claimTask, releaseTask as releaseTaskClaim } from "../task-claims.mjs";
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
  "OPENFLEET_INSTANCE_ID",
  "INTERNAL_EXECUTOR_REPLENISH_ENABLED",
  "INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS",
  "INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS",
  "PROJECT_REQUIREMENTS_PROFILE",
  "PROJECT_REQUIREMENTS_NOTES",
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

    it("adopts stable presence instance id when no explicit id is configured", async () => {
      const ex = new TaskExecutor();
      getPresenceState.mockReturnValueOnce({
        instance_id: "stable-instance-99",
        coordinator_priority: 50,
      });

      await ex._ensureTaskClaimsInitialized();

      expect(initPresence).toHaveBeenCalled();
      expect(ex._instanceId).toBe("stable-instance-99");
    });

    it("keeps explicit instance id when provided in env", async () => {
      process.env.VE_INSTANCE_ID = "explicit-instance-1";
      const ex = new TaskExecutor();
      getPresenceState.mockReturnValueOnce({
        instance_id: "stable-instance-99",
        coordinator_priority: 50,
      });

      await ex._ensureTaskClaimsInitialized();

      expect(ex._instanceId).toBe("explicit-instance-1");
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

    it("start() sets _running to true and creates poll timer", () => {
      const ex = new TaskExecutor({ pollIntervalMs: 10_000 });
      ex.start();
      expect(ex._running).toBe(true);
      expect(ex._pollTimer).not.toBeNull();
      // cleanup
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

      expect(updateTaskStatus).toHaveBeenCalledWith("stale-1", "todo");
      expect(executeSpy).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // _pollLoop guards
  // ────────────────────────────────────────────────────────────────────────

  describe("_pollLoop guards", () => {
    it("skips when _running is false", async () => {
      const ex = new TaskExecutor();
      ex._running = false;
      await ex._pollLoop();
      expect(listProjects).not.toHaveBeenCalled();
      expect(listTasks).not.toHaveBeenCalled();
    });

    it("skips when _pollInProgress is true", async () => {
      const ex = new TaskExecutor();
      ex._running = true;
      ex._pollInProgress = true;
      await ex._pollLoop();
      expect(listProjects).not.toHaveBeenCalled();
    });

    it("skips when slots are full", async () => {
      const ex = new TaskExecutor({ maxParallel: 1 });
      ex._running = true;
      ex._activeSlots.set("existing", { taskId: "existing" });
      await ex._pollLoop();
      expect(listProjects).not.toHaveBeenCalled();
    });

    it("resolves project ID on first poll from listProjects", async () => {
      const ex = new TaskExecutor();
      ex._running = true;
      listProjects.mockResolvedValueOnce([
        { id: "auto-proj", name: "Auto Detected" },
      ]);
      listTasks.mockResolvedValueOnce([]);

      await ex._pollLoop();

      expect(listProjects).toHaveBeenCalled();
      expect(ex._resolvedProjectId).toBe("auto-proj");
    });

    it("uses provided projectId without calling listProjects", async () => {
      const ex = new TaskExecutor({ projectId: "my-proj" });
      ex._running = true;
      listTasks.mockResolvedValueOnce([]);

      await ex._pollLoop();

      expect(listProjects).not.toHaveBeenCalled();
      expect(ex._resolvedProjectId).toBe("my-proj");
    });

    it("resets _pollInProgress even on error", async () => {
      const ex = new TaskExecutor({ projectId: "p1" });
      ex._running = true;
      listTasks.mockRejectedValueOnce(new Error("network"));

      await ex._pollLoop();
      expect(ex._pollInProgress).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // executeTask
  // ────────────────────────────────────────────────────────────────────────

  describe("executeTask", () => {
    beforeEach(() => {
      existsSync.mockReturnValue(true);
    });

    it("allocates a slot for the task", async () => {
      const ex = new TaskExecutor();
      const promise = ex.executeTask({ ...mockTask });
      // Slot should be set immediately (synchronous part)
      expect(ex._activeSlots.has("task-123-uuid")).toBe(true);
      expect(ex._activeSlots.get("task-123-uuid")?.agentInstanceId).toBeTypeOf(
        "number",
      );
      await promise;
    });

    it("reuses persisted slot runtime metadata for in-progress recovery", async () => {
      const ex = new TaskExecutor();
      const recoveredStartedAt = Date.now() - 20_000;
      ex._slotRuntimeState.set("task-123-uuid", {
        taskId: "task-123-uuid",
        taskTitle: "Fix the bug",
        branch: "ve/task-123-fix-the-bug",
        sdk: "codex",
        attempt: 0,
        startedAt: recoveredStartedAt,
        agentInstanceId: 41,
        status: "running",
        updatedAt: Date.now(),
      });

      const promise = ex.executeTask({ ...mockTask, status: "inprogress" });
      const slot = ex._activeSlots.get("task-123-uuid");
      expect(slot?.agentInstanceId).toBe(41);
      expect(slot?.startedAt).toBe(recoveredStartedAt);
      await promise;
    });

    it("calls updateTaskStatus with inprogress", async () => {
      const ex = new TaskExecutor();
      await ex.executeTask({ ...mockTask });
      expect(updateTaskStatus).toHaveBeenCalledWith(
        "task-123-uuid",
        "inprogress",
      );
    });

    it("skips execution when task is claimed by another orchestrator", async () => {
      claimTask.mockResolvedValueOnce({
        success: false,
        error: "task_already_claimed",
        existing_instance: "other-orchestrator-42",
        existing_claim: {
          claimed_at: "2026-02-13T09:00:00.000Z",
          expires_at: "2026-02-13T10:00:00.000Z",
        },
      });

      const onTaskFailed = vi.fn();
      const ex = new TaskExecutor({ onTaskFailed });
      await ex.executeTask({
        ...mockTask,
        backend: "github",
        externalId: "#123",
      });

      expect(execWithRetry).not.toHaveBeenCalled();
      expect(onTaskFailed).not.toHaveBeenCalled();
      expect(updateTaskStatus).not.toHaveBeenCalledWith(
        "task-123-uuid",
        "inprogress",
      );
      expect(addComment).toHaveBeenCalledWith(
        "123",
        expect.stringContaining("Task Deferred"),
      );
      expect(releaseTaskClaim).not.toHaveBeenCalled();
    });

    it("calls acquireWorktree with correct branch", async () => {
      const ex = new TaskExecutor();
      await ex.executeTask({ ...mockTask });
      expect(acquireWorktree).toHaveBeenCalledWith(
        "ve/task-123-fix-the-bug",
        "task-123-uuid",
        expect.objectContaining({ owner: "task-executor" }),
      );
    });

    it("calls execWithRetry with built prompt", async () => {
      const ex = new TaskExecutor();
      await ex.executeTask({ ...mockTask });
      expect(execWithRetry).toHaveBeenCalledWith(
        expect.stringContaining("Fix the bug"),
        expect.objectContaining({
          taskKey: "task-123-uuid",
          cwd: "/fake/worktree",
        }),
      );
    });

    it("forwards COPILOT_MODEL override to background agent execution", async () => {
      process.env.COPILOT_MODEL = "gpt-5.3-codex";
      const ex = new TaskExecutor({ sdk: "auto" });
      ex._executorScheduler = {
        next: () => ({
          name: "copilot-default",
          executor: "COPILOT",
          variant: "DEFAULT",
          weight: 100,
          role: "primary",
          enabled: true,
        }),
        recordSuccess: vi.fn(),
        recordFailure: vi.fn(),
      };

      await ex.executeTask({ ...mockTask });

      expect(execWithRetry).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          sdk: "copilot",
          model: "gpt-5.3-codex",
        }),
      );
    });

    it("uses complexity-routed Copilot model when no env override is set", async () => {
      delete process.env.COPILOT_MODEL;
      delete process.env.COPILOT_SDK_MODEL;
      const ex = new TaskExecutor({ sdk: "auto" });
      ex._executorScheduler = {
        next: () => ({
          name: "copilot-default",
          executor: "COPILOT",
          variant: "DEFAULT",
          weight: 100,
          role: "primary",
          enabled: true,
        }),
        recordSuccess: vi.fn(),
        recordFailure: vi.fn(),
      };

      await ex.executeTask({ ...mockTask });

      expect(execWithRetry).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          sdk: "copilot",
          model: "sonnet-4.5",
        }),
      );
    });

    it("releases slot and worktree after completion", async () => {
      const ex = new TaskExecutor();
      await ex.executeTask({ ...mockTask });
      expect(releaseWorktree).toHaveBeenCalledWith("task-123-uuid");
      expect(releaseTaskClaim).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-123-uuid",
          claimToken: "claim-1",
        }),
      );
      expect(ex._activeSlots.has("task-123-uuid")).toBe(false);
    });

    it("handles failure — calls onTaskFailed callback", async () => {
      execWithRetry.mockResolvedValueOnce({
        success: false,
        attempts: 2,
        error: "tests failed",
      });
      const onTaskFailed = vi.fn();
      const ex = new TaskExecutor({ onTaskFailed });

      await ex.executeTask({ ...mockTask });

      expect(onTaskFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-123-uuid" }),
        expect.objectContaining({ success: false }),
      );
    });

    it("calls onTaskFailed when worktree acquisition fails", async () => {
      acquireWorktree.mockRejectedValueOnce(new Error("no space"));
      const onTaskFailed = vi.fn();
      const ex = new TaskExecutor({ onTaskFailed });

      await ex.executeTask({ ...mockTask });

      expect(onTaskFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-123-uuid" }),
        expect.any(Error),
      );
      // Slot should be cleaned up
      expect(ex._activeSlots.has("task-123-uuid")).toBe(false);
    });

    it("generates branch name from task id and title when branchName missing", async () => {
      const task = {
        id: "abcd1234-uuid",
        title: "Add New Feature!",
        description: "desc",
        status: "todo",
      };
      const ex = new TaskExecutor();
      await ex.executeTask(task);

      // Branch should be auto-generated: ve/<first-8-of-id>-<slug>
      expect(acquireWorktree).toHaveBeenCalledWith(
        expect.stringMatching(/^ve\/abcd1234-add-new-feature/),
        "abcd1234-uuid",
        expect.any(Object),
      );
    });
  });

  describe("prompt enrichment", () => {
    it("injects backlog replenishment instructions when experimental mode is enabled", () => {
      const ex = new TaskExecutor({
        repoSlug: "virtengine/virtengine",
        backlogReplenishment: {
          enabled: true,
          minNewTasks: 1,
          maxNewTasks: 2,
        },
        projectRequirements: {
          profile: "large-feature",
          notes: "optimize adjacent modules",
        },
      });

      spawnSync.mockReturnValueOnce({ stdout: "ve/test-branch\n" });
      const prompt = ex._buildTaskPrompt(
        {
          id: "task-abc",
          title: "Implement feature",
          description: "Do the work",
          status: "todo",
        },
        "/fake/worktree",
      );

      expect(prompt).toContain("Experimental Backlog Replenishment");
      expect(prompt).toContain("openfleet-backlog");
      expect(prompt).toContain("Project requirements profile: large-feature");
    });
  });

  describe("planner result handling", () => {
    it("marks planner task done when no commits but planner created backlog tasks", async () => {
      const onTaskCompleted = vi.fn();
      const sendTelegram = vi.fn();
      const ex = new TaskExecutor({ onTaskCompleted, sendTelegram });
      const task = {
        id: "planner-1",
        title: "Plan next tasks (nightly)",
        description: "Task Planner — Auto-created by openfleet",
      };
      ex._noCommitCounts.set(task.id, 2);
      ex._skipUntil.set(task.id, Date.now() + 60_000);
      vi.spyOn(ex, "_hasUnpushedCommits").mockReturnValue(false);
      vi.spyOn(ex, "_verifyPlannerTaskCompletion").mockResolvedValue({
        completed: true,
        createdCount: 2,
        sampleTitles: ["Task A", "Task B"],
      });

      await ex._handleTaskResult(
        task,
        { success: true, attempts: 1, output: "planner output" },
        "/fake/worktree",
        { agentMadeNewCommits: false },
      );

      expect(updateTaskStatus).toHaveBeenCalledWith("planner-1", "done");
      expect(updateTaskStatus).not.toHaveBeenCalledWith("planner-1", "todo");
      expect(ex._noCommitCounts.has("planner-1")).toBe(false);
      expect(ex._skipUntil.has("planner-1")).toBe(false);
      expect(onTaskCompleted).toHaveBeenCalledWith(
        task,
        expect.objectContaining({ success: true }),
      );
      expect(sendTelegram).toHaveBeenCalledWith(
        expect.stringContaining("Planner task completed"),
      );
    });

    it("keeps no-commit cooldown flow when planner produced no backlog tasks", async () => {
      const ex = new TaskExecutor();
      const task = {
        id: "planner-2",
        title: "Task planner follow-up",
        description: "Task Planner — Auto-created by openfleet",
      };
      vi.spyOn(ex, "_hasUnpushedCommits").mockReturnValue(false);
      vi.spyOn(ex, "_verifyPlannerTaskCompletion").mockResolvedValue({
        completed: false,
        createdCount: 0,
      });

      await ex._handleTaskResult(
        task,
        { success: true, attempts: 1, output: "no tasks generated" },
        "/fake/worktree",
        { agentMadeNewCommits: false },
      );

      expect(updateTaskStatus).toHaveBeenCalledWith("planner-2", "todo");
      expect(updateTaskStatus).not.toHaveBeenCalledWith("planner-2", "done");
      expect(ex._noCommitCounts.get("planner-2")).toBe(1);
      expect(ex._skipUntil.has("planner-2")).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // loadExecutorOptionsFromConfig
  // ────────────────────────────────────────────────────────────────────────

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
  // ────────────────────────────────────────────────────────────────────────

  describe("branch safety guard", () => {
    it("blocks push when branch safety check fails", () => {
      const ex = new TaskExecutor();
      evaluateBranchSafetyForPush.mockReturnValueOnce({
        safe: false,
        reason: "unsafe diff signature",
      });

      const result = ex._pushBranch("/fake/worktree", "ve/bad-branch");

      expect(result.success).toBe(false);
      expect(result.error).toContain("unsafe diff signature");
      const pushCall = spawnSync.mock.calls.find(
        ([bin, args]) => bin === "git" && args[0] === "push",
      );
      expect(pushCall).toBeUndefined();
    });

    it("blocks PR creation before push when branch safety fails", async () => {
      const ex = new TaskExecutor();
      evaluateBranchSafetyForPush.mockReturnValueOnce({
        safe: false,
        reason: "unsafe diff signature",
      });

      const pr = await ex._createPR(
        {
          id: "task-123-uuid",
          title: "Bad branch",
          branchName: "ve/bad-branch",
        },
        "/fake/worktree",
      );
      expect(pr).toBeNull();

      const pushCall = spawnSync.mock.calls.find(
        ([bin, args]) => bin === "git" && args[0] === "push",
      );
      expect(pushCall).toBeUndefined();
    });

    it("adds issue-closing keywords for GitHub-backed tasks", async () => {
      getKanbanBackendName.mockReturnValue("github");
      const ex = new TaskExecutor({ repoSlug: "acme/widgets" });

      spawnSync.mockImplementation((bin, args) => {
        if (bin === "gh" && args[0] === "pr" && args[1] === "list") {
          return { status: 0, stdout: "[]", stderr: "" };
        }
        if (bin === "gh" && args[0] === "pr" && args[1] === "create") {
          return {
            status: 0,
            stdout: "https://github.com/acme/widgets/pull/77\n",
            stderr: "",
          };
        }
        if (bin === "git" && args[0] === "diff" && args[1] === "--name-only") {
          return { status: 0, stdout: "src/app.ts\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });

      const pr = await ex._createPR(
        {
          id: "123",
          title: "feat: test github issue linking",
          description: "desc",
          branchName: "ve/test-issue-linking",
          backend: "github",
        },
        "/fake/worktree",
      );

      expect(pr?.prNumber).toBe("77");
      const prCreateCall = spawnSync.mock.calls.find(
        ([bin, args]) =>
          bin === "gh" && args[0] === "pr" && args[1] === "create",
      );
      expect(prCreateCall).toBeTruthy();
      const createArgs = prCreateCall[1];
      const bodyArg = createArgs[createArgs.indexOf("--body") + 1];
      expect(bodyArg).toContain("Closes #123");
      expect(bodyArg).toContain("- GitHub Issue: #123");
    });
  });

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
  // _pollLoop task dispatching
  // ────────────────────────────────────────────────────────────────────────

  describe("_pollLoop task dispatching", () => {
    it("dispatches eligible tasks up to maxParallel", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2 });
      ex._running = true;
      existsSync.mockReturnValue(true);

      listTasks.mockResolvedValueOnce([
        {
          id: "t1",
          title: "Task 1",
          status: "todo",
          branchName: "ve/t1",
          backend: "vk",
        },
        {
          id: "t2",
          title: "Task 2",
          status: "todo",
          branchName: "ve/t2",
          backend: "vk",
        },
        {
          id: "t3",
          title: "Task 3",
          status: "todo",
          branchName: "ve/t3",
          backend: "vk",
        },
      ]);

      await ex._pollLoop();

      // Should dispatch at most maxParallel (2) tasks
      // Wait a tick for the fire-and-forget executeTask promises
      await new Promise((r) => setTimeout(r, 50));
      expect(updateTaskStatus).toHaveBeenCalledWith("t1", "inprogress");
      expect(updateTaskStatus).toHaveBeenCalledWith("t2", "inprogress");
    });

    it("skips tasks already in active slots", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 5 });
      ex._running = true;
      ex._activeSlots.set("t1", { taskId: "t1" });

      listTasks.mockResolvedValueOnce([
        {
          id: "t1",
          title: "Task 1",
          status: "todo",
          branchName: "ve/t1",
          backend: "vk",
        },
        {
          id: "t2",
          title: "Task 2",
          status: "todo",
          branchName: "ve/t2",
          backend: "vk",
        },
      ]);

      existsSync.mockReturnValue(true);
      await ex._pollLoop();
      await new Promise((r) => setTimeout(r, 50));

      // t1 was already in slots, should not be dispatched again
      expect(updateTaskStatus).not.toHaveBeenCalledWith("t1", "inprogress");
      expect(updateTaskStatus).toHaveBeenCalledWith("t2", "inprogress");
    });

    it("skips tasks in cooldown", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 5 });
      ex._running = true;
      // Set cooldown just now → within COOLDOWN_MS window
      ex._taskCooldowns.set("t1", Date.now());

      listTasks.mockResolvedValueOnce([
        { id: "t1", title: "Task 1", status: "todo", branchName: "ve/t1" },
      ]);

      await ex._pollLoop();
      await new Promise((r) => setTimeout(r, 50));

      expect(updateTaskStatus).not.toHaveBeenCalled();
    });

    it("handles no projects found gracefully", async () => {
      const ex = new TaskExecutor();
      ex._running = true;
      listProjects.mockResolvedValueOnce([]);

      await ex._pollLoop();

      expect(listTasks).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // GitHub Issue Tracking
  // ────────────────────────────────────────────────────────────────────────

  describe("GitHub issue tracking", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    });

    it("comments on GitHub issue when task starts (github backend)", async () => {
      getKanbanBackendName.mockReturnValue("github");
      const ex = new TaskExecutor({ maxParallel: 1 });
      ex._running = true;

      // Mock successful workflow: acquire worktree, run agent, done
      const { acquireWorktree: mockAcquire } =
        await import("../worktree-manager.mjs");
      mockAcquire.mockResolvedValueOnce({ path: "/fake/wt", created: true });

      const { execWithRetry: mockExec } = await import("../agent-pool.mjs");
      mockExec.mockResolvedValueOnce({
        success: true,
        output: "done",
        attempts: 1,
      });

      const githubTask = {
        id: "42",
        title: "Fix auth bug",
        description: "Auth is broken",
        status: "todo",
        branchName: "ve/42-fix-auth",
        backend: "github",
      };

      await ex.executeTask(githubTask);

      // Should have called addComment with start info
      expect(addComment).toHaveBeenCalledWith(
        "42",
        expect.stringContaining("Agent Started"),
      );
      expect(addComment).toHaveBeenCalledWith(
        "42",
        expect.stringContaining("ve/42-fix-auth"),
      );
    });

    it("does NOT comment on issue when backend is vk", async () => {
      getKanbanBackendName.mockReturnValue("vk");
      const ex = new TaskExecutor({ maxParallel: 1 });
      ex._running = true;

      const { acquireWorktree: mockAcquire } =
        await import("../worktree-manager.mjs");
      mockAcquire.mockResolvedValueOnce({ path: "/fake/wt", created: true });

      const { execWithRetry: mockExec } = await import("../agent-pool.mjs");
      mockExec.mockResolvedValueOnce({
        success: true,
        output: "done",
        attempts: 1,
      });

      await ex.executeTask({ ...mockTask, backend: "vk" });

      // addComment should NOT have been called for VK backend
      expect(addComment).not.toHaveBeenCalled();
    });

    it("_commentCommitsOnIssue posts commit details for github tasks", async () => {
      getKanbanBackendName.mockReturnValue("github");
      const ex = new TaskExecutor({ repoSlug: "acme/widgets" });

      // Mock git log and diff-tree for commit details
      spawnSync.mockImplementation((bin, args) => {
        if (bin === "git" && args[0] === "log") {
          return {
            status: 0,
            stdout:
              "abc12345|feat: add auth flow\ndef67890|fix: typo in login\n",
            stderr: "",
          };
        }
        if (bin === "git" && args[0] === "diff-tree") {
          return {
            status: 0,
            stdout: "src/auth.ts\nsrc/login.ts\n",
            stderr: "",
          };
        }
        if (bin === "git" && args[0] === "diff" && args[1] === "--stat") {
          return {
            status: 0,
            stdout: " 2 files changed, 50 insertions(+), 10 deletions(-)\n",
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      });

      const pr = {
        url: "https://github.com/acme/widgets/pull/77",
        branch: "ve/42-fix-auth",
        prNumber: "77",
      };

      await ex._commentCommitsOnIssue(
        { id: "42", backend: "github" },
        "/fake/wt",
        { preExecHead: "aaa111", postExecHead: "bbb222" },
        pr,
      );

      expect(addComment).toHaveBeenCalledTimes(1);
      const commentBody = addComment.mock.calls[0][1];
      expect(commentBody).toContain("Agent Completed");
      expect(commentBody).toContain("pull/77");
      expect(commentBody).toContain("abc12345");
      expect(commentBody).toContain("feat: add auth flow");
      expect(commentBody).toContain("src/auth.ts");
    });

    it("_commentCommitsOnIssue skips for non-github backend", async () => {
      getKanbanBackendName.mockReturnValue("vk");
      const ex = new TaskExecutor();

      await ex._commentCommitsOnIssue(
        { id: "some-uuid", backend: "vk" },
        "/fake/wt",
        { preExecHead: "aaa", postExecHead: "bbb" },
        { url: "http://x", branch: "b", prNumber: "1" },
      );

      expect(addComment).not.toHaveBeenCalled();
    });

    it("_closeIssueAfterMerge comments and closes issue", async () => {
      getKanbanBackendName.mockReturnValue("github");
      const ex = new TaskExecutor();

      await ex._closeIssueAfterMerge({ id: "42", backend: "github" }, "77");

      // Should comment with merge info
      expect(addComment).toHaveBeenCalledWith(
        "42",
        expect.stringContaining("Issue Resolved"),
      );
      expect(addComment).toHaveBeenCalledWith(
        "42",
        expect.stringContaining("#77"),
      );

      // Should close the issue
      expect(updateTaskStatus).toHaveBeenCalledWith("42", "done");
    });

    it("_closeIssueAfterMerge uses externalId when task id is non-numeric", async () => {
      getKanbanBackendName.mockReturnValue("github");
      const ex = new TaskExecutor();

      await ex._closeIssueAfterMerge(
        {
          id: "28c1b2e9-0e9e-4eeb-83ac-90c80e7f4a2e",
          externalId: "151",
          backend: "github",
        },
        "747",
      );

      expect(addComment).toHaveBeenCalledWith(
        "151",
        expect.stringContaining("Issue Resolved"),
      );
      expect(updateTaskStatus).toHaveBeenCalledWith("151", "done");
    });

    it("_closeIssueAfterMerge skips for non-github backend", async () => {
      getKanbanBackendName.mockReturnValue("vk");
      const ex = new TaskExecutor();

      await ex._closeIssueAfterMerge({ id: "uuid", backend: "vk" }, "10");

      expect(addComment).not.toHaveBeenCalled();
      expect(updateTaskStatus).not.toHaveBeenCalled();
    });

    it("_enableAutoMerge closes issue after direct merge for github tasks", () => {
      getKanbanBackendName.mockReturnValue("github");
      const ex = new TaskExecutor();
      const closeSpy = vi
        .spyOn(ex, "_closeIssueAfterMerge")
        .mockResolvedValue(undefined);

      // First call: auto-merge fails with "clean status"
      // Second call: direct merge succeeds
      let callCount = 0;
      spawnSync.mockImplementation((bin, args) => {
        if (bin === "gh" && args[0] === "pr" && args[1] === "merge") {
          callCount++;
          if (callCount === 1) {
            return {
              status: 1,
              stdout: "",
              stderr: "pull request is in clean status",
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });

      ex._enableAutoMerge("77", "/fake/wt", {
        id: "42",
        backend: "github",
      });

      expect(closeSpy).toHaveBeenCalledWith(
        { id: "42", backend: "github" },
        "77",
      );
    });
  });
});
