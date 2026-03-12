import { describe, it, expect } from "vitest";
import {
  buildNodeStatusesFromRunDetail,
  createHistoryState,
  parseGraphSnapshot,
  pushHistorySnapshot,
  redoHistory,
  searchNodeTypes,
  undoHistory,
} from "../ui/tabs/workflow-canvas-utils.mjs";
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
