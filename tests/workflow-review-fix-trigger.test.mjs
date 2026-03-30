import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("workflow review-fix trigger routing", () => {
  const engineSource = readFileSync(
    resolve(process.cwd(), "workflow/workflow-engine.mjs"),
    "utf8",
  );

  it("allows trigger.task_assigned workflows to react to task.review_fix_requested", () => {
    expect(engineSource).toContain('tNode.type === "trigger.task_assigned"');
    expect(engineSource).toContain('eventType !== "task.review_fix_requested"');
  });
});