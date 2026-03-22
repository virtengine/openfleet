import { describe, expect, it } from "vitest";

import {
  FanoutPipeline,
  RacePipeline,
  SequentialPipeline,
} from "../workflow/pipeline.mjs";

describe("workflow pipeline primitives", () => {
  it("supports plain agent specs through options.agentRunner", async () => {
    const seen = [];
    const pipeline = new SequentialPipeline(
      [
        { id: "analyze", role: "analyze" },
        { id: "implement", role: "implement" },
      ],
      {
        agentRunner(agent, descriptor) {
          seen.push({ agent: agent.id, descriptor });
          if (agent.id === "analyze") {
            return {
              success: true,
              output: {
                taskId: descriptor.task.taskId,
                summary: "analysis-ready",
                paths: ["task/task-executor.mjs"],
              },
              summary: "analysis-ready",
              usage: { totalTokens: 3 },
              filePaths: ["task/task-executor.mjs"],
            };
          }
          return {
            success: true,
            output: {
              taskId: descriptor.task.taskId,
              summary: `implemented-from:${descriptor.previous?.summary}`,
            },
            summary: `implemented-from:${descriptor.previous?.summary}`,
            usage: { totalTokens: 5 },
          };
        },
      },
    );

    const result = await pipeline.run({
      taskId: "task-1",
      summary: "extract pipeline primitives",
      largeContext: "x".repeat(1000),
    });

    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(2);
    expect(result.outputs[1].summary).toContain("analysis-ready");
    expect(result.tokensUsed.totalTokens).toBe(8);
    expect(seen[1].descriptor.previous.summary).toBe("analysis-ready");
  });

  it("races plain agent specs and returns first successful winner", async () => {
    const pipeline = new RacePipeline(
      [{ id: "slow" }, { id: "fast" }],
      {
        async agentRunner(agent, _descriptor, context) {
          if (agent.id === "slow") {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 80);
              context.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              }, { once: true });
            });
            return { success: true, output: { summary: "slow" }, usage: { totalTokens: 1 } };
          }
          return { success: true, output: { summary: "fast" }, usage: { totalTokens: 2 } };
        },
      },
    );

    const result = await pipeline.run({ taskId: "task-2", summary: "race mode" });
    expect(result.success).toBe(true);
    expect(result.winner.agentId).toBe("fast");
    expect(result.finalOutput.output.summary).toBe("fast");
    expect(result.outputs.some((entry) => entry.agentId === "fast")).toBe(true);
  });

  it("fanout still aggregates all outputs with structured token usage", async () => {
    const pipeline = new FanoutPipeline([
      async () => ({ success: true, output: { summary: "a" }, usage: { totalTokens: 1 } }),
      async () => ({ success: true, output: { summary: "b" }, usage: { totalTokens: 2 } }),
    ]);

    const result = await pipeline.run({ taskId: "task-3", summary: "fanout mode" });
    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(2);
    expect(result.tokensUsed.totalTokens).toBe(3);
  });
});
