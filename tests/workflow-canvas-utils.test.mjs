import { describe, it, expect } from "vitest";
import { searchNodeTypes } from "../ui/tabs/workflow-canvas-utils.mjs";

describe("workflow canvas node search", () => {
  it("finds custom nodes through fuzzy query and keeps custom metadata", () => {
    const nodeTypes = [
      {
        type: "action.notify",
        category: "action",
        description: "Send notification",
        inputs: ["message"],
        outputs: ["success"],
      },
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

    const results = searchNodeTypes(nodeTypes, "my notifier");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe("custom.my_notifier");
    expect(results[0].isCustom).toBe(true);
    expect(results[0].badge).toBe("custom");
  });
});
