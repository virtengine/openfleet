import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  isOldEnoughToArchive,
  archiveTaskToFile,
  isAlreadyArchived,
  fetchCompletedTasks,
  deleteTaskFromVK,
  archiveCompletedTasks,
  loadArchivedTasks,
  pruneOldArchives,
  getArchiveStats,
  generateSprintReport,
  formatSprintReport,
  readDailyArchive,
  migrateLegacyArchives,
  ARCHIVE_AGE_HOURS,
  ARCHIVE_RETENTION_DAYS,
  DEFAULT_MAX_ARCHIVE,
} from "../task-archiver.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

function tmpArchiveDir() {
  return resolve(tmpdir(), `archiver-test-${randomBytes(6).toString("hex")}`);
}

function makeTask(overrides = {}) {
  return {
    id: overrides.id ?? randomBytes(8).toString("hex"),
    title: overrides.title ?? "Test task",
    status: overrides.status ?? "done",
    priority: overrides.priority ?? 1,
    completed_at:
      overrides.completed_at ??
      new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    updated_at:
      overrides.updated_at ??
      new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

// ── Constants ────────────────────────────────────────────────────────────────

describe("exported constants", () => {
  it("ARCHIVE_AGE_HOURS is 24", () => {
    expect(ARCHIVE_AGE_HOURS).toBe(24);
  });

  it("ARCHIVE_RETENTION_DAYS is 90", () => {
    expect(ARCHIVE_RETENTION_DAYS).toBe(90);
  });

  it("DEFAULT_MAX_ARCHIVE is 50", () => {
    expect(DEFAULT_MAX_ARCHIVE).toBe(50);
  });
});

// ── isOldEnoughToArchive ─────────────────────────────────────────────────────

describe("isOldEnoughToArchive", () => {
  const nowMs = Date.now();

  it("returns true for task completed 48h ago with 24h threshold", () => {
    const task = makeTask({
      completed_at: new Date(nowMs - 48 * 60 * 60 * 1000).toISOString(),
    });
    expect(isOldEnoughToArchive(task, { nowMs })).toBe(true);
  });

  it("returns false for task completed 1h ago with 24h threshold", () => {
    const task = makeTask({
      completed_at: new Date(nowMs - 1 * 60 * 60 * 1000).toISOString(),
    });
    expect(isOldEnoughToArchive(task, { nowMs })).toBe(false);
  });

  it("uses updated_at as fallback when completed_at is missing", () => {
    const task = {
      id: "t1",
      title: "fallback",
      status: "done",
      updated_at: new Date(nowMs - 48 * 60 * 60 * 1000).toISOString(),
    };
    expect(isOldEnoughToArchive(task, { nowMs })).toBe(true);
  });

  it("returns false for invalid date", () => {
    const task = { id: "t2", completed_at: "invalid-date" };
    expect(isOldEnoughToArchive(task)).toBe(false);
  });

  it("respects custom ageHours", () => {
    const task = makeTask({
      completed_at: new Date(nowMs - 2 * 60 * 60 * 1000).toISOString(),
    });
    expect(isOldEnoughToArchive(task, { nowMs, ageHours: 1 })).toBe(true);
    expect(isOldEnoughToArchive(task, { nowMs, ageHours: 4 })).toBe(false);
  });

  it("uses ARCHIVE_AGE_HOURS by default", () => {
    const task = makeTask({
      completed_at: new Date(nowMs - 25 * 60 * 60 * 1000).toISOString(),
    });
    expect(isOldEnoughToArchive(task, { nowMs })).toBe(true);
  });
});

// ── archiveTaskToFile ────────────────────────────────────────────────────────

describe("archiveTaskToFile", () => {
  let dir;

  beforeEach(() => {
    dir = tmpArchiveDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("creates daily archive file with correct structure", async () => {
    const task = makeTask({ id: "abc123" });
    const path = await archiveTaskToFile(task, null, dir);

    expect(path).not.toBeNull();
    expect(existsSync(path)).toBe(true);

    // Daily file is an array of entries
    const entries = JSON.parse(await readFile(path, "utf8"));
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].task.id).toBe("abc123");
    expect(entries[0].archived_at).toBeDefined();
    expect(entries[0].archiver_version).toBe(3);
  });

  it("appends to existing daily file (same day)", async () => {
    const task1 = makeTask({ id: "day-1" });
    const task2 = makeTask({ id: "day-2" });
    const path1 = await archiveTaskToFile(task1, null, dir);
    const path2 = await archiveTaskToFile(task2, null, dir);

    // Both land in same daily file
    expect(path1).toBe(path2);
    const entries = JSON.parse(await readFile(path1, "utf8"));
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.task.id).sort()).toEqual(["day-1", "day-2"]);
  });

  it("is idempotent — does not duplicate on second call", async () => {
    const task = makeTask({ id: "idem123" });
    const path1 = await archiveTaskToFile(task, null, dir);
    const path2 = await archiveTaskToFile(task, null, dir);

    expect(path1).toBe(path2);
    const entries = JSON.parse(await readFile(path1, "utf8"));
    // Only one entry despite two calls
    expect(entries.filter((e) => e.task.id === "idem123")).toHaveLength(1);
  });

  it("includes attempt data when provided", async () => {
    const task = makeTask();
    const attempt = { id: "att-1", branch: "ve/test" };
    const path = await archiveTaskToFile(task, attempt, dir);

    const entries = JSON.parse(await readFile(path, "utf8"));
    expect(entries[0].attempt).toEqual(attempt);
  });

  it("creates directory if it doesn't exist", async () => {
    const nested = resolve(dir, "nested", "deep");
    const task = makeTask();
    const path = await archiveTaskToFile(task, null, nested);
    expect(path).not.toBeNull();
    expect(existsSync(nested)).toBe(true);
  });

  it("returns null on undefined task", async () => {
    const path = await archiveTaskToFile(undefined, null, dir);
    expect(path).toBeNull();
  });
});

// ── isAlreadyArchived ────────────────────────────────────────────────────────

describe("isAlreadyArchived", () => {
  let dir;

  beforeEach(() => {
    dir = tmpArchiveDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns false for non-existent directory", async () => {
    expect(await isAlreadyArchived("test-id", dir)).toBe(false);
  });

  it("returns false when task not archived", async () => {
    await mkdir(dir, { recursive: true });
    // Daily file exists but task ID is not inside
    await writeFile(
      resolve(dir, "2026-01-01.json"),
      JSON.stringify([{ task: { id: "other" }, archived_at: "2026-01-01" }]),
    );
    expect(await isAlreadyArchived("test-id", dir)).toBe(false);
  });

  it("returns true when task exists inside a daily file", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      resolve(dir, "2026-01-01.json"),
      JSON.stringify([{ task: { id: "match123" }, archived_at: "2026-01-01" }]),
    );
    expect(await isAlreadyArchived("match123", dir)).toBe(true);
  });

  it("returns true for legacy per-task file (backwards compat)", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, "2026-01-01-legacy99.json"), "{}");
    expect(await isAlreadyArchived("legacy99", dir)).toBe(true);
  });

  it("returns false for empty taskId", async () => {
    expect(await isAlreadyArchived("", dir)).toBe(false);
    expect(await isAlreadyArchived(null, dir)).toBe(false);
  });
});

// ── fetchCompletedTasks ──────────────────────────────────────────────────────

describe("fetchCompletedTasks", () => {
  it("returns empty array when fetchVk is null", async () => {
    expect(await fetchCompletedTasks(null, "proj-1")).toEqual([]);
  });

  it("returns empty array when projectId is null", async () => {
    expect(await fetchCompletedTasks(() => {}, null)).toEqual([]);
  });

  it("fetches done and cancelled tasks", async () => {
    const doneTasks = [makeTask({ status: "done" })];
    const cancelledTasks = [makeTask({ status: "cancelled" })];

    const fetchVk = async (path) => {
      if (path.includes("status=done"))
        return { success: true, data: doneTasks };
      if (path.includes("status=cancelled"))
        return { success: true, data: cancelledTasks };
      return { success: false };
    };

    const result = await fetchCompletedTasks(fetchVk, "proj-1");
    expect(result).toHaveLength(2);
  });

  it("handles API errors gracefully", async () => {
    const fetchVk = async () => {
      throw new Error("API down");
    };
    const result = await fetchCompletedTasks(fetchVk, "proj-1");
    expect(result).toEqual([]);
  });

  it("handles non-success responses", async () => {
    const fetchVk = async () => ({ success: false });
    const result = await fetchCompletedTasks(fetchVk, "proj-1");
    expect(result).toEqual([]);
  });
});

// ── deleteTaskFromVK ─────────────────────────────────────────────────────────

describe("deleteTaskFromVK", () => {
  it("returns false for null fetchVk", async () => {
    expect(await deleteTaskFromVK(null, "task-1")).toBe(false);
  });

  it("returns false for null taskId", async () => {
    expect(await deleteTaskFromVK(() => {}, null)).toBe(false);
  });

  it("returns true on successful DELETE", async () => {
    const fetchVk = async () => ({ success: true });
    expect(await deleteTaskFromVK(fetchVk, "task-1")).toBe(true);
  });

  it("falls back to PUT when DELETE fails", async () => {
    let callCount = 0;
    const fetchVk = async (path, opts) => {
      callCount++;
      if (opts?.method === "DELETE") return { success: false };
      if (opts?.method === "PUT") return { success: true };
      return { success: false };
    };
    expect(await deleteTaskFromVK(fetchVk, "task-1")).toBe(true);
    expect(callCount).toBe(2);
  });

  it("returns false when both DELETE and PUT fail", async () => {
    const fetchVk = async () => ({ success: false });
    expect(await deleteTaskFromVK(fetchVk, "task-1")).toBe(false);
  });

  it("returns false on exception", async () => {
    const fetchVk = async () => {
      throw new Error("network");
    };
    expect(await deleteTaskFromVK(fetchVk, "task-1")).toBe(false);
  });
});

// ── pruneOldArchives ─────────────────────────────────────────────────────────

describe("pruneOldArchives", () => {
  let dir;

  beforeEach(() => {
    dir = tmpArchiveDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns 0 for non-existent directory", async () => {
    expect(await pruneOldArchives({ archiveDir: dir })).toBe(0);
  });

  it("does not prune recent files", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, "recent.json"), "{}");
    const pruned = await pruneOldArchives({
      archiveDir: dir,
      retentionDays: 90,
    });
    expect(pruned).toBe(0);
    expect(existsSync(resolve(dir, "recent.json"))).toBe(true);
  });

  it("prunes expired files based on mtime", async () => {
    await mkdir(dir, { recursive: true });
    const filePath = resolve(dir, "old-task.json");
    await writeFile(filePath, "{}");
    // Use nowMs far in the future to make file appear old
    const farFuture = Date.now() + 200 * 24 * 60 * 60 * 1000;
    const pruned = await pruneOldArchives({
      archiveDir: dir,
      retentionDays: 90,
      nowMs: farFuture,
    });
    expect(pruned).toBe(1);
    expect(existsSync(filePath)).toBe(false);
  });

  it("skips non-json files", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, "readme.txt"), "hello");
    const farFuture = Date.now() + 200 * 24 * 60 * 60 * 1000;
    const pruned = await pruneOldArchives({
      archiveDir: dir,
      retentionDays: 90,
      nowMs: farFuture,
    });
    expect(pruned).toBe(0);
    expect(existsSync(resolve(dir, "readme.txt"))).toBe(true);
  });
});

// ── getArchiveStats ──────────────────────────────────────────────────────────

describe("getArchiveStats", () => {
  let dir;

  beforeEach(() => {
    dir = tmpArchiveDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns zeros for non-existent directory", async () => {
    const stats = await getArchiveStats(dir);
    expect(stats).toEqual({ count: 0, taskCount: 0, totalBytes: 0 });
  });

  it("counts json files, tasks inside daily files, and sums sizes", async () => {
    await mkdir(dir, { recursive: true });
    // Daily file with 3 entries
    await writeFile(
      resolve(dir, "2026-02-01.json"),
      JSON.stringify([
        { task: { id: "a" }, archived_at: "2026-02-01" },
        { task: { id: "b" }, archived_at: "2026-02-01" },
        { task: { id: "c" }, archived_at: "2026-02-01" },
      ]),
    );
    // Legacy per-task file (one task)
    await writeFile(
      resolve(dir, "2026-02-02-legacy.json"),
      JSON.stringify({ task: { id: "d" }, archived_at: "2026-02-02" }),
    );
    await writeFile(resolve(dir, "c.txt"), "not counted");

    const stats = await getArchiveStats(dir);
    expect(stats.count).toBe(2);
    expect(stats.taskCount).toBe(4); // 3 in daily + 1 legacy
    expect(stats.totalBytes).toBeGreaterThan(0);
  });

  it("ignores .tmp- files", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, ".tmp-partial.json"), "[]");
    const stats = await getArchiveStats(dir);
    expect(stats.count).toBe(0);
  });
});

// ── archiveCompletedTasks (integration) ──────────────────────────────────────

describe("archiveCompletedTasks", () => {
  let dir;

  beforeEach(() => {
    dir = tmpArchiveDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("archives old tasks and deletes from VK", async () => {
    const oldTask = makeTask({
      id: "old-task-1",
      title: "Old task",
      completed_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });

    const fetchVk = async (path, opts) => {
      if (path.includes("status=done"))
        return { success: true, data: [oldTask] };
      if (path.includes("status=cancelled")) return { success: true, data: [] };
      if (opts?.method === "DELETE") return { success: true };
      return { success: false };
    };

    const result = await archiveCompletedTasks(fetchVk, "proj-1", {
      archiveDir: dir,
      prune: false,
    });

    expect(result.archived).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("skips tasks that are too recent", async () => {
    const recentTask = makeTask({
      id: "recent-1",
      completed_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    });

    const fetchVk = async (path) => {
      if (path.includes("status=done"))
        return { success: true, data: [recentTask] };
      return { success: true, data: [] };
    };

    const result = await archiveCompletedTasks(fetchVk, "proj-1", {
      archiveDir: dir,
      prune: false,
    });
    expect(result.archived).toBe(0);
  });

  it("dry-run archives but doesn't delete", async () => {
    const task = makeTask({ id: "dryrun-1" });
    let deleteCalled = false;

    const fetchVk = async (path, opts) => {
      if (path.includes("status=done")) return { success: true, data: [task] };
      if (path.includes("status=cancelled")) return { success: true, data: [] };
      if (opts?.method === "DELETE") {
        deleteCalled = true;
        return { success: true };
      }
      return { success: false };
    };

    const result = await archiveCompletedTasks(fetchVk, "proj-1", {
      archiveDir: dir,
      dryRun: true,
      prune: false,
    });

    expect(result.archived).toBe(1);
    expect(result.deleted).toBe(0);
    expect(deleteCalled).toBe(false);
  });

  it("skips already-archived tasks (idempotent)", async () => {
    const task = makeTask({ id: "idem-task" });

    // Pre-archive the task
    await archiveTaskToFile(task, null, dir);

    const fetchVk = async (path) => {
      if (path.includes("status=done")) return { success: true, data: [task] };
      return { success: true, data: [] };
    };

    const result = await archiveCompletedTasks(fetchVk, "proj-1", {
      archiveDir: dir,
      prune: false,
    });

    expect(result.archived).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("respects maxArchive limit", { timeout: 15_000 }, async () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      makeTask({ id: `limit-${i}` }),
    );

    const fetchVk = async (path, opts) => {
      if (path.includes("status=done")) return { success: true, data: tasks };
      if (path.includes("status=cancelled")) return { success: true, data: [] };
      if (opts?.method === "DELETE") return { success: true };
      return { success: false };
    };

    const result = await archiveCompletedTasks(fetchVk, "proj-1", {
      archiveDir: dir,
      maxArchive: 3,
      prune: false,
    });

    expect(result.archived).toBe(3);
  });

  it("handles fetchVk error gracefully (caught by fetchCompletedTasks)", async () => {
    const fetchVk = async () => {
      throw new Error("API down");
    };
    const result = await archiveCompletedTasks(fetchVk, "proj-1", {
      archiveDir: dir,
      prune: false,
    });
    // fetchCompletedTasks catches internally and returns [], so no errors bubble
    expect(result.archived).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("returns zero result for empty completed tasks", async () => {
    const fetchVk = async () => ({ success: true, data: [] });
    const result = await archiveCompletedTasks(fetchVk, "proj-1", {
      archiveDir: dir,
      prune: false,
    });
    expect(result.archived).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.errors).toBe(0);
  });
});

// ── loadArchivedTasks ────────────────────────────────────────────────────────

describe("loadArchivedTasks", () => {
  let dir;

  beforeEach(() => {
    dir = tmpArchiveDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns empty array for non-existent directory", async () => {
    expect(await loadArchivedTasks({ archiveDir: dir })).toEqual([]);
  });

  it("loads from daily grouped files and sorts newest first", async () => {
    await mkdir(dir, { recursive: true });

    const entries = [
      {
        task: makeTask({ id: "old" }),
        archived_at: "2026-01-01T00:00:00.000Z",
      },
      {
        task: makeTask({ id: "new" }),
        archived_at: "2026-02-01T00:00:00.000Z",
      },
    ];

    await writeFile(
      resolve(dir, "2026-01-01.json"),
      JSON.stringify([entries[0]]),
    );
    await writeFile(
      resolve(dir, "2026-02-01.json"),
      JSON.stringify([entries[1]]),
    );

    const result = await loadArchivedTasks({ archiveDir: dir });
    expect(result).toHaveLength(2);
    expect(result[0].task.id).toBe("new");
    expect(result[1].task.id).toBe("old");
  });

  it("loads from legacy single-task files", async () => {
    await mkdir(dir, { recursive: true });

    const older = {
      task: makeTask({ id: "old" }),
      archived_at: "2026-01-01T00:00:00.000Z",
    };
    const newer = {
      task: makeTask({ id: "new" }),
      archived_at: "2026-02-01T00:00:00.000Z",
    };

    await writeFile(resolve(dir, "2026-01-01-old.json"), JSON.stringify(older));
    await writeFile(resolve(dir, "2026-02-01-new.json"), JSON.stringify(newer));

    const result = await loadArchivedTasks({ archiveDir: dir });
    expect(result).toHaveLength(2);
    expect(result[0].task.id).toBe("new");
    expect(result[1].task.id).toBe("old");
  });

  it("loads from mixed daily + legacy files", async () => {
    await mkdir(dir, { recursive: true });

    // Daily file with 2 entries
    await writeFile(
      resolve(dir, "2026-02-01.json"),
      JSON.stringify([
        { task: makeTask({ id: "d1" }), archived_at: "2026-02-01T10:00:00Z" },
        { task: makeTask({ id: "d2" }), archived_at: "2026-02-01T12:00:00Z" },
      ]),
    );
    // Legacy single-task file
    await writeFile(
      resolve(dir, "2026-01-15-legacy.json"),
      JSON.stringify({
        task: makeTask({ id: "legacy" }),
        archived_at: "2026-01-15T00:00:00Z",
      }),
    );

    const result = await loadArchivedTasks({ archiveDir: dir });
    expect(result).toHaveLength(3);
  });

  it("filters by since date", async () => {
    await mkdir(dir, { recursive: true });

    await writeFile(
      resolve(dir, "2025-12-01.json"),
      JSON.stringify([
        {
          task: makeTask({ id: "old" }),
          archived_at: "2025-12-01T00:00:00.000Z",
        },
      ]),
    );
    await writeFile(
      resolve(dir, "2026-02-01.json"),
      JSON.stringify([
        {
          task: makeTask({ id: "recent" }),
          archived_at: "2026-02-01T00:00:00.000Z",
        },
      ]),
    );

    const result = await loadArchivedTasks({
      archiveDir: dir,
      since: "2026-01-01",
    });
    expect(result).toHaveLength(1);
    expect(result[0].task.id).toBe("recent");
  });

  it("filters by status", async () => {
    await mkdir(dir, { recursive: true });

    // Both tasks in the same daily file
    await writeFile(
      resolve(dir, "2026-02-01.json"),
      JSON.stringify([
        {
          task: makeTask({ id: "done-1", status: "done" }),
          archived_at: "2026-02-01T00:00:00.000Z",
        },
        {
          task: makeTask({ id: "cancelled-1", status: "cancelled" }),
          archived_at: "2026-02-01T00:00:00.000Z",
        },
      ]),
    );

    const result = await loadArchivedTasks({
      archiveDir: dir,
      status: "done",
    });
    expect(result).toHaveLength(1);
    expect(result[0].task.id).toBe("done-1");
  });

  it("skips corrupted JSON files", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      resolve(dir, "2026-02-01.json"),
      JSON.stringify([
        {
          task: makeTask({ id: "good" }),
          archived_at: "2026-02-01T00:00:00.000Z",
        },
      ]),
    );
    await writeFile(resolve(dir, "2026-02-02.json"), "not valid json{{{");

    const result = await loadArchivedTasks({ archiveDir: dir });
    expect(result).toHaveLength(1);
    expect(result[0].task.id).toBe("good");
  });
});

// ── readDailyArchive ─────────────────────────────────────────────────────────────

describe("readDailyArchive", () => {
  let dir;

  beforeEach(() => {
    dir = tmpArchiveDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns empty array for missing file", async () => {
    await mkdir(dir, { recursive: true });
    const entries = await readDailyArchive("2099-01-01", dir);
    expect(entries).toEqual([]);
  });

  it("returns parsed entries from daily file", async () => {
    await mkdir(dir, { recursive: true });
    const data = [
      { task: { id: "a" }, archived_at: "2026-02-01" },
      { task: { id: "b" }, archived_at: "2026-02-01" },
    ];
    await writeFile(resolve(dir, "2026-02-01.json"), JSON.stringify(data));
    const entries = await readDailyArchive("2026-02-01", dir);
    expect(entries).toHaveLength(2);
  });

  it("returns empty array for corrupted file", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, "2026-02-01.json"), "broken{{");
    const entries = await readDailyArchive("2026-02-01", dir);
    expect(entries).toEqual([]);
  });
});

// ── migrateLegacyArchives ───────────────────────────────────────────────────────

describe("migrateLegacyArchives", () => {
  let dir;

  beforeEach(() => {
    dir = tmpArchiveDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns zero counts for non-existent directory", async () => {
    const r = await migrateLegacyArchives(dir);
    expect(r).toEqual({ migrated: 0, errors: 0 });
  });

  it("returns zero counts when no legacy files exist", async () => {
    await mkdir(dir, { recursive: true });
    // Only a daily file with no legacy siblings
    await writeFile(
      resolve(dir, "2026-02-01.json"),
      JSON.stringify([{ task: { id: "x" }, archived_at: "2026-02-01" }]),
    );
    const r = await migrateLegacyArchives(dir);
    expect(r.migrated).toBe(0);
  });

  it("consolidates legacy per-task files into daily files", async () => {
    await mkdir(dir, { recursive: true });

    // 3 legacy files on same date
    const t1 = { task: { id: "aa" }, archived_at: "2026-02-01T10:00:00Z" };
    const t2 = { task: { id: "bb" }, archived_at: "2026-02-01T11:00:00Z" };
    const t3 = { task: { id: "cc" }, archived_at: "2026-02-01T12:00:00Z" };
    await writeFile(resolve(dir, "2026-02-01-aa.json"), JSON.stringify(t1));
    await writeFile(resolve(dir, "2026-02-01-bb.json"), JSON.stringify(t2));
    await writeFile(resolve(dir, "2026-02-01-cc.json"), JSON.stringify(t3));

    const r = await migrateLegacyArchives(dir);
    expect(r.migrated).toBe(3);
    expect(r.errors).toBe(0);

    // Legacy files should be deleted
    const files = await readdir(dir);
    expect(
      files.filter(
        (f) => f.includes("-aa") || f.includes("-bb") || f.includes("-cc"),
      ),
    ).toHaveLength(0);

    // Daily file should contain all 3
    const daily = JSON.parse(
      await readFile(resolve(dir, "2026-02-01.json"), "utf8"),
    );
    expect(daily).toHaveLength(3);
  });

  it("merges legacy files into existing daily file without duplicates", async () => {
    await mkdir(dir, { recursive: true });

    // Pre-existing daily file
    const existing = [
      { task: { id: "pre" }, archived_at: "2026-02-01T09:00:00Z" },
    ];
    await writeFile(resolve(dir, "2026-02-01.json"), JSON.stringify(existing));

    // Legacy file for same date, different task
    const legacy = {
      task: { id: "extra" },
      archived_at: "2026-02-01T15:00:00Z",
    };
    await writeFile(
      resolve(dir, "2026-02-01-extra.json"),
      JSON.stringify(legacy),
    );

    const r = await migrateLegacyArchives(dir);
    expect(r.migrated).toBe(1);

    const daily = JSON.parse(
      await readFile(resolve(dir, "2026-02-01.json"), "utf8"),
    );
    expect(daily).toHaveLength(2);
    expect(daily.map((e) => e.task.id).sort()).toEqual(["extra", "pre"]);
  });

  it("skips duplicate task IDs during migration", async () => {
    await mkdir(dir, { recursive: true });

    // Daily file already has this task
    const existing = [{ task: { id: "dup" }, archived_at: "2026-02-01" }];
    await writeFile(resolve(dir, "2026-02-01.json"), JSON.stringify(existing));

    // Legacy file with same task ID
    await writeFile(
      resolve(dir, "2026-02-01-dup.json"),
      JSON.stringify({ task: { id: "dup" }, archived_at: "2026-02-01" }),
    );

    const r = await migrateLegacyArchives(dir);
    expect(r.migrated).toBe(0); // skipped as duplicate

    // Legacy file should still be cleaned up
    const files = await readdir(dir);
    expect(files.filter((f) => f.includes("-dup"))).toHaveLength(0);
  });

  it("is idempotent — running twice produces same result", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      resolve(dir, "2026-03-01-once.json"),
      JSON.stringify({ task: { id: "once" }, archived_at: "2026-03-01" }),
    );

    const r1 = await migrateLegacyArchives(dir);
    expect(r1.migrated).toBe(1);

    const r2 = await migrateLegacyArchives(dir);
    expect(r2.migrated).toBe(0); // nothing left to migrate

    const daily = JSON.parse(
      await readFile(resolve(dir, "2026-03-01.json"), "utf8"),
    );
    expect(daily).toHaveLength(1);
  });
});

// ── generateSprintReport ─────────────────────────────────────────────────────

describe("generateSprintReport", () => {
  it("returns empty report for non-array input", () => {
    const report = generateSprintReport(null);
    expect(report.total).toBe(0);
    expect(report.tasks).toEqual([]);
  });

  it("returns empty report for empty array", () => {
    const report = generateSprintReport([]);
    expect(report.total).toBe(0);
  });

  it("groups by status, priority, and date", () => {
    const items = [
      {
        task: makeTask({
          id: "t1",
          status: "done",
          priority: 1,
          completed_at: "2026-02-01T10:00:00Z",
        }),
        archived_at: "2026-02-02T00:00:00Z",
      },
      {
        task: makeTask({
          id: "t2",
          status: "cancelled",
          priority: 2,
          completed_at: "2026-02-01T12:00:00Z",
        }),
        archived_at: "2026-02-02T01:00:00Z",
      },
      {
        task: makeTask({
          id: "t3",
          status: "done",
          priority: 1,
          completed_at: "2026-02-02T10:00:00Z",
        }),
        archived_at: "2026-02-03T00:00:00Z",
      },
    ];

    const report = generateSprintReport(items);
    expect(report.total).toBe(3);
    expect(report.by_status.done).toBe(2);
    expect(report.by_status.cancelled).toBe(1);
    expect(report.by_priority[1]).toBe(2);
    expect(report.by_priority[2]).toBe(1);
    expect(report.by_date["2026-02-01"]).toBe(2);
    expect(report.by_date["2026-02-02"]).toBe(1);
    expect(report.tasks).toHaveLength(3);
  });

  it("skips items without task", () => {
    const items = [
      { archived_at: "2026-01-01" },
      { task: makeTask({ id: "ok" }), archived_at: "2026-01-01" },
    ];
    const report = generateSprintReport(items);
    expect(report.tasks).toHaveLength(1);
  });

  it("handles task with invalid date", () => {
    const items = [
      {
        task: makeTask({
          id: "invalid",
          completed_at: "not-a-date",
          updated_at: undefined,
        }),
        archived_at: "2026-01-01",
      },
    ];
    const report = generateSprintReport(items);
    expect(report.by_date["unknown"]).toBe(1);
  });
});

// ── formatSprintReport ───────────────────────────────────────────────────────

describe("formatSprintReport", () => {
  it("returns 'No report data.' for null", () => {
    expect(formatSprintReport(null)).toBe("No report data.");
    expect(formatSprintReport(undefined)).toBe("No report data.");
  });

  it("formats a complete report", () => {
    const report = {
      total: 2,
      by_status: { done: 2 },
      by_priority: { 1: 2 },
      by_date: { "2026-02-01": 2 },
      tasks: [
        { id: "abcdefgh", title: "Task Alpha", status: "done" },
        { id: "12345678", title: "Task Beta", status: "done" },
      ],
    };

    const text = formatSprintReport(report);
    expect(text).toContain("Sprint Review Report");
    expect(text).toContain("Total Tasks Completed: 2");
    expect(text).toContain("done: 2");
    expect(text).toContain("2026-02-01: 2 tasks");
    expect(text).toContain("Task Alpha");
    expect(text).toContain("abcdefgh");
  });

  it("handles empty sections gracefully", () => {
    const report = {
      total: 0,
      by_status: {},
      by_priority: {},
      by_date: {},
      tasks: [],
    };
    const text = formatSprintReport(report);
    expect(text).toContain("Total Tasks Completed: 0");
    expect(text).not.toContain("By Status:");
  });

  it("handles missing task fields", () => {
    const report = {
      total: 1,
      by_status: {},
      by_priority: {},
      by_date: {},
      tasks: [{ id: undefined, title: undefined, status: undefined }],
    };
    const text = formatSprintReport(report);
    expect(text).toContain("untitled");
    expect(text).toContain("[?]");
  });
});
