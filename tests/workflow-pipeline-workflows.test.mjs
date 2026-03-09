import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config/config.mjs";
import {
  getPipelineWorkflow,
  normalizePipelineWorkflows,
  runPipelineWorkflow,
} from "../workflow/pipeline-workflows.mjs";

describe("pipeline workflow definitions", () => {
  let tempConfigDir = "";

  beforeEach(async () => {
    tempConfigDir = await mkdtemp(resolve(tmpdir(), "bosun-workflow-config-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tempConfigDir) {
      await rm(tempConfigDir, { recursive: true, force: true });
    }
  });

  it("includes built-in workflow templates during normalization", () => {
    const workflows = normalizePipelineWorkflows({
      custom: {
        type: "race",
        stages: ["research", "implement"],
      },
    });

    expect(workflows["code-review-chain"]).toBeDefined();
    expect(workflows["parallel-search"]).toBeDefined();
    expect(workflows.custom.type).toBe("race");
  });

  it("loads config-defined workflows through loadConfig", async () => {
    await writeFile(
      resolve(tempConfigDir, "bosun.config.json"),
      JSON.stringify(
        {
          workflows: {
            "code-review": {
              type: "sequential",
              stages: ["implement", "test", "review"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(getPipelineWorkflow("code-review", config.workflows)).toBeDefined();
    expect(getPipelineWorkflow("parallel-search", config.workflows)).toBeDefined();
  });

  it("runs a workflow with an injected stage runner", async () => {
    const workflows = normalizePipelineWorkflows({
      demo: {
        type: "sequential",
        stages: ["implement", "review"],
      },
    });

    const result = await runPipelineWorkflow(
      "demo",
      { taskId: "task-123", summary: "Ship pipeline primitives" },
      {
        workflows,
        runStage(stage, input, context) {
          return {
            output: {
              taskId: input.taskId || "task-123",
              summary: `${stage.name}:${input.summary || input.taskId}`,
            },
            tokensUsed: context.stageIndex + 1,
          };
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.outputs).toHaveLength(2);
    expect(result.outputs[1].input.summary).toContain("implement");
    expect(result.tokensUsed).toBe(3);
  });
});
