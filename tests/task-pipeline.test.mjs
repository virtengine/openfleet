import { describe, expect, it, vi } from "vitest";

import {
  FanoutPipeline,
  RacePipeline,
  SequentialPipeline,
} from "../task/pipeline.mjs";

describe("task pipeline primitives", () => {
  it("passes only the prior stage descriptor into the next sequential stage", async () => {
    const seen = [];
    const pipeline = SequentialPipeline([
      async (input, context) => {
        seen.push({ input, context });
        return {
          output: {
            taskId: "task-1",
            summary: "implemented",
            paths: ["task/pipeline.mjs"],
            internal: "do-not-forward",
          },
          tokensUsed: 11,
        };
      },
      async (input, context) => {
        seen.push({ input, context });
        return { output: { summary: "reviewed" }, tokensUsed: 7 };
      },
    ]);

    const result = await pipeline.run({ taskId: "task-1", summary: "fix bug", huge: "x".repeat(100) });

    expect(seen[1].context.freshContext).toBe(true);
    expect(seen[1].input).toEqual({
      taskId: "task-1",
      summary: "implemented",
      paths: ["task/pipeline.mjs"],
    });
    expect(seen[1].input.internal).toBeUndefined();
    expect(result.outputs).toHaveLength(2);
    expect(result.tokensUsed).toBe(18);
  });

  it("collects every fanout result", async () => {
    const pipeline = FanoutPipeline([
      async () => ({ output: { summary: "codex" }, tokensUsed: 3 }),
      async () => ({ output: { summary: "claude" }, tokensUsed: 5 }),
      async () => ({ output: { summary: "copilot" }, tokensUsed: 7 }),
    ]);

    const result = await pipeline.run({ summary: "search" });

    expect(result.ok).toBe(true);
    expect(result.outputs).toHaveLength(3);
    expect(result.outputs.map((entry) => entry.output.summary)).toEqual([
      "codex",
      "claude",
      "copilot",
    ]);
    expect(result.tokensUsed).toBe(15);
  });

  it("returns the first successful race result and cancels slower stages", async () => {
    const slow = vi.fn(async (_input, context) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        context.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
      return { output: { summary: "slow" } };
    });
    const fast = async () => ({ output: { summary: "fast" }, tokensUsed: 2 });

    const result = await RacePipeline([
      { name: "slow-agent", run: slow },
      { name: "fast-agent", run: fast },
    ]).run({ summary: "race" });

    expect(result.winner.stageName).toBe("fast-agent");
    expect(result.finalOutput).toEqual({ summary: "fast" });
    expect(result.outputs.some((entry) => entry.meta?.cancelled === true)).toBe(true);
  });
});
