import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";

import {
  TUI_EVENT_SCHEMAS,
  TUI_EVENT_TYPES,
  buildMonitorStats,
  buildSessionEventPayload,
  buildSessionsUpdatePayload,
  buildStructuredLogLine,
  buildTaskUpdatePayload,
  buildWorkflowStatusPayload,
} from "../infra/tui-bridge.mjs";

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = Object.fromEntries(
  Object.entries(TUI_EVENT_SCHEMAS).map(([type, schema]) => [type, ajv.compile(schema)]),
);

function expectSchemaValid(type, payload) {
  const validate = validators[type];
  const ok = validate(payload);
  expect(ok, `${type} schema errors: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

describe("tui bridge payload schemas", () => {
  it("defines a schema for every documented TUI event type", () => {
    expect(Object.keys(TUI_EVENT_SCHEMAS).sort()).toEqual([...TUI_EVENT_TYPES].sort());
  });

  it("builds monitor stats from mocked session sources", () => {
    const getActiveSessions = vi.fn(() => [
      { taskKey: "task-live", sdk: "codex", threadId: "thread-1", age: 1200 },
      { taskKey: "task-review", sdk: "claude", threadId: "thread-2", age: 800 },
    ]);
    const listAllSessions = vi.fn(() => [
      {
        id: "session-live",
        taskId: "task-live",
        title: "Investigate flaky tests",
        type: "task",
        status: "active",
        workspaceId: "workspace-a",
        workspaceDir: "C:/repo",
        branch: "task/tui-bridge",
        turnCount: 3,
        createdAt: "2026-03-21T00:00:00.000Z",
        lastActiveAt: "2026-03-21T00:00:02.000Z",
        idleMs: 0,
        elapsedMs: 2000,
        recommendation: "continue",
        preview: "Running tests",
        lastMessage: "Running tests",
        insights: {
          tokenUsage: {
            inputTokens: 120,
            outputTokens: 30,
            totalTokens: 150,
          },
        },
      },
      {
        id: "session-ended",
        taskId: "task-ended",
        title: "Completed task",
        type: "task",
        status: "completed",
        workspaceId: null,
        workspaceDir: null,
        branch: null,
        turnCount: 1,
        createdAt: "2026-03-21T00:00:00.000Z",
        lastActiveAt: "2026-03-21T00:00:01.000Z",
        idleMs: 0,
        elapsedMs: 1000,
        recommendation: "none",
        preview: "Done",
        lastMessage: "Done",
        insights: {
          tokenUsage: {
            inputTokens: 999,
            outputTokens: 999,
            totalTokens: 1998,
          },
        },
      },
    ]);
    const getCompletedSessions = vi.fn(() => [
      {
        id: "session-done",
        taskId: "task-done",
        inputTokens: 400,
        outputTokens: 100,
        tokenCount: 500,
      },
    ]);

    const payload = buildMonitorStats({
      getActiveSessions,
      listAllSessions,
      getCompletedSessions,
      maxAgents: 6,
      uptimeMs: 2000,
      rateLimits: {
        openai: { primary: 12, secondary: 0, credits: 1000, unit: "rpm" },
        anthropic: { primary: 6, secondary: 3, credits: null, unit: "rpm" },
      },
      ts: 1742553600000,
    });

    expect(getActiveSessions).toHaveBeenCalledTimes(1);
    expect(listAllSessions).toHaveBeenCalledTimes(1);
    expect(getCompletedSessions).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({
      activeAgents: 2,
      maxAgents: 6,
      tokensIn: 520,
      tokensOut: 130,
      tokensTotal: 650,
      throughputTps: 325,
      uptimeMs: 2000,
      rateLimits: {
        openai: { primary: 12, secondary: 0, credits: 1000, unit: "rpm" },
        anthropic: { primary: 6, secondary: 3, credits: null, unit: "rpm" },
      },
      ts: 1742553600000,
    });
    expectSchemaValid("monitor:stats", payload);
  });

  it("validates example payloads for all canonical TUI events", () => {
    const sessionSnapshot = buildSessionsUpdatePayload([
      {
        id: "session-live",
        taskId: "task-live",
        title: "Investigate flaky tests",
        type: "task",
        status: "active",
        workspaceId: "workspace-a",
        workspaceDir: "C:/repo",
        branch: "task/tui-bridge",
        turnCount: 3,
        createdAt: "2026-03-21T00:00:00.000Z",
        lastActiveAt: "2026-03-21T00:00:02.000Z",
        idleMs: 0,
        elapsedMs: 2000,
        recommendation: "continue",
        preview: "Running tests",
        lastMessage: "Running tests",
        insights: null,
      },
    ]);
    const sessionEvent = buildSessionEventPayload({
      sessionId: "session-live",
      taskId: "task-live",
      message: {
        type: "agent_message",
        content: "Patch applied",
        timestamp: "2026-03-21T00:00:02.000Z",
      },
      session: {
        id: "session-live",
        taskId: "task-live",
        type: "task",
        status: "active",
        lastActiveAt: "2026-03-21T00:00:02.000Z",
        turnCount: 3,
      },
      ts: 1742553602000,
    });
    const logLine = buildStructuredLogLine(
      JSON.stringify({
        level: "warn",
        message: "rate limit reached",
        timestamp: "2026-03-21T00:00:00.000Z",
      }),
      {
        logType: "system",
        filePath: "C:/repo/.bosun/logs/system.log",
        ts: 1742553600000,
      },
    );
    const workflowStatus = buildWorkflowStatusPayload({
      eventType: "node:complete",
      workflowId: "default-chat",
      workflowName: "Default Chat",
      runId: "run-123",
      status: "success",
      nodeId: "node-2",
      nodeType: "task",
      nodeLabel: "Execute task",
      duration: 250,
      outputPreview: { summary: "Task finished" },
      timestamp: 1742553600250,
    });
    const taskUpdate = buildTaskUpdatePayload({
      reason: "task-updated",
      taskId: "task-42",
      status: "in_progress",
      parentTaskId: null,
      task: { id: "task-42", title: "Fix flaky test" },
      kanbanBackend: "internal",
      timestamp: 1742553600000,
    });

    expectSchemaValid("sessions:update", sessionSnapshot);
    expectSchemaValid("session:event", sessionEvent);
    expectSchemaValid("logs:stream", logLine);
    expectSchemaValid("workflow:status", workflowStatus);
    expectSchemaValid("tasks:update", taskUpdate);
  });
});
