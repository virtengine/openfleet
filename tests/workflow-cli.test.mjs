import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  executeWorkflowCommand,
  listWorkflowSummaries,
  parseWorkflowInput,
} from "../workflow/workflow-cli.mjs";

describe("workflow CLI helpers", () => {
  it("lists builtin and configured workflows", () => {
    const summaries = listWorkflowSummaries({
      workflows: {
        customRace: {
          type: "race",
          agents: ["implement", "review"],
        },
      },
    });

    expect(summaries.some((entry) => entry.name === "code-review-chain")).toBe(true);
    expect(summaries.some((entry) => entry.name === "customRace" && entry.source === "config")).toBe(true);
  });

  it("parses file and inline workflow input", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "bosun-workflow-cli-"));
    try {
      const filePath = resolve(dir, "input.json");
      writeFileSync(filePath, JSON.stringify({ title: "From file", prompt: "Run it" }), "utf8");

      expect(parseWorkflowInput('{"title":"Inline","prompt":"Go"}')).toEqual({
        title: "Inline",
        prompt: "Go",
      });
      expect(parseWorkflowInput(filePath)).toEqual({
        title: "From file",
        prompt: "Run it",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs declarative workflows with injected services", async () => {
    const stdout = [];
    const prompts = [];

    const response = await executeWorkflowCommand(
      ["workflow", "run", "code-review-chain", "--input", '{"title":"Task","prompt":"Ship it"}'],
      {
        stdout: (line) => stdout.push(line),
        config: { workflows: {} },
        forceJsonOutput: true,
        services: {
          agentPool: {
            async execWithRetry(prompt) {
              prompts.push(prompt);
              return {
                success: true,
                output: `step-${prompts.length}`,
                usage: { totalTokens: 1 },
              };
            },
          },
        },
      },
    );

    expect(response.ok).toBe(true);
    expect(response.result.success).toBe(true);
    expect(prompts).toHaveLength(3);
    expect(JSON.parse(stdout[0]).success).toBe(true);
  });
});

