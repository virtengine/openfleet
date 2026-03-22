import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("operations surface UI regression", () => {
  for (const rel of [
    "ui/tabs/tasks.js",
    "site/ui/tabs/tasks.js",
  ]) {
    const source = readFileSync(resolve(process.cwd(), rel), "utf8");
    it(`${rel} exposes operations tab with notifications and activity feed`, () => {
      expect(source).toContain('activeTab === "operations"');
      expect(source).toContain("TaskOperationsRail");
      expect(source).toContain("Notifications");
      expect(source).toContain("Run detail");
      expect(source).toContain("Activity feed");
    });
  }

  for (const rel of [
    "ui/tabs/workflows.js",
    "site/ui/tabs/workflows.js",
  ]) {
    const source = readFileSync(resolve(process.cwd(), rel), "utf8");
    it(`${rel} exposes workflow notifications and persistent run panel`, () => {
      expect(source).toContain("summarizeWorkflowNotifications");
      expect(source).toContain("Persistent run detail panel");
      expect(source).toContain("Workflow activity feed");
      expect(source).toContain("workflow-run-columns");
    });
  }

  const styles = readFileSync(resolve(process.cwd(), "ui/styles.css"), "utf8");
  it("styles include task and workflow operations layout", () => {
    expect(styles).toContain(".task-operations-rail");
    expect(styles).toContain(".workflow-ops-card");
    expect(styles).toContain(".workflow-run-columns");
  });
});
