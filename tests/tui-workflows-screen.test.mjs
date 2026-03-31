import { describe, expect, it } from "vitest";

import {
  WORKFLOW_FLASH_DURATION_MS,
  WORKFLOW_HISTORY_LIMIT,
  buildWorkflowHistoryRows,
  buildWorkflowTemplateRows,
  createWorkflowTriggerFormState,
  reduceWorkflowStatusEvent,
  toggleWorkflowTreeNode,
} from "../ui/tui/workflows-screen-helpers.js";

describe("tui workflows screen helpers", () => {
  it("builds template rows with required input summaries and live status glyphs", () => {
    const rows = buildWorkflowTemplateRows([
      {
        id: "continuation-loop",
        name: "Continuation Loop",
        type: "pipeline",
        enabled: true,
        schedule: "manual",
        requiredInputs: {
          taskId: { type: "string", required: true },
        },
        lastRunAt: "2026-03-25T12:00:00.000Z",
        lastResult: "success",
      },
    ], {
      activeRuns: new Map([["continuation-loop", { runId: "run-1", spinnerFrame: 2 }]]),
      flashByWorkflowId: new Map(),
      now: Date.parse("2026-03-25T12:00:01.000Z"),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toContain("Continuation Loop");
    expect(rows[0].name).toContain("⠹");
    expect(rows[0].scheduleOrTrigger).toBe("manual · taskId*");
    expect(rows[0].lastResult).toBe("success");
  });

  it("keeps only the most recent 50 history rows and surfaces run detail metadata", () => {
    const history = Array.from({ length: 55 }, (_, index) => ({
      runId: `run-${index + 1}`,
      workflowId: "wf-demo",
      workflowName: "Demo",
      status: index % 2 === 0 ? "completed" : "failed",
      startedAt: 1_000 + index,
      endedAt: 2_000 + index,
      durationMs: 1_000,
      triggerSource: "manual",
      error: index % 2 === 0 ? null : "boom",
    }));

    const rows = buildWorkflowHistoryRows(history);
    expect(rows).toHaveLength(WORKFLOW_HISTORY_LIMIT);
    expect(rows[0].runId).toBe("run-55");
    expect(rows.at(-1).runId).toBe("run-6");
    expect(rows[1].result).toBe("failed");
  });

  it("creates inline trigger form state from required input schema", () => {
    expect(createWorkflowTriggerFormState({
      taskId: { type: "string", required: true, description: "Task id" },
      branch: { type: "string", required: false, default: "main" },
    })).toEqual({
      fields: [
        { id: "taskId", label: "taskId", required: true, value: "", description: "Task id" },
        { id: "branch", label: "branch", required: false, value: "main", description: "" },
      ],
      values: { taskId: "", branch: "main" },
    });
  });

  it("reduces workflow:status events into active runs, flashes, and history entries", () => {
    const now = Date.parse("2026-03-25T12:00:00.000Z");
    let state = reduceWorkflowStatusEvent(undefined, {
      runId: "run-1",
      workflowId: "wf-1",
      workflowName: "Demo",
      eventType: "run:start",
      status: "running",
      timestamp: now,
    }, now);

    expect(state.activeRuns.get("wf-1")?.runId).toBe("run-1");

    state = reduceWorkflowStatusEvent(state, {
      runId: "run-1",
      workflowId: "wf-1",
      workflowName: "Demo",
      eventType: "run:end",
      status: "completed",
      durationMs: 800,
      timestamp: now + 800,
    }, now + 800);

    expect(state.activeRuns.has("wf-1")).toBe(false);
    expect(state.flashByWorkflowId.get("wf-1")?.status).toBe("completed");
    expect(state.history[0]).toMatchObject({ runId: "run-1", workflowId: "wf-1", status: "completed" });

    const afterFlash = reduceWorkflowStatusEvent(state, {
      runId: "run-2",
      workflowId: "wf-2",
      workflowName: "Other",
      eventType: "run:start",
      status: "running",
      timestamp: now + 800 + WORKFLOW_FLASH_DURATION_MS + 1,
    }, now + 800 + WORKFLOW_FLASH_DURATION_MS + 1);
    expect(afterFlash.flashByWorkflowId.has("wf-1")).toBe(false);
  });

  it("toggles workflow detail tree expansion paths", () => {
    const expanded = toggleWorkflowTreeNode(new Set(), "nodes.root.child");
    expect(expanded.has("nodes.root.child")).toBe(true);

    const collapsed = toggleWorkflowTreeNode(expanded, "nodes.root.child");
    expect(collapsed.has("nodes.root.child")).toBe(false);
  });
});
