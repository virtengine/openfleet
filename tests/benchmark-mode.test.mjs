import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  clearBenchmarkModeState,
  readBenchmarkModeState,
  taskMatchesBenchmarkMode,
  writeBenchmarkModeState,
} from "../bench/benchmark-mode.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix) {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("benchmark mode state", () => {
  it("persists normalized repo-local benchmark mode state", () => {
    const repoRoot = makeTempDir("bosun-benchmark-mode-");
    const workspaceDir = resolve(repoRoot, "workspace");
    const mode = writeBenchmarkModeState(repoRoot, {
      enabled: true,
      providerId: "SWEBENCH",
      workspaceId: "bench-alpha",
      workspaceDir,
      requiredTagsAll: ["Benchmark"],
      requiredTagsAny: ["SWEBench"],
      pauseOtherAgents: true,
      maxParallel: 2,
    });

    const modePath = resolve(repoRoot, ".bosun", ".cache", "benchmark-mode.json");
    expect(existsSync(modePath)).toBe(true);
    expect(mode.providerId).toBe("swebench");
    expect(mode.scopePaths).toContain(workspaceDir);

    const persisted = JSON.parse(readFileSync(modePath, "utf8"));
    expect(persisted.providerId).toBe("swebench");

    const reloaded = readBenchmarkModeState(repoRoot);
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.requiredTagsAll).toEqual(["benchmark"]);
    expect(reloaded.requiredTagsAny).toEqual(["swebench"]);
    expect(reloaded.workspaceId).toBe("bench-alpha");

    const cleared = clearBenchmarkModeState(repoRoot);
    expect(cleared.enabled).toBe(false);
    expect(existsSync(modePath)).toBe(false);
  });

  it("matches benchmark tasks by workspace path and generic benchmark metadata", () => {
    const repoRoot = makeTempDir("bosun-benchmark-match-");
    const workspaceDir = resolve(repoRoot, "workspace");
    const mode = {
      enabled: true,
      providerId: "swebench",
      workspaceDir,
      requiredTagsAll: ["benchmark"],
      requiredTagsAny: ["swebench"],
    };

    const matchingTask = {
      id: "task-1",
      workspace: workspaceDir,
      tags: ["benchmark"],
      meta: {
        benchmark: { type: "swebench", provider: "swebench" },
      },
    };
    const wrongWorkspaceTask = {
      ...matchingTask,
      id: "task-2",
      workspace: resolve(repoRoot, "other-workspace"),
    };
    const wrongProviderTask = {
      ...matchingTask,
      id: "task-3",
      meta: {
        benchmark: { type: "library-resolver", provider: "library-resolver" },
      },
    };

    expect(taskMatchesBenchmarkMode(matchingTask, mode, { repoRoot })).toBe(true);
    expect(taskMatchesBenchmarkMode(wrongWorkspaceTask, mode, { repoRoot })).toBe(false);
    expect(taskMatchesBenchmarkMode(wrongProviderTask, mode, { repoRoot })).toBe(false);
  });
});
