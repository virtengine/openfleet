import { describe, expect, it } from "vitest";

import {
  TASK_COLUMNS,
  buildTaskFormRows,
  bucketTasksByStatus,
  createEmptyTaskFormState,
  formatTask,
  normalizeTaskCreatePayload,
} from "../tui/screens/tasks-screen-helpers.mjs";

describe("tui tasks screen helpers", () => {
  it("creates a default inline task form draft", () => {
    expect(createEmptyTaskFormState()).toEqual({
      title: "",
      description: "",
      priority: "medium",
    });
  });

  it("normalizes inline task form payloads and enforces a title", () => {
    expect(normalizeTaskCreatePayload({ title: "   " })).toEqual({
      ok: false,
      error: "Title is required.",
    });

    expect(normalizeTaskCreatePayload({
      title: "  Ship inline form  ",
      description: "  Render in terminal  ",
      priority: "HIGH",
    })).toEqual({
      ok: true,
      payload: {
        title: "Ship inline form",
        description: "Render in terminal",
        priority: "high",
      },
    });
  });

  it("projects inline form rows with the active editor on the same line", () => {
    expect(buildTaskFormRows(createEmptyTaskFormState(), "title")).toEqual([
      {
        field: "title",
        label: "Title",
        value: "",
        displayValue: "(required)",
        isActive: true,
        isPlaceholder: true,
        inputPlaceholder: undefined,
      },
      {
        field: "description",
        label: "Description",
        value: "",
        displayValue: "(optional)",
        isActive: false,
        isPlaceholder: true,
        inputPlaceholder: undefined,
      },
      {
        field: "priority",
        label: "Priority",
        value: "medium",
        displayValue: "medium",
        isActive: false,
        isPlaceholder: false,
        inputPlaceholder: "critical, high, medium, low",
      },
    ]);

    expect(buildTaskFormRows({
      title: "Ship inline form",
      description: "Render the editor inside the row",
      priority: "high",
    }, "description")[1]).toEqual({
      field: "description",
      label: "Description",
      value: "Render the editor inside the row",
      displayValue: "Render the editor inside the row",
      isActive: true,
      isPlaceholder: false,
      inputPlaceholder: undefined,
    });
  });

  it("buckets tasks by status and formats compact rows", () => {
    const buckets = bucketTasksByStatus([
      { id: "task-12345678", title: "Draft form", status: "todo", priority: "high" },
      { id: "task-abcdef12", title: "Ship tests", status: "done" },
    ]);

    expect(TASK_COLUMNS.every((column) => buckets.has(column))).toBe(true);
    expect(buckets.get("todo")).toHaveLength(1);
    expect(buckets.get("done")).toHaveLength(1);
    expect(formatTask(buckets.get("todo")[0])).toBe("task-123  [h] Draft form");
  });
});