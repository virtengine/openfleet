import { describe, expect, it } from "vitest";

import {
  WORKFLOW_FLASH_DURATION_MS,
  buildWorkflowHistoryRows,
  buildWorkflowTemplateRows,
  createWorkflowTriggerFormState,
  reduceWorkflowStatusEvent,
  tickWorkflowStatusState,
} from "../ui/tui/workflows-screen-helpers.js";

describe("workflows-screen-helpers", () => {
  it("builds trigger form fields from schema properties", () => {
    const form = createWorkflowTriggerFormState({
      required: ["taskId"],
      properties: {
        taskId: { description: "Task id", default: "123" },
        note: { required: false, defaultValue: "hello" },
      },
    });

    expect(form.fields).toEqual([
      expect.objectContaining({ id: "taskId", required: true, value: "123", description: "Task id" }),
      expect.objectContaining({ id: "note", required: false, value: "hello" }),
    ]);
    expect(form.values).toEqual({ taskId: "123", note: "hello" });
  });

  it("shows running spinner and completion flash in template rows", () => {
    const active = reduceWorkflowStatusEvent(undefined, {
      eventType: "run:start",
      workflowId: "wf-1",
      workflowName: "Continuation Loop",
      runId: "run-1",
      timestamp: 1000,
      status: "running",
    }, 1000);

    const runningRow = buildWorkflowTemplateRows([
      { id: "wf-1", name: "Continuation Loop", requiredInputs: { taskId: { required: true } } },
    ], {
      activeRuns: active.activeRuns,
      flashByWorkflowId: active.flashByWorkflowId,
      now: 1000,
    })[0];

    expect(runningRow.name).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /);
    expect(runningRow.scheduleOrTrigger).toContain("taskId*");

    const done = reduceWorkflowStatusEvent(active, {
      eventType: "run:end",
      workflowId: "wf-1",
      workflowName: "Continuation Loop",
      runId: "run-1",
      timestamp: 1500,
      status: "completed",
      durationMs: 500,
    }, 1500);

    const flashedRow = buildWorkflowTemplateRows([
      { id: "wf-1", name: "Continuation Loop" },
    ], {
      activeRuns: done.activeRuns,
      flashByWorkflowId: done.flashByWorkflowId,
      now: 1500 + WORKFLOW_FLASH_DURATION_MS - 1,
    })[0];

    expect(flashedRow.name.startsWith("✔ ")).toBe(true);
  });

  it("ticks spinner frames for active runs", () => {
    const state = reduceWorkflowStatusEvent(undefined, {
      eventType: "run:start",
      workflowId: "wf-1",
      runId: "run-1",
      timestamp: 1000,
      status: "running",
    }, 1000);

    const next = tickWorkflowStatusState(state);
    expect(next.activeRuns.get("wf-1")?.spinnerFrame).toBe((state.activeRuns.get("wf-1")?.spinnerFrame + 1) % 10);
  });

  it("caps and sorts recent history rows", () => {
    const rows = buildWorkflowHistoryRows([
      { runId: "r1", workflowId: "wf", workflowName: "One", startedAt: 10, endedAt: 1010, status: "completed" },
      { runId: "r2", workflowId: "wf", workflowName: "Two", startedAt: 20, endedAt: 2020, status: "failed", error: "boom" },
    ]);

    expect(rows.map((row) => row.runId)).toEqual(["r2", "r1"]);
    expect(rows[0]).toEqual(expect.objectContaining({ result: "failed", error: "boom" }));
  });
});