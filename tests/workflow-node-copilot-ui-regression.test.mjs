import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("workflow node copilot UI surfaces", () => {
  const workflowUiSource = readFileSync(resolve(process.cwd(), "ui/tabs/workflows.js"), "utf8");

  it("shows node action presets in both inspector and run detail views", () => {
    expect(workflowUiSource).toContain("Explain Node");
    expect(workflowUiSource).toContain("Fix Node");
    expect(workflowUiSource).toContain("Retry Node");
    expect(workflowUiSource).toContain("Generate Test");
    expect(workflowUiSource).toContain("Summarize Output");
    expect(workflowUiSource).toContain("copilotActionStatus");
    expect(workflowUiSource).toContain("copilotActionResult");
    expect(workflowUiSource).toContain("/api/workflows/runs/");
  });
});
