import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadAgentPrompts } from "../config.mjs";

describe("loadAgentPrompts generic prompt loading", () => {
  /** @type {string} */
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(resolve(tmpdir(), "openfleet-prompts-"));
    await mkdir(resolve(rootDir, ".openfleet", "agents"), {
      recursive: true,
    });
  });

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
    delete process.env.OPENFLEET_PROMPT_MONITOR_MONITOR;
  });

  it("loads monitor-monitor prompt from .openfleet/agents when present", async () => {
    await writeFile(
      resolve(rootDir, ".openfleet", "agents", "monitor-monitor.md"),
      "CUSTOM_MONITOR_PROMPT",
      "utf8",
    );

    const prompts = loadAgentPrompts(rootDir, rootDir, {});
    expect(prompts.monitorMonitor).toContain("CUSTOM_MONITOR_PROMPT");
  });

  it("supports config override path for planner prompt", async () => {
    await mkdir(resolve(rootDir, "custom-prompts"), { recursive: true });
    await writeFile(
      resolve(rootDir, "custom-prompts", "planner.md"),
      "PLANNER_OVERRIDE_PROMPT",
      "utf8",
    );

    const prompts = loadAgentPrompts(rootDir, rootDir, {
      agentPrompts: { planner: "custom-prompts/planner.md" },
    });

    expect(prompts.planner).toContain("PLANNER_OVERRIDE_PROMPT");
  });

  it("supports env override path with highest priority", async () => {
    await mkdir(resolve(rootDir, "env-prompts"), { recursive: true });
    await writeFile(
      resolve(rootDir, "env-prompts", "monitor.md"),
      "ENV_MONITOR_PROMPT",
      "utf8",
    );

    process.env.OPENFLEET_PROMPT_MONITOR_MONITOR =
      "env-prompts/monitor.md";

    const prompts = loadAgentPrompts(rootDir, rootDir, {
      agentPrompts: {
        monitorMonitor: ".openfleet/agents/monitor-monitor.md",
      },
    });

    expect(prompts.monitorMonitor).toContain("ENV_MONITOR_PROMPT");
  });

  it("falls back to built-in prompt when no files exist", () => {
    const prompts = loadAgentPrompts(rootDir, rootDir, {});
    expect(prompts.orchestrator).toContain("Task Orchestrator Agent");
    expect(prompts.planner).toContain("Codex-Task-Planner Agent");
    expect(prompts.monitorMonitor).toContain("OpenFleet-Monitor Agent");
  });
});
