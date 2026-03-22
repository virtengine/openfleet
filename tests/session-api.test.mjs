import { describe, expect, it } from "vitest";

import {
  formatSessionFreshnessTimestamp,
  getSessionManualRetryState,
  getSessionLifecycleState,
  getSessionRecencyTimestamp,
  getSessionRuntimeState,
  buildSessionApiPath,
  createSessionLoadMeta,
  getSessionRetryDelayMs,
  markSessionLoadFailure,
  markSessionLoadSuccess,`r`n  normalizeSessionWorkspaceHint,`r`n  resetSessionRetryMeta,
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

  it("normalizes wildcard, explicit, and malformed workspace hints predictably", () => {
    expect(normalizeSessionWorkspaceHint("*")).toBe("all");
    expect(normalizeSessionWorkspaceHint(" ALL ")).toBe("all");
    expect(normalizeSessionWorkspaceHint("active")).toBe("active");
    expect(normalizeSessionWorkspaceHint("workspace-123")).toBe("workspace-123");
    expect(normalizeSessionWorkspaceHint("../bad")).toBeNull();
    expect(normalizeSessionWorkspaceHint("bad/value")).toBeNull();
    expect(normalizeSessionWorkspaceHint("?")).toBeNull();
  });

  it("omits malformed workspace hints from built session api paths", () => {
    const path = buildSessionApiPath("abc123", "message", { workspace: "../bad" });
    expect(path).toBe("/api/sessions/abc123/message");
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

describe("session lifecycle/runtime metadata", () => {
  it("keeps lifecycle state separate from live runtime state", () => {
    expect(
      getSessionLifecycleState({
        status: "idle",
        lifecycleStatus: "active",
      }),
    ).toEqual(
      expect.objectContaining({
        key: "active",
        label: "Active",
        isActive: true,
      }),
    );

    expect(
      getSessionRuntimeState({
        status: "idle",
        lifecycleStatus: "active",
        runtimeState: "running",
      }),
    ).toEqual(
      expect.objectContaining({
        key: "running",
        label: "Running",
        isLive: true,
        isStale: false,
        source: "runtime",
      }),
    );
  });

  it("falls back to session recency when runtime state is missing", () => {
    const now = Date.UTC(2026, 0, 2, 0, 5, 0);

    expect(
      getSessionRuntimeState(
        {
          lifecycleStatus: "active",
          lastActiveAt: new Date(now - 45_000).toISOString(),
        },
        { now },
      ),
    ).toEqual(
      expect.objectContaining({
        key: "recent",
        label: "Recent",
        isLive: false,
        isStale: false,
        source: "recency",
      }),
    );

    expect(
      getSessionRuntimeState(
        {
          lifecycleStatus: "active",
          lastActiveAt: new Date(now - 11 * 60_000).toISOString(),
        },
        { now },
      ),
    ).toEqual(
      expect.objectContaining({
        key: "stale",
        label: "Stale",
        isLive: false,
        isStale: true,
        source: "recency",
      }),
    );
  });

  it("reports non-live runtime for terminal lifecycle states", () => {
    expect(
      getSessionRuntimeState({
        lifecycleStatus: "completed",
        status: "completed",
        lastActiveAt: "2026-01-02T00:00:00.000Z",
      }),
    ).toEqual(
      expect.objectContaining({
        key: "stopped",
        label: "Not live",
        isLive: false,
        source: "lifecycle",
      }),
    );
  });

  it("uses lastActiveAt before updatedAt and createdAt for session recency", () => {
    expect(
      getSessionRecencyTimestamp({
        createdAt: "2026-01-01T23:59:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        lastActiveAt: "2026-01-02T00:01:00.000Z",
      }),
    ).toBe("2026-01-02T00:01:00.000Z");

    expect(
      getSessionRecencyTimestamp({
        createdAt: "2026-01-01T23:59:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    ).toBe("2026-01-02T00:00:00.000Z");
  });
});

