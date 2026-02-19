import { describe, expect, it, beforeEach } from "vitest";
import { createSessionTracker, SessionTracker } from "../session-tracker.mjs";

describe("session-tracker", () => {
  /** @type {SessionTracker} */
  let tracker;

  beforeEach(() => {
    tracker = createSessionTracker({ maxMessages: 5 });
  });

  describe("startSession / endSession", () => {
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

      // But totalEvents is still incremented
      const session = tracker.getSession("task-1");
      expect(session.totalEvents).toBe(1);
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
});
