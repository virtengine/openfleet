import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { buildRepoMap, buildArchitectEditorFrame, formatRepoTopology } from "../lib/repo-map.mjs";

let testRoot;

function makeTempRoot() {
  const dir = resolve(
    tmpdir(),
    `repo-map-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("repo-map", () => {
  beforeEach(() => {
    testRoot = makeTempRoot();
  });

  afterEach(async () => {
    if (testRoot && existsSync(testRoot)) {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("builds a query-scoped repo map from the Bosun agent index", () => {
    const indexDir = resolve(testRoot, ".bosun", "context-index");
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(resolve(indexDir, "agent-index.json"), JSON.stringify({
      files: [
        { path: "agent/primary-agent.mjs", summary: "primary agent routing and prompt framing" },
        { path: "tests/primary-agent.runtime.test.mjs", summary: "runtime coverage for primary agent framing" },
        { path: "workflow/workflow-nodes.mjs", summary: "workflow node implementations" },
      ],
      symbols: [
        { path: "agent/primary-agent.mjs", name: "buildArchitectEditorFrame", kind: "function", line: 100, signature: "buildArchitectEditorFrame(options, effectiveMode)" },
        { path: "agent/primary-agent.mjs", name: "execPrimaryPrompt", kind: "function", line: 200, signature: "execPrimaryPrompt(userMessage, options)" },
        { path: "tests/primary-agent.runtime.test.mjs", name: "primaryAgentRuntime", kind: "test", line: 10, signature: "primary agent framing tests" },
      ],
    }, null, 2), "utf8");

    const repoMap = buildRepoMap({
      repoRoot: testRoot,
      query: "primary agent framing",
      repoMapFileLimit: 2,
    });

    expect(repoMap.root).toBe(testRoot.replace(/\\/g, "/"));
    expect(repoMap.files).toHaveLength(2);
    expect(repoMap.files[0].path).toBe("agent/primary-agent.mjs");
    expect(repoMap.files[0].symbols).toContain("buildArchitectEditorFrame");
  });

  it("prepends architect/editor framing with explicit repo maps", () => {
    const frame = buildArchitectEditorFrame({
      executionRole: "editor",
      architectPlan: "1. Update prompt framing\n2. Run focused tests",
      repoMap: {
        root: "C:/repo",
        files: [
          { path: "agent/primary-agent.mjs", summary: "primary agent runtime", symbols: ["execPrimaryPrompt"] },
        ],
      },
    }, "agent");

    expect(frame).toContain("## Architect/Editor Execution");
    expect(frame).toContain("You are the editor phase.");
    expect(frame).toContain("## Architect Plan");
    expect(frame).toContain("## Repo Topology");
    expect(frame).toContain("Root: C:/repo");
    expect(frame).toContain("owner: agent");
    expect(frame).toContain("agent/primary-agent.mjs");
  });

  it("formats compact repo topology with ownership and adjacency summaries", () => {
    const topology = formatRepoTopology({
      root: "C:/repo",
      files: [
        { path: "workflow/workflow-engine.mjs", summary: "workflow runtime" },
        { path: "workflow/workflow-nodes.mjs", summary: "workflow nodes" },
        { path: "tests/workflow-engine.test.mjs", summary: "workflow runtime coverage" },
      ],
    });

    expect(topology).toContain("## Repo Topology");
    expect(topology).toContain("Areas: workflow (2), tests (1)");
    expect(topology).toContain("workflow/workflow-engine.mjs");
    expect(topology).toContain("owner: workflow");
    expect(topology).toContain("adjacent: workflow/workflow-nodes.mjs, tests/workflow-engine.test.mjs");
  });

  it("caps repo topology summaries to protect prompt budget", () => {
    const topology = formatRepoTopology({
      root: "C:/repo",
      files: [
        {
          path: "workflow/workflow-engine.mjs",
          summary: "This summary is intentionally very long so the compact repo topology formatter trims it before injecting it into planner and execution prompts.",
        },
      ],
    }, { repoMapSummaryLimit: 60 });

    expect(topology).toContain("This summary is intentionally very long so the compact re...");
    expect(topology).not.toContain("formatter trims it before injecting");
  });

  it("omits repo topology when architect/editor framing disables enrichment", () => {
    const frame = buildArchitectEditorFrame({
      executionRole: "editor",
      architectPlan: "1. Update prompt framing\n2. Run focused tests",
      includeRepoMap: false,
      repoMap: {
        root: "C:/repo",
        files: [
          { path: "workflow/workflow-engine.mjs", summary: "workflow runtime" },
        ],
      },
    }, "agent");

    expect(frame).toContain("## Architect/Editor Execution");
    expect(frame).toContain("## Architect Plan");
    expect(frame).not.toContain("## Repo Topology");
  });

  it("handles slash-heavy query input without regex backtracking", () => {
    const indexDir = resolve(testRoot, ".bosun", "context-index");
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(resolve(indexDir, "agent-index.json"), JSON.stringify({
      files: [
        { path: "lib/repo-map.mjs", summary: "repo map query tokenization" },
      ],
      symbols: [
        { path: "lib/repo-map.mjs", name: "tokenizeQuery", kind: "function", line: 155, signature: "tokenizeQuery(...parts)" },
      ],
    }, null, 2), "utf8");

    const repoMap = buildRepoMap({
      repoRoot: testRoot,
      query: `${"/".repeat(5000)}repo-map///`,
      repoMapFileLimit: 1,
    });

    expect(repoMap.files).toHaveLength(1);
    expect(repoMap.files[0].path).toBe("lib/repo-map.mjs");
    expect(repoMap.files[0].symbols).toContain("tokenizeQuery");
  });
});




