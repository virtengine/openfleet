import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUILTIN_TOOLS,
  measureToolDefinitionChars,
} from "../agent/agent-tool-config.mjs";

describe("agent tool overhead", () => {
  it("measures serialized chars per tool and total", () => {
    const toolDefs = [
      { id: "alpha", name: "Alpha", description: "First tool" },
      { id: "beta", schema: { type: "object", properties: { q: { type: "string" } } } },
    ];

    const report = measureToolDefinitionChars(toolDefs);

    expect(report.total).toBe(toolDefs.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0));
    expect(report.tools).toEqual([
      { id: "alpha", chars: JSON.stringify(toolDefs[0]).length },
      { id: "beta", chars: JSON.stringify(toolDefs[1]).length },
    ]);
  });

  it("supports builtin tool definitions", () => {
    const report = measureToolDefinitionChars(DEFAULT_BUILTIN_TOOLS);

    expect(report.total).toBeGreaterThan(0);
    expect(report.tools).toHaveLength(DEFAULT_BUILTIN_TOOLS.length);
    expect(report.tools[0]).toHaveProperty("chars");
  });
});

