import { describe, expect, it } from "vitest";
import Ajv from "ajv";

import {
  TUI_EVENT_SCHEMAS,
  buildMonitorStatsPayload,
} from "../infra/tui-bridge.mjs";

function compileSchema(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

describe("tui event contract", () => {
  it("compiles schemas for all canonical TUI events", () => {
    const eventNames = [
      "monitor:stats",
      "sessions:update",
      "session:event",
      "logs:stream",
      "workflow:status",
      "tasks:update",
    ];

    for (const eventName of eventNames) {
      expect(TUI_EVENT_SCHEMAS[eventName]).toBeTruthy();
      expect(() => compileSchema(TUI_EVENT_SCHEMAS[eventName])).not.toThrow();
    }
  });

  it("builds monitor:stats payloads that satisfy the contract schema", () => {
    const validate = compileSchema(TUI_EVENT_SCHEMAS["monitor:stats"]);
    const agentPool = {
      getTuiStats() {
        return {
          activeAgents: 3,
          maxAgents: 8,
          tokensIn: 1200,
          tokensOut: 400,
          throughputTps: 13.5,
          rateLimits: {
            openai: { primary: 120, secondary: 20, credits: 4.5, unit: "rpm" },
            anthropic: { primary: 60, secondary: 10, credits: null, unit: "rpm" },
          },
        };
      },
    };

    const payload = buildMonitorStatsPayload({
      agentPool,
      runtimeStats: {
        totalInputTokens: 1200,
        totalOutputTokens: 400,
      },
      uptimeMs: 30_000,
    });

    expect(payload).toMatchObject({
      activeAgents: 3,
      maxAgents: 8,
      tokensIn: 1200,
      tokensOut: 400,
      tokensTotal: 1600,
      totalTokens: 1600,
      throughputTps: 13.5,
      uptimeMs: 30_000,
      activeSessionCount: 0,
      completedSessionCount: 0,
      totalSessionCount: 0,
      rateLimits: {
        openai: {
          primary: 120,
          primaryLimit: null,
          secondary: 20,
          secondaryLimit: null,
          credits: 4.5,
          creditsLimit: null,
          unit: "rpm",
        },
        anthropic: {
          primary: 60,
          primaryLimit: null,
          secondary: 10,
          secondaryLimit: null,
          credits: null,
          creditsLimit: null,
          unit: "rpm",
        },
      },
      rateLimitSummary: {
        providerCount: 2,
        providersNearExhaustion: 1,
        providersExhausted: 1,
      },
      sessionHealth: {
        live: 0,
        active: 0,
        working: 0,
        editing: 0,
        committing: 0,
        idle: 0,
        stalled: 0,
        blocked: 0,
        completed: 0,
      },
      context: {
        liveSessionCount: 0,
        completedSessionCount: 0,
        sessionsNearContextLimit: 0,
        sessionsHighContextPressure: 0,
        maxContextUsagePercent: 0,
        avgContextUsagePercent: null,
      },
      toolSummary: {
        toolCalls: 0,
        toolResults: 0,
        errors: 0,
        editOps: 0,
        commitOps: 0,
        sessionsWithEdits: 0,
        sessionsWithCommits: 0,
        topTools: [],
      },
      activeSessions: [],
    });

    expect(validate(payload)).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
