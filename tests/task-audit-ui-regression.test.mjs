import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceFiles = [
  "ui/tabs/tasks.js",
  "site/ui/tabs/tasks.js",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

for (const { relPath, source } of sourceFiles) {
  describe(`task audit UI parity (${relPath})`, () => {
    it("merges workflow runs sourced from audit activity", () => {
      expect(source).toContain("const taskAuditWorkflowRuns = useMemo(() => {");
      expect(source).toContain("taskAuditActivity?.workflowRuns");
      expect(source).toContain("normalizeTaskWorkflowRunEntry(entry)");
      expect(source).toContain("const hasTaskAuditContent = Boolean(");
    });

    it("renders all ledger-backed task audit panels", () => {
      expect(source).toContain("Claim Ledger");
      expect(source).toContain("Session & Agent Activity");
      expect(source).toContain("Tool Calls");
      expect(source).toContain("Artifacts");
      expect(source).toContain("Operator Actions");
      expect(source).toContain("Promoted Strategies");
      expect(source).toContain("Promoted Strategy Events");
      expect(source).toContain("Task Trace Events");
      expect(source).toContain("Ledger Workflow Runs");
      expect(source).toContain("ledger workflow runs");
      expect(source).toContain("claim lifecycle events");
    });

    it("surfaces delegated workflow and task topology", () => {
      expect(source).toContain("Delegation Topology");
      expect(source).toContain("Task graph:");
      expect(source).toContain("Delegation depth");
      expect(source).toContain("Task lineage:");
      expect(source).toContain("Session ancestry:");
      expect(source).toContain("child runs");
      expect(source).toContain("child sessions");
      expect(source).toContain("normalizeTaskWorkflowDelegationTopology");
    });
  });
}
