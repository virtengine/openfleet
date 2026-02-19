import { describe, it, expect, beforeEach } from "vitest";
import {
  getDirtyTasks,
  prioritizeDirtyTasks,
  shouldReserveDirtySlot,
  getDirtySlotReservation,
  buildConflictResolutionPrompt,
  isFileOverlapWithDirtyPR,
  registerDirtyTask,
  clearDirtyTask,
  isDirtyTask,
  getHighTierForDirty,
  isOnResolutionCooldown,
  recordResolutionAttempt,
  formatDirtyTaskSummary,
  DIRTY_TASK_DEFAULTS,
} from "../conflict-resolver.mjs";

// ── getDirtyTasks ────────────────────────────────────────────────────────────

describe("getDirtyTasks", () => {
  const nowMs = Date.now();

  it("returns empty array for non-array input", () => {
    expect(getDirtyTasks(null)).toEqual([]);
    expect(getDirtyTasks(undefined)).toEqual([]);
    expect(getDirtyTasks("string")).toEqual([]);
    expect(getDirtyTasks(123)).toEqual([]);
  });

  it("returns empty array for empty array", () => {
    expect(getDirtyTasks([])).toEqual([]);
  });

  it("filters out attempts without branch", () => {
    const attempts = [
      { updated_at: new Date(nowMs - 1000).toISOString() },
      {
        branch: "ve/123-task",
        updated_at: new Date(nowMs - 1000).toISOString(),
      },
    ];
    const result = getDirtyTasks(attempts, { nowMs });
    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("ve/123-task");
  });

  it("filters out attempts without valid timestamp", () => {
    const attempts = [
      { branch: "ve/1-a" },
      { branch: "ve/2-b", updated_at: "invalid-date" },
      {
        branch: "ve/3-c",
        updated_at: new Date(nowMs - 5000).toISOString(),
      },
    ];
    const result = getDirtyTasks(attempts, { nowMs });
    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("ve/3-c");
  });

  it("filters out attempts older than maxAgeHours", () => {
    const oldTime = nowMs - 25 * 60 * 60 * 1000; // 25 hours ago
    const recentTime = nowMs - 1 * 60 * 60 * 1000; // 1 hour ago
    const attempts = [
      { branch: "ve/old", updated_at: new Date(oldTime).toISOString() },
      {
        branch: "ve/recent",
        updated_at: new Date(recentTime).toISOString(),
      },
    ];
    const result = getDirtyTasks(attempts, { nowMs, maxAgeHours: 24 });
    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("ve/recent");
  });

  it("uses custom maxAgeHours", () => {
    const time = nowMs - 2 * 60 * 60 * 1000; // 2 hours ago
    const attempts = [
      { branch: "ve/task", updated_at: new Date(time).toISOString() },
    ];
    // With 1 hour max age → filtered out
    expect(getDirtyTasks(attempts, { nowMs, maxAgeHours: 1 })).toHaveLength(0);
    // With 3 hour max age → included
    expect(getDirtyTasks(attempts, { nowMs, maxAgeHours: 3 })).toHaveLength(1);
  });

  it("accepts updatedAt (camelCase) field", () => {
    const attempts = [
      {
        branch: "ve/camel",
        updatedAt: new Date(nowMs - 1000).toISOString(),
      },
    ];
    const result = getDirtyTasks(attempts, { nowMs });
    expect(result).toHaveLength(1);
  });

  it("accepts last_process_completed_at as fallback timestamp", () => {
    const attempts = [
      {
        branch: "ve/fallback",
        last_process_completed_at: new Date(nowMs - 1000).toISOString(),
      },
    ];
    const result = getDirtyTasks(attempts, { nowMs });
    expect(result).toHaveLength(1);
  });

  it("uses DIRTY_TASK_DEFAULTS.maxAgeHours by default", () => {
    expect(DIRTY_TASK_DEFAULTS.maxAgeHours).toBe(24);
  });
});

// ── prioritizeDirtyTasks ─────────────────────────────────────────────────────

describe("prioritizeDirtyTasks", () => {
  it("returns empty array for non-array input", () => {
    expect(prioritizeDirtyTasks(null)).toEqual([]);
    expect(prioritizeDirtyTasks(undefined)).toEqual([]);
  });

  it("returns empty array for empty array", () => {
    expect(prioritizeDirtyTasks([])).toEqual([]);
  });

  it("sorts by priority descending", () => {
    const tasks = [
      { id: "a", priority: 1 },
      { id: "b", priority: 3 },
      { id: "c", priority: 2 },
    ];
    const result = prioritizeDirtyTasks(tasks);
    expect(result.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("breaks ties by updated_at descending (most recent first)", () => {
    const now = Date.now();
    const tasks = [
      {
        id: "old",
        priority: 1,
        updated_at: new Date(now - 5000).toISOString(),
      },
      {
        id: "new",
        priority: 1,
        updated_at: new Date(now - 1000).toISOString(),
      },
    ];
    const result = prioritizeDirtyTasks(tasks);
    expect(result[0].id).toBe("new");
    expect(result[1].id).toBe("old");
  });

  it("limits results to maxCandidates", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      priority: i,
    }));
    const result = prioritizeDirtyTasks(tasks, { maxCandidates: 3 });
    expect(result).toHaveLength(3);
    // Should be highest priority first
    expect(result[0].id).toBe("t9");
    expect(result[1].id).toBe("t8");
    expect(result[2].id).toBe("t7");
  });

  it("uses DIRTY_TASK_DEFAULTS.maxCandidates by default", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      priority: 0,
    }));
    const result = prioritizeDirtyTasks(tasks);
    expect(result).toHaveLength(DIRTY_TASK_DEFAULTS.maxCandidates);
  });

  it("does not mutate input array", () => {
    const tasks = [
      { id: "a", priority: 1 },
      { id: "b", priority: 3 },
    ];
    const copy = [...tasks];
    prioritizeDirtyTasks(tasks);
    expect(tasks).toEqual(copy);
  });

  it("handles tasks with missing priority (defaults to 0)", () => {
    const tasks = [{ id: "with", priority: 5 }, { id: "without" }];
    const result = prioritizeDirtyTasks(tasks);
    expect(result[0].id).toBe("with");
  });
});

// ── shouldReserveDirtySlot ───────────────────────────────────────────────────

describe("shouldReserveDirtySlot", () => {
  it("returns false for empty array", () => {
    expect(shouldReserveDirtySlot([])).toBe(false);
  });

  it("returns false for non-array", () => {
    expect(shouldReserveDirtySlot(null)).toBe(false);
    expect(shouldReserveDirtySlot(undefined)).toBe(false);
  });

  it("returns true when tasks.length >= minCountToReserve (default 1)", () => {
    expect(shouldReserveDirtySlot([{ id: "a" }])).toBe(true);
    expect(shouldReserveDirtySlot([{ id: "a" }, { id: "b" }])).toBe(true);
  });

  it("respects custom minCountToReserve", () => {
    expect(
      shouldReserveDirtySlot([{ id: "a" }], { minCountToReserve: 2 }),
    ).toBe(false);
    expect(
      shouldReserveDirtySlot([{ id: "a" }, { id: "b" }], {
        minCountToReserve: 2,
      }),
    ).toBe(true);
  });
});

// ── getDirtySlotReservation ──────────────────────────────────────────────────

describe("getDirtySlotReservation", () => {
  it("returns not-reserved for empty tasks", () => {
    const result = getDirtySlotReservation([]);
    expect(result.reserved).toBe(false);
    expect(result.count).toBe(0);
    expect(result.reason).toBe("none");
  });

  it("returns reserved with count for dirty tasks", () => {
    const tasks = [{ id: "a" }, { id: "b" }];
    const result = getDirtySlotReservation(tasks);
    expect(result.reserved).toBe(true);
    expect(result.count).toBe(2);
    expect(result.reason).toBe("dirty-tasks");
  });

  it("handles non-array input gracefully", () => {
    const result = getDirtySlotReservation(null);
    expect(result.reserved).toBe(false);
    expect(result.count).toBe(0);
  });
});

// ── buildConflictResolutionPrompt ────────────────────────────────────────────

describe("buildConflictResolutionPrompt", () => {
  it("returns prompt with upstream branch", () => {
    const prompt = buildConflictResolutionPrompt({
      upstreamBranch: "origin/main",
    });
    expect(prompt).toContain("origin/main");
  });

  it("includes auto-resolve summary for lock files", () => {
    const prompt = buildConflictResolutionPrompt({
      conflictFiles: ["pnpm-lock.yaml", "src/main.ts"],
      upstreamBranch: "origin/main",
    });
    expect(prompt).toContain("pnpm-lock.yaml→theirs");
    expect(prompt).toContain("src/main.ts");
  });

  it("includes manual conflict entries", () => {
    const prompt = buildConflictResolutionPrompt({
      conflictFiles: ["pkg/provider_daemon/bid_engine.go"],
      upstreamBranch: "origin/develop",
    });
    expect(prompt).toContain("Manual conflicts remain:");
    expect(prompt).toContain("pkg/provider_daemon/bid_engine.go");
  });

  it("classifies CHANGELOG.md as ours", () => {
    const prompt = buildConflictResolutionPrompt({
      conflictFiles: ["CHANGELOG.md"],
      upstreamBranch: "origin/main",
    });
    expect(prompt).toContain("CHANGELOG.md→ours");
  });

  it("classifies .lock extension as theirs", () => {
    const prompt = buildConflictResolutionPrompt({
      conflictFiles: ["vendor/something.lock"],
      upstreamBranch: "origin/main",
    });
    expect(prompt).toContain("something.lock→theirs");
  });

  it("handles empty conflict files", () => {
    const prompt = buildConflictResolutionPrompt({
      conflictFiles: [],
      upstreamBranch: "origin/main",
    });
    expect(prompt).toContain("origin/main");
    expect(prompt).toContain("Auto-resolve summary: none");
  });

  it("handles missing parameters with defaults", () => {
    const prompt = buildConflictResolutionPrompt();
    expect(prompt).toContain("origin/main");
    expect(prompt).toContain("Auto-resolve summary: none");
  });

  it("handles multiple lock files", () => {
    const prompt = buildConflictResolutionPrompt({
      conflictFiles: [
        "pnpm-lock.yaml",
        "package-lock.json",
        "yarn.lock",
        "go.sum",
      ],
    });
    expect(prompt).toContain("pnpm-lock.yaml→theirs");
    expect(prompt).toContain("package-lock.json→theirs");
    expect(prompt).toContain("yarn.lock→theirs");
    expect(prompt).toContain("go.sum→theirs");
    expect(prompt).not.toContain("Manual conflicts remain:");
  });

  it("includes checkout instructions", () => {
    const prompt = buildConflictResolutionPrompt({
      conflictFiles: ["go.sum", "src/handler.go"],
    });
    expect(prompt).toContain("git checkout --theirs");
    expect(prompt).toContain("git checkout --ours");
  });
});

// ── isFileOverlapWithDirtyPR ─────────────────────────────────────────────────

describe("isFileOverlapWithDirtyPR", () => {
  it("returns false for empty inputs", () => {
    expect(isFileOverlapWithDirtyPR([], [])).toBe(false);
  });

  it("returns false when no overlap exists", () => {
    expect(isFileOverlapWithDirtyPR(["src/a.ts"], ["src/b.ts"])).toBe(false);
  });

  it("detects exact file overlap", () => {
    expect(isFileOverlapWithDirtyPR(["src/main.ts"], ["src/main.ts"])).toBe(
      true,
    );
  });

  it("is case-insensitive", () => {
    expect(isFileOverlapWithDirtyPR(["SRC/Main.ts"], ["src/main.ts"])).toBe(
      true,
    );
  });

  it("detects overlap with multiple files", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const dirtyFiles = ["src/x.ts", "src/b.ts"];
    expect(isFileOverlapWithDirtyPR(files, dirtyFiles)).toBe(true);
  });

  it("returns false when no files overlap among many", () => {
    const files = ["src/a.ts", "src/b.ts"];
    const dirtyFiles = ["src/x.ts", "src/y.ts"];
    expect(isFileOverlapWithDirtyPR(files, dirtyFiles)).toBe(false);
  });

  it("handles null/undefined gracefully", () => {
    expect(isFileOverlapWithDirtyPR(null, null)).toBe(false);
    expect(isFileOverlapWithDirtyPR(undefined, ["a.ts"])).toBe(false);
    expect(isFileOverlapWithDirtyPR(["a.ts"], undefined)).toBe(false);
  });
});

// ── DIRTY_TASK_DEFAULTS ──────────────────────────────────────────────────────

describe("DIRTY_TASK_DEFAULTS", () => {
  it("has expected shape and values", () => {
    expect(DIRTY_TASK_DEFAULTS).toEqual({
      maxAgeHours: 24,
      minCountToReserve: 1,
      maxCandidates: 5,
    });
  });

  it("is an object", () => {
    expect(typeof DIRTY_TASK_DEFAULTS).toBe("object");
    expect(DIRTY_TASK_DEFAULTS).not.toBeNull();
  });
});

// ── Dirty task registry ──────────────────────────────────────────────────────

describe("registerDirtyTask / clearDirtyTask / isDirtyTask", () => {
  beforeEach(() => {
    // Clear any leftover state between tests
    clearDirtyTask("test-1");
    clearDirtyTask("test-2");
  });

  it("registers and checks a dirty task", () => {
    expect(isDirtyTask("test-1")).toBe(false);
    registerDirtyTask({ taskId: "test-1", prNumber: 42, branch: "ve/test" });
    expect(isDirtyTask("test-1")).toBe(true);
  });

  it("clears a dirty task", () => {
    registerDirtyTask({ taskId: "test-1" });
    expect(isDirtyTask("test-1")).toBe(true);
    clearDirtyTask("test-1");
    expect(isDirtyTask("test-1")).toBe(false);
  });

  it("clearing a non-existent task is a no-op", () => {
    expect(() => clearDirtyTask("nonexistent")).not.toThrow();
  });

  it("ignores registration with no taskId", () => {
    registerDirtyTask({});
    registerDirtyTask();
    // Should not throw, and registry should remain empty for missing ids
    expect(isDirtyTask(undefined)).toBe(false);
  });
});

// ── getHighTierForDirty ──────────────────────────────────────────────────────

describe("getHighTierForDirty", () => {
  it("returns HIGH tier with reason", () => {
    const result = getHighTierForDirty();
    expect(result.tier).toBe("HIGH");
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ── Resolution cooldown ──────────────────────────────────────────────────────

describe("recordResolutionAttempt / isOnResolutionCooldown", () => {
  it("is not on cooldown before any attempt", () => {
    expect(isOnResolutionCooldown("cool-1")).toBe(false);
  });

  it("is on cooldown immediately after an attempt", () => {
    recordResolutionAttempt("cool-2");
    expect(isOnResolutionCooldown("cool-2")).toBe(true);
  });

  it("respects custom cooldown duration", () => {
    recordResolutionAttempt("cool-3");
    // With 0ms cooldown it should already be expired
    expect(isOnResolutionCooldown("cool-3", { cooldownMs: 0 })).toBe(false);
    // With a very long cooldown it should still be active
    expect(isOnResolutionCooldown("cool-3", { cooldownMs: 999999999 })).toBe(
      true,
    );
  });
});

// ── formatDirtyTaskSummary ───────────────────────────────────────────────────

describe("formatDirtyTaskSummary", () => {
  beforeEach(() => {
    clearDirtyTask("fmt-1");
    clearDirtyTask("fmt-2");
  });

  it("returns zero count when no dirty tasks", () => {
    const summary = formatDirtyTaskSummary();
    expect(summary).toContain("0");
  });

  it("includes task info when dirty tasks exist", () => {
    registerDirtyTask({ taskId: "fmt-1", prNumber: 99, title: "Fix auth" });
    const summary = formatDirtyTaskSummary();
    expect(summary).toContain("1");
    expect(summary).toContain("Fix auth");
    expect(summary).toContain("99");
  });
});
