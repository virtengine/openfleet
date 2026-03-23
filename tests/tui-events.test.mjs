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

    expect(payload).toEqual({
      activeAgents: 3,
      maxAgents: 8,
      tokensIn: 1200,
      tokensOut: 400,
      tokensTotal: 1600,
      totalTokens: 1600,
      throughputTps: 13.5,
      uptimeMs: 30_000,
      rateLimits: {
        openai: { primary: 120, secondary: 20, credits: 4.5, unit: "rpm" },
        anthropic: { primary: 60, secondary: 10, credits: null, unit: "rpm" },
      },
    });

    expect(validate(payload)).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
