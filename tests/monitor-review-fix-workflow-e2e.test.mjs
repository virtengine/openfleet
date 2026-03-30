import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../workflow/workflow-nodes/triggers.mjs";
import "../workflow/workflow-nodes/actions.mjs";
import "../workflow/workflow-nodes/flow.mjs";
import { WorkflowEngine } from "../workflow/workflow-engine.mjs";
import { dispatchWorkflowEvent } from "../infra/monitor.mjs";

function createWorkflow(id) {
  return {
    id,
    name: "Monitor Review Fix Regression",
    description: "Validates monitor dispatch for task.review_fix_requested",
    enabled: true,
    variables: {},
    nodes: [
      {
        id: "trigger",
        type: "trigger.task_assigned",
        label: "Task Assigned",
        config: {
          filter: "String(task?.id || $data?.taskId || '').trim() === 'TASK-REVIEW-FIX'",
        },
      },
      {
        id: "capture",
        type: "action.set_variable",
        label: "Capture Review Fix Event",
        config: {
          key: "reviewFixSignal",
          value: "{{workflowEvent}}",
        },
      },
      {
        id: "end",
        type: "flow.end",
        label: "End",
        config: {
          status: "completed",
          output: {
            workflowEvent: "{{workflowEvent}}",
            taskId: "{{taskId}}",
          },
        },
      },
    ],
    edges: [
      { source: "trigger", target: "capture" },
      { source: "capture", target: "end" },
    ],
  };
}

describe("monitor review-fix workflow dispatch", () => {
  let tempDir = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("executes a real trigger.task_assigned workflow for task.review_fix_requested", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    tempDir = mkdtempSync(join(tmpdir(), "bosun-monitor-review-fix-"));
    const engine = new WorkflowEngine({
      workflowDir: join(tempDir, "workflows"),
      runsDir: join(tempDir, "runs"),
      services: {},
    });

    const workflowId = "test-monitor-review-fix";
    engine.save(createWorkflow(workflowId));

    const result = await dispatchWorkflowEvent(
      "task.review_fix_requested",
      {
        workflowEvent: "task.review_fix_requested",
        taskId: "TASK-REVIEW-FIX",
        task: {
          id: "TASK-REVIEW-FIX",
          title: "Apply requested review changes",
        },
      },
      {
        engine,
        awaitRuns: true,
      },
    );

    expect(result).toMatchObject({
      triggered: true,
      triggeredCount: 1,
    });
    expect(Array.isArray(result.runs)).toBe(true);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      workflowId,
      runStatus: "completed",
    });
    expect(result.runs[0].ctx?.data?.reviewFixSignal).toBe("task.review_fix_requested");
    expect(result.runs[0].ctx?.data?._workflowTerminalOutput).toMatchObject({
      workflowEvent: "task.review_fix_requested",
      taskId: "TASK-REVIEW-FIX",
    });
  });
});
