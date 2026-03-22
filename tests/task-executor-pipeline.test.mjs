import { describe, expect, it, vi } from "vitest";

import {
  createExecutionPipeline,
  runExecutionPipeline,
  runExecutionPipelineAgent,
} from "../task/task-executor-pipeline.mjs";

describe("task executor pipeline helpers", () => {
  it("maps execution mode to the expected pipeline primitive", () => {
    const runner = async () => ({ output: { summary: "ok" } });
    const fanout = createExecutionPipeline(
      "parallel-slots",
      [{ id: "a" }],
      { agentRunner: runner },
    );
    const race = createExecutionPipeline("failover", [{ id: "a" }], {
      agentRunner: runner,
    });
    const sequential = createExecutionPipeline("single", [{ id: "a" }], {
      agentRunner: runner,
    });

    expect(fanout.type).toBe("fanout");
    expect(race.type).toBe("race");
    expect(sequential.type).toBe("sequential");
  });

  it("runs plain agent descriptors through a shared runner with fresh context", async () => {
    const calls = [];
    const pipeline = createExecutionPipeline(
      "single",
      [{ id: "analyze" }, { id: "review" }],
      {
        task: { id: "task-1" },
        agentRunner: async (agent, input, context) => {
          calls.push({ agent: agent.id, input, context });
          return {
            output: {
              taskId: "task-1",
              summary: agent.id === "analyze" ? "analysis-ready" : "reviewed",
              paths: ["task/task-executor.mjs"],
              hidden: "do-not-forward",
            },
            tokensUsed: 2,
          };
        },
      },
    );

    const result = await pipeline.run({ taskId: "task-1", summary: "work item" });

    expect(result.ok).toBe(true);
    expect(result.outputs).toHaveLength(2);
    expect(result.tokensUsed).toBe(4);
    expect(calls[0].context.options.metadata.mode).toBe("single");
    expect(calls[1].input).toEqual({
      taskId: "task-1",
      summary: "analysis-ready",
      paths: ["task/task-executor.mjs"],
    });
  });

  it("builds a deterministic pipeline task key for execWithRetry calls", async () => {
    const execWithRetry = vi.fn(async () => ({
      success: true,
      output: "done",
      sdk: "codex",
      tokensUsed: 7,
    }));

    const result = await runExecutionPipelineAgent(
      { id: "implement", role: "implement", sdk: "codex" },
      { taskId: "task-1", summary: "work item" },
      {
        stageIndex: 1,
        runId: "run-1",
        options: { id: "task-1-single", metadata: { mode: "single" } },
        signal: null,
      },
      {
        execWithRetry,
        repoRoot: "C:/repo",
        timeoutMs: 1000,
      },
    );

    expect(execWithRetry).toHaveBeenCalledTimes(1);
    expect(execWithRetry.mock.calls[0][1].taskKey).toBe(
      "task-1-single-implement-2",
    );
    expect(result.tokensUsed).toBe(7);
    expect(result.meta.taskKey).toBe("task-1-single-implement-2");
  });

  it("exposes a convenience runner for one-off execution", async () => {
    const result = await runExecutionPipeline(
      "fanout",
      [
        { id: "a" },
        { id: "b" },
      ],
      { summary: "search" },
      {
        agentRunner: async (agent) => ({
          output: { summary: agent.id },
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.outputs).toHaveLength(2);
  });
  it("offloads heavy validation stages through an isolated runner lease", async () => {
    const acquireRunnerLease = vi.fn(async () => ({
      leaseId: "lease-1",
      runnerKind: "container",
      workspacePath: "/tmp/runner",
    }));
    const releaseRunnerLease = vi.fn(async () => {});
    const execHeavyValidation = vi.fn(async () => ({
      success: true,
      output: "npm test ok",
      sdk: "codex",
      exitCode: 0,
      compact: {
        summary: "npm test ok",
        retrievalCommand: "bosun artifacts get artifact://lease-1/stdout",
      },
      artifacts: [
        {
          id: "stdout",
          kind: "log",
          uri: "artifact://lease-1/stdout",
          label: "Full stdout",
        },
      ],
    }));

    const result = await runExecutionPipelineAgent(
      {
        id: "validate",
        role: "validation",
        sdk: "codex",
        heavy: true,
        command: "npm test",
      },
      { taskId: "task-1", summary: "run validation" },
      {
        stageIndex: 0,
        runId: "run-1",
        options: { id: "task-1-single", metadata: { mode: "single" } },
        signal: null,
      },
      {
        execWithRetry: vi.fn(),
        acquireRunnerLease,
        releaseRunnerLease,
        execHeavyValidation,
        repoRoot: "C:/repo",
        timeoutMs: 1000,
      },
    );

    expect(acquireRunnerLease).toHaveBeenCalledWith(
      expect.objectContaining({
        taskKey: "task-1-single-validate-1",
        taskId: "task-1",
        purpose: "validation",
      }),
    );
    expect(execHeavyValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({ leaseId: "lease-1" }),
        agent: expect.objectContaining({ id: "validate" }),
        input: expect.objectContaining({ taskId: "task-1" }),
      }),
    );
    expect(releaseRunnerLease).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-1", status: "completed" }),
    );
    expect(result.output).toEqual(
      expect.objectContaining({
        text: "npm test ok",
        compact: expect.objectContaining({
          summary: "npm test ok",
          retrievalCommand: "bosun artifacts get artifact://lease-1/stdout",
        }),
        artifacts: [
          expect.objectContaining({ uri: "artifact://lease-1/stdout" }),
        ],
      }),
    );
    expect(result.meta).toEqual(
      expect.objectContaining({
        taskKey: "task-1-single-validate-1",
        executionMode: "isolated-runner",
        leaseId: "lease-1",
      }),
    );
  });

  it("surfaces lease failures as blocked evidence and skips silent fallback", async () => {
    const acquireRunnerLease = vi.fn(async () => {
      throw new Error("runner pool unavailable");
    });
    const execWithRetry = vi.fn(async () => ({
      success: true,
      output: "should not run",
      sdk: "codex",
    }));

    await expect(
      runExecutionPipelineAgent(
        {
          id: "build",
          role: "build",
          heavy: true,
          command: "npm run build",
        },
        { taskId: "task-2", summary: "run build" },
        {
          stageIndex: 1,
          runId: "run-2",
          options: { id: "task-2-single", metadata: { mode: "single" } },
          signal: null,
        },
        {
          execWithRetry,
          acquireRunnerLease,
          repoRoot: "C:/repo",
        },
      ),
    ).rejects.toThrow(/blocked evidence/i);

    expect(execWithRetry).not.toHaveBeenCalled();
  });

  it("retries isolated heavy validation once before surfacing blocked evidence", async () => {
    const acquireRunnerLease = vi
      .fn()
      .mockResolvedValueOnce({ leaseId: "lease-a" })
      .mockResolvedValueOnce({ leaseId: "lease-b" });
    const releaseRunnerLease = vi.fn(async () => {});
    const execHeavyValidation = vi
      .fn()
      .mockRejectedValueOnce(new Error("sandbox boot failed"))
      .mockResolvedValueOnce({
        success: true,
        output: "build ok",
        sdk: "codex",
        compact: { summary: "build ok", retrievalCommand: "bosun artifacts get artifact://lease-b/build" },
        artifacts: [{ id: "build-log", uri: "artifact://lease-b/build", kind: "log" }],
      });

    const result = await runExecutionPipelineAgent(
      { id: "build", role: "build", heavy: true, command: "npm run build", runnerRetries: 2 },
      { taskId: "task-3", summary: "run build" },
      {
        stageIndex: 0,
        runId: "run-3",
        options: { id: "task-3-single", metadata: { mode: "single" } },
        signal: null,
      },
      {
        execWithRetry: vi.fn(),
        acquireRunnerLease,
        releaseRunnerLease,
        execHeavyValidation,
        repoRoot: "C:/repo",
      },
    );

    expect(acquireRunnerLease).toHaveBeenCalledTimes(2);
    expect(execHeavyValidation).toHaveBeenCalledTimes(2);
    expect(releaseRunnerLease).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-a", status: "failed" }),
    );
    expect(releaseRunnerLease).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-b", status: "completed" }),
    );
    expect(result.output.compact.summary).toBe("build ok");
  });
});

