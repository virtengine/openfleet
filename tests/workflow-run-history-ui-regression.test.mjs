import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function extractFunctionSource(source, functionName, nextFunctionName) {
  const startToken = `function ${functionName}() {`;
  const endToken = `function ${nextFunctionName}(`;
  const startIndex = source.indexOf(startToken);
  const endIndex = source.indexOf(endToken, startIndex);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Unable to extract ${functionName} from source`);
  }

  return source.slice(startIndex, endIndex);
}

describe("workflow run history UI pagination", () => {
  const uiSource = readFileSync(resolve(process.cwd(), "ui/tabs/workflows.js"), "utf8");
  const siteSource = readFileSync(resolve(process.cwd(), "site/ui/tabs/workflows.js"), "utf8");
  const uiRunHistorySource = extractFunctionSource(uiSource, "RunHistoryView", "WorkflowCodeView");
  const siteRunHistorySource = extractFunctionSource(siteSource, "RunHistoryView", "WorkflowCodeView");

  for (const [label, source] of [
    ["ui", uiSource],
    ["site", siteSource],
  ]) {
    it(`${label} track total counts and next offsets from workflow run pagination`, () => {
      expect(source).toContain("workflowRunsTotal");
      expect(source).toContain("workflowRunsNextOffset");
      expect(source).toContain("data?.pagination?.total");
      expect(source).toContain("data?.pagination?.nextOffset");
      expect(source).toContain("data?.pagination?.hasMore");
    });

    it(`${label} keeps older workflow pagination manual-only`, () => {
      expect(source).not.toContain("tailSentinelRef");
      expect(source).not.toContain("autoLoadMoreRef");
      expect(source).not.toContain("new IntersectionObserver");
      expect(source).toContain("Load more runs");
      expect(source).toContain("of ${totalRuns} run(s)");
    });

    it(`${label} exposes DAG revision history in run details`, () => {
      if (label !== "ui") return;
      expect(source).toContain("DAG Revisions");
      expect(source).toContain("Graph Before:");
      expect(source).toContain("Graph After:");
    });

    it(`${label} exposes explicit edge port mapping controls`, () => {
      if (label !== "ui") return;
      expect(source).toContain("Port Bindings");
      expect(source).toContain("Source Port");
      expect(source).toContain("Target Port");
      expect(source).toContain("updateEdgePortMapping");
      expect(source).toContain("Select source port");
      expect(source).toContain("Select target port");
    });
  }

  for (const [label, source] of [
    ["ui", uiRunHistorySource],
    ["site", siteRunHistorySource],
  ]) {
    it(`${label} keeps RunHistoryView free of canvas-only edge editing symbols`, () => {
      expect(source).not.toMatch(/\beditingNode\b/);
      expect(source).not.toMatch(/\bselectedEdge\b/);
      expect(source).not.toContain("Selected edge");
      expect(source).not.toContain("Port Bindings");
      expect(source).not.toContain("updateEdgePortMapping");
      expect(source).not.toContain("validateEdgePortMapping");
    });
  }
});
