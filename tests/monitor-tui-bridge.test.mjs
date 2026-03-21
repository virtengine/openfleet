import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  TUI_EVENT_SCHEMAS,
  buildMonitorStats,
  buildSessionEventPayload,
  buildSessionsUpdatePayload,
  buildStructuredLogLine,
  buildTaskUpdatePayload,
  buildWorkflowStatusPayload,
} from "../infra/tui-bridge.mjs";

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });

function compile(type) {
  return ajv.compile(TUI_EVENT_SCHEMAS[type]);
}

describe("tui-bridge monitor stats", () => {
  it("builds monitor stats payloads that satisfy the TUI contract", () => {
    const validate = compile("monitor:stats");
    const payload = buildMonitorStats({
      activeSessions: [
        { taskKey: "task-1", sdk: "codex", threadId: "th-1", age: 1000 },
        { taskKey: "task-2", sdk: "codex", threadId: "th-2", age: 500 },
      ],
      sessions: [
        {
          id: "task-1",
          taskId: "task-1",
          status: "active",
          insights: { tokenUsage: { inputTokens: 30, outputTokens: 70, totalTokens: 100 } },
        },
      ],
      completedSessions: [
        {
          id: "task-0",
          taskId: "task-0",
          inputTokens: 10,
          outputTokens: 15,
          tokenCount: 25,
        },
      ],
      maxAgents: 6,
      uptimeMs: 4000,
      rateLimits: {
        openai: { primary: 12, secondary: 3, credits: 99, unit: "requests/min" },
      },
      ts: 123456,
    });

    expect(payload).toMatchObject({
      activeAgents: 2,
      maxAgents: 6,
      tokensIn: 40,
      tokensOut: 85,
      tokensTotal: 125,
      uptimeMs: 4000,
      rateLimits: {
        openai: { primary: 12, secondary: 3, credits: 99, unit: "requests/min" },
      },
      ts: 123456,
    });
    expect(payload.throughputTps).toBeCloseTo(31.25, 3);
    expect(validate(payload), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("validates the canonical payload schemas for all TUI event types", () => {
    const samples = {
      "sessions:update": buildSessionsUpdatePayload([
        {
          id: "task-1",
          taskId: "task-1",
          title: "Fix bridge",
          type: "task",
          status: "active",
          workspaceId: "ws-1",
          workspaceDir: "C:/repo",
          branch: "task/bridge",
          turnCount: 3,
          createdAt: new Date(0).toISOString(),
          lastActiveAt: new Date(1000).toISOString(),
          idleMs: 0,
          elapsedMs: 1000,
          recommendation: "none",
          preview: "Working",
          lastMessage: "Working",
          insights: { tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
        },
      ]),
      "session:event": buildSessionEventPayload({
        sessionId: "task-1",
        taskId: "task-1",
        message: { type: "agent_message", content: "Done", timestamp: new Date(0).toISOString() },
        session: { id: "task-1", status: "active", turnCount: 1 },
        ts: 99,
      }),
      "logs:stream": buildStructuredLogLine('{"level":"info","message":"hello","timestamp":"2026-03-21T00:00:00.000Z"}', {
        logType: "system",
        filePath: "logs/monitor.log",
        ts: 111,
      }),
      "workflow:status": buildWorkflowStatusPayload({
        eventType: "run:start",
        workflowId: "wf-1",
        workflowName: "Bridge Workflow",
        runId: "run-1",
        status: "running",
        timestamp: 222,
      }),
      "tasks:update": buildTaskUpdatePayload({
        reason: "task-updated",
        taskId: "task-9",
        status: "inprogress",
        parentTaskId: null,
        task: { id: "task-9", title: "Ship it" },
        kanbanBackend: "internal",
        timestamp: 333,
      }),
    };

    for (const [type, payload] of Object.entries(samples)) {
      const validate = compile(type);
      expect(validate(payload), `${type}: ${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
    }
  });
});
