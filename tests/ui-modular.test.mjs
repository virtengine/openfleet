import { describe, it, expect, vi } from "vitest";
import {
  buildNodeStatusesFromRunDetail,
  createHistoryState,
  parseGraphSnapshot,
  pushHistorySnapshot,
  redoHistory,
  resolveNodeOutputPreview,
  searchNodeTypes,
  undoHistory,
} from "../ui/tabs/workflow-canvas-utils.mjs";
import {
  SETTINGS_SCHEMA as appSettingsSchema,
  validateSetting as validateAppSetting,
} from "../ui/modules/settings-schema.js";
import {
  isPlaceholderTaskDescription,
  sanitizeTaskText,
} from "../ui/modules/state.js";
import {
  SETTINGS_SCHEMA as siteSettingsSchema,
  validateSetting as validateSiteSetting,
} from "../site/ui/modules/settings-schema.js";
import {
  buildMarketplaceImportPayload,
  extractSelectableLibraryTasks,
  isSelectableLibraryTask,
} from "../ui/tabs/library.js";
import {
  buildTaskDescriptionFallback,
  normalizeTaskWorkflowRunEntry,
  openTaskWorkflowAgentHistory,
  openTaskWorkflowRun,
} from "../ui/tabs/tasks.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const uiDir = resolve(process.cwd(), "ui");
const uiComponentsCss = readFileSync(resolve(process.cwd(), "ui/styles/components.css"), "utf8");
const siteComponentsCss = readFileSync(resolve(process.cwd(), "site/ui/styles/components.css"), "utf8");

describe("modular mini app structure", () => {
  const requiredModules = [
    "app.js",
    "modules/telegram.js",
    "modules/api.js",
    "modules/state.js",
    "modules/router.js",
    "modules/utils.js",
    "modules/icons.js",
    "components/shared.js",
    "components/charts.js",
    "components/forms.js",
    "tabs/dashboard.js",
    "tabs/tasks.js",
    "tabs/benchmarks.js",
    "tabs/agents.js",
    "tabs/infra.js",
    "tabs/control.js",
    "tabs/logs.js",
    "tabs/settings.js",
    "styles.css",
    "styles/variables.css",
    "styles/base.css",
    "styles/layout.css",
    "styles/components.css",
    "styles/animations.css",
    "index.html",
  ];

  for (const file of requiredModules) {
    it(`${file} exists`, () => {
      expect(existsSync(resolve(uiDir, file))).toBe(true);
    });
  }
});

describe("workflow canvas helpers", () => {
  it("keeps workflow node header constants defined at module scope for render-time aliases", () => {
    const workflowsSource = readFileSync(resolve(process.cwd(), "ui/tabs/workflows.js"), "utf8");
    expect(workflowsSource).toContain("const WORKFLOW_NODE_HEADER_HEIGHT = 44;");
    expect(workflowsSource).toContain("const NODE_HEADER = WORKFLOW_NODE_HEADER_HEIGHT;");
    expect(workflowsSource).toContain("const NODE_HEADER_H = WORKFLOW_NODE_HEADER_HEIGHT;");
  });

  it("finds agent nodes with fuzzy partial matches", () => {
    const results = searchNodeTypes([
      {
        type: "action.run_agent",
        category: "action",
        description: "Run an autonomous agent task",
        schema: { properties: { prompt: { type: "string" } } },
      },
      {
        type: "agent.configure_profile",
        category: "agent",
        description: "Configure agent execution defaults",
        schema: { properties: { model: { type: "string" }, temperature: { type: "number" } } },
      },
      {
        type: "notify.send_message",
        category: "notify",
        description: "Post a notification",
        schema: { properties: { channel: { type: "string" } } },
      },
    ], "agent");

    expect(results.map((item) => item.type)).toEqual([
      "agent.configure_profile",
      "action.run_agent",
    ]);
    expect(results[0].inputs).toContain("model");
    expect(results[0].outputs).toContain("default");
  });

  it("returns every registered node when the caller raises the limit", () => {
    const nodeTypes = Array.from({ length: 81 }, (_, index) => ({
      type: `category.node_${index}`,
      category: index % 2 === 0 ? "category" : "other",
      description: `Node ${index} description`,
      schema: { properties: { value: { type: "string" } } },
    }));

    const results = searchNodeTypes(nodeTypes, "node", nodeTypes.length);

    expect(results).toHaveLength(nodeTypes.length);
  });

  it("searches category and description fields without truncating matches", () => {
    const nodeTypes = [
      {
        type: "action.run_agent",
        category: "agent",
        description: "Launch an autonomous coding agent",
        schema: { properties: { prompt: { type: "string" } } },
      },
      {
        type: "notify.send_summary",
        category: "notify",
        description: "Send a summary notification",
        schema: { properties: { channel: { type: "string" } } },
      },
      {
        type: "flow.branch",
        category: "flow",
        description: "Conditional router for workflow branches",
        schema: { properties: { expression: { type: "string" } } },
      },
    ];

    const categoryMatches = searchNodeTypes(nodeTypes, "notify", nodeTypes.length);
    const descriptionMatches = searchNodeTypes(nodeTypes, "coding", nodeTypes.length);

    expect(categoryMatches.map((item) => item.type)).toEqual(["notify.send_summary"]);
    expect(descriptionMatches.map((item) => item.type)).toEqual(["action.run_agent"]);
  });

  it("matches node types by category and description", () => {
    const results = searchNodeTypes([
      {
        type: "action.run_command",
        category: "action",
        description: "Execute a shell command in the workspace",
        schema: { properties: { command: { type: "string" } } },
      },
      {
        type: "notify.send_message",
        category: "notify",
        description: "Post a chat notification",
        schema: { properties: { channel: { type: "string" } } },
      },
      {
        type: "logic.branch",
        category: "logic",
        description: "Route execution based on a condition",
        schema: { properties: { expression: { type: "string" } } },
      },
    ], "shell workspace");

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("action.run_command");

    const categoryResults = searchNodeTypes([
      {
        type: "logic.branch",
        category: "logic",
        description: "Route execution based on a condition",
        schema: { properties: { expression: { type: "string" } } },
      },
      {
        type: "notify.send_message",
        category: "notify",
        description: "Post a chat notification",
        schema: { properties: { channel: { type: "string" } } },
      },
    ], "logic");

    expect(categoryResults[0].type).toBe("logic.branch");
  });

  it("indexes explicit node inputs even when schema is absent", () => {
    const results = searchNodeTypes([
      {
        type: "custom.notify_ops",
        category: "custom",
        description: "Route notification payloads",
        inputs: ["room", "severity"],
        outputs: ["success", "error"],
      },
      {
        type: "action.run_command",
        category: "action",
        description: "Execute a shell command",
        schema: { properties: { command: { type: "string" } } },
      },
    ], "severity", 10);

    expect(results.map((item) => item.type)).toEqual(["custom.notify_ops"]);
    expect(results[0].inputs).toEqual(["room", "severity"]);
  });

  it("caps history depth and supports undo redo", () => {
    let history = createHistoryState([{ id: "node-0" }], []);
    for (let index = 1; index <= 55; index += 1) {
      history = pushHistorySnapshot(history, [{ id: `node-${index}` }], [], 50);
    }

    expect(history.past).toHaveLength(50);

    const undone = undoHistory(history);
    expect(parseGraphSnapshot(undone.history.present).nodes[0].id).toBe("node-54");
    expect(undone.history.future).toHaveLength(1);

    const redone = redoHistory(undone.history, 50);
    expect(parseGraphSnapshot(redone.history.present).nodes[0].id).toBe("node-55");
  });

  it("does not grow history for duplicate snapshots", () => {
    const history = createHistoryState([{ id: "node-1", label: "Agent" }], []);
    const nextHistory = pushHistorySnapshot(history, [{ id: "node-1", label: "Agent" }], [], 50);

    expect(nextHistory).toBe(history);
    expect(nextHistory.past).toHaveLength(0);
  });

  it("drops redo history after a new change and ignores identical snapshots", () => {
    let history = createHistoryState([{ id: "node-0", position: { x: 0, y: 0 } }], []);

    history = pushHistorySnapshot(history, [{ id: "node-1", position: { x: 10, y: 20 } }], [], 50);
    history = pushHistorySnapshot(history, [{ id: "node-2", position: { x: 20, y: 30 } }], [], 50);

    const undone = undoHistory(history);
    expect(parseGraphSnapshot(undone.history.present).nodes[0].id).toBe("node-1");
    expect(undone.history.future).toHaveLength(1);

    const sameSnapshot = pushHistorySnapshot(undone.history, [{ id: "node-1", position: { x: 10, y: 20 } }], [], 50);
    expect(sameSnapshot).toBe(undone.history);

    const branched = pushHistorySnapshot(undone.history, [{ id: "node-3", position: { x: 40, y: 50 } }], [], 50);
    expect(parseGraphSnapshot(branched.present).nodes[0].id).toBe("node-3");
    expect(branched.future).toEqual([]);
  });

  it("prefers status events and explicit statuses when deriving node execution states", () => {
    const statuses = buildNodeStatusesFromRunDetail({
      status: "running",
      detail: {
        nodeStatuses: {
          "node-a": "waiting",
        },
        nodeStatusEvents: [
          { nodeId: "node-a", status: "running" },
          { nodeId: "node-b", status: "completed" },
        ],
      },
    });

    expect(statuses).toEqual({
      "node-a": "running",
      "node-b": "completed",
    });
  });

  it("backfills node statuses from logs when explicit status data is missing", () => {
    const statuses = buildNodeStatusesFromRunDetail({
      status: "failed",
      detail: {
        logs: [
          { nodeId: "node-a" },
          { nodeId: "node-a" },
          { nodeId: "node-b" },
        ],
      },
    });

    expect(statuses).toEqual({
      "node-a": "failed",
      "node-b": "failed",
    });
  });

  it("derives node output previews from stored run data", () => {
    const preview = resolveNodeOutputPreview("action.run_agent", null, {
      summary: "Generated implementation plan",
      narrative: "Updated tests and finished validation.",
      usage: { total_tokens: 4821 },
    });

    expect(preview.lines).toEqual([
      "Generated implementation plan",
      "Updated tests and finished validation.",
    ]);
    expect(preview.tokenCount).toBe(4821);
  });

  it("prefers live node output preview payloads when present", () => {
    const preview = resolveNodeOutputPreview("action.run_agent", {
      lines: ["Preview summary", "Second line"],
      tokenCount: 128,
    }, {
      summary: "Fallback output",
      usage: { total_tokens: 999 },
    });

    expect(preview.lines).toEqual(["Preview summary", "Second line"]);
    expect(preview.tokenCount).toBe(128);
  });
});

describe("library marketplace helpers", () => {
  it("preserves custom repo metadata when building import payloads", () => {
    const payload = buildMarketplaceImportPayload(
      "custom",
      {
        source: {
          id: "custom",
          repoUrl: "https://github.com/K-Dense-AI/claude-scientific-skills",
          defaultBranch: "main",
        },
        candidatesByType: {
          agent: 0,
          prompt: 0,
          skill: 1,
        },
      },
      ["scientific-skills/xlsx/SKILL.md"],
    );

    expect(payload).toMatchObject({
      sourceId: "custom",
      repoUrl: "https://github.com/K-Dense-AI/claude-scientific-skills",
      branch: "main",
      includeEntries: ["scientific-skills/xlsx/SKILL.md"],
      importAgents: false,
      importSkills: true,
      importPrompts: false,
      importTools: true,
    });
  });
});

describe("library task selection helpers", () => {
  it("accepts backlog and draft tasks from api data payloads", () => {
    const result = extractSelectableLibraryTasks({
      ok: true,
      data: [
        { id: "1", title: "Draft task", status: "draft" },
        { id: "2", title: "Backlog task", status: "todo" },
        { id: "3", title: "In progress task", status: "inprogress" },
        { id: "4", title: "Blocked task", status: "blocked" },
      ],
    });

    expect(result.map((task) => task.id)).toEqual(["1", "2"]);
  });

  it("treats legacy backlog labels as selectable and excludes active work", () => {
    expect(isSelectableLibraryTask({ status: "backlog" })).toBe(true);
    expect(isSelectableLibraryTask({ status: "planned" })).toBe(true);
    expect(isSelectableLibraryTask({ status: "open" })).toBe(true);
    expect(isSelectableLibraryTask({ status: "new" })).toBe(true);
    expect(isSelectableLibraryTask({ status: "in-progress" })).toBe(false);
    expect(isSelectableLibraryTask({ status: "blocked" })).toBe(false);
  });
});

describe("task description fallbacks", () => {
  it("treats scrubbed internal errors as missing descriptions", () => {
    expect(isPlaceholderTaskDescription("Internal server error")).toBe(true);
    expect(buildTaskDescriptionFallback("Queue retry fix", "Internal server error")).toContain("Queue retry fix");
  });

  it("treats unresolved template placeholders as missing descriptions", () => {
    expect(isPlaceholderTaskDescription("{{taskDescription}}")).toBe(true);
    expect(isPlaceholderTaskDescription("{{ repoSlug }}")).toBe(true);
    expect(buildTaskDescriptionFallback("Queue retry fix", "{{taskDescription}}")).toContain("Queue retry fix");
  });

  it("preserves real descriptions while still sanitizing punctuation noise", () => {
    const raw = "Fix worker loop… and validate retries";
    expect(sanitizeTaskText(raw)).toContain("Fix worker loop");
    expect(isPlaceholderTaskDescription(raw)).toBe(false);
    expect(buildTaskDescriptionFallback("Worker fix", raw)).toContain("Fix worker loop");
  });
});

describe("task workflow activity helpers", () => {
  it("opens task-linked workflow runs in the workflows run detail view", async () => {
    const navigateTo = vi.fn(() => true);
    const openWorkflowRunsView = vi.fn();

    await expect(openTaskWorkflowRun(
      { workflowId: "wf-task", runId: "run-task-1" },
      { navigateTo, openWorkflowRunsView },
    )).resolves.toBe(true);

    expect(navigateTo).toHaveBeenCalledWith("workflows");
    expect(openWorkflowRunsView).toHaveBeenCalledWith("wf-task", "run-task-1");
  });

  it("opens linked historical agent sessions from task workflow activity", async () => {
    const navigateTo = vi.fn(() => true);
    const loadSessions = vi.fn(async () => ({ ok: true }));
    const loadSessionMessages = vi.fn(async () => ({ ok: true }));
    const selectedSessionId = { value: "" };

    await expect(openTaskWorkflowAgentHistory(
      { primarySessionId: "session-task-1" },
      { navigateTo, loadSessions, loadSessionMessages, selectedSessionId },
    )).resolves.toBe(true);

    expect(navigateTo).toHaveBeenCalledWith("agents");
    expect(loadSessions).toHaveBeenCalledWith({ type: "task", workspace: "all" });
    expect(selectedSessionId.value).toBe("session-task-1");
    expect(loadSessionMessages).toHaveBeenCalledWith("session-task-1", { limit: 50 });
  });

  it("keeps stored session links ahead of derived primary session ids", () => {
    const normalized = normalizeTaskWorkflowRunEntry({
      workflowId: "wf-task",
      runId: "run-task-2",
      sessionId: "stored-session",
      primarySessionId: "derived-session",
      status: "completed",
    });

    expect(normalized).toMatchObject({
      sessionId: "stored-session",
      primarySessionId: "derived-session",
      hasRunLink: true,
      hasSessionLink: true,
    });
  });
});

describe("restart delay settings", () => {
  it("keeps the crash restart delay default and cap aligned across app and site schemas", () => {
    const appRestartDelay = appSettingsSchema.find((def) => def.key === "RESTART_DELAY_MS");
    const siteRestartDelay = siteSettingsSchema.find((def) => def.key === "RESTART_DELAY_MS");

    expect(appRestartDelay).toMatchObject({
      defaultVal: 180000,
      min: 1000,
      max: 1800000,
    });
    expect(siteRestartDelay).toEqual(appRestartDelay);
  });

  it("accepts a 180 second crash restart delay and rejects values above the UI cap", () => {
    const appRestartDelay = appSettingsSchema.find((def) => def.key === "RESTART_DELAY_MS");
    const siteRestartDelay = siteSettingsSchema.find((def) => def.key === "RESTART_DELAY_MS");

    expect(validateAppSetting(appRestartDelay, "180000")).toEqual({ valid: true });
    expect(validateSiteSetting(siteRestartDelay, "180000")).toEqual({ valid: true });
    expect(validateAppSetting(appRestartDelay, "1800001")).toEqual({
      valid: false,
      error: "Maximum: 1800000",
    });
    expect(validateSiteSetting(siteRestartDelay, "1800001")).toEqual({
      valid: false,
      error: "Maximum: 1800000",
    });
  });
});

describe("shared icon sizing rules", () => {
  it("keeps shared icon wrappers from letting inline svg render at intrinsic size", () => {
    for (const source of [uiComponentsCss, siteComponentsCss]) {
      expect(source).toContain(".btn-icon svg");
      expect(source).toContain(".dashboard-action-icon svg");
      expect(source).toContain(".fleet-rest-icon svg");
      expect(source).toContain(".dashboard-welcome-icon svg");
      expect(source).toContain("width: 1em;");
      expect(source).toContain("height: 1em;");
      expect(source).toContain("max-width: 100%;");
      expect(source).toContain("max-height: 100%;");
    }
  });
});
