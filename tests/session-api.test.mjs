import { describe, expect, it } from "vitest";

import {
  formatSessionFreshnessTimestamp,
  getSessionManualRetryState,
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

  it("formats freshness labels with relative and absolute timestamps", () => {
    const label = formatSessionFreshnessTimestamp("2026-01-02T00:00:00.000Z", {
      formatRelative: () => "2m ago",
      formatDate: () => "Jan 2, 2026, 12:00 AM",
    });
    expect(label).toBe("2m ago (Jan 2, 2026, 12:00 AM)");
    expect(formatSessionFreshnessTimestamp(null)).toBe("unknown");
  });

  it("disables manual retry while retry backoff is active", () => {
    const now = Date.UTC(2026, 0, 2, 0, 0, 0);
    const pendingRetry = createSessionLoadMeta({
      stale: true,
      retryAttempt: 2,
      maxAttempts: 5,
      nextRetryAt: new Date(now + 5000).toISOString(),
    });
    expect(getSessionManualRetryState(pendingRetry, { now })).toEqual(
      expect.objectContaining({
        disabled: true,
        label: "Retry in 5s",
        reason: "Manual retry is disabled while automatic backoff is active.",
        retrySeconds: 5,
        backoffActive: true,
      }),
    );

    const exhaustedRetry = createSessionLoadMeta({
      stale: true,
      retryAttempt: 5,
      retriesExhausted: true,
      maxAttempts: 5,
      nextRetryAt: null,
    });
    expect(getSessionManualRetryState(exhaustedRetry, { now })).toEqual(
      expect.objectContaining({
        disabled: false,
        label: "Retry now",
        reason: "",
        retrySeconds: 0,
        backoffActive: false,
      }),
    );
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
    meta = markSessionLoadFailure(meta, now, {
      staleReason: {
        code: "request_failed",
        message: "Gateway timeout",
      },
    });
    meta = markSessionLoadFailure(meta, now + 1000);
    expect(meta.stale).toBe(true);
    expect(meta.retryAttempt).toBeGreaterThan(0);
    expect(meta.staleReasonCode).toBe("request_failed");
    expect(meta.staleReasonLabel).toBe("Refresh request failed");
    expect(meta.staleReason).toBe("Gateway timeout");
    expect(meta.lastFailureAt).toBe(new Date(now).toISOString());

    const successMeta = markSessionLoadSuccess(meta, now + 2000);
    expect(successMeta.stale).toBe(false);
    expect(successMeta.retryAttempt).toBe(0);
    expect(successMeta.retriesExhausted).toBe(false);
    expect(successMeta.lastSuccessAt).toBe(new Date(now + 2000).toISOString());
    expect(successMeta.staleReason).toBe(null);
    expect(successMeta.staleReasonCode).toBe(null);
    expect(successMeta.staleReasonLabel).toBe(null);
    expect(successMeta.staleReasonMeta).toBe(null);

    const resetMeta = resetSessionRetryMeta(markSessionLoadFailure(successMeta, now + 3000));
    expect(resetMeta.retryAttempt).toBe(0);
    expect(resetMeta.nextRetryAt).toBe(null);
    expect(resetMeta.retriesExhausted).toBe(false);
  });
});

