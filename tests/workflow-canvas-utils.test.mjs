import { describe, expect, it } from "vitest";
import {
  createHistoryState,
  parseGraphSnapshot,
  pushHistorySnapshot,
  redoHistory,
  searchNodeTypes,
  serializeGraphSnapshot,
  undoHistory,
} from "../ui/tabs/workflow-canvas-utils.mjs";

function makeNode(id, x = 0, y = 0) {
  return {
    id,
    type: "action.run_command",
    label: id,
    position: { x, y },
    config: {},
    outputs: ["default"],
  };
}

describe("workflow canvas node search", () => {
  const nodeTypeFixtures = [
    {
      type: "action.run_agent",
      category: "action",
      description: "Runs an agent task with configured profile",
      outputs: ["result"],
      schema: {
        properties: {
          agentProfileId: { type: "string" },
          prompt: { type: "string" },
        },
      },
    },
    {
      type: "agent.configure_profile",
      category: "agent",
      description: "Configure agent execution profile and defaults",
      outputs: ["profile"],
      schema: {
        properties: {
          model: { type: "string" },
        },
      },
    },
    {
      type: "notify.telegram",
      category: "notify",
      description: "Send a Telegram notification",
      outputs: ["sent"],
      schema: {
        properties: {
          message: { type: "string" },
        },
      },
    },
  ];

  it("matches fuzzy partial name queries", () => {
    const results = searchNodeTypes(nodeTypeFixtures, "agent", 10);
    const types = results.map((item) => item.type);
    expect(types).toContain("action.run_agent");
    expect(types).toContain("agent.configure_profile");
  });

  it("matches by category and description", () => {
    const categoryResults = searchNodeTypes(nodeTypeFixtures, "notify", 10);
    expect(categoryResults[0]?.type).toBe("notify.telegram");

    const descriptionResults = searchNodeTypes(nodeTypeFixtures, "telegram notification", 10);
    expect(descriptionResults[0]?.type).toBe("notify.telegram");
  });

  it("returns all registered node types when query is empty", () => {
    const results = searchNodeTypes(nodeTypeFixtures, "", 10);
    expect(results.length).toBe(nodeTypeFixtures.length);
  });

  it("finds custom nodes through fuzzy query and keeps custom metadata", () => {
    const customFixtures = [
      ...nodeTypeFixtures,
      {
        type: "custom.my_notifier",
        category: "custom",
        description: "Custom node: my notifier",
        inputs: ["message"],
        outputs: ["success", "error"],
        badge: "custom",
        isCustom: true,
      },
    ];
    const results = searchNodeTypes(customFixtures, "my notifier");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe("custom.my_notifier");
    expect(results[0].isCustom).toBe(true);
    expect(results[0].badge).toBe("custom");
  });
});

describe("workflow canvas history", () => {
  it("undo/redo traverses add-delete graph changes", () => {
    const nodeA = makeNode("node-a", 10, 20);
    const edge = { id: "edge-a", source: "node-a", target: "node-b", sourcePort: "default" };

    let history = createHistoryState([], []);

    history = pushHistorySnapshot(history, [nodeA], [], 50);
    expect(parseGraphSnapshot(history.present).nodes.map((node) => node.id)).toEqual(["node-a"]);

    history = pushHistorySnapshot(history, [nodeA, makeNode("node-b", 200, 20)], [edge], 50);
    expect(parseGraphSnapshot(history.present).edges.map((item) => item.id)).toEqual(["edge-a"]);

    history = pushHistorySnapshot(history, [nodeA], [], 50);
    expect(parseGraphSnapshot(history.present).nodes.map((node) => node.id)).toEqual(["node-a"]);
    expect(parseGraphSnapshot(history.present).edges).toEqual([]);

    const undo1 = undoHistory(history);
    expect(undo1.snapshot.nodes.map((node) => node.id)).toEqual(["node-a", "node-b"]);
    expect(undo1.snapshot.edges.map((item) => item.id)).toEqual(["edge-a"]);

    const redo1 = redoHistory(undo1.history, 50);
    expect(redo1.snapshot.nodes.map((node) => node.id)).toEqual(["node-a"]);
    expect(redo1.snapshot.edges).toEqual([]);
  });

  it("enforces history depth limit of 50", () => {
    let history = createHistoryState([], []);
    for (let index = 1; index <= 80; index += 1) {
      history = pushHistorySnapshot(history, [makeNode(`node-${index}`, index, index)], [], 50);
    }
    expect(history.past.length).toBe(50);
  });

  it("does not grow history when a snapshot is unchanged", () => {
    let history = createHistoryState([], []);
    history = pushHistorySnapshot(history, [makeNode("node-a", 10, 20)], [], 50);
    const beforeRepeat = history;
    const repeated = pushHistorySnapshot(history, [makeNode("node-a", 10, 20)], [], 50);
    expect(repeated).toBe(beforeRepeat);
    expect(repeated.past.length).toBe(1);
  });

  it("snapshot serialization round-trips node and edge data", () => {
    const nodes = [makeNode("n1", 40, 80)];
    const edges = [{ id: "e1", source: "n1", target: "n2", condition: "ok" }];

    const snapshot = serializeGraphSnapshot(nodes, edges);
    const parsed = parseGraphSnapshot(snapshot);

    expect(parsed.nodes).toEqual(nodes);
    expect(parsed.edges).toEqual(edges);
  });

  it("undo/redo restores node move, edge creation, and config edits", () => {
    const nodeA = makeNode("node-a", 20, 40);
    const nodeB = makeNode("node-b", 280, 40);
    let history = createHistoryState([nodeA, nodeB], []);

    history = pushHistorySnapshot(
      history,
      [
        { ...nodeA, position: { x: 140, y: 120 } },
        nodeB,
      ],
      [],
      50,
    );

    history = pushHistorySnapshot(
      history,
      [
        { ...nodeA, position: { x: 140, y: 120 } },
        nodeB,
      ],
      [{ id: "edge-a-b", source: "node-a", target: "node-b", sourcePort: "default" }],
      50,
    );

    history = pushHistorySnapshot(
      history,
      [
        { ...nodeA, position: { x: 140, y: 120 }, config: { prompt: "hello" } },
        nodeB,
      ],
      [{ id: "edge-a-b", source: "node-a", target: "node-b", sourcePort: "default" }],
      50,
    );

    const undoConfig = undoHistory(history);
    expect(undoConfig.snapshot.nodes[0].config || {}).toEqual({});
    expect(undoConfig.snapshot.edges).toHaveLength(1);

    const undoEdge = undoHistory(undoConfig.history);
    expect(undoEdge.snapshot.edges).toHaveLength(0);
    expect(undoEdge.snapshot.nodes[0].position).toEqual({ x: 140, y: 120 });

    const undoMove = undoHistory(undoEdge.history);
    expect(undoMove.snapshot.nodes[0].position).toEqual({ x: 20, y: 40 });

    const redoMove = redoHistory(undoMove.history, 50);
    expect(redoMove.snapshot.nodes[0].position).toEqual({ x: 140, y: 120 });

    const redoEdge = redoHistory(redoMove.history, 50);
    expect(redoEdge.snapshot.edges).toHaveLength(1);

    const redoConfig = redoHistory(redoEdge.history, 50);
    expect(redoConfig.snapshot.nodes[0].config).toEqual({ prompt: "hello" });
  });
});
