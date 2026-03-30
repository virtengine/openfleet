import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUILTIN_TOOLS,
  getToolOverheadReport,
  measureToolDefinitionChars,
  refreshToolOverheadReport,
  saveToolConfig,
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

  it("persists overhead reports when passed an explicit .bosun config dir", () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), "bosun-agent-tools-"));
    const bosunDir = resolve(rootDir, ".bosun");

    try {
      saveToolConfig(bosunDir, {
        agents: {},
        defaults: {
          builtinTools: ["search-files"],
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
        toolOverhead: {
          primary: {
            total: 23456,
            bySource: { builtin: 3456, "huge-server": 20000 },
            updatedAt: "2026-03-25T00:00:00.000Z",
          },
        },
      });

      expect(existsSync(resolve(bosunDir, "agent-tools.json"))).toBe(true);
      expect(existsSync(resolve(bosunDir, ".bosun", "agent-tools.json"))).toBe(false);
      expect(getToolOverheadReport(bosunDir, "primary")).toEqual({
        total: 23456,
        bySource: { builtin: 3456, "huge-server": 20000 },
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("refreshes and persists builtin overhead without nesting .bosun twice", async () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), "bosun-agent-tools-refresh-"));
    const bosunDir = resolve(rootDir, ".bosun");

    try {
      saveToolConfig(bosunDir, {
        agents: {
          primary: {
            enabledMcpServers: [],
            updatedAt: "2026-03-25T00:00:00.000Z",
          },
        },
        defaults: {
          builtinTools: ["search-files"],
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
        toolOverhead: {},
      });

      const refreshed = await refreshToolOverheadReport(bosunDir, "primary");

      expect(existsSync(resolve(bosunDir, "agent-tools.json"))).toBe(true);
      expect(existsSync(resolve(bosunDir, ".bosun", "agent-tools.json"))).toBe(false);
      expect(refreshed.total).toBeGreaterThan(0);
      expect(refreshed.bySource).toEqual({ builtin: refreshed.total });
      expect(getToolOverheadReport(bosunDir, "primary")).toEqual({
        total: refreshed.total,
        bySource: { builtin: refreshed.total },
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
