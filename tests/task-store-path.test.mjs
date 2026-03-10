import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const tempDirs = [];
const TEST_ENV_KEYS = [
  "VITEST",
  "VITEST_POOL_ID",
  "VITEST_WORKER_ID",
  "NODE_ENV",
  "JEST_WORKER_ID",
  "BOSUN_HOME",
  "BOSUN_DIR",
];

function makeTempDir(prefix) {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadTaskStoreModule() {
  await vi.resetModules();
  return import("../task/task-store.mjs");
}

function snapshotEnv() {
  return Object.fromEntries(TEST_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const key of TEST_ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("task-store path configuration", () => {
  it("configureTaskStore changes active store path", async () => {
    const taskStore = await loadTaskStoreModule();
    const tempDir = makeTempDir("ve-task-store-");
    const customStorePath = resolve(tempDir, "custom-state.json");

    taskStore.configureTaskStore({ storePath: customStorePath });

    expect(taskStore.getStorePath()).toBe(customStorePath);
  });

  it("getStorePath returns path configured via baseDir", async () => {
    const taskStore = await loadTaskStoreModule();
    const baseDir = makeTempDir("ve-task-store-base-");
    const expectedPath = resolve(
      baseDir,
      ".bosun",
      ".cache",
      "kanban-state.json",
    );

    taskStore.configureTaskStore({ baseDir });

    expect(taskStore.getStorePath()).toBe(expectedPath);
  });

  it("reconfigure resets in-memory load state without throwing", async () => {
    const taskStore = await loadTaskStoreModule();
    const firstDir = makeTempDir("ve-task-store-first-");
    const secondDir = makeTempDir("ve-task-store-second-");
    const firstPath = resolve(firstDir, "first.json");
    const secondPath = resolve(secondDir, "second.json");

    taskStore.configureTaskStore({ storePath: firstPath });
    taskStore.loadStore();
    taskStore.addTask({ id: "task-1", title: "One" });
    expect(taskStore.getAllTasks().length).toBe(1);

    expect(() =>
      taskStore.configureTaskStore({ storePath: secondPath }),
    ).not.toThrow();

    taskStore.loadStore();
    expect(taskStore.getAllTasks()).toEqual([]);
  });

  it("isolates real persistent store paths during test runtime", async () => {
    const env = snapshotEnv();
    const homeDir = makeTempDir("ve-task-store-home-");
    try {
      process.env.VITEST = "1";
      process.env.BOSUN_HOME = homeDir;

      const persistentPath = resolve(process.cwd(), ".bosun", ".cache", "kanban-state.json");
      const taskStore = await loadTaskStoreModule();

      expect(taskStore.getStorePath()).toContain("kanban-state-vitest-");
      expect(taskStore.getStorePath()).not.toBe(persistentPath);

      taskStore.configureTaskStore({ storePath: persistentPath });
      expect(taskStore.getStorePath()).toContain("kanban-state-vitest-");
      expect(taskStore.getStorePath()).not.toBe(persistentPath);
    } finally {
      restoreEnv(env);
    }
  });
});

