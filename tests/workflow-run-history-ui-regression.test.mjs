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

    it(`${label} auto-load older workflow runs with a sentinel`, () => {
      expect(source).toContain("tailSentinelRef");
      expect(source).toContain("new IntersectionObserver");
      expect(source).toContain("Load more runs");
      expect(source).toContain("of ${totalRuns} run(s)");
    });
  }
});
