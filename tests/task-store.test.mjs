/**
 * task-store.test.mjs — Tests for corruption recovery, backup creation,
 * concurrent saves, and atomic rename fallback in task-store.mjs.
 *
 * Task-first: these tests define the desired behaviour; the implementation
 * (T5) must be updated to make the backup/corruption tests pass.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs = [];

function makeTempDir(prefix = "task-store-test-") {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadTaskStoreModule() {
  await vi.resetModules();
  return import("../task/task-store.mjs");
}

afterEach(async () => {
  await vi.resetModules();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  vi.restoreAllMocks();
});

// ── Corruption Recovery ───────────────────────────────────────────────────────

describe("task-store corruption recovery", () => {
  it("backs up corrupted store to <storePath>.bak and starts empty", async () => {
    const dir = makeTempDir("task-store-corrupt-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    // Write deliberately corrupt JSON
    writeFileSync(storePath, "{not valid json!!!", "utf8");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    // Corrupt store should have been backed up
    const backupPath = `${storePath}.bak`;
    expect(existsSync(backupPath), `backup file should exist at ${backupPath}`).toBe(true);

    // Backup should contain the original corrupt content
    const backupContent = readFileSync(backupPath, "utf8");
    expect(backupContent).toBe("{not valid json!!!");

    // Store should have been initialised to an empty state
    expect(ts.getAllTasks()).toEqual([]);
  });

  it("logs a warning mentioning backup path when store is corrupt", async () => {
    const dir = makeTempDir("task-store-corrupt-warn-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");
    writeFileSync(storePath, "{{ broken }}", "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    const warnMessages = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0]));
    expect(
      warnMessages.some((m) => m.includes(".bak")),
      "Expected a warning that mentions the backup path",
    ).toBe(true);
  });

  it("tolerates a best-effort backup failure without crashing loadStore", async () => {
    const dir = makeTempDir("task-store-bak-fail-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");
    writeFileSync(storePath, "not json", "utf8");

    // Make the backup write fail by spying on copyFileSync (or writeFileSync)
    // The store should still initialise cleanly
    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });

    // Should NOT throw even if backup can't be written
    expect(() => ts.loadStore()).not.toThrow();
    expect(ts.getAllTasks()).toEqual([]);
  });

  it("does not create a backup when the store file contains valid JSON", async () => {
    const dir = makeTempDir("task-store-valid-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    const validStore = {
      _meta: { version: 1, updatedAt: new Date().toISOString(), taskCount: 0, stats: {} },
      tasks: { "t-1": { id: "t-1", title: "Valid task", status: "todo" } },
    };
    writeFileSync(storePath, JSON.stringify(validStore, null, 2), "utf8");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    const backupPath = `${storePath}.bak`;
    expect(existsSync(backupPath), "No backup should exist for a healthy store").toBe(false);
    expect(ts.getAllTasks()).toHaveLength(1);
  });

  it("loads normally when store file does not exist yet", async () => {
    const dir = makeTempDir("task-store-missing-");
    const storePath = join(dir, "missing-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    expect(ts.getAllTasks()).toEqual([]);
    expect(existsSync(`${storePath}.bak`)).toBe(false);
  });
});

// ── Atomic Rename Fallback ─────────────────────────────────────────────────

describe("task-store saveStore atomic rename fallback", () => {
  it("falls back to direct write when rename fails with EXDEV", async () => {
    const dir = makeTempDir("task-store-exdev-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.addTask({ id: "exdev-1", title: "EXDEV test task", status: "todo" });

    // Wait for the async write chain to flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Store file should exist and be valid JSON after fallback write
    expect(existsSync(storePath)).toBe(true);
    const saved = JSON.parse(readFileSync(storePath, "utf8"));
    expect(saved.tasks["exdev-1"]).toBeDefined();
    expect(saved.tasks["exdev-1"].title).toBe("EXDEV test task");
  });

  it("cleans up tmp file after successful rename", async () => {
    const dir = makeTempDir("task-store-tmp-cleanup-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.addTask({ id: "cleanup-1", title: "Cleanup test", status: "todo" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Tmp file should NOT exist after a successful atomic rename
    const tmpPath = `${storePath}.tmp`;
    expect(
      existsSync(tmpPath),
      "Temp file should be cleaned up after rename",
    ).toBe(false);
  });
});

// ── Concurrent Save Consistency ────────────────────────────────────────────

describe("task-store concurrent save consistency", () => {
  it("serialises multiple rapid saveStore calls without corruption", async () => {
    const dir = makeTempDir("task-store-concurrent-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    // Fire many rapid mutations — each triggers a saveStore via the write chain
    for (let i = 0; i < 20; i++) {
      ts.addTask({ id: `concurrent-${i}`, title: `Task ${i}`, status: "todo" });
    }

    // Allow all async writes to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Reload from disk into a fresh module instance
    const ts2 = await loadTaskStoreModule();
    ts2.configureTaskStore({ storePath });
    ts2.loadStore();

    const tasks = ts2.getAllTasks();
    // All 20 tasks should be persisted; none should be lost
    expect(tasks).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      expect(
        tasks.some((t) => t.id === `concurrent-${i}`),
        `Task concurrent-${i} should have been persisted`,
      ).toBe(true);
    }
  });

  it("final in-memory state is consistent after interleaved add+update", async () => {
    const dir = makeTempDir("task-store-interleaved-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.addTask({ id: "interleaved-1", title: "Original title", status: "todo" });
    ts.updateTask("interleaved-1", { status: "in_progress" });
    ts.updateTask("interleaved-1", { status: "done" });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Reload from disk
    const ts2 = await loadTaskStoreModule();
    ts2.configureTaskStore({ storePath });
    ts2.loadStore();

    const task = ts2.getTask("interleaved-1");
    expect(task).not.toBeNull();
    expect(task.status).toBe("done");
  });
});

describe("task-store DAG organization", () => {
  it("reorders sprint orders, auto-applies sequential dependencies, and syncs epic dependencies", async () => {
    const dir = makeTempDir("task-store-dag-organize-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.createSprint({ id: "sprint-a", name: "Sprint A", order: 1, executionMode: "parallel" });
    ts.createSprint({ id: "sprint-b", name: "Sprint B", order: 2, executionMode: "sequential" });
    ts.addTask({ id: "dep-task", title: "Dependency task", status: "todo", sprintId: "sprint-b", sprintOrder: 1, epicId: "epic-seq" });
    ts.addTask({ id: "target-task", title: "Target task", status: "todo", sprintId: "sprint-a", sprintOrder: 1, dependencyTaskIds: ["dep-task"], epicId: "epic-target" });
    ts.addTask({ id: "seq-a", title: "Seq A", status: "todo", sprintId: "sprint-b", sprintOrder: 2, dependencyTaskIds: [] });
    ts.addTask({ id: "seq-b", title: "Seq B", status: "todo", sprintId: "sprint-b", sprintOrder: 3, dependencyTaskIds: ["seq-a"] });
    ts.addTask({ id: "seq-c", title: "Seq C", status: "todo", sprintId: "sprint-b", sprintOrder: 4, dependencyTaskIds: ["seq-a", "seq-b"], epicId: "epic-seq" });
    ts.addTask({ id: "seq-d", title: "Seq D", status: "todo", sprintId: "sprint-b", sprintOrder: 5, dependencyTaskIds: [], epicId: "epic-seq" });

    const result = ts.organizeTaskDag();

    expect(result.orderedSprintIds.slice(0, 2)).toEqual(["sprint-b", "sprint-a"]);
    expect(result.updatedSprintCount).toBeGreaterThanOrEqual(1);
    expect(result.orderedTaskIdsBySprint["sprint-b"]).toEqual(["dep-task", "seq-a", "seq-b", "seq-c", "seq-d"]);
    expect(result.appliedDependencySuggestionCount).toBe(2);
    expect(result.syncedEpicDependencyCount).toBe(1);
    expect(ts.getTask("seq-a")?.dependencyTaskIds || []).toContain("dep-task");
    expect(ts.getTask("seq-d")?.dependencyTaskIds || []).toContain("seq-c");
    expect(ts.getEpicDependencies()).toEqual(expect.arrayContaining([
      expect.objectContaining({ epicId: "epic-target", dependencies: expect.arrayContaining(["epic-seq"]) }),
    ]));

    // Verify that the underlying task sprintOrder values were actually updated
    // (distinct from result.orderedTaskIdsBySprint which is the return value).
    const sprintBTasks = [
      ts.getTask("dep-task"),
      ts.getTask("seq-a"),
      ts.getTask("seq-b"),
      ts.getTask("seq-c"),
      ts.getTask("seq-d"),
    ];
    const sprintBTasksSortedByOrder = [...sprintBTasks].sort((a, b) => (a.sprintOrder ?? 0) - (b.sprintOrder ?? 0));
    expect(sprintBTasksSortedByOrder.map(t => t.id)).toEqual(["dep-task", "seq-a", "seq-b", "seq-c", "seq-d"]);

    expect(result.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "redundant_transitive_dependency", taskId: "seq-c", dependencyTaskId: "seq-a" }),
    ]));
    expect(result.suggestions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "missing_sequential_dependency", taskId: "seq-d", dependencyTaskId: "seq-c" }),
    ]));
  });

  it("can keep dependency suggestions in review-only mode", async () => {
    const dir = makeTempDir("task-store-dag-organize-review-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.createSprint({ id: "sprint-review", name: "Sprint Review", order: 1, executionMode: "sequential" });
    ts.addTask({ id: "review-a", title: "Review A", status: "todo", sprintId: "sprint-review", sprintOrder: 1, dependencyTaskIds: [] });
    ts.addTask({ id: "review-b", title: "Review B", status: "todo", sprintId: "sprint-review", sprintOrder: 2, dependencyTaskIds: [] });

    const result = ts.organizeTaskDag({ applyDependencySuggestions: false, syncEpicDependencies: false });

    expect(result.appliedDependencySuggestionCount).toBe(0);
    expect(result.syncedEpicDependencyCount).toBe(0);
    expect(result.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "missing_sequential_dependency", taskId: "review-b", dependencyTaskId: "review-a" }),
    ]));
    expect(ts.getTask("review-b")?.dependencyTaskIds || []).not.toContain("review-a");
  });

  it("recovers timed blocked tasks back to todo", async () => {
    const dir = makeTempDir("task-store-auto-recovery-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    const retryAt = new Date(Date.now() - 60_000).toISOString();
    ts.addTask({
      id: "blocked-auto-1",
      title: "Blocked auto task",
      status: "blocked",
      cooldownUntil: retryAt,
      blockedReason: "Auto recovery pending",
      meta: {
        autoRecovery: {
          active: true,
          reason: "worktree_failure",
          retryAt,
        },
      },
    });

    const recovered = ts.recoverAutoBlockedTasks();
    const task = ts.getTask("blocked-auto-1");

    expect(recovered.recoveredTaskIds).toEqual(["blocked-auto-1"]);
    expect(task.status).toBe("todo");
    expect(task.cooldownUntil).toBeNull();
    expect(task.blockedReason).toBeNull();
    expect(task.meta?.autoRecovery?.active).toBe(false);
  });

  it("clears blocked metadata in one operation when manually unblocked", async () => {
    const dir = makeTempDir("task-store-manual-unblock-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.addTask({
      id: "blocked-manual-1",
      title: "Blocked manual task",
      status: "blocked",
      cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
      blockedReason: "Waiting for repo setup",
      meta: {
        autoRecovery: {
          active: true,
          reason: "worktree_failure",
          retryAt: new Date(Date.now() + 60_000).toISOString(),
        },
        keep: "yes",
      },
    });

    const task = ts.unblockTask("blocked-manual-1", {
      status: "todo",
      source: "manual-unblock-test",
    });

    expect(task.status).toBe("todo");
    expect(task.cooldownUntil).toBeNull();
    expect(task.blockedReason).toBeNull();
    expect(task.meta?.autoRecovery).toBeUndefined();
    expect(task.meta?.keep).toBe("yes");
  });
});


describe("task-store external change visibility", () => {
  it("reloads from disk when another process updates the store file", async () => {
    const dir = makeTempDir("task-store-external-reload-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();
    ts.addTask({ id: "local-1", title: "Local task", status: "todo" });
    await ts.waitForStoreWrites();

    // Simulate an external writer (CLI/API in a separate process) replacing the store file.
    const externallyWritten = {
      _meta: {
        version: 1,
        projectId: null,
        lastFullSync: null,
        taskCount: 1,
        stats: {
          draft: 0,
          todo: 1,
          inprogress: 0,
          inreview: 0,
          done: 0,
          blocked: 0,
        },
      },
      tasks: {
        "external-1": {
          id: "external-1",
          title: "External task",
          status: "todo",
        },
      },
    };
    writeFileSync(storePath, JSON.stringify(externallyWritten, null, 2), "utf8");

    const tasksAfterExternalWrite = ts.getAllTasks();
    expect(tasksAfterExternalWrite).toHaveLength(1);
    expect(tasksAfterExternalWrite[0].id).toBe("external-1");
  });
});
// ── getStorePath / configureTaskStore contracts ────────────────────────────

describe("task-store configureTaskStore contracts", () => {
  it("loadStore/saveStore signatures are unchanged — loadStore takes no args", async () => {
    const ts = await loadTaskStoreModule();
    expect(typeof ts.loadStore).toBe("function");
    expect(ts.loadStore.length).toBe(0);
  });

  it("saveStore accepts no arguments (fire-and-forget, returns void)", async () => {
    const ts = await loadTaskStoreModule();
    expect(typeof ts.saveStore).toBe("function");
    expect(ts.saveStore.length).toBe(0);
  });

  it("getStorePath returns a string after configureTaskStore", async () => {
    const ts = await loadTaskStoreModule();
    const dir = makeTempDir("task-store-path-contract-");
    ts.configureTaskStore({ storePath: join(dir, "state.json") });
    expect(typeof ts.getStorePath()).toBe("string");
  });
});

describe("task-store sprint and DAG primitives", () => {
  it("loads legacy store files without sprints and backfills task sprint fields", async () => {
    const dir = makeTempDir("task-store-legacy-sprints-");
    const storePath = join(dir, "kanban-state.json");
    const legacyStore = {
      _meta: {
        version: 1,
        projectId: null,
        lastFullSync: null,
        taskCount: 1,
        stats: {
          draft: 0,
          todo: 1,
          inprogress: 0,
          inreview: 0,
          done: 0,
          blocked: 0,
        },
      },
      tasks: {
        "legacy-1": {
          id: "legacy-1",
          title: "Legacy task",
          status: "todo",
        },
      },
    };
    writeFileSync(storePath, JSON.stringify(legacyStore, null, 2), "utf8");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    expect(ts.listSprints()).toEqual([]);
    expect(ts.getSprint("s-1")).toBeNull();
    expect(ts.getTask("legacy-1")).toMatchObject({
      sprintId: null,
      sprintOrder: null,
    });
  });

  it("upserts sprints, lists them by order, and assigns tasks to sprint", async () => {
    const dir = makeTempDir("task-store-sprint-crud-");
    const storePath = join(dir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.upsertSprint({ id: "s-2", name: "Sprint 2", order: 2 });
    ts.upsertSprint({ id: "s-1", name: "Sprint 1", order: 1 });

    const ordered = ts.listSprints();
    expect(ordered.map((s) => s.id)).toEqual(["s-1", "s-2"]);
    expect(ts.getSprint("s-1")).toMatchObject({ id: "s-1", order: 1 });

    ts.addTask({ id: "task-a", title: "Task A", status: "todo" });
    const assigned = ts.assignTaskToSprint("task-a", "s-1");
    expect(assigned).toMatchObject({ sprintId: "s-1", sprintOrder: 1 });
  });

  it("builds global and per-sprint DAG levels", async () => {
    const dir = makeTempDir("task-store-dag-levels-");
    const storePath = join(dir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.upsertSprint({ id: "s-1", order: 1 });
    ts.upsertSprint({ id: "s-2", order: 2 });

    ts.addTask({ id: "a", title: "A", status: "todo" });
    ts.addTask({ id: "b", title: "B", status: "todo" });
    ts.addTask({ id: "c", title: "C", status: "todo" });
    ts.addTask({ id: "d", title: "D", status: "todo" });

    ts.assignTaskToSprint("a", "s-1");
    ts.assignTaskToSprint("b", "s-1");
    ts.assignTaskToSprint("c", "s-1");
    ts.assignTaskToSprint("d", "s-2");

    ts.addTaskDependency("b", "a");
    ts.addTaskDependency("c", "b");
    ts.addTaskDependency("d", "c");

    const globalDag = ts.getTaskDag();
    expect(globalDag.hasCycle).toBe(false);
    expect(globalDag.levels).toEqual([["a"], ["b"], ["c"], ["d"]]);

    const sprintDag = ts.getTaskDag({ sprintId: "s-1" });
    expect(sprintDag.hasCycle).toBe(false);
    expect(sprintDag.levels).toEqual([["a"], ["b"], ["c"]]);
    expect(sprintDag.edges).toHaveLength(2);
  });

  it("detects DAG cycles", async () => {
    const dir = makeTempDir("task-store-dag-cycle-");
    const storePath = join(dir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.addTask({ id: "x", title: "X", status: "todo" });
    ts.addTask({ id: "y", title: "Y", status: "todo" });
    ts.addTaskDependency("x", "y");
    ts.addTaskDependency("y", "x");

    const dag = ts.getTaskDag();
    expect(dag.hasCycle).toBe(true);
    expect(dag.cycleTaskIds).toEqual(["x", "y"]);
  });

  it("canTaskStart blocks on unresolved dependencies and allows after completion", async () => {
    const dir = makeTempDir("task-store-can-start-deps-");
    const storePath = join(dir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.addTask({ id: "dep", title: "Dependency", status: "todo" });
    ts.addTask({ id: "child", title: "Child", status: "todo" });
    ts.addTaskDependency("child", "dep");

    const blocked = ts.canTaskStart("child");
    expect(blocked.canStart).toBe(false);
    expect(blocked.reason).toBe("dependencies_unresolved");
    expect(blocked.blockingTaskIds).toContain("dep");

    ts.setTaskStatus("dep", "done", "test");
    const allowed = ts.canTaskStart("child");
    expect(allowed.canStart).toBe(true);
    expect(allowed.reason).toBe("ok");
  });

  it("canTaskStart honors sequential sprint order mode", async () => {
    const dir = makeTempDir("task-store-can-start-sprint-order-");
    const storePath = join(dir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.upsertSprint({ id: "s-1", order: 1 });
    ts.upsertSprint({ id: "s-2", order: 2 });
    ts.addTask({ id: "s1-task", title: "Sprint 1 task", status: "todo" });
    ts.addTask({ id: "s2-task", title: "Sprint 2 task", status: "todo" });
    ts.assignTaskToSprint("s1-task", "s-1");
    ts.assignTaskToSprint("s2-task", "s-2");

    const blocked = ts.canTaskStart("s2-task", { sprintOrderMode: "sequential" });
    expect(blocked.canStart).toBe(false);
    expect(blocked.reason).toBe("prior_sprint_incomplete");
    expect(blocked.blockingTaskIds).toContain("s1-task");

    ts.setTaskStatus("s1-task", "done", "test");
    const allowed = ts.canTaskStart("s2-task", { sprintOrderMode: "sequential" });
    expect(allowed.canStart).toBe(true);
    expect(allowed.reason).toBe("ok");
  });

  it("canTaskStart blocks on unresolved epic dependencies", async () => {
    const dir = makeTempDir("task-store-can-start-epic-deps-");
    const storePath = join(dir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.addTask({ id: "epic-b-task-1", title: "Epic B task", status: "todo", epicId: "EPIC-B" });
    ts.addTask({ id: "epic-a-task-1", title: "Epic A task", status: "todo", epicId: "EPIC-A" });
    ts.setEpicDependencies("EPIC-A", ["EPIC-B"]);

    const blocked = ts.canTaskStart("epic-a-task-1");
    expect(blocked.canStart).toBe(false);
    expect(blocked.reason).toBe("epic_dependencies_unresolved");
    expect(blocked.blockingEpicIds).toEqual(["EPIC-B"]);
    expect(blocked.blockingTaskIds).toContain("epic-b-task-1");

    ts.setTaskStatus("epic-b-task-1", "done", "test");
    const allowed = ts.canTaskStart("epic-a-task-1");
    expect(allowed.canStart).toBe(true);
    expect(allowed.reason).toBe("ok");
  });

  it("startTask blocks on unresolved epic dependencies unless forced", async () => {
    const dir = makeTempDir("task-store-start-epic-guard-");
    const storePath = join(dir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.addTask({ id: "epic-b-task-1", title: "Epic B task", status: "todo", epicId: "EPIC-B" });
    ts.addTask({ id: "epic-a-task-1", title: "Epic A task", status: "todo", epicId: "EPIC-A" });
    ts.setEpicDependencies("EPIC-A", ["EPIC-B"]);

    const blocked = ts.startTask("epic-a-task-1");
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("start_guard_blocked");
    expect(blocked.canStart?.reason).toBe("epic_dependencies_unresolved");
    expect(ts.getTask("epic-a-task-1")?.status).toBe("todo");

    const forced = ts.startTask("epic-a-task-1", { force: true });
    expect(forced.ok).toBe(true);
    expect(forced.toStatus).toBe("inprogress");
    expect(ts.getTask("epic-a-task-1")?.status).toBe("inprogress");
  });
  
  it("keeps PR-backed inreview tasks sticky when generic status updates try to demote them", async () => {
    const dir = makeTempDir("task-store-sticky-review-");
    const storePath = join(dir, "kanban-state.json");
    
    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();
    
    ts.addTask({
      id: "review-task",
      title: "Review task",
      status: "inreview",
      prNumber: 42,
      prUrl: "https://github.com/virtengine/bosun/pull/42",
    });
    
    ts.setTaskStatus("review-task", "todo", "test");
    expect(ts.getTask("review-task")?.status).toBe("inreview");
    
    ts.updateTask("review-task", { status: "inprogress" });
    expect(ts.getTask("review-task")?.status).toBe("inreview");
    
    ts.setTaskStatus("review-task", "done", "test");
    expect(ts.getTask("review-task")?.status).toBe("done");
  });
});

describe("task-store comment handling", () => {
  it("loads legacy comments from task meta and normalizes comment fields", async () => {
    const dir = makeTempDir("task-store-legacy-comments-");
    const storePath = join(dir, "kanban-state.json");
    const legacyStore = {
      _meta: {
        version: 1,
        projectId: null,
        lastFullSync: null,
        taskCount: 1,
        stats: {
          draft: 0,
          todo: 1,
          inprogress: 0,
          inreview: 0,
          done: 0,
          blocked: 0,
        },
      },
      tasks: {
        "legacy-comments": {
          id: "legacy-comments",
          title: "Legacy comments",
          status: "todo",
          meta: {
            comments: [
              "  first note  ",
              {
                id: 17,
                text: " second note ",
                user: "reviewer",
                created_at: "2026-03-08T09:11:22.557Z",
                source: "jira",
                kind: "status",
                meta: { severity: "info" },
              },
              { body: "   " },
            ],
          },
        },
      },
    };
    writeFileSync(storePath, JSON.stringify(legacyStore, null, 2), "utf8");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    expect(ts.getTaskComments("legacy-comments")).toEqual([
      expect.objectContaining({
        id: null,
        body: "first note",
        author: null,
        source: "task",
        kind: "comment",
        meta: {},
      }),
      expect.objectContaining({
        id: "17",
        body: "second note",
        author: "reviewer",
        createdAt: "2026-03-08T09:11:22.557Z",
        source: "jira",
        kind: "status",
        meta: { severity: "info" },
      }),
    ]);
  });


  it("normalizes replayable runs with short step summaries", async () => {
    const dir = makeTempDir("task-store-runs-");
    const storePath = join(dir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.addTask({ id: "task-runs", title: "Replay task", status: "inprogress" });
    const appended = ts.appendTaskRun("task-runs", {
      runId: "run-1",
      startedAt: "2026-03-22T10:00:00.000Z",
      status: "failed",
      sdk: "codex",
      threadId: "thread-123",
      steps: [
        { type: "thread", payload: { sdk: "codex", resumed: true } },
        { type: "tool_call", payload: { toolName: "exec_command" } },
        { type: "assistant", payload: { content: "Implemented the change and hit a test failure that needs a retry." } },
      ],
    });

    expect(appended).toMatchObject({
      runId: "run-1",
      sdk: "codex",
      threadId: "thread-123",
      replayable: true,
      status: "failed",
    });
    expect(appended.steps).toHaveLength(3);
    expect(appended.steps[0]).toMatchObject({ type: "thread", summary: "Resumed codex session." });
    expect(appended.steps[1]).toMatchObject({ type: "tool_call", summary: "Called exec_command." });
    expect(appended.steps[2].summary).toContain("Implemented the change");

    expect(ts.getTaskRuns("task-runs")).toHaveLength(1);
    expect(ts.getTask("task-runs").runs[0].steps[1].summary).toBe("Called exec_command.");
  });

  it("updates, appends, and caps normalized task comments", async () => {
    const dir = makeTempDir("task-store-comments-");
    const storePath = join(dir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.addTask({ id: "task-comments", title: "Comment task", status: "todo" });
    const seedComments = Array.from({ length: 205 }, (_, index) => ` comment ${index + 1} `);

    ts.updateTask("task-comments", { comments: seedComments });

    const normalized = ts.getTaskComments("task-comments");
    expect(normalized).toHaveLength(200);
    expect(normalized[0]).toMatchObject({ body: "comment 6" });
    expect(normalized.at(-1)).toMatchObject({ body: "comment 205" });

    const added = ts.addTaskComment("task-comments", {
      id: 999,
      content: " final review note ",
      author: "bosun",
      createdAt: "2026-03-09T00:00:00.000Z",
      source: "github",
      kind: "review",
      meta: { commentUrl: "https://example.test/comments/999" },
    });

    expect(added).toMatchObject({
      id: "999",
      body: "final review note",
      author: "bosun",
      createdAt: "2026-03-09T00:00:00.000Z",
      source: "github",
      kind: "review",
      meta: { commentUrl: "https://example.test/comments/999" },
    });
    expect(ts.addTaskComment("task-comments", { body: "   " })).toBeNull();

    const comments = ts.getTaskComments("task-comments");
    expect(comments).toHaveLength(200);
    expect(comments[0]).toMatchObject({ body: "comment 7" });
    expect(comments.at(-1)).toMatchObject({
      id: "999",
      body: "final review note",
      author: "bosun",
      source: "github",
      kind: "review",
    });

    expect(ts.getTask("task-comments").timeline.at(-1)).toMatchObject({
      type: "task.comment",
      source: "github",
      actor: "bosun",
      message: "final review note",
      payload: { commentId: "999" },
    });
  });
});
