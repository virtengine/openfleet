import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadAgentPrompts } from "../config.mjs";

describe("loadAgentPrompts generic prompt loading", () => {
  /** @type {string} */
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(resolve(tmpdir(), "bosun-prompts-"));
    await mkdir(resolve(rootDir, ".bosun", "agents"), {
      recursive: true,
    });
  });

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("supports config override path for taskExecutor prompt", async () => {
    await mkdir(resolve(rootDir, "custom-prompts"), { recursive: true });
    await writeFile(
      resolve(rootDir, "custom-prompts", "task-executor.md"),
      "EXECUTOR_OVERRIDE_PROMPT",
      "utf8",
    );

    const prompts = loadAgentPrompts(rootDir, rootDir, {
      agentPrompts: { taskExecutor: "custom-prompts/task-executor.md" },
    });

    expect(prompts.taskExecutor).toContain("EXECUTOR_OVERRIDE_PROMPT");
  });

  it("falls back to built-in prompt when no files exist", () => {
    const prompts = loadAgentPrompts(rootDir, rootDir, {});
    expect(prompts.orchestrator).toContain("Task Orchestrator Agent");
  });
});
