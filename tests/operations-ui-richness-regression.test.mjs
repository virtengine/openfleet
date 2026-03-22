import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const tasksSurfaces = ["ui/tabs/tasks.js", "site/ui/tabs/tasks.js"].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

const workflowSurfaces = ["ui/tabs/workflows.js", "site/ui/tabs/workflows.js"].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

describe("operations UI richness regression", () => {
  for (const { relPath, source } of tasksSurfaces) {
    it(`${relPath} keeps chorus-style task surfaces together`, () => {
      expect(source).toContain('const viewMode = signal("kanban")');
      expect(source).toContain('aria-label="Task dependency graph"');
      expect(source).toContain("Workflow Activity");
      expect(source).toMatch(/task-comment-meta|jira-panel|inspector/i);
    });

    it(`${relPath} keeps task detail affordances persistent`, () => {
      expect(source).toContain("workflowRuns.length > 0");
      expect(source).toMatch(/detail|modal|panel/i);
    });
  }

  for (const { relPath, source } of workflowSurfaces) {
    it(`${relPath} keeps chorus-style workflow surfaces together`, () => {
      expect(source).toContain('viewMode.value = "canvas"');
      expect(source).toContain('viewMode.value = "runs"');
      expect(source).toContain("recentRuns");
      expect(source).toContain("liveEdgeActivity");
    });

    it(`${relPath} keeps persistent run detail state and side panels`, () => {
      expect(source).toContain("selectedRunDetail");
      expect(source).toMatch(/runsPanelOpen|inspector|panel/i);
    });
  }
});
