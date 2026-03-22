import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { buildRepoMap, buildArchitectEditorFrame } from "../lib/repo-map.mjs";

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
    expect(frame).toContain("Root: C:/repo");
    expect(frame).toContain("agent/primary-agent.mjs");
  });
});
