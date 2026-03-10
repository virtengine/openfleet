import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  addTask,
  configureTaskStore,
  loadStore,
  waitForStoreWrites,
} from "../task/task-store.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempStorePath() {
  const dir = mkdtempSync(resolve(tmpdir(), "bosun-task-cli-"));
  tempDirs.push(dir);
  return resolve(dir, "kanban-state.json");
}

function readStore(storePath) {
  return JSON.parse(readFileSync(storePath, "utf8"));
}

describe("task CLI store persistence", () => {
  it("persists created tasks before the CLI exits", () => {
    const storePath = makeTempStorePath();
    const result = spawnSync(
      process.execPath,
      [
        "cli.mjs",
        "task",
        "create",
        JSON.stringify({
          title: "Persist created task",
          status: "todo",
          draft: false,
          workspace: "virtengine-gh",
          repository: "bosun",
        }),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, BOSUN_STORE_PATH: storePath },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const tasks = Object.values(readStore(storePath).tasks || {});
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe("Persist created task");
  });

  it("persists deleted tasks before the CLI exits", async () => {
    const storePath = makeTempStorePath();
    configureTaskStore({ storePath });
    loadStore();
    const task = addTask({
      id: randomUUID(),
      title: "Persist deleted task",
      status: "todo",
      draft: false,
      workspace: "virtengine-gh",
      repository: "bosun",
    });
    await waitForStoreWrites();

    const result = spawnSync(
      process.execPath,
      ["cli.mjs", "task", "delete", task.id],
      {
        cwd: process.cwd(),
        env: { ...process.env, BOSUN_STORE_PATH: storePath },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect((readStore(storePath).tasks || {})[task.id]).toBeUndefined();
  });
});

const {
  mockConfigureTaskStore,
  mockLoadStore,
  mockGetStats,
  mockReadFileSync,
  mockExistsSync,
  mockStatSync,
} = vi.hoisted(() => ({
  mockConfigureTaskStore: vi.fn(),
  mockLoadStore: vi.fn(),
  mockGetStats: vi.fn(() => ({
    draft: 1,
    todo: 2,
    inprogress: 1,
    inreview: 0,
    done: 3,
    blocked: 0,
    total: 7,
  })),
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn(() => false),
  mockStatSync: vi.fn(() => ({ isDirectory: () => false })),
}));

vi.mock("../task/task-store.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  mockConfigureTaskStore.mockImplementation((...args) => actual.configureTaskStore(...args));
  mockLoadStore.mockImplementation((...args) => actual.loadStore(...args));
  return {
    ...actual,
    configureTaskStore: mockConfigureTaskStore,
    loadStore: mockLoadStore,
    getStats: mockGetStats,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  mockReadFileSync.mockImplementation((...args) => actual.readFileSync(...args));
  mockExistsSync.mockImplementation((...args) => actual.existsSync(...args));
  mockStatSync.mockImplementation((...args) => actual.statSync(...args));
  return {
    ...actual,
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
    statSync: mockStatSync,
  };
});

describe("task-cli taskStats repo area lock state", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockExistsSync.mockImplementation(() => false);
    vi.doMock("../task/task-store.mjs", () => ({
      configureTaskStore: mockConfigureTaskStore,
      loadStore: mockLoadStore,
      getStats: mockGetStats,
    }));
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual("node:fs");
      return {
        ...actual,
        readFileSync: mockReadFileSync,
        existsSync: mockExistsSync,
        statSync: mockStatSync,
      };
    });
  });

  afterEach(() => {
    vi.doUnmock("../task/task-store.mjs");
    vi.doUnmock("node:fs");
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
