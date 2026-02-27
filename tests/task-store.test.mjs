import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadTaskStoreModule() {
  await vi.resetModules();
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

describe("task-store corruption recovery and write behavior", () => {
  it("backs up corrupted JSON and starts with empty state", async () => {
    const taskStore = await loadTaskStoreModule();
    const tempDir = makeTempDir("ve-task-store-corrupt-");
    const storePath = resolve(tempDir, "kanban-state.json");
    writeFileSync(storePath, "{not valid json", "utf-8");

    taskStore.configureTaskStore({ storePath });
    expect(() => taskStore.loadStore()).not.toThrow();
    expect(taskStore.getAllTasks()).toEqual([]);

    const backupFiles = readdirSync(tempDir).filter((name) =>
      name.startsWith("kanban-state.json.corrupt-"),
    );
    expect(backupFiles.length).toBe(1);
    const backupPayload = readFileSync(resolve(tempDir, backupFiles[0]), "utf-8");
    expect(backupPayload).toBe("{not valid json");
  });

  it("preserves final state after rapid sequential updates", async () => {
    const taskStore = await loadTaskStoreModule();
    const tempDir = makeTempDir("ve-task-store-write-chain-");
    const storePath = resolve(tempDir, "kanban-state.json");

    taskStore.configureTaskStore({ storePath });
    taskStore.addTask({ id: "task-1", title: "Initial", status: "todo" });

    for (let i = 0; i < 25; i += 1) {
      taskStore.updateTask("task-1", {
        title: `Title ${i}`,
        status: i % 2 === 0 ? "inprogress" : "inreview",
      });
    }

    await taskStore.waitForStoreWrites();

    const onDisk = JSON.parse(readFileSync(storePath, "utf-8"));
    expect(onDisk.tasks["task-1"].title).toBe("Title 24");
    expect(onDisk.tasks["task-1"].status).toBe("inprogress");
    expect(onDisk._meta.taskCount).toBe(1);
  });

  it("falls back to direct write when atomic rename fails and cleans tmp file", async () => {
    const fsActual = await vi.importActual("node:fs");
    const renameSyncSpy = vi
      .fn((fromPath, toPath) => fsActual.renameSync(fromPath, toPath))
      .mockImplementationOnce(() => {
        const err = new Error("busy");
        err.code = "EPERM";
        throw err;
      });

    vi.doMock("node:fs", () => ({
      ...fsActual,
      renameSync: renameSyncSpy,
    }));

    const taskStore = await loadTaskStoreModule();
    const tempDir = makeTempDir("ve-task-store-rename-fallback-");
    const storePath = resolve(tempDir, "kanban-state.json");
    const storeTmpPath = `${storePath}.tmp`;

    taskStore.configureTaskStore({ storePath });
    taskStore.addTask({ id: "task-1", title: "Atomic fallback", status: "todo" });
    await taskStore.waitForStoreWrites();

    expect(renameSyncSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(storePath)).toBe(true);
    expect(existsSync(storeTmpPath)).toBe(false);
    const onDisk = JSON.parse(readFileSync(storePath, "utf-8"));
    expect(onDisk.tasks["task-1"].title).toBe("Atomic fallback");
  });

  it("keeps fallback write successful even when tmp cleanup fails", async () => {
    const fsActual = await vi.importActual("node:fs");
    const renameSyncSpy = vi.fn(() => {
      const err = new Error("cross-device");
      err.code = "EXDEV";
      throw err;
    });
    const unlinkSyncSpy = vi.fn(() => {
      throw new Error("unlink blocked");
    });

    vi.doMock("node:fs", () => ({
      ...fsActual,
      renameSync: renameSyncSpy,
      unlinkSync: unlinkSyncSpy,
    }));

    const taskStore = await loadTaskStoreModule();
    const tempDir = makeTempDir("ve-task-store-cleanup-best-effort-");
    const storePath = resolve(tempDir, "kanban-state.json");

    taskStore.configureTaskStore({ storePath });
    taskStore.addTask({ id: "task-2", title: "Cleanup failure tolerant" });
    await taskStore.waitForStoreWrites();

    expect(renameSyncSpy).toHaveBeenCalledTimes(1);
    expect(unlinkSyncSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(storePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(storePath, "utf-8"));
    expect(onDisk.tasks["task-2"].title).toBe("Cleanup failure tolerant");
  });
});
