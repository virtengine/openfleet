import { describe, expect, it, vi } from "vitest";

import { createRunnerPool } from "../infra/runner-pool.mjs";

vi.mock("../infra/container-runner.mjs", async () => {
  const actual = await vi.importActual("../infra/container-runner.mjs");
  return {
    ...actual,
    isContainerEnabled: vi.fn(() => true),
    runInContainer: vi.fn(async () => ({
      exitCode: 0,
      stdout: "build ok\nsummary line",
      stderr: "",
      durationMs: 123,
    })),
  };
});

describe("infra runner pool", () => {
  it("acquires isolated leases and persists artifact retrieval pointers", async () => {
    process.env.BOSUN_HEAVY_RUNNER_USE_CONTAINER = "1";
    const pool = createRunnerPool({ workspaceRoot: process.cwd() });
    const lease = await pool.acquireLease({ taskId: "task-1", heavyType: "build" });

    const result = await lease.runCommand({
      command: "npm run build",
      cwd: process.cwd(),
      artifacts: [
        {
          name: "stdout",
          fileName: "stdout.log",
          content: "full build log",
        },
      ],
    });

    expect(lease.mode).toBe("container");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("build ok");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].path).toContain(".bosun");
    expect(result.artifacts[0].retrieveCommand).toContain("readFileSync");
  });

  it("fails explicitly when isolated runners are unavailable", async () => {
    process.env.BOSUN_HEAVY_RUNNER_USE_CONTAINER = "0";
    const pool = createRunnerPool({ workspaceRoot: process.cwd() });
    const lease = await pool.acquireLease({ taskId: "task-2", heavyType: "test" });

    await expect(
      lease.runCommand({ command: "npm test", cwd: process.cwd() }),
    ).rejects.toThrow(/No isolated runners available/i);
  });
});
