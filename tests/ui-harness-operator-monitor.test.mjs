import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentSources = [
  "ui/tabs/agents.js",
  "site/ui/tabs/agents.js",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

const workflowSources = [
  "ui/tabs/workflows.js",
  "site/ui/tabs/workflows.js",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

const demoSources = [
  "ui/demo.html",
  "site/ui/demo.html",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

for (const { relPath, source } of agentSources) {
  describe(`harness operator monitor (${relPath})`, () => {
    it("renders the harness monitor summary card and filters", () => {
      expect(source).toContain("Harness Monitor");
      expect(source).toContain("harnessFilterOptions");
      expect(source).toContain("No harness runs match this filter.");
    });

    it("loads harness telemetry from shared status signals", () => {
      expect(source).toContain("statusData");
      expect(source).toContain("telemetrySummary");
      expect(source).toContain("normalizeHarnessRuns");
    });

    it("resolves harness approvals directly from the monitor", () => {
      expect(source).toContain("/api/harness/approvals/");
      expect(source).toContain("resolveHarnessApproval");
      expect(source).toContain("Harness approval granted.");
      expect(source).toContain("Harness approval denied.");
    });
  });
}

for (const { relPath, source } of workflowSources) {
  describe(`workflow approval queue harness integration (${relPath})`, () => {
    it("merges workflow and harness approval requests into one queue", () => {
      expect(source).toContain("mergeApprovalRequestLists");
      expect(source).toContain("/api/workflows/approvals");
      expect(source).toContain("/api/harness/approvals");
    });

    it("routes harness approval actions to the harness API and agents monitor", () => {
      expect(source).toContain('scopeType === "harness-run"');
      expect(source).toContain('navigateTo("agents", {');
      expect(source).toContain("harnessRunId");
      expect(source).toContain("harnessSource");
      expect(source).toContain("Open Harness Monitor");
    });
  });
}

for (const { relPath, source } of demoSources) {
  describe(`demo harness approval fixture (${relPath})`, () => {
    it("defines a harness approvals endpoint for the operator dashboard", () => {
      expect(source).toContain("route === '/api/harness/approvals'");
      expect(source).toContain("demo-approval-1");
      expect(source).toContain("Approve harness patch application");
    });
  });
}
