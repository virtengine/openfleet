import { describe, expect, it } from "vitest";
import { buildSessionDiagnosticsBundle, buildSessionInsights } from "../ui/modules/session-insights.js";

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

  it("builds a compact diagnostics export bundle with linked workflow context", () => {
    const session = {
      id: "session-diagnostics-1",
      taskId: "TASK-101",
      title: "Diagnose agent stall",
      status: "active",
      lifecycleStatus: "active",
      runtimeState: "running",
      type: "task",
      totalEvents: 18,
      createdAt: "2026-03-04T00:58:00.000Z",
      lastActiveAt: "2026-03-04T01:00:10.000Z",
      elapsedMs: 130000,
      idleMs: 4000,
      workspaceDir: "/repo/worktrees/task-101",
      workspaceRoot: "/repo",
      branch: "task/TASK-101-diagnostics",
      metadata: {
        agentId: "agent-17",
        workflowId: "wf-diagnostics",
        workflowName: "Agent Diagnostics",
      },
      turns: [
        {
          id: "turn-1",
          status: "completed",
          summary: "Collected telemetry and paused for input.",
          startedAt: "2026-03-04T00:58:10.000Z",
          endedAt: "2026-03-04T00:58:45.000Z",
          durationMs: 35000,
          tokenUsage: {
            inputTokens: 900,
            outputTokens: 240,
            totalTokens: 1140,
          },
        },
      ],
      messages: [
        {
          type: "system",
          role: "system",
          content: "Context Window\n103.2K / 272K tokens • 38%\nMessages 4.2%",
          timestamp: "2026-03-04T00:58:00.000Z",
        },
        {
          type: "user",
          role: "user",
          content: "Export diagnostics for this session.",
          timestamp: "2026-03-04T00:59:00.000Z",
        },
        {
          type: "tool_call",
          content: "read_file(src/ui/app.js)",
          meta: { toolName: "read_file" },
          timestamp: "2026-03-04T00:59:10.000Z",
        },
        {
          type: "agent_message",
          role: "assistant",
          content: "I gathered the linked workflow state.",
          timestamp: "2026-03-04T01:00:00.000Z",
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

    const bundle = buildSessionDiagnosticsBundle(session, {
      exportedAt: "2026-03-04T01:00:30.000Z",
      task: {
        id: "TASK-101",
        title: "Investigate stalled agent",
        status: "inprogress",
        branch: "task/TASK-101-diagnostics",
        repository: "bosun",
        worktreePath: "/repo/worktrees/task-101",
        primarySessionId: "session-diagnostics-1",
        linkedSessionIds: ["session-diagnostics-1", "session-shadow-2"],
        workflowRuns: [
          {
            runId: "run-17",
            workflowId: "wf-diagnostics",
            status: "completed",
            startedAt: "2026-03-04T00:58:05.000Z",
            endedAt: "2026-03-04T00:59:55.000Z",
            primarySessionId: "session-diagnostics-1",
            issueAdvisor: {
              recommendedAction: "resume_remaining",
              summary: "Resume from Agent Plan.",
            },
          },
        ],
      },
    });

    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.session.id).toBe("session-diagnostics-1");
    expect(bundle.session.workflowId).toBe("wf-diagnostics");
    expect(bundle.session.tokenUsage.totalTokens).toBe(1500);
    expect(bundle.session.contextWindow.usedTokens).toBe(103200);
    expect(bundle.transcript.recentTurns).toHaveLength(1);
    expect(bundle.transcript.recentTurns[0].totalTokens).toBe(1140);
    expect(bundle.transcript.recentMessages[0].content).toBe("Export diagnostics for this session.");
    expect(bundle.linked.task.id).toBe("TASK-101");
    expect(bundle.linked.task.linkedSessionIds).toContain("session-shadow-2");
    expect(bundle.linked.workflowRuns[0]).toMatchObject({
      runId: "run-17",
      workflowId: "wf-diagnostics",
      issueAdvisor: {
        recommendedAction: "resume_remaining",
      },
    });
  });
});
