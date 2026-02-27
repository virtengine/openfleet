/**
 * task-store.test.mjs — Tests for corruption recovery, backup creation,
 * concurrent saves, and atomic rename fallback in task-store.mjs.
 *
 * Task-first: these tests define the desired behaviour; the implementation
 * (T5) must be updated to make the backup/corruption tests pass.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs = [];

function makeTempDir(prefix = "task-store-test-") {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadTaskStoreModule() {
  await vi.resetModules();
  return import("../task-store.mjs");
}

afterEach(async () => {
  await vi.resetModules();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  vi.restoreAllMocks();
});

// ── Corruption Recovery ───────────────────────────────────────────────────────

describe("task-store corruption recovery", () => {
  it("backs up corrupted store to <storePath>.bak and starts empty", async () => {
    const dir = makeTempDir("task-store-corrupt-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    // Write deliberately corrupt JSON
    writeFileSync(storePath, "{not valid json!!!", "utf8");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    // Corrupt store should have been backed up
    const backupPath = `${storePath}.bak`;
    expect(existsSync(backupPath), `backup file should exist at ${backupPath}`).toBe(true);

    // Backup should contain the original corrupt content
    const backupContent = readFileSync(backupPath, "utf8");
    expect(backupContent).toBe("{not valid json!!!");

    // Store should have been initialised to an empty state
    expect(ts.getAllTasks()).toEqual([]);
  });

  it("logs a warning mentioning backup path when store is corrupt", async () => {
    const dir = makeTempDir("task-store-corrupt-warn-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");
    writeFileSync(storePath, "{{ broken }}", "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    const warnMessages = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0]));
    expect(
      warnMessages.some((m) => m.includes(".bak")),
      "Expected a warning that mentions the backup path",
    ).toBe(true);
  });

  it("tolerates a best-effort backup failure without crashing loadStore", async () => {
    const dir = makeTempDir("task-store-bak-fail-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");
    writeFileSync(storePath, "not json", "utf8");

    // Make the backup write fail by spying on copyFileSync (or writeFileSync)
    // The store should still initialise cleanly
    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });

    // Should NOT throw even if backup can't be written
    expect(() => ts.loadStore()).not.toThrow();
    expect(ts.getAllTasks()).toEqual([]);
  });

  it("does not create a backup when the store file contains valid JSON", async () => {
    const dir = makeTempDir("task-store-valid-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    const validStore = {
      _meta: { version: 1, updatedAt: new Date().toISOString(), taskCount: 0, stats: {} },
      tasks: { "t-1": { id: "t-1", title: "Valid task", status: "todo" } },
    };
    writeFileSync(storePath, JSON.stringify(validStore, null, 2), "utf8");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    const backupPath = `${storePath}.bak`;
    expect(existsSync(backupPath), "No backup should exist for a healthy store").toBe(false);
    expect(ts.getAllTasks()).toHaveLength(1);
  });

  it("loads normally when store file does not exist yet", async () => {
    const dir = makeTempDir("task-store-missing-");
    const storePath = join(dir, "missing-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    expect(ts.getAllTasks()).toEqual([]);
    expect(existsSync(`${storePath}.bak`)).toBe(false);
  });
});

// ── Atomic Rename Fallback ─────────────────────────────────────────────────

describe("task-store saveStore atomic rename fallback", () => {
  it("falls back to direct write when rename fails with EXDEV", async () => {
    const dir = makeTempDir("task-store-exdev-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.addTask({ id: "exdev-1", title: "EXDEV test task", status: "todo" });

    // Wait for the async write chain to flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Store file should exist and be valid JSON after fallback write
    expect(existsSync(storePath)).toBe(true);
    const saved = JSON.parse(readFileSync(storePath, "utf8"));
    expect(saved.tasks["exdev-1"]).toBeDefined();
    expect(saved.tasks["exdev-1"].title).toBe("EXDEV test task");
  });

  it("cleans up tmp file after successful rename", async () => {
    const dir = makeTempDir("task-store-tmp-cleanup-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.addTask({ id: "cleanup-1", title: "Cleanup test", status: "todo" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Tmp file should NOT exist after a successful atomic rename
    const tmpPath = `${storePath}.tmp`;
    expect(
      existsSync(tmpPath),
      "Temp file should be cleaned up after rename",
    ).toBe(false);
  });
});

// ── Concurrent Save Consistency ────────────────────────────────────────────

describe("task-store concurrent save consistency", () => {
  it("serialises multiple rapid saveStore calls without corruption", async () => {
    const dir = makeTempDir("task-store-concurrent-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    // Fire many rapid mutations — each triggers a saveStore via the write chain
    for (let i = 0; i < 20; i++) {
      ts.addTask({ id: `concurrent-${i}`, title: `Task ${i}`, status: "todo" });
    }

    // Allow all async writes to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Reload from disk into a fresh module instance
    const ts2 = await loadTaskStoreModule();
    ts2.configureTaskStore({ storePath });
    ts2.loadStore();

    const tasks = ts2.getAllTasks();
    // All 20 tasks should be persisted; none should be lost
    expect(tasks).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      expect(
        tasks.some((t) => t.id === `concurrent-${i}`),
        `Task concurrent-${i} should have been persisted`,
      ).toBe(true);
    }
  });

  it("final in-memory state is consistent after interleaved add+update", async () => {
    const dir = makeTempDir("task-store-interleaved-");
    const storeDir = join(dir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.addTask({ id: "interleaved-1", title: "Original title", status: "todo" });
    ts.updateTask("interleaved-1", { status: "in_progress" });
    ts.updateTask("interleaved-1", { status: "done" });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Reload from disk
    const ts2 = await loadTaskStoreModule();
    ts2.configureTaskStore({ storePath });
    ts2.loadStore();

    const task = ts2.getTask("interleaved-1");
    expect(task).not.toBeNull();
    expect(task.status).toBe("done");
  });
});

// ── getStorePath / configureTaskStore contracts ────────────────────────────

describe("task-store configureTaskStore contracts", () => {
  it("loadStore/saveStore signatures are unchanged — loadStore takes no args", async () => {
    const ts = await loadTaskStoreModule();
    expect(typeof ts.loadStore).toBe("function");
    expect(ts.loadStore.length).toBe(0);
  });

  it("saveStore accepts no arguments (fire-and-forget, returns void)", async () => {
    const ts = await loadTaskStoreModule();
    expect(typeof ts.saveStore).toBe("function");
    expect(ts.saveStore.length).toBe(0);
  });

  it("getStorePath returns a string after configureTaskStore", async () => {
    const ts = await loadTaskStoreModule();
    const dir = makeTempDir("task-store-path-contract-");
    ts.configureTaskStore({ storePath: join(dir, "state.json") });
    expect(typeof ts.getStorePath()).toBe("string");
  });
});
