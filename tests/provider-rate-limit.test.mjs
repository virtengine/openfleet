import { describe, expect, it } from "vitest";
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
});
