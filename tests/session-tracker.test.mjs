import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { addSessionStateListener, _test, createSessionTracker, SessionTracker } from "../infra/session-tracker.mjs";

describe("session-tracker", () => {
  /** @type {SessionTracker} */
  let tracker;

  beforeEach(() => {
    tracker = createSessionTracker({ maxMessages: 5 });
  });

  describe("startSession / endSession", () => {
    it("resolves workspace-mirror tracker paths back to the source repo logs directory", () => {
      const sourceRepo = join(tmpdir(), "bosun-source-repo");
      const mirrorInfraDir = join(
        sourceRepo,
        ".bosun",
        "workspaces",
        "virtengine-gh",
        "bosun",
        "infra",
      );

      expect(_test.resolveSessionTrackerSourceRepoRoot(mirrorInfraDir)).toBe(sourceRepo);
    });

    it("creates a new session", () => {
      tracker.startSession("task-1", "Test Task");
      const session = tracker.getSession("task-1");

      expect(session).toBeTruthy();
      expect(session.taskId).toBe("task-1");
      expect(session.taskTitle).toBe("Test Task");
      expect(session.status).toBe("active");
      expect(session.messages).toEqual([]);
      expect(session.totalEvents).toBe(0);
    });

    it("ends a session with status", () => {
      tracker.startSession("task-1", "Test Task");
      tracker.endSession("task-1", "completed");

      const session = tracker.getSession("task-1");
      expect(session.status).toBe("completed");
      expect(session.endedAt).toBeGreaterThan(0);
    });

    it("replaces existing session", () => {
      tracker.startSession("task-1", "First");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "agent_message", text: "hello" },
      });
      tracker.startSession("task-1", "Second");

      const session = tracker.getSession("task-1");
      expect(session.taskTitle).toBe("Second");
      expect(session.messages).toEqual([]);
    });

    it("returns null for non-existent session", () => {
      expect(tracker.getSession("nonexistent")).toBeNull();
    });
  });

  it("emits session state changes for lifecycle transitions and message activity", () => {
    const seen = [];
    const dispose = addSessionStateListener((payload) => seen.push(payload));
    try {
      tracker.startSession("task-1", "Test Task");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "agent_message", text: "hello" },
      });
      tracker.endSession("task-1", "completed");
    } finally {
      dispose();
    }

    expect(seen.map((entry) => entry.reason)).toEqual(["started", "message", "ended"]);
    expect(seen[0].sessionId).toBe("task-1");
    expect(seen[1].session.insights).toBeTruthy();
    expect(seen[2].status).toBe("completed");
  });

  describe("recordEvent", () => {
    it("records Codex agent_message events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "agent_message", text: "I will fix the bug" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("agent_message");
      expect(messages[0].content).toContain("fix the bug");
    });

    it("preserves compression metadata on normalized Codex agent messages", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "Condensed summary",
          _compressed: "agent_tier1",
          _originalLength: 420,
        },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].meta?.compression).toEqual(
        expect.objectContaining({
          kind: "agent_tier1",
          originalLength: 420,
        }),
      );
    });

    it("records Codex function_call events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "function_call", name: "read_file", arguments: "/path/to/file" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("tool_call");
      expect(messages[0].meta.toolName).toBe("read_file");
    });

    it("records Codex function_call_output events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "function_call_output", output: "file contents here" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("tool_result");
    });

    it("records Codex command_execution events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "git status -sb",
          aggregated_output: "## main",
          status: "completed",
          exit_code: 0,
        },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("tool_call");
      expect(messages[0].meta.toolName).toBe("command_execution");
      expect(messages[0].content).toContain("git status -sb");
      expect(messages[0].content).toContain("## main");
    });

    it("records Codex reasoning events as system messages", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "reasoning", text: "Planning the next edit" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("system");
      expect(messages[0].content).toContain("Planning the next edit");
    });

    it("records Codex reasoning update events as system messages", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.updated",
        item: { type: "reasoning", text: "Inspecting workspace state" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("system");
      expect(messages[0].content).toContain("Inspecting workspace state");
    });

    it("records Codex command start events as tool calls", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.started",
        item: { type: "command_execution", command: "npm test" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("tool_call");
      expect(messages[0].content).toContain("npm test");
    });

    it("records plain formatted stream lines as system messages", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", ":u1f4ad: Thinking about approach");

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("system");
      expect(messages[0].content).toContain("Thinking about approach");
    });

    it("records assistant.message events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "assistant.message",
        data: { content: "Done. Changes are applied." },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("agent_message");
      expect(messages[0].content).toContain("Done. Changes are applied.");
    });

    it("ignores low-signal stream noise for activity tracking", () => {
      tracker.startSession("task-1", "Test");
      const session = tracker.getSession("task-1");
      const before = session.lastActivityAt;

      tracker.recordEvent("task-1", { type: "turn_context" });
      tracker.recordEvent("task-1", {
        type: "event_msg",
        payload: { type: "token_count" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(0);
      expect(session.totalEvents).toBe(0);
      expect(session.lastActivityAt).toBe(before);
    });

    it("records Copilot message events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "message",
        content: "copilot says hello",
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("agent_message");
    });

    it("records Claude content_block_delta events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "content_block_delta",
        delta: { text: "claude response" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("agent_message");
    });

    it("records error events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "error",
        error: { message: "rate limit exceeded" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("error");
      expect(messages[0].content).toContain("rate limit");
    });

    it("respects maxMessages ring buffer", () => {
      tracker.startSession("task-1", "Test");

      for (let i = 0; i < 10; i++) {
        tracker.recordEvent("task-1", {
          type: "item.completed",
          item: { type: "agent_message", text: `message ${i}` },
        });
      }

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(5); // maxMessages = 5
      expect(messages[0].content).toContain("message 5");
      expect(messages[4].content).toContain("message 9");

      const session = tracker.getSession("task-1");
      expect(session.totalEvents).toBe(10);
    });

    it("ignores events for non-existent sessions", () => {
      // Should not throw
      tracker.recordEvent("nonexistent", {
        type: "item.completed",
        item: { type: "agent_message", text: "hello" },
      });
    });

    it("skips uninteresting events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", { type: "item.created", item: { type: "session" } });

      // item.created is not tracked as a message
      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(0);

      // Low-signal events should not keep the session alive
      const session = tracker.getSession("task-1");
      expect(session.totalEvents).toBe(0);
    });
  });

  describe("getMessageSummary", () => {
    it("returns formatted summary", () => {
      tracker.startSession("task-1", "Fix Bug");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "agent_message", text: "Analyzing the code" },
      });
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "function_call", name: "read_file", arguments: "main.go" },
      });

      const summary = tracker.getMessageSummary("task-1");
      expect(summary).toContain("Fix Bug");
      expect(summary).toContain("AGENT");
      expect(summary).toContain("TOOL");
      expect(summary).toContain("read_file");
    });

    it("returns placeholder for empty sessions", () => {
      tracker.startSession("task-1", "Test");
      const summary = tracker.getMessageSummary("task-1");
      expect(summary).toContain("no session messages recorded");
    });

    it("returns placeholder for non-existent sessions", () => {
      const summary = tracker.getMessageSummary("nonexistent");
      expect(summary).toContain("no session messages recorded");
    });
  });

  describe("isSessionIdle", () => {
    it("detects idle sessions", () => {
      const shortTracker = createSessionTracker({ idleThresholdMs: 50 });
      shortTracker.startSession("task-1", "Test");

      expect(shortTracker.isSessionIdle("task-1")).toBe(false);

      // Hack: manually set lastActivityAt in the past
      const session = shortTracker.getSession("task-1");
      session.lastActivityAt = Date.now() - 100;

      expect(shortTracker.isSessionIdle("task-1")).toBe(true);
    });

    it("returns false for non-existent sessions", () => {
      expect(tracker.isSessionIdle("nonexistent")).toBe(false);
    });
  });

  describe("removeSession / getStats", () => {
    it("removes sessions", () => {
      tracker.startSession("task-1", "Test");
      tracker.removeSession("task-1");
      expect(tracker.getSession("task-1")).toBeNull();
    });

    it("tracks stats", () => {
      tracker.startSession("task-1", "Test 1");
      tracker.startSession("task-2", "Test 2");
      tracker.endSession("task-1", "completed");

      const stats = tracker.getStats();
      expect(stats.total).toBe(2);
      expect(stats.active).toBe(1);
      expect(stats.completed).toBe(1);
    });
  });

  describe("persisted insights", () => {
    it("derives idle and stalled list statuses for active sessions", () => {
      vi.useFakeTimers();
      try {
        const timedTracker = createSessionTracker({ maxMessages: 10, idleThresholdMs: 1000, persistDir: null });
        timedTracker.createSession({ id: "chat-idle", type: "primary" });
        timedTracker.createSession({ id: "chat-stalled", type: "primary" });

        vi.advanceTimersByTime(1500);
        timedTracker.recordEvent("chat-idle", {
          type: "assistant",
          role: "assistant",
          content: "still working",
          timestamp: new Date().toISOString(),
        });
        vi.advanceTimersByTime(1200);

        const listed = timedTracker.listAllSessions();
        expect(listed.find((entry) => entry.id === "chat-idle")?.status).toBe("idle");
        expect(listed.find((entry) => entry.id === "chat-stalled")?.status).toBe("stalled");
      } finally {
        vi.useRealTimers();
      }
    });

    it("stores inspector insights on sessions and reloads them from disk", () => {
      const persistDir = mkdtempSync(join(tmpdir(), "bosun-session-tracker-"));
      try {
        const persistentTracker = createSessionTracker({ maxMessages: 10, persistDir });
        persistentTracker.createSession({ id: "chat-1", type: "primary" });
        persistentTracker.recordEvent("chat-1", {
          role: "system",
          type: "system",
          content: "Context Window\n103.2K / 272K tokens • 38%\nMessages 4.2%",
          timestamp: "2026-03-04T01:00:00.000Z",
        });
        persistentTracker.recordEvent("chat-1", {
          type: "item.completed",
          item: { type: "function_call", name: "read_file", arguments: "ui/app.js" },
        });
        persistentTracker.flush();
        persistentTracker.destroy();

        const reloadedTracker = createSessionTracker({ maxMessages: 10, persistDir });
        const session = reloadedTracker.getSessionMessages("chat-1");
        const listed = reloadedTracker.listAllSessions().find((entry) => entry.id === "chat-1");

        expect(session?.insights?.totals?.toolCalls).toBe(1);
        expect(session?.insights?.contextWindow?.percent).toBe(38);
        expect(listed?.insights?.contextWindow?.usedTokens).toBe(103200);

        reloadedTracker.destroy();
      } finally {
        rmSync(persistDir, { recursive: true, force: true });
      }
    });
  });
});
