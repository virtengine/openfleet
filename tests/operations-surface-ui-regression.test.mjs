import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("operations surface UI regression", () => {
  const tasksSource = readFileSync(resolve(process.cwd(), "ui/tabs/tasks.js"), "utf8");
  const workflowsSource = readFileSync(resolve(process.cwd(), "ui/tabs/workflows.js"), "utf8");

  it("tasks tab exposes chorus-style operations views and persistent detail shell", () => {
    expect(tasksSource).toContain("operationsViewMode");
    expect(tasksSource).toContain("OperationsActivityFeed");
    expect(tasksSource).toContain("OperationsNotificationsRail");
    expect(tasksSource).toContain("PersistentRunDetailPanel");
    expect(tasksSource).toContain("Kanban");
    expect(tasksSource).toContain("Dependency DAG");`n    expect(tasksSource).toContain("OperationsKanbanSummary");`n    expect(tasksSource).toContain("OperationsDagPreview");`n    expect(tasksSource).toContain("Chorus-style Kanban");
  });

  it("tasks tab renders task and workflow activity summaries", () => {
    expect(tasksSource).toContain("buildOperationsActivityItems");
    expect(tasksSource).toContain("buildOperationsNotificationItems");
    expect(tasksSource).toContain("Recent activity");
    expect(tasksSource).toContain("Notifications");
    expect(tasksSource).toContain("workflow run");
  });

  it("workflow tab keeps a persistent run detail panel alongside history and graph", () => {
    expect(workflowsSource).toContain("PersistentRunDetailPanel");
    expect(workflowsSource).toContain("Run timeline");
    expect(workflowsSource).toContain("Live activity");
    expect(workflowsSource).toContain("selectedRunDetail");`n    expect(workflowsSource).toContain("OperationsKanbanSummary");`n    expect(workflowsSource).toContain("OperationsDagPreview");`n    expect(workflowsSource).toContain("Workflow runs board");
  });
});

