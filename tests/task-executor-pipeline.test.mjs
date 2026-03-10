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
});
