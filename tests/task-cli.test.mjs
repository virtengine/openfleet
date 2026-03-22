import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockStatSync = vi.hoisted(() => vi.fn());
const mockConfigureTaskStore = vi.hoisted(() => vi.fn());
const mockLoadStore = vi.hoisted(() => vi.fn());
const mockGetStats = vi.hoisted(() => vi.fn());

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

function parseJsonPayloadFromStdout(stdout) {
  const text = String(stdout || "");
  const jsonStart = text.indexOf("{");
  if (jsonStart === -1) {
    throw new Error(`No JSON payload found in stdout: ${text}`);
  }
  return JSON.parse(text.slice(jsonStart));
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

  it("canonicalizes workspace and repository keys on create", () => {
    const storePath = makeTempStorePath();
    const result = spawnSync(
      process.execPath,
      [
        "cli.mjs",
        "task",
        "create",
        JSON.stringify({
          title: "Canonical task key",
          status: "todo",
          draft: false,
          workspace: "VirtEngine-GH\\BOSUN",
          repository: "VirtEngine-GH\\Repo-ONE/",
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
    const isWin = process.platform === "win32";
    expect(tasks[0]?.workspace).toBe(isWin ? "virtengine-gh/bosun" : "VirtEngine-GH/BOSUN");
    expect(tasks[0]?.repository).toBe(isWin ? "virtengine-gh/repo-one" : "VirtEngine-GH/Repo-ONE");
  });

  it("fails fast when repository keys collide after normalization", () => {
    const storePath = makeTempStorePath();
    const result = spawnSync(
      process.execPath,
      [
        "cli.mjs",
        "task",
        "create",
        JSON.stringify({
          title: "Collision task key",
          status: "todo",
          draft: false,
          repository: "virtengine-gh/bosun",
          repositories: ["virtengine-gh\\bosun/"],
        }),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, BOSUN_STORE_PATH: storePath },
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(String(result.stderr || "")).toMatch(/collision/i);
  });
});

describe("task-cli taskStats repo area lock state", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockExistsSync.mockImplementation(() => false);
    vi.doMock("../task/task-store.mjs", async () => {
      const actual = await vi.importActual("../task/task-store.mjs");
      return {
        ...actual,
        configureTaskStore: mockConfigureTaskStore,
        loadStore: mockLoadStore,
        getStats: mockGetStats,
      };
    });
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
    delete process.env.BOSUN_HOME;
  });

  it("resolves active workspace store path using canonical workspace/repository keys", async () => {
    process.env.BOSUN_HOME = resolve(tmpdir(), "bosun-home");
    const runtimePayload = {};
    const expectedStorePathFragment = ".bosun/.cache/kanban-state.json";

    mockExistsSync.mockImplementation((filePath) => {
      const value = String(filePath || "").replace(/\\/g, "/");
      if (value.endsWith("/bosun.config.json")) return true;
      if (value.includes(expectedStorePathFragment.replace("/kanban-state.json", ""))) return true;
      if (value.includes("task-executor-runtime.json")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((filePath) => {
      const value = String(filePath || "").replace(/\\/g, "/");
      if (value.endsWith("/bosun.config.json")) {
        return JSON.stringify({
          workspacesDir: "C:/tmp/workspaces",
          activeWorkspace: "VirtEngine-GH",
          workspaces: [
            {
              id: "virtengine-gh",
              activeRepo: "BOSUN",
              repos: [{ name: "bosun", primary: true }],
            },
          ],
        });
      }
      if (value.includes("task-executor-runtime.json")) {
        return JSON.stringify(runtimePayload);
      }
      return "{}";
    });

    vi.resetModules();
    const { taskStats } = await import("../task/task-cli.mjs");
    await taskStats();

    const firstCall = mockConfigureTaskStore.mock.calls[0]?.[0] || {};
    const configuredPath = String(firstCall.storePath || "").replace(/\\/g, "/");
    expect(configuredPath).toContain(expectedStorePathFragment);
  });

  it("prefers explicit REPO_ROOT store path over the active workspace mirror", async () => {
    process.env.BOSUN_HOME = resolve(tmpdir(), "bosun-home");
    process.env.REPO_ROOT = resolve(tmpdir(), "bosun-source-repo");

    mockExistsSync.mockImplementation((filePath) => {
      const value = String(filePath || "").replace(/\\/g, "/");
      if (value.endsWith("/bosun.config.json")) return true;
      if (value.includes("/workspaces/virtengine-gh/bosun/.bosun/.cache")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath || "").replace(/\\/g, "/").endsWith("/bosun.config.json")) {
        return JSON.stringify({
          workspacesDir: "C:/tmp/workspaces",
          activeWorkspace: "virtengine-gh",
          workspaces: [
            {
              id: "virtengine-gh",
              activeRepo: "bosun",
              repos: [{ name: "bosun", primary: true }],
            },
          ],
        });
      }
      return "{}";
    });

    vi.resetModules();
    const { taskStats } = await import("../task/task-cli.mjs");
    await taskStats();

    const firstCall = mockConfigureTaskStore.mock.calls[0]?.[0] || {};
    const configuredPath = String(firstCall.storePath || "").replace(/\\/g, "/");
    expect(configuredPath).toContain("/bosun-source-repo/.bosun/.cache/kanban-state.json");
    expect(configuredPath).not.toContain("/workspaces/virtengine-gh/bosun/.bosun/.cache/kanban-state.json");
  });

  it("fails fast when workspace ids collide after normalization", async () => {
    process.env.BOSUN_HOME = resolve(tmpdir(), "bosun-home");
    mockExistsSync.mockImplementation((filePath) =>
      String(filePath || "").replace(/\\/g, "/").endsWith("/bosun.config.json"),
    );
    mockReadFileSync.mockImplementation((filePath) => {
      if (String(filePath || "").replace(/\\/g, "/").endsWith("/bosun.config.json")) {
        return JSON.stringify({
          workspacesDir: "C:/tmp/workspaces",
          activeWorkspace: "prod",
          workspaces: [{ id: "prod/" }, { id: "prod" }],
        });
      }
      return "{}";
    });

    vi.resetModules();
    const { taskStats } = await import("../task/task-cli.mjs");
    await expect(taskStats()).rejects.toThrow(/collision/i);
  });

  it("surfaces adaptive repo-area lock state from runtime payload", async () => {
    const storePath = makeTempStorePath();
    const runtimeStatePath = resolve(tempDirs[tempDirs.length - 1], "task-executor-runtime.json");
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
    const runtimePayload = {
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
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runTaskCli } = await import("../task/task-cli.mjs");
    await runTaskCli(["stats"]);

    const output = logSpy.mock.calls.map((entry) => entry.join(" ")).join("\n");
    expect(output).toContain("Task Statistics");
    expect(output).not.toContain("Repo Area Locks");
    expect(output).not.toContain("contention:");
    logSpy.mockRestore();
  });

  it("shows lock diagnostics in stats output when debug mode is enabled", async () => {
    const runtimePayload = {
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
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runTaskCli } = await import("../task/task-cli.mjs");
    await runTaskCli(["stats", "--debug"]);

    const output = logSpy.mock.calls.map((entry) => entry.join(" ")).join("\n");
    expect(output).toContain("Repo Area Locks");
    expect(output).toContain("Contention Events:");
    expect(output).toContain("contention: area=infra, waitMs=850, reason=selected, task=task-123");
    logSpy.mockRestore();
  });
});
