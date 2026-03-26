import { describe, expect, it, vi } from "vitest";
import { createAgentEventBus } from "../agent/agent-event-bus.mjs";
import { detectRateLimitInfo, emitRateLimitHit } from "../lib/provider-rate-limit.mjs";

describe("provider rate-limit helpers", () => {
  it("detects 429s and retry-after metadata", () => {
    const info = detectRateLimitInfo({
      status: 429,
      response: { headers: { "retry-after": "12" } },
      message: "Too many requests",
    });

    expect(info).toMatchObject({
      statusCode: 429,
      retryAfterMs: 12000,
    });
  });

  it("emits a structured rateLimitHit payload", () => {
    const events = [];
    const payload = emitRateLimitHit({
      provider: "copilot",
      sessionId: "sess-1",
      error: new Error("429 rate limit exceeded; retry-after: 5"),
      onProviderEvent: (event) => events.push(event),
    });

    expect(payload).toMatchObject({
      type: "rateLimitHit",
      provider: "copilot",
      sessionId: "sess-1",
      statusCode: 429,
      retryAfterMs: 5000,
    });
    expect(events).toEqual([expect.objectContaining({ type: "rateLimitHit", provider: "copilot" })]);
  });

  it("forwards rate-limit hits to the shared agent event bus", () => {
    const bus = createAgentEventBus();
    const onProviderEvent = vi.fn();

    const payload = emitRateLimitHit({
      provider: "claude",
      sessionId: "sess-bus",
      taskId: "task-429",
      error: new Error("429 too many requests retry-after: 7"),
      onProviderEvent,
      eventBus: bus,
    });

    expect(payload).toMatchObject({
      provider: "claude",
      sessionId: "sess-bus",
      retryAfterMs: 7000,
    });
    expect(onProviderEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "rateLimitHit" }));
    expect(bus.getEventLog({ type: "rateLimitHit" })).toEqual([
      expect.objectContaining({
        taskId: "task-429",
        payload: expect.objectContaining({
          provider: "claude",
          sessionId: "sess-bus",
          retryAfterMs: 7000,
        }),
      }),
    ]);
  });
  it("does not emit when the error is not a rate limit", () => {
    const bus = createAgentEventBus();
    const onProviderEvent = vi.fn();

    const payload = emitRateLimitHit({
      provider: "codex",
      sessionId: "sess-ok",
      taskId: "task-ok",
      error: new Error("socket hangup"),
      onProviderEvent,
      eventBus: bus,
    });

    expect(payload).toBeNull();
    expect(onProviderEvent).not.toHaveBeenCalled();
    expect(bus.getEventLog({ type: "rateLimitHit" })).toEqual([]);
  });

  it("parses retry-after from message text when headers are absent", () => {
    const info = detectRateLimitInfo({
      message: "Provider rejected request: 429 quota exceeded, retry-after=2.5",
    });

    expect(info).toMatchObject({
      statusCode: 429,
      retryAfterMs: 2500,
    });
  });
});
