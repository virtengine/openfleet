import { describe, expect, it } from "vitest";
import { buildSessionInsights } from "../ui/modules/session-insights.js";

describe("session-insights", () => {
  it("tracks tool/file counters from tool call history", () => {
    const session = {
      messages: [
        {
          type: "tool_call",
          content: "read_file(src/ui/app.js)",
          meta: { toolName: "read_file" },
          timestamp: "2026-03-04T01:00:00.000Z",
        },
        {
          type: "tool_call",
          content: "*** Begin Patch\n*** Update File: src/ui/app.js\n*** End Patch\n",
          meta: { toolName: "apply_patch" },
          timestamp: "2026-03-04T01:00:05.000Z",
        },
        {
          type: "tool_call",
          content: "rg --files ui/components",
          meta: { toolName: "command_execution" },
          timestamp: "2026-03-04T01:00:09.000Z",
        },
        {
          type: "error",
          content: "Failed to parse JSON",
          timestamp: "2026-03-04T01:00:10.000Z",
        },
      ],
    };

    const insights = buildSessionInsights(session);
    expect(insights.totals.toolCalls).toBe(3);
    expect(insights.totals.commandExecutions).toBe(1);
    expect(insights.totals.errors).toBe(1);
    expect(insights.fileCounts.openedFiles).toBeGreaterThanOrEqual(1);
    expect(insights.fileCounts.editedFiles).toBe(1);
    expect(insights.activityDiff.totalFiles).toBe(1);
    expect(insights.activityDiff.files[0].path).toBe("src/ui/app.js");
  });

  it("extracts context window snapshots and token usage", () => {
    const session = {
      messages: [
        {
          type: "system",
          role: "system",
          content: "Context Window\n103.2K / 272K tokens • 38%\nSystem Instructions 4.6%\nTool Definitions 4.2%\nMessages 4.2%",
        },
        {
          type: "agent_message",
          role: "assistant",
          content: "Done",
          meta: {
            usage: {
              input_tokens: 1200,
              output_tokens: 300,
              total_tokens: 1500,
            },
          },
        },
      ],
    };

    const insights = buildSessionInsights(session);
    expect(insights.contextWindow).toBeTruthy();
    expect(insights.contextWindow.usedTokens).toBe(103200);
    expect(insights.contextWindow.totalTokens).toBe(272000);
    expect(insights.contextWindow.percent).toBe(38);
    expect(Array.isArray(insights.contextBreakdown)).toBe(true);
    expect(insights.contextBreakdown.length).toBeGreaterThan(0);
    expect(insights.tokenUsage.totalTokens).toBe(1500);
  });
});
