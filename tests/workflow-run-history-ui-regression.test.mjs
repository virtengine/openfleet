import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("workflow run history UI pagination", () => {
  const uiSource = readFileSync(resolve(process.cwd(), "ui/tabs/workflows.js"), "utf8");
  const siteSource = readFileSync(resolve(process.cwd(), "site/ui/tabs/workflows.js"), "utf8");

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
      expect(source).toContain("graphBefore");
      expect(source).toContain("graphAfter");
    });

    it(`${label} exposes explicit edge port mapping controls`, () => {
      if (label !== "ui") return;
      expect(source).toContain("Port Bindings");
      expect(source).toContain("Source Port");
      expect(source).toContain("Target Port");
      expect(source).toContain("updateEdgePortMapping");
      expect(source).toContain("Unknown output port");
      expect(source).toContain("Unknown input port");
    });
  }
});