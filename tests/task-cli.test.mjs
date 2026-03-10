import { beforeEach, describe, expect, it, vi } from "vitest";

const mockConfigureTaskStore = vi.fn();
const mockLoadStore = vi.fn();
const mockGetStats = vi.fn(() => ({
  draft: 1,
  todo: 2,
  inprogress: 1,
  inreview: 0,
  done: 3,
  blocked: 0,
  total: 7,
}));

const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn(() => false);
const mockStatSync = vi.fn(() => ({ isDirectory: () => false }));

vi.mock("../task/task-store.mjs", () => ({
  configureTaskStore: mockConfigureTaskStore,
  loadStore: mockLoadStore,
  getStats: mockGetStats,
}));

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
  statSync: mockStatSync,
}));

describe("task-cli taskStats repo area lock state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockImplementation(() => false);
  });

  it("surfaces adaptive repo-area lock state from runtime payload", async () => {
    const now = Date.now();
    const runtimePayload = {
      repoAreaParallelLimit: 3,
      repoAreaDispatchCycles: 4,
      repoAreaConflictCount: 3,
      repoAreaDispatchCycle: {
        cycle: 4,
        selectedCount: 1,
        blockedTasks: 2,
        blockedByArea: { infra: 2 },
        areaLimits: {
          infra: {
            configuredLimit: 3,
            effectiveLimit: 1,
            adaptivePenalty: 2,
            adaptiveReasons: ["failure_rate", "merge_latency"],
          },
        },
      },
      repoAreaLockMetrics: {
        infra: {
          conflicts: 3,
          blockedDispatches: 3,
          selectedDispatches: 1,
          waitMsTotal: 1400,
          waitSamples: 2,
          maxWaitMs: 900,
        },
      },
      repoAreaTelemetry: {
        infra: {
          recentOutcomes: [1, 1, 0, 1],
          mergeLatencySamples: [5 * 60 * 60 * 1000, 5 * 60 * 60 * 1000, 5 * 60 * 60 * 1000],
        },
      },
      repoAreaBlockedTasks: {
        "blocked-1": {
          blockedAt: now - 2000,
          lastObservedWaitMs: 2000,
          areas: ["infra"],
        },
      },
      repoAreaTaskAreas: {
        "task-1": ["infra"],
      },
      slots: {
        "task-1": {
          startedAt: now - 5 * 60 * 60 * 1000,
          attempt: 2,
          status: "running",
        },
      },
    };

    mockExistsSync.mockImplementation((filePath) =>
      String(filePath || "").includes("task-executor-runtime.json"),
    );
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath || "").includes("task-executor-runtime.json")) {
        return JSON.stringify(runtimePayload);
      }
      return "{}";
    });

    vi.resetModules();
    const { taskStats } = await import("../task/task-cli.mjs");
    const stats = await taskStats();

    expect(stats.total).toBe(7);
    expect(stats.repoAreaLocks).toEqual(
      expect.objectContaining({
        enabled: true,
        configuredLimit: 3,
        dispatchCycles: 4,
        conflictEvents: 3,
        totals: expect.objectContaining({
          dispatchCycles: 4,
          conflictEvents: 3,
          blockedDispatches: 3,
        }),
      }),
    );
    expect(stats.repoAreaLocks.areas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          area: "infra",
          effectiveLimit: 1,
          adaptivePenalty: 2,
          waitingTasks: 1,
          activeFailureRate: 1,
          adaptiveReasons: expect.arrayContaining(["failure_rate", "merge_latency"]),
        }),
      ]),
    );
    expect(stats.repoAreaLocks.lastDispatch.areaLimits).toEqual(
      expect.objectContaining({
        infra: expect.objectContaining({
          configuredLimit: 3,
          effectiveLimit: 1,
        }),
      }),
    );
  });

  it("returns null lock state when runtime payload is absent", async () => {
    mockExistsSync.mockImplementation(() => false);
    mockReadFileSync.mockReturnValue("{}");

    vi.resetModules();
    const { taskStats } = await import("../task/task-cli.mjs");
    const stats = await taskStats();

    expect(stats.total).toBe(7);
    expect(stats.repoAreaLocks).toBeNull();
  });
});
