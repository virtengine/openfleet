import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
  };
});

const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await vi.importActual("node:fs");

import {
  addTask,
  configureTaskStore,
  getStats,
  loadStore,
  waitForStoreWrites,
} from "../task/task-store.mjs";

const tempDirs = [];

afterEach(() => {
  vi.doUnmock("../task/task-store.mjs");
  vi.resetModules();
  vi.clearAllMocks();
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

function parseJsonPayloadFromStdout(stdout) {
  const text = String(stdout || "");
  const jsonStart = text.indexOf("{");
  if (jsonStart === -1) {
    throw new Error(`No JSON payload found in stdout: ${text}`);
  }
  return JSON.parse(text.slice(jsonStart));
}

function omitTaskStatsField(stats, field) {
  const next = { ...stats };
  delete next[field];
  return next;
}

function addUnexpectedTaskStatsField(stats, field, value) {
  return {
    ...stats,
    [field]: value,
  };
}

function withTaskStatsCounter(stats, field, value) {
  return {
    ...stats,
    [field]: value,
  };
}

async function buildRealisticTaskStatsFixture(overrides = {}) {
  const storePath = makeTempStorePath();
  configureTaskStore({ storePath });
  loadStore();

  const tasks = [
    { title: "Draft task", status: "draft", draft: true },
    { title: "Todo task", status: "todo", draft: false },
    { title: "In Progress task", status: "inprogress", draft: false },
    { title: "In Review task", status: "inreview", draft: false },
    { title: "Done task", status: "done", draft: false },
    { title: "Blocked task", status: "blocked", draft: false },
  ];

  for (const task of tasks) {
    addTask({
      id: randomUUID(),
      workspace: "virtengine-gh",
      repository: "bosun",
      ...task,
    });
  }

  await waitForStoreWrites();
  return {
    storePath,
    stats: {
      ...getStats(),
      ...overrides,
    },
  };
}

async function buildInvalidTaskStatsFixture(mutator) {
  const fixture = await buildRealisticTaskStatsFixture();
  return {
    ...fixture,
    stats: mutator(fixture.stats),
  };
}

function buildRuntimePayloadFixture(overrides = {}) {
  const now = Date.now();
  return {
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
        mergeLatencySamples: [
          5 * 60 * 60 * 1000,
          5 * 60 * 60 * 1000,
          5 * 60 * 60 * 1000,
        ],
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
    ...overrides,
  };
}

async function loadTaskCliModule() {
  vi.resetModules();
  return import("../task/task-cli.mjs");
}

async function loadTaskCliModuleWithMockedStats(stats) {
  vi.resetModules();
  vi.doMock("../task/task-store.mjs", async () => {
    const actual = await vi.importActual("../task/task-store.mjs");
    return {
      ...actual,
      configureTaskStore: vi.fn(),
      loadStore: vi.fn(),
      getStats: vi.fn(() => stats),
    };
  });
  return import("../task/task-cli.mjs");
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
      title: "Delete me",
      status: "todo",
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
    const tasks = Object.values(readStore(storePath).tasks || {});
    expect(tasks).toHaveLength(0);
  });
});

describe("task-cli taskStats repo area lock state", () => {
  it("includes repo area lock summary in JSON stats output", () => {
    const storePath = makeTempStorePath();
    const runtimeStatePath = resolve(tempDirs[tempDirs.length - 1], "task-executor-runtime.json");
    const runtimePayload = buildRuntimePayloadFixture();

    writeFileSync(runtimeStatePath, JSON.stringify(runtimePayload), "utf8");
    const result = spawnSync(
      process.execPath,
      ["task/task-cli.mjs", "stats", "--json"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BOSUN_STORE_PATH: storePath,
          BOSUN_TASK_EXECUTOR_RUNTIME_FILE: runtimeStatePath,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const stats = parseJsonPayloadFromStdout(result.stdout);
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
  });

  it("returns null lock state when runtime payload is absent", () => {
    const storePath = makeTempStorePath();
    const missingRuntimeStatePath = resolve(
      tempDirs[tempDirs.length - 1],
      "missing-task-executor-runtime.json",
    );
    const result = spawnSync(
      process.execPath,
      ["task/task-cli.mjs", "stats", "--json"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BOSUN_STORE_PATH: storePath,
          BOSUN_TASK_EXECUTOR_RUNTIME_FILE: missingRuntimeStatePath,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const stats = parseJsonPayloadFromStdout(result.stdout);
    expect(stats.repoAreaLocks).toBeNull();
  });

  it("keeps default stats output lock-telemetry free without debug mode", async () => {
    const runtimePayload = buildRuntimePayloadFixture({
      repoAreaParallelLimit: 2,
      repoAreaDispatchCycles: 2,
      repoAreaConflictCount: 1,
      repoAreaLockMetrics: {
        infra: {
          conflicts: 1,
          blockedDispatches: 1,
          selectedDispatches: 1,
          waitMsTotal: 850,
          waitSamples: 1,
        },
      },
      repoAreaContentionEvents: [
        {
          at: "2026-03-09T10:00:00.000Z",
          taskId: "task-123",
          area: "infra",
          waitMs: 850,
          resolutionReason: "selected",
        },
      ],
    });
    mockExistsSync.mockImplementation((filePath) =>
      String(filePath || "").includes("task-executor-runtime.json"),
    );
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath || "").includes("task-executor-runtime.json")) {
        return JSON.stringify(runtimePayload);
      }
      return "{}";
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runTaskCli } = await loadTaskCliModule();
    await runTaskCli(["stats"]);

    const output = logSpy.mock.calls.map((entry) => entry.join(" ")).join("\n");
    expect(output).toContain("Task Statistics");
    expect(output).not.toContain("Repo Area Locks");
    expect(output).not.toContain("contention:");
    logSpy.mockRestore();
  });

  it("shows lock diagnostics in stats output when debug mode is enabled", async () => {
    const runtimePayload = buildRuntimePayloadFixture({
      repoAreaParallelLimit: 2,
      repoAreaDispatchCycles: 2,
      repoAreaConflictCount: 1,
      repoAreaLockMetrics: {
        infra: {
          conflicts: 1,
          blockedDispatches: 1,
          selectedDispatches: 1,
          waitMsTotal: 850,
          waitSamples: 1,
        },
      },
      repoAreaContentionEvents: [
        {
          at: "2026-03-09T10:00:00.000Z",
          taskId: "task-123",
          area: "infra",
          waitMs: 850,
          resolutionReason: "selected",
        },
      ],
    });
    mockExistsSync.mockImplementation((filePath) =>
      String(filePath || "").includes("task-executor-runtime.json"),
    );
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath || "").includes("task-executor-runtime.json")) {
        return JSON.stringify(runtimePayload);
      }
      return "{}";
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runTaskCli } = await loadTaskCliModule();
    await runTaskCli(["stats", "--debug"]);

    const output = logSpy.mock.calls.map((entry) => entry.join(" ")).join("\n");
    expect(output).toContain("Repo Area Locks");
    expect(output).toContain("Contention Events:");
    expect(output).toContain("contention: area=infra, waitMs=850, reason=selected, task=task-123");
    logSpy.mockRestore();
  });

  it("renders normal task stats output from realistic store-backed fixtures", async () => {
    const { storePath } = await buildRealisticTaskStatsFixture();

    const result = spawnSync(
      process.execPath,
      ["task/task-cli.mjs", "stats"],
      {
        cwd: process.cwd(),
        env: { ...process.env, BOSUN_STORE_PATH: storePath },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Draft:       1");
    expect(result.stdout).toContain("Todo:        1");
    expect(result.stdout).toContain("In Progress: 1");
    expect(result.stdout).toContain("In Review:   1");
    expect(result.stdout).toContain("Done:        1");
    expect(result.stdout).toContain("Blocked:     1");
    expect(result.stdout).toContain("Total:       6");
  });

  it("fails fast when task stats are missing required fields", async () => {
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("{}");

    const fixture = await buildRealisticTaskStatsFixture();
    const { taskStats } = await loadTaskCliModuleWithMockedStats(
      omitTaskStatsField(fixture.stats, "blocked"),
    );

    await expect(taskStats()).rejects.toThrow(/taskStats\.blocked: missing required field/i);
  });

  it("fails fast when task stats include unexpected fields", async () => {
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("{}");

    const fixture = await buildRealisticTaskStatsFixture();
    const { taskStats } = await loadTaskCliModuleWithMockedStats({
      ...fixture.stats,
      archived: 2,
    });

    await expect(taskStats()).rejects.toThrow(/taskStats\.archived: unexpected field/i);
  });

  it("fails fast when task stats counters are malformed", async () => {
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("{}");

    const fixture = await buildRealisticTaskStatsFixture({ inreview: "three" });
    const { taskStats } = await loadTaskCliModuleWithMockedStats(fixture.stats);

    await expect(taskStats()).rejects.toThrow(/taskStats\.inreview: expected a non-negative integer/i);
  });
});
