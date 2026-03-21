import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";

const tempDirs = [];
const TEST_ENV_KEYS = [
  "VITEST",
  "VITEST_POOL_ID",
  "VITEST_WORKER_ID",
  "NODE_ENV",
  "JEST_WORKER_ID",
  "BOSUN_HOME",
  "BOSUN_DIR",
  "REPO_ROOT",
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
      delete process.env.REPO_ROOT;
      process.env.BOSUN_HOME = homeDir;

      const persistentPath = resolve(homeDir, ".cache", "kanban-state.json");
      const taskStore = await loadTaskStoreModule();

      expect(taskStore.getStorePath()).toContain("kanban-state-vitest-");
      expect(dirname(taskStore.getStorePath())).toContain(
        resolve(tmpdir(), "bosun-vitest"),
      );
      expect(taskStore.getStorePath()).not.toBe(persistentPath);
      expect(taskStore.getStorePath()).not.toContain(
        resolve(homeDir, ".cache"),
      );

      taskStore.configureTaskStore({ storePath: persistentPath });
      expect(taskStore.getStorePath()).toBe(persistentPath);
    } finally {
      restoreEnv(env);
    }
  });

  it("prefers explicit REPO_ROOT over BOSUN_HOME for default store resolution", async () => {
    const env = snapshotEnv();
    const explicitRepoRoot = makeTempDir("ve-task-store-explicit-repo-");
    const homeDir = makeTempDir("ve-task-store-explicit-home-");
    try {
      process.env.VITEST = "1";
      process.env.REPO_ROOT = explicitRepoRoot;
      process.env.BOSUN_HOME = homeDir;

      const taskStore = await loadTaskStoreModule();
      const storePath = String(taskStore.getStorePath() || "").toLowerCase();

      expect(storePath).toContain("kanban-state-vitest-");
      expect(storePath).toContain(basename(explicitRepoRoot).toLowerCase());
      expect(storePath).not.toContain(basename(homeDir).toLowerCase());
    } finally {
      restoreEnv(env);
    }
  });

  it("prefers inferred repo root over BOSUN_HOME when cwd is inside a repo", async () => {
    const env = snapshotEnv();
    const repoRoot = makeTempDir("ve-task-store-inferred-repo-");
    const homeDir = makeTempDir("ve-task-store-inferred-home-");
    try {
      delete process.env.REPO_ROOT;
      delete process.env.BOSUN_DIR;
      delete process.env.VITEST;
      delete process.env.VITEST_POOL_ID;
      delete process.env.VITEST_WORKER_ID;
      delete process.env.JEST_WORKER_ID;
      delete process.env.NODE_ENV;
      mkdirSync(resolve(repoRoot, ".git"), { recursive: true });

      const output = execFileSync(
        process.execPath,
        ["-e", `import(${JSON.stringify(pathToFileURL(resolve(process.cwd(), "task", "task-store.mjs")).href)}).then((m)=>console.log(m.getStorePath()))`],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            BOSUN_HOME: homeDir,
          },
          encoding: "utf8",
        },
      );
      const storePath = String(output || "").trim().toLowerCase();

      expect(storePath).toContain(resolve(repoRoot, ".bosun", ".cache", "kanban-state.json").toLowerCase());
      expect(storePath).not.toContain(basename(homeDir).toLowerCase());
    } finally {
      restoreEnv(env);
    }
  });
});

