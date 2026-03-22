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

  it("prefers persisted backend insights when available", () => {
    const session = {
      insights: {
        totals: {
          messages: 24,
          toolCalls: 8,
          toolResults: 4,
          errors: 1,
          userMessages: 3,
          assistantMessages: 5,
          systemMessages: 2,
          commandExecutions: 2,
          uniqueTools: 4,
        },
        fileCounts: {
          openedFiles: 7,
          editedFiles: 3,
          referencedFiles: 9,
          openOps: 7,
          editOps: 3,
        },
        recentActions: [{ type: "tool_call", label: "apply_patch", level: "info" }],
        contextWindow: { usedTokens: 120000, totalTokens: 272000, percent: 44.1 },
        contextBreakdown: [{ label: "Messages", percent: 12.4 }],
        tokenUsage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 },
        activityDiff: {
          files: [{ path: "src/ui/app.js", edits: 2, lastTs: "2026-03-04T01:00:00.000Z" }],
          totalFiles: 1,
        },
        generatedAt: "2026-03-04T01:00:00.000Z",
      },
      messages: [
        {
          type: "tool_call",
          content: "read_file(src/ui/app.js)",
          meta: { toolName: "read_file" },
          timestamp: "2026-03-04T01:00:00.000Z",
        },
      ],
    };

    const insights = buildSessionInsights(session);
    expect(insights.totals.toolCalls).toBe(8);
    expect(insights.fileCounts.editedFiles).toBe(3);
    expect(insights.contextWindow.percent).toBe(44.1);
    expect(insights.recentActions).toHaveLength(1);
    expect(insights.activityDiff.totalFiles).toBe(1);
  });
});


describe("session insights replay summaries", () => {
  it("derives replay trajectory and short steps from tool activity", () => {
    const insights = buildSessionInsights({
      messages: [
        { type: "tool_call", timestamp: "2026-03-20T10:00:00.000Z", content: "cat task/task-executor.mjs", meta: { toolName: "command_execution" } },
        { type: "tool_result", timestamp: "2026-03-20T10:00:01.000Z", content: "file contents" },
        { type: "tool_call", timestamp: "2026-03-20T10:00:02.000Z", content: "*** Update File: task/task-executor.mjs", meta: { toolName: "apply_patch" } },
        { type: "agent_message", role: "assistant", timestamp: "2026-03-20T10:00:03.000Z", content: "Patched the executor" },
      ],
    });

    expect(insights.replay).toBeTruthy();
    expect(insights.replay.trajectory).toHaveLength(4);
    expect(insights.replay.steps.some((step) => step.label.includes("Inspected task/task-executor.mjs"))).toBe(true);
    expect(insights.replay.steps.some((step) => step.label.includes("Edited task/task-executor.mjs"))).toBe(true);
    expect(insights.replay.resumeHint).toContain("Edited");
    expect(insights.replay.overview).toContain("Edited 1 file");
  });
});
