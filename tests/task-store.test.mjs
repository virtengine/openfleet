import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadTaskStore() {
  await vi.resetModules();
  vi.unmock("node:fs");
  return import("../task-store.mjs");
}

async function loadTaskStoreWithFsOverride(overrideFactory) {
  await vi.resetModules();
  vi.unmock("node:fs");
  vi.doMock("node:fs", async (importOriginal) => {
    const actual = await importOriginal();
    return overrideFactory(actual);
  });
  return import("../task-store.mjs");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unmock("node:fs");
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("task-store recovery and persistence", () => {
  it("snapshots corrupted JSON and initializes a safe empty store", async () => {
    const taskStore = await loadTaskStore();
    const tempDir = makeTempDir("ve-task-store-corrupt-");
    const storePath = resolve(tempDir, "kanban-state.json");
    const corruptedPayload = "{\n  \"tasks\": {\n    \"broken\": true\n";

    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, corruptedPayload, "utf-8");

    taskStore.configureTaskStore({ storePath });
    taskStore.loadStore();

    expect(taskStore.getAllTasks()).toEqual([]);

    const persisted = JSON.parse(readFileSync(storePath, "utf-8"));
    expect(persisted.tasks).toEqual({});

    const backups = readdirSync(tempDir).filter(
      (name) =>
        name.startsWith("kanban-state.json.corrupt-") && name.endsWith(".json"),
    );

    expect(backups.length).toBe(1);
    expect(readFileSync(resolve(tempDir, backups[0]), "utf-8")).toBe(
      corruptedPayload,
    );
  });

  it("preserves final task state during rapid sequential updates", async () => {
    const taskStore = await loadTaskStore();
    const tempDir = makeTempDir("ve-task-store-seq-");
    const storePath = resolve(tempDir, "kanban-state.json");

    taskStore.configureTaskStore({ storePath });
    taskStore.addTask({ id: "task-1", title: "initial" });

    for (let i = 0; i < 30; i++) {
      taskStore.updateTask("task-1", {
        title: `title-${i}`,
        lastError: `error-${i}`,
      });
    }

    await taskStore.waitForStoreWrites();

    const persisted = JSON.parse(readFileSync(storePath, "utf-8"));
    expect(persisted.tasks["task-1"].title).toBe("title-29");
    expect(persisted.tasks["task-1"].lastError).toBe("error-29");
  });

  it("cleans up temporary file after successful atomic rename", async () => {
    const taskStore = await loadTaskStore();
    const tempDir = makeTempDir("ve-task-store-tmp-");
    const storePath = resolve(tempDir, "kanban-state.json");
    const tmpPath = `${storePath}.tmp`;

    taskStore.configureTaskStore({ storePath });
    taskStore.addTask({ id: "task-1", title: "tmp cleanup" });
    await taskStore.waitForStoreWrites();

    expect(existsSync(tmpPath)).toBe(false);
  });

  it("falls back to direct write when atomic rename fails and removes tmp file", async () => {
    const tempDir = makeTempDir("ve-task-store-rename-fallback-");
    const storePath = resolve(tempDir, "kanban-state.json");
    const tmpPath = `${storePath}.tmp`;

    const renameSyncMock = vi.fn(() => {
      const error = new Error("simulated busy rename");
      error.code = "EBUSY";
      throw error;
    });

    let unlinkSyncMock;
    const taskStore = await loadTaskStoreWithFsOverride((actual) => {
      unlinkSyncMock = vi.fn((filePath) => actual.unlinkSync(filePath));
      return {
        ...actual,
        renameSync: renameSyncMock,
        unlinkSync: unlinkSyncMock,
      };
    });

    taskStore.configureTaskStore({ storePath });
    taskStore.addTask({ id: "task-1", title: "rename fallback" });
    await taskStore.waitForStoreWrites();

    expect(renameSyncMock).toHaveBeenCalled();
    expect(unlinkSyncMock).toHaveBeenCalledWith(tmpPath);
    expect(existsSync(tmpPath)).toBe(false);

    const persisted = JSON.parse(readFileSync(storePath, "utf-8"));
    expect(persisted.tasks["task-1"].title).toBe("rename fallback");
  });
});
