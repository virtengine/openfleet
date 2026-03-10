import { afterEach, describe, expect, it } from "vitest";
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
