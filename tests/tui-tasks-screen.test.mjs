import React from "react";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import stripAnsi from "strip-ansi";
import { render } from "ink";

import {
  formatColumnSummary,
  LINE_LIST_FIELD_KEYS,
  TASK_VIEW_WIDTH_THRESHOLD,
  buildBoardColumns,
  buildListRows,
  createTaskFromForm,
  deleteTaskById,
  normalizeTaskStatus,
  parseTaskDescription,
  resolveTaskView,
  updateTaskFromForm,
  validateTaskForm,
} from "../ui/tui/tasks-screen-helpers.js";
import { taskList } from "../task/task-cli.mjs";
import TasksScreen from "../ui/tui/TasksScreen.js";

const tempDirs = [];
const inkInstances = [];

function createTempStorePath() {
  const dir = mkdtempSync(join(tmpdir(), "bosun-tui-tasks-"));
  tempDirs.push(dir);
  return join(dir, "kanban-state.json");
}

function readStore(storePath) {
  return JSON.parse(readFileSync(storePath, "utf8"));
}

function sanitizeOutput(value) {
  return stripAnsi(String(value || "")).replace(/\u001B\[\?25[hl]/g, "");
}

function createTuiHarness(tasks, width = 160) {
  const stdout = new PassThrough();
  stdout.columns = width;
  stdout.rows = 32;
  stdout.isTTY = true;
  stdout.getColorDepth = () => 8;

  let buffer = "";
  stdout.on("data", (chunk) => {
    buffer += chunk.toString();
  });

  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  const instance = render(
    React.createElement(TasksScreen, { tasks }),
    { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false },
  );
  inkInstances.push(instance);

  return {
    stdin,
    async waitForRender() {
      await new Promise((resolve) => setTimeout(resolve, 120));
    },
    readLastFrame() {
      const output = sanitizeOutput(buffer);
      const index = output.lastIndexOf(" Tasks");
      return index >= 0 ? output.slice(index) : output;
    },
    clearBuffer() {
      buffer = "";
    },
  };
}

afterEach(() => {
  delete process.env.BOSUN_STORE_PATH;
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  while (inkInstances.length) {
    inkInstances.pop().unmount();
  }
});

describe("tui tasks screen helpers", () => {
  it("falls back to list view below the kanban width threshold", () => {
    expect(TASK_VIEW_WIDTH_THRESHOLD).toBe(140);
    expect(resolveTaskView(120)).toBe("list");
    expect(resolveTaskView(160)).toBe("kanban");
    expect(resolveTaskView(200, "list")).toBe("list");
  });

  it("builds four board columns with counts and real-time filtering by title, tag, or id", () => {
    const tasks = [
      { id: "MT-101", title: "Fix login flow", status: "todo", priority: "critical", tags: ["auth"] },
      { id: "MT-102", title: "Ship audit log", status: "inprogress", priority: "high", tags: ["ops"] },
      { id: "MT-103", title: "Review release notes", status: "inreview", priority: "medium", tags: ["docs"] },
      { id: "MT-104", title: "Close sprint board", status: "done", priority: "low", tags: ["ops"] },
      { id: "MT-105", title: "Unblock deploy", status: "blocked", priority: "high", tags: ["deploy"] },
    ];

    const allColumns = buildBoardColumns(tasks, { filterText: "", columnWidth: 30 });
    expect(allColumns.map((column) => column.key)).toEqual(["todo", "in_progress", "review", "done"]);
    expect(allColumns.map((column) => column.count)).toEqual([1, 2, 1, 1]);

    const titleFiltered = buildBoardColumns(tasks, { filterText: "login", columnWidth: 30 });
    expect(titleFiltered[0].items).toHaveLength(1);
    expect(titleFiltered[0].items[0].idShort).toBe("MT-101");

    const tagFiltered = buildBoardColumns(tasks, { filterText: "deploy", columnWidth: 30 });
    expect(tagFiltered[1].items).toHaveLength(1);
    expect(tagFiltered[1].items[0].idShort).toBe("MT-105");

    const idFiltered = buildBoardColumns(tasks, { filterText: "104", columnWidth: 30 });
    expect(idFiltered[3].items).toHaveLength(1);
    expect(idFiltered[3].items[0].idShort).toBe("MT-104");
  });

  it("formats the status summary line shown above the board", () => {
    const summary = formatColumnSummary([
      { label: "TODO", count: 12 },
      { label: "IN PROGRESS", count: 5 },
      { label: "REVIEW", count: 3 },
      { label: "DONE", count: 47 },
    ]);

    expect(summary).toBe("TODO (12) | IN PROGRESS (5) | REVIEW (3) | DONE (47)");
  });

  it("marks list-style form fields for steps, acceptance criteria, and verification", () => {
    expect(LINE_LIST_FIELD_KEYS.has("stepsText")).toBe(true);
    expect(LINE_LIST_FIELD_KEYS.has("acceptanceCriteriaText")).toBe(true);
    expect(LINE_LIST_FIELD_KEYS.has("verificationText")).toBe(true);
  });

  it("sorts list rows by status and priority for narrow terminals", () => {
    const rows = buildListRows([
      { id: "MT-3", title: "done low", status: "done", priority: "low", tags: [] },
      { id: "MT-2", title: "review high", status: "inreview", priority: "high", tags: [] },
      { id: "MT-4", title: "todo medium", status: "todo", priority: "medium", tags: [] },
      { id: "MT-1", title: "todo critical", status: "todo", priority: "critical", tags: [] },
    ]);

    expect(rows.map((row) => row.idShort)).toEqual(["MT-1", "MT-4", "MT-2", "MT-3"]);
  });

  it("validates that title is required before submit", () => {
    expect(validateTaskForm({ title: "   " })).toEqual({ title: "Title is required" });
    expect(validateTaskForm({ title: "Wire up tasks" })).toEqual({});
  });

  it("parses structured description sections into form fields", () => {
    const parsed = parseTaskDescription(`Summary line\n\n## Implementation Steps\n- First\n- Second\n\n## Acceptance Criteria\n- Third\n\n## Verification\n- Fourth`);

    expect(parsed.description).toBe("Summary line");
    expect(parsed.steps).toEqual(["First", "Second"]);
    expect(parsed.acceptanceCriteria).toEqual(["Third"]);
    expect(parsed.verification).toEqual(["Fourth"]);
  });

  it("persists create, update, and delete through the task CLI API", async () => {
    const storePath = createTempStorePath();
    process.env.BOSUN_STORE_PATH = storePath;

    const created = await createTaskFromForm({
      title: "Ship terminal kanban",
      priority: "high",
      status: "in_progress",
      tagsText: "tui,kanban",
      description: "Implement CRUD",
      steps: ["Render four columns"],
      acceptanceCriteria: ["Counts render"],
      verification: ["Create task in TUI"],
    });

    expect(created.title).toBe("Ship terminal kanban");
    expect(normalizeTaskStatus(created.status)).toBe("in_progress");

    const createdStore = readStore(storePath);
    expect(Object.keys(createdStore.tasks || {})).toHaveLength(1);

    const updated = await updateTaskFromForm(created.id, {
      title: "Ship terminal kanban now",
      priority: "critical",
      status: "review",
      tagsText: "tui,release",
      description: "Implement CRUD and polish",
      steps: ["Render four columns", "Support filters"],
      acceptanceCriteria: ["Counts render", "Filters update immediately"],
      verification: ["Move task to review"],
    });

    expect(updated.title).toBe("Ship terminal kanban now");
    expect(normalizeTaskStatus(updated.status)).toBe("review");

    const listed = await taskList();
    expect(listed).toHaveLength(1);
    expect(listed[0].description).toContain("## Implementation Steps");
    expect(listed[0].tags).toEqual(["tui", "release"]);

    const removed = await deleteTaskById(created.id);
    expect(removed).toBe(true);
    expect(Object.keys(readStore(storePath).tasks || {})).toHaveLength(0);
  });
});

describe("tui tasks screen component", () => {
  it("renders list mode at 120 columns and kanban mode at 160 and 200 columns", async () => {
    const sampleTasks = [
      { id: "MT-123", title: "Alpha", status: "todo", priority: "high", tags: ["auth"] },
      { id: "MT-124", title: "Beta", status: "done", priority: "low", tags: ["ops"] },
    ];

    const narrow = createTuiHarness(sampleTasks, 120);
    await narrow.waitForRender();
    expect(narrow.readLastFrame()).toContain("[V]iew: kanban/list -> list (auto)");
    expect(narrow.readLastFrame()).toContain("Task List");

    const medium = createTuiHarness(sampleTasks, 160);
    await medium.waitForRender();
    expect(medium.readLastFrame()).toContain("[V]iew: kanban/list -> kanban");
    expect(medium.readLastFrame()).toContain("TODO (1)");
    expect(medium.readLastFrame()).toContain("DONE (1)");

    const wide = createTuiHarness(sampleTasks, 200);
    await wide.waitForRender();
    expect(wide.readLastFrame()).toContain("TODO (1)");
    expect(wide.readLastFrame()).toContain("IN PROGRESS (0)");
    expect(wide.readLastFrame()).toContain("REVIEW (0)");
    expect(wide.readLastFrame()).toContain("DONE (1)");
  });

  it("updates the filter results on the next keypress and clears with escape", async () => {
    const harness = createTuiHarness([
      { id: "MT-123", title: "Alpha", status: "todo", priority: "high", tags: ["auth"] },
      { id: "MT-124", title: "Beta", status: "done", priority: "low", tags: ["ops"] },
    ], 120);

    await harness.waitForRender();
    harness.clearBuffer();

    harness.stdin.write("f");
    await harness.waitForRender();
    harness.stdin.write("z");
    await harness.waitForRender();

    expect(harness.readLastFrame()).toContain("[F]ilter: z█");
    expect(harness.readLastFrame()).toContain("TODO (0) | IN PROGRESS (0) | REVIEW (0) | DONE (0)");
    expect(harness.readLastFrame()).toContain("No matching tasks");

    harness.clearBuffer();
    harness.stdin.write("\u001b");
    await harness.waitForRender();

    expect(harness.readLastFrame()).toContain("[F]ilter: (title, tag, id)");
    expect(harness.readLastFrame()).toContain("MT-123 Alpha");
    expect(harness.readLastFrame()).toContain("MT-124 Beta");
  });

  it("shows title validation inline and opens the delete confirmation inline", async () => {
    const validationHarness = createTuiHarness([], 160);

    await validationHarness.waitForRender();
    validationHarness.clearBuffer();
    validationHarness.stdin.write("n");
    await validationHarness.waitForRender();
    validationHarness.stdin.write("\u0013");
    await validationHarness.waitForRender();

    expect(validationHarness.readLastFrame()).toContain("New Task");
    expect(validationHarness.readLastFrame()).toContain("Title - Title is required");

    const deleteHarness = createTuiHarness([
      { id: "MT-123", title: "Alpha", status: "todo", priority: "high", tags: ["auth"] },
    ], 160);

    await deleteHarness.waitForRender();
    deleteHarness.clearBuffer();
    deleteHarness.stdin.write("d");
    await deleteHarness.waitForRender();

    expect(deleteHarness.readLastFrame()).toContain("Delete MT-123? [y/N]");
  });
});
