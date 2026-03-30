import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import {
  TUI_EVENT_TYPES,
  TUI_EVENT_SCHEMAS,
  createTuiStatsEmitter,
  persistCompatibleTuiAuthToken,
  resolveTuiAuthToken,
  buildMonitorStatsPayload,
  buildSessionsUpdatePayload,
} from "../infra/tui-bridge.mjs";

describe("tui bridge helpers", () => {
  it("exports the canonical event list", () => {
    expect(TUI_EVENT_TYPES).toEqual([
      "monitor:stats",
      "sessions:update",
      "session:event",
      "logs:stream",
      "workflow:status",
      "tasks:update",
    ]);
    expect(TUI_EVENT_SCHEMAS["monitor:stats"]).toBeTruthy();
  });

  it("ticks a stats emitter with schema-compatible payloads", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validateStats = ajv.compile(TUI_EVENT_SCHEMAS["monitor:stats"]);
    const agentPool = {
      getTuiStats: vi.fn(() => ({
        activeAgents: 1,
        maxAgents: 2,
        tokensIn: 10,
        tokensOut: 5,
        rateLimits: { openai: { primary: 1, secondary: null, credits: null, unit: "rpm" } },
      })),
    };
    const emitter = createTuiStatsEmitter({
      intervalMs: 2000,
      emit,
      getPayload: () => buildMonitorStatsPayload({
        agentPool,
        uptimeMs: 1000,
      }),
    });

    const first = await emitter.tick();
    expect(agentPool.getTuiStats).toHaveBeenCalledTimes(1);
    expect(first.tokensTotal).toBe(15);
    expect(validateStats(first)).toBe(true);
    expect(validateStats.errors).toBeNull();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith(first);

    emitter.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(validateStats(emit.mock.calls[1][0])).toBe(true);
    emitter.stop();
    vi.useRealTimers();
  });

  it("persists and resolves the shared auth token", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "bosun-tui-token-"));
    try {
      expect(persistCompatibleTuiAuthToken("token-123", { cacheDir })).toBe("token-123");
      expect(resolveTuiAuthToken({ cacheDir, env: {} })).toBe("token-123");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("normalizes enriched session summaries and monitor payload telemetry", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validateStats = ajv.compile(TUI_EVENT_SCHEMAS["monitor:stats"]);
    const validateSessions = ajv.compile(TUI_EVENT_SCHEMAS["sessions:update"]);
    const sessions = buildSessionsUpdatePayload([
      {
        id: "task-1",
        taskId: "task-1",
        title: "Telemetry Session",
        type: "task",
        status: "editing",
        lifecycleStatus: "active",
        runtimeState: "editing",
        runtimeUpdatedAt: "2026-03-30T10:00:04.000Z",
        runtimeIsLive: true,
        workspaceId: null,
        workspaceDir: null,
        branch: "main",
        turnCount: 1,
        createdAt: "2026-03-30T10:00:00.000Z",
        lastActiveAt: "2026-03-30T10:00:04.000Z",
        idleMs: 1000,
        elapsedMs: 4000,
        recommendation: "none",
        preview: "updated src/app.mjs",
        lastMessage: "updated src/app.mjs",
        insights: { tokenUsage: { inputTokens: 120, outputTokens: 45, totalTokens: 165 } },
        totalEvents: 4,
        lastEventType: "tool_result",
        hasEdits: true,
        hasCommits: false,
        toolCalls: 2,
        toolResults: 1,
        errors: 0,
        commandExecutions: 1,
        fileCounts: {
          openedFiles: 1,
          editedFiles: 1,
          referencedFiles: 1,
          openOps: 1,
          editOps: 1,
        },
        topTools: [{ name: "apply_patch", count: 1 }],
        recentActions: [{ type: "tool_call", label: "apply_patch", level: "info", timestamp: "2026-03-30T10:00:02.000Z" }],
        contextWindow: { usedTokens: 184000, totalTokens: 200000, percent: 92 },
        contextUsagePercent: 92,
        contextPressure: "critical",
        lastToolName: "apply_patch",
        lastActionAt: "2026-03-30T10:00:02.000Z",
        runtimeHealth: {
          state: "editing",
          severity: "critical",
          live: true,
          idleMs: 1000,
          contextPressure: "critical",
          contextUsagePercent: 92,
          toolCalls: 2,
          toolResults: 1,
          errors: 0,
          hasEdits: true,
          hasCommits: false,
          reasons: ["critical_context", "edits"],
        },
      },
    ]);

    expect(validateSessions(sessions)).toBe(true);
    expect(sessions[0].contextPressure).toBe("critical");
    expect(sessions[0].runtimeHealth.state).toBe("editing");

    const payload = buildMonitorStatsPayload({
      agentPool: {
        activeAgents: 1,
        maxAgents: 3,
        tokensIn: 120,
        tokensOut: 45,
        rateLimits: {
          openai: {
            primary: 1,
            primaryLimit: 10,
            secondary: 5,
            secondaryLimit: 10,
            credits: 50,
            creditsLimit: 100,
            unit: "rpm",
          },
        },
        activeSessions: sessions,
      },
      runtimeStats: {
        sessionCount: 2,
        completedSessions: [
          {
            id: "done-1",
            taskId: "done-1",
            type: "completed_session",
            status: "completed",
            inputTokens: 300,
            outputTokens: 120,
            tokenCount: 420,
            turnCount: 2,
            toolCalls: 3,
            toolResults: 2,
            errors: 0,
            hasEdits: true,
            hasCommits: true,
            fileCounts: { editOps: 2 },
            topTools: [{ name: "command_execution", count: 2 }],
            contextUsagePercent: 88,
            runtimeHealth: { state: "completed", severity: "warning" },
          },
        ],
        toolSummary: {
          toolCalls: 3,
          toolResults: 2,
          errors: 0,
          editOps: 2,
          commitOps: 1,
          sessionsWithEdits: 1,
          sessionsWithCommits: 1,
          topTools: [{ name: "command_execution", count: 2 }],
        },
        contextSummary: {
          sessionsNearLimit: 1,
          sessionsHighPressure: 1,
          maxUsagePercent: 88,
          avgUsagePercent: 88,
        },
      },
      uptimeMs: 5000,
    });

    expect(validateStats(payload), JSON.stringify(validateStats.errors || [])).toBe(true);
    expect(payload.activeSessionCount).toBe(1);
    expect(payload.completedSessionCount).toBe(2);
    expect(payload.totalSessionCount).toBe(3);
    expect(payload.sessionHealth.editing).toBe(1);
    expect(payload.context.sessionsNearContextLimit).toBe(2);
    expect(payload.rateLimitSummary.providersNearExhaustion).toBe(1);
    expect(payload.toolSummary.topTools[0]).toEqual({ name: "command_execution", count: 2 });
    expect(payload.activeSessions[0].lastToolName).toBe("apply_patch");
  });
});

