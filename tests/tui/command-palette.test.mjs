import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCommandPaletteActions,
  loadCommandPaletteHistory,
  rankCommandPaletteActions,
  saveCommandPaletteHistory,
} from "../../tui/lib/command-palette.mjs";

describe("command palette helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("ranks common abbreviations to the expected session action", () => {
    const actions = buildCommandPaletteActions({
      sessions: [{ id: "MT-734", title: "Investigate flakes", status: "active" }],
      tasks: [],
      workflows: [],
      currentScreen: "status",
    });

    const ranked = rankCommandPaletteActions("kmt7", actions);
    expect(ranked[0]?.id).toBe("session:kill:MT-734");
    expect(ranked[0]?.label).toContain("Kill MT-734");
  });

  it("surfaces recent actions first when the query is empty", () => {
    const actions = buildCommandPaletteActions({
      sessions: [{ id: "MT-734", title: "Investigate flakes", status: "active" }],
      tasks: [{ id: "task-1", title: "Fix CI failure", status: "todo" }],
      workflows: [{ id: "wf-1", name: "Health Check" }],
      currentScreen: "status",
      recentActionIds: ["task:update:task-1", "session:kill:MT-734"],
    });

    const ranked = rankCommandPaletteActions("", actions);
    expect(ranked.slice(0, 2).map((entry) => entry.id)).toEqual([
      "task:update:task-1",
      "session:kill:MT-734",
    ]);
  });

  it("includes every expected action family in the palette list", () => {
    const actions = buildCommandPaletteActions({
      sessions: [{ id: "MT-734", title: "Investigate flakes", status: "active" }],
      tasks: [{ id: "task-1", title: "Fix CI failure", status: "todo" }],
      workflows: [{ id: "wf-1", name: "Health Check" }],
      currentScreen: "status",
    });

    expect(actions.some((action) => action.id === "session:kill:MT-734")).toBe(true);
    expect(actions.some((action) => action.id === "task:update:task-1")).toBe(true);
    expect(actions.some((action) => action.id === "workflow:trigger:wf-1")).toBe(true);
    expect(actions.some((action) => action.id === "nav:tasks")).toBe(true);
    expect(actions.some((action) => action.id === "config:refresh:1")).toBe(true);
  });

  it("adds only one create-task action and excludes unsupported config toggles", () => {
    const actions = buildCommandPaletteActions({
      tasks: [
        { id: "task-1", title: "Fix CI failure", status: "todo" },
        { id: "task-2", title: "Review PR #404", status: "inprogress" },
      ],
    });

    expect(actions.filter((action) => action.id.startsWith("task:create:"))).toHaveLength(1);
    expect(actions.some((action) => action.id.startsWith("config:connectOnly:"))).toBe(false);
  });

  it("keeps only known recent actions at the top when the query is empty", () => {
    const actions = buildCommandPaletteActions({
      sessions: [{ id: "MT-734", title: "Investigate flakes", status: "active" }],
      tasks: [],
      workflows: [],
      currentScreen: "status",
      recentActionIds: ["missing:id", "session:kill:MT-734"],
    });

    const ranked = rankCommandPaletteActions("", actions);
    expect(ranked[0]?.id).toBe("session:kill:MT-734");
  });

  it("loads persisted history and falls back safely", async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ recent: ["a", "b"] }))
      .mockRejectedValueOnce(new Error("missing"));

    await expect(loadCommandPaletteHistory({ readFile, historyPath: "x.json" })).resolves.toEqual(["a", "b"]);
    await expect(loadCommandPaletteHistory({ readFile, historyPath: "x.json" })).resolves.toEqual([]);
  });

  it("stores only the latest 10 unique actions", async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const writeFile = vi.fn().mockResolvedValue(undefined);

    await saveCommandPaletteHistory({
      mkdir,
      writeFile,
      historyPath: ".bosun/.cache/tui-history.json",
      actionId: "task:update:task-12",
      recentActionIds: [
        "a","b","c","d","e","f","g","h","i","j",
      ],
    });

    const payload = JSON.parse(writeFile.mock.calls[0][1]);
    expect(payload.recent).toEqual(["task:update:task-12","a","b","c","d","e","f","g","h","i"]);
  });
});
