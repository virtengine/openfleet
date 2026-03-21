import Ajv from "ajv";
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

const ajv = new Ajv({ allErrors: true });
const validators = Object.fromEntries(
  Object.entries(TUI_EVENT_SCHEMAS).map(([eventType, schema]) => [eventType, ajv.compile(schema)]),
);

function expectSchema(eventType, payload) {
  const validate = validators[eventType];
  const valid = validate(payload);
  expect(valid, `${eventType} schema errors: ${JSON.stringify(validate.errors || [])}`).toBe(true);
}

describe("tui bridge event contract", () => {
  it("builds monitor stats from mocked runtime state", () => {
    const payload = buildMonitorStats({
      getActiveSessions: () => [{ id: "a" }, { id: "b" }],
      listAllSessions: () => [
        {
          id: "a",
          status: "active",
          insights: { tokenUsage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 } },
        },
        {
          id: "done",
          status: "completed",
          insights: { tokenUsage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998 } },
        },
      ],
      getCompletedSessions: () => [
        {
          id: "archived",
          insights: { tokenUsage: { inputTokens: 70, outputTokens: 30, totalTokens: 100 } },
        },
      ],
      maxAgents: 6,
      uptimeMs: 10_000,
      ts: 123456,
      rateLimits: {
        openai: { primary: 42, secondary: 7, credits: 1000, unit: "rpm" },
      },
    });

    expect(payload).toMatchObject({
      activeAgents: 2,
      maxAgents: 6,
      tokensIn: 100,
      tokensOut: 50,
      tokensTotal: 150,
      uptimeMs: 10_000,
      throughputTps: 15,
      ts: 123456,
      rateLimits: {
        openai: { primary: 42, secondary: 7, credits: 1000, unit: "rpm" },
      },
    });
    expectSchema("monitor:stats", payload);
  });

  it("validates canonical payload builders against ajv schemas", () => {
    const sessionsPayload = buildSessionsUpdatePayload([
      {
        id: "task-1",
        taskId: "task-1",
        title: "Example",
        type: "task",
        status: "active",
        workspaceId: null,
        workspaceDir: null,
        branch: "task/task-1",
        turnCount: 2,
        createdAt: "2026-03-21T10:00:00.000Z",
        lastActiveAt: "2026-03-21T10:01:00.000Z",
        idleMs: 0,
        elapsedMs: 60000,
        recommendation: "none",
        preview: "preview",
        lastMessage: "preview",
        insights: {},
      },
    ]);
    expectSchema("sessions:update", sessionsPayload);

    const sessionEventPayload = buildSessionEventPayload({
      sessionId: "task-1",
      taskId: "task-1",
      message: { role: "assistant", content: "hello" },
      session: { id: "task-1", status: "active" },
      ts: 1,
    });
    expectSchema("session:event", sessionEventPayload);

    const logPayload = buildStructuredLogLine('{"level":"warn","message":"slow request"}', {
      logType: "system",
      filePath: "logs/monitor.log",
      ts: 2,
    });
    expectSchema("logs:stream", logPayload);

    const workflowPayload = buildWorkflowStatusPayload({
      eventType: "node:complete",
      workflowId: "wf-1",
      workflowName: "Demo",
      runId: "run-1",
      status: "success",
      nodeId: "node-1",
      nodeType: "action.exec_command",
      nodeLabel: "Run",
      outputPreview: { lines: ["ok"] },
      timestamp: 3,
    });
    expectSchema("workflow:status", workflowPayload);

    const taskPayload = buildTaskUpdatePayload({
      reason: "updated",
      taskId: "task-1",
      status: "inprogress",
      parentTaskId: null,
      task: { id: "task-1", status: "inprogress" },
      kanbanBackend: "internal",
      timestamp: 4,
    });
    expectSchema("tasks:update", taskPayload);
  });
});