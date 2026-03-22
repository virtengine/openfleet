import { describe, expect, it } from "vitest";

import {
  SESSION_RETENTION_MS,
  buildOsc52CopySequence,
  formatRetryQueueCountdown,
  projectSessionRow,
  reconcileSessionEntries,
} from "../tui/screens/agents-screen-helpers.mjs";

describe("tui agents screen helpers", () => {
  it("retains completed sessions for 10 seconds after they disappear from the live snapshot", () => {
    const startedAt = "2026-03-21T00:00:00.000Z";
    const completedAt = "2026-03-21T00:00:05.000Z";
    const initialNow = Date.parse("2026-03-21T00:00:06.000Z");
    const doneSession = {
      id: "session-done",
      status: "completed",
      title: "Done session",
      lastActiveAt: completedAt,
      createdAt: startedAt,
    };
    const activeSession = {
      id: "session-active",
      status: "active",
      title: "Active session",
      lastActiveAt: "2026-03-21T00:00:06.000Z",
      createdAt: "2026-03-21T00:00:06.000Z",
    };

    const first = reconcileSessionEntries([], [doneSession, activeSession], initialNow);
    expect(first.map((entry) => entry.id)).toEqual(["session-active", "session-done"]);

    const retained = reconcileSessionEntries(
      first,
      [activeSession],
      initialNow + SESSION_RETENTION_MS - 1,
    );
    expect(retained.map((entry) => entry.id)).toEqual(["session-active", "session-done"]);
    expect(retained.find((entry) => entry.id === "session-done")?.isRetained).toBe(true);

    const expired = reconcileSessionEntries(
      retained,
      [activeSession],
      initialNow + SESSION_RETENTION_MS + 1,
    );
    expect(expired.map((entry) => entry.id)).toEqual(["session-active"]);
  });

  it("projects display columns from session telemetry and truncates the event preview", () => {
    const row = projectSessionRow(
      {
        id: "12345678-1234-1234-1234-1234567890ab",
        status: "stalled",
        recommendation: "continue",
        title: "Investigate model failure",
        turnCount: 7,
        lastActiveAt: "2026-03-21T00:10:00.000Z",
        createdAt: "2026-03-21T00:00:00.000Z",
        elapsedMs: 610000,
        lastMessage:
          "This is a long event payload that should be truncated before it blows out the table width.",
        insights: {
          contextWindow: {
            usedTokens: 103200,
            totalTokens: 272000,
            percent: 38,
          },
        },
        metadata: {
          pid: 734,
        },
      },
      Date.parse("2026-03-21T00:10:10.000Z"),
      32,
    );

    expect(row.statusColor).toBe("red");
    expect(row.stageText.trim()).toBe("stalled");
    expect(row.pidText.trim()).toBe("734");
    expect(row.ageTurnText.trim()).toBe("10m/7");
    expect(row.tokensText.trim()).toBe("103.2K/272K");
    expect(row.sessionText.trim()).toBe("Investigate mo");
    expect(row.eventText.endsWith("…")).toBe(true);
  });

  it("formats retry queue countdowns with attempts", () => {
    const text = formatRetryQueueCountdown(
      {
        taskId: "task-123",
        retryCount: 3,
        nextRetryAt: "2026-03-21T00:00:12.000Z",
      },
      Date.parse("2026-03-21T00:00:10.000Z"),
    );

    expect(text).toContain("attempt 3");
    expect(text).toContain("2s");
  });

  it("keeps age advancing from the session start time when elapsedMs is stale", () => {
    const row = projectSessionRow(
      {
        id: "age-check",
        status: "active",
        title: "Age check",
        turnCount: 2,
        createdAt: "2026-03-21T00:00:00.000Z",
        lastActiveAt: "2026-03-21T00:00:05.000Z",
        elapsedMs: 5_000,
      },
      Date.parse("2026-03-21T00:02:00.000Z"),
      24,
    );

    expect(row.ageTurnText.trim()).toBe("2m/2");
  });

  it("builds an OSC 52 clipboard sequence", () => {
    const value = buildOsc52CopySequence("MT-734");
    expect(value.startsWith("\u001b]52;c;")).toBe(true);
    expect(value.endsWith("\u0007")).toBe(true);
  });
});
