import { describe, expect, it } from "vitest";

import {
  buildSessionApiPath,
  createSessionLoadMeta,
  getSessionRetryDelayMs,
  markSessionLoadFailure,
  markSessionLoadSuccess,
  resetSessionRetryMeta,
  resolveSessionWorkspaceHint,
} from "../ui/modules/session-api.js";

describe("session api workspace routing", () => {
  it("preserves workspace=all in session detail paths", () => {
    const path = buildSessionApiPath("abc123", "", { workspace: "all" });
    expect(path).toBe("/api/sessions/abc123?workspace=all");
  });

  it("normalizes wildcard workspace hints to all", () => {
    const path = buildSessionApiPath("abc123", "message", { workspace: "*" });
    expect(path).toBe("/api/sessions/abc123/message?workspace=all");
  });

  it("falls back to all when session metadata is absent", () => {
    expect(resolveSessionWorkspaceHint(null, "all")).toBe("all");
  });
});

describe("session api stale/retry metadata", () => {
  it("computes bounded retry backoff delays", () => {
    const meta = createSessionLoadMeta({
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
      maxAttempts: 5,
    });
    expect(getSessionRetryDelayMs(1, meta)).toBe(1000);
    expect(getSessionRetryDelayMs(2, meta)).toBe(2000);
    expect(getSessionRetryDelayMs(3, meta)).toBe(4000);
    expect(getSessionRetryDelayMs(4, meta)).toBe(5000);
    expect(getSessionRetryDelayMs(5, meta)).toBe(5000);
  });

  it("marks stale after failures and stops scheduling when attempts are exhausted", () => {
    const now = Date.UTC(2026, 0, 2, 0, 0, 0);
    let meta = createSessionLoadMeta({
      maxAttempts: 2,
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
    });

    meta = markSessionLoadFailure(meta, now);
    expect(meta.stale).toBe(true);
    expect(meta.retryAttempt).toBe(1);
    expect(meta.retriesExhausted).toBe(false);
    expect(meta.nextRetryAt).toBe(new Date(now + 1000).toISOString());

    meta = markSessionLoadFailure(meta, now + 1000);
    expect(meta.retryAttempt).toBe(2);
    expect(meta.retriesExhausted).toBe(false);
    expect(meta.nextRetryAt).toBe(new Date(now + 3000).toISOString());

    meta = markSessionLoadFailure(meta, now + 3000);
    expect(meta.retryAttempt).toBe(3);
    expect(meta.retriesExhausted).toBe(true);
    expect(meta.nextRetryAt).toBe(null);
  });

  it("resets stale retry counters on success and manual reset", () => {
    const now = Date.UTC(2026, 0, 2, 0, 0, 0);
    let meta = createSessionLoadMeta();
    meta = markSessionLoadFailure(meta, now);
    meta = markSessionLoadFailure(meta, now + 1000);
    expect(meta.stale).toBe(true);
    expect(meta.retryAttempt).toBeGreaterThan(0);

    const successMeta = markSessionLoadSuccess(meta, now + 2000);
    expect(successMeta.stale).toBe(false);
    expect(successMeta.retryAttempt).toBe(0);
    expect(successMeta.retriesExhausted).toBe(false);
    expect(successMeta.lastSuccessAt).toBe(new Date(now + 2000).toISOString());

    const resetMeta = resetSessionRetryMeta(markSessionLoadFailure(successMeta, now + 3000));
    expect(resetMeta.retryAttempt).toBe(0);
    expect(resetMeta.nextRetryAt).toBe(null);
    expect(resetMeta.retriesExhausted).toBe(false);
  });
});
