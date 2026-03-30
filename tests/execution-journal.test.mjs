import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];

function makeTempDir(prefix = "execution-journal-test-") {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadTaskStoreModule() {
  await vi.resetModules();
  return import("../task/task-store.mjs");
}

afterEach(async () => {
  await vi.resetModules();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("execution journal task-store integration", () => {
  it("persists task run journals with step and artifact files", async () => {
    const dir = makeTempDir("execution-journal-store-");
    const storePath = join(dir, ".bosun", ".cache", "kanban-state.json");
    mkdirSync(dirname(storePath), { recursive: true });

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.addTask({ id: "journal-task", title: "Journal task", status: "inprogress" });
    const appended = ts.appendTaskRun("journal-task", {
      runId: "run-1",
      status: "running",
      summary: "Journal me",
      sdk: "codex",
      steps: [
        {
          type: "tool_result",
          payload: {
            toolName: "write_file",
            artifacts: [
              { path: "output/result.txt", type: "file", mimeType: "text/plain" },
            ],
          },
        },
      ],
    });

    expect(appended).toMatchObject({
      runId: "run-1",
      journal: expect.objectContaining({
        taskId: "journal-task",
        runId: "run-1",
        stepCount: 1,
        artifactCount: 1,
      }),
    });

    const journalDir = join(dir, ".bosun", ".cache", "execution-journal", appended.journal.relativeDir);
    expect(existsSync(join(journalDir, "run.json"))).toBe(true);
    expect(existsSync(join(journalDir, "steps.jsonl"))).toBe(true);
    expect(existsSync(join(journalDir, "artifacts.json"))).toBe(true);

    const storedRun = JSON.parse(readFileSync(join(journalDir, "run.json"), "utf8"));
    const storedArtifacts = JSON.parse(readFileSync(join(journalDir, "artifacts.json"), "utf8"));
    const storedSteps = readFileSync(join(journalDir, "steps.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(storedRun).toMatchObject({
      taskId: "journal-task",
      runId: "run-1",
      stepCount: 1,
      artifactCount: 1,
      sdk: "codex",
    });
    expect(storedArtifacts).toEqual([
      expect.objectContaining({
        path: "output/result.txt",
        type: "file",
        mimeType: "text/plain",
      }),
    ]);
    expect(storedSteps).toHaveLength(1);
    expect(storedSteps[0]).toMatchObject({
      type: "tool_result",
    });
  });

  it("backfills run journals when loading legacy task store data", async () => {
    const dir = makeTempDir("execution-journal-backfill-");
    const storePath = join(dir, ".bosun", ".cache", "kanban-state.json");
    mkdirSync(dirname(storePath), { recursive: true });

    const legacyStore = {
      _meta: { version: 1, updatedAt: new Date().toISOString(), taskCount: 1, stats: {} },
      tasks: {
        "legacy-task": {
          id: "legacy-task",
          title: "Legacy task",
          status: "inprogress",
          runs: [
            {
              runId: "legacy-run",
              status: "failed",
              steps: [
                { type: "assistant", payload: { content: "Legacy assistant output" } },
              ],
            },
          ],
        },
      },
    };
    writeFileSync(storePath, JSON.stringify(legacyStore, null, 2), "utf8");

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();
    await ts.waitForStoreWrites();

    const run = ts.getTaskRuns("legacy-task")[0];
    expect(run.journal).toMatchObject({
      taskId: "legacy-task",
      runId: "legacy-run",
      stepCount: 1,
    });

    const persistedStore = JSON.parse(readFileSync(storePath, "utf8"));
    expect(persistedStore.tasks["legacy-task"].runs[0].journal).toMatchObject({
      taskId: "legacy-task",
      runId: "legacy-run",
    });
  });

  it("resolves active journal context for managed task sessions", async () => {
    const dir = makeTempDir("execution-journal-context-");
    const storePath = join(dir, ".bosun", ".cache", "kanban-state.json");
    mkdirSync(dirname(storePath), { recursive: true });

    const ts = await loadTaskStoreModule();
    ts.configureTaskStore({ storePath });
    ts.loadStore();

    ts.addTask({ id: "ctx-task", title: "Context task", status: "inprogress" });
    ts.appendTaskRun("ctx-task", {
      runId: "ctx-run",
      status: "running",
      steps: [{ type: "thread", payload: { sdk: "codex", resumed: true } }],
    });

    const ctx = await import("../task/task-context.mjs");
    const resolved = ctx.getBosunTaskExecutionJournalContext({
      env: {
        BOSUN_TASK_ID: "ctx-task",
        BOSUN_MANAGED: "1",
      },
    });

    expect(resolved).toMatchObject({
      taskId: "ctx-task",
      activeRun: expect.objectContaining({ runId: "ctx-run" }),
      journal: expect.objectContaining({
        taskId: "ctx-task",
        runId: "ctx-run",
      }),
    });
    expect(existsSync(resolved.journal.paths.runFile)).toBe(true);
    expect(existsSync(resolved.journal.paths.stepsFile)).toBe(true);
  });
});
