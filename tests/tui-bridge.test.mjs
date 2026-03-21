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
      expect(resolveTuiAuthToken({ cacheDir })).toBe("token-123");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
