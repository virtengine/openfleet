import { describe, it, expect } from "vitest";
import {
  createHistoryState,
  parseGraphSnapshot,
  pushHistorySnapshot,
  redoHistory,
  searchNodeTypes,
  undoHistory,
} from "../ui/tabs/workflow-canvas-utils.mjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const uiDir = resolve(process.cwd(), "ui");

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
});
