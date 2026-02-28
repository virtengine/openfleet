import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mock external boundaries ────────────────────────────────────────────────

vi.mock("../config.mjs", () => ({
  loadConfig: vi.fn(() => ({ primaryAgent: "codex-sdk", voice: {} })),
}));

vi.mock("../primary-agent.mjs", () => ({
  execPrimaryPrompt: vi.fn(async () => "agent response"),
  getPrimaryAgentName: vi.fn(() => "codex-sdk"),
  setPrimaryAgent: vi.fn(),
}));

vi.mock("../kanban-adapter.mjs", () => ({
  listTasks: vi.fn(async () => [{ id: "1", title: "Test Task", status: "todo" }]),
  getTask: vi.fn(async () => ({
    id: "1",
    title: "Test Task",
    status: "todo",
    body: "desc",
  })),
  createTask: vi.fn(async () => ({ id: "2", title: "New Task" })),
  updateTaskStatus: vi.fn(async () => {}),
}));

vi.mock("../session-tracker.mjs", () => ({
  listSessions: vi.fn(() => []),
  getSession: vi.fn(() => null),
  getSessionById: vi.fn(() => null),
}));

vi.mock("../fleet-coordinator.mjs", () => ({
  getFleetStatus: vi.fn(() => ({ instances: [] })),
}));

vi.mock("../agent-supervisor.mjs", () => ({}));
vi.mock("../shared-state-manager.mjs", () => ({}));

// ── Lazy import (after mocks are set up) ─────────────────────────────────────

const {
  getToolDefinitions,
  executeToolCall,
  VOICE_TOOLS,
} = await import("../voice-tools.mjs");

const { execPrimaryPrompt, setPrimaryAgent } = await import("../primary-agent.mjs");
const sessionTracker = await import("../session-tracker.mjs");

// ── Tests ────────────────────────────────────────────────────────────────────

describe("voice-tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── getToolDefinitions ──────────────────────────────────────

  describe("getToolDefinitions", () => {
    it("returns non-empty array", () => {
      const defs = getToolDefinitions();
      expect(Array.isArray(defs)).toBe(true);
      expect(defs.length).toBeGreaterThan(0);
    });

    it("each tool def has required fields", () => {
      const defs = getToolDefinitions();
      for (const def of defs) {
        expect(def).toHaveProperty("type", "function");
        expect(def).toHaveProperty("name");
        expect(typeof def.name).toBe("string");
        expect(def).toHaveProperty("description");
        expect(typeof def.description).toBe("string");
        expect(def).toHaveProperty("parameters");
        expect(def.parameters).toHaveProperty("type", "object");
      }
    });

    it("includes gemini-sdk in delegate and switch executor enums", () => {
      const defs = getToolDefinitions();
      const delegate = defs.find((def) => def.name === "delegate_to_agent");
      const switchAgent = defs.find((def) => def.name === "switch_agent");
      expect(delegate?.parameters?.properties?.executor?.enum || []).toContain("gemini-sdk");
      expect(switchAgent?.parameters?.properties?.executor?.enum || []).toContain("gemini-sdk");
    });
  });

  // ── VOICE_TOOLS export ──────────────────────────────────────

  describe("VOICE_TOOLS", () => {
    it("is exported and equals getToolDefinitions()", () => {
      expect(VOICE_TOOLS).toBeDefined();
      expect(VOICE_TOOLS).toBe(getToolDefinitions());
    });
  });

  // ── executeToolCall ─────────────────────────────────────────

  describe("executeToolCall", () => {
    it("returns error for unknown tool", async () => {
      const result = await executeToolCall("nonexistent_tool", {});
      expect(result.error).toMatch(/unknown tool/i);
      expect(result.result).toBeNull();
    });

    it("list_tasks returns task array", async () => {
      const result = await executeToolCall("list_tasks", {});
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]).toHaveProperty("id");
      expect(parsed[0]).toHaveProperty("title");
    });

    it("get_task returns task details", async () => {
      const result = await executeToolCall("get_task", { taskId: "1" });
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed).toHaveProperty("id");
      expect(parsed).toHaveProperty("title");
      expect(parsed).toHaveProperty("status");
    });

    it("create_task returns success message", async () => {
      const result = await executeToolCall("create_task", { title: "Test" });
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/created/i);
    });

    it("get_system_status returns status object", async () => {
      const result = await executeToolCall("get_system_status", {});
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed).toHaveProperty("primaryAgent");
    });

    it("get_agent_status returns agent info", async () => {
      const result = await executeToolCall("get_agent_status", {});
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed).toHaveProperty("activeAgent");
      expect(parsed).toHaveProperty("status");
    });

    it("delegate_to_agent calls execPrimaryPrompt", async () => {
      const result = await executeToolCall("delegate_to_agent", {
        message: "test instruction",
      });
      expect(result.error).toBeUndefined();
      expect(vi.mocked(execPrimaryPrompt)).toHaveBeenCalled();
      const callArgs = vi.mocked(execPrimaryPrompt).mock.calls[0];
      expect(callArgs[0]).toBe("test instruction");
    });

    it("delegate_to_agent honors call context session/executor/mode/model", async () => {
      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "ship it" },
        {
          sessionId: "primary-abc123",
          executor: "claude-sdk",
          mode: "plan",
          model: "claude-opus-4.6",
        },
      );
      expect(result.error).toBeUndefined();
      expect(vi.mocked(setPrimaryAgent)).toHaveBeenCalledWith("claude-sdk");
      const callArgs = vi.mocked(execPrimaryPrompt).mock.calls.at(-1);
      expect(callArgs?.[0]).toBe("ship it");
      expect(callArgs?.[1]).toMatchObject({
        sessionId: "primary-abc123",
        sessionType: "primary",
        mode: "plan",
        model: "claude-opus-4.6",
      });
    });

    it("delegate_to_agent accepts gemini-sdk executor", async () => {
      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "summarize the task" },
        {
          sessionId: "primary-gemini-1",
          executor: "gemini-sdk",
          mode: "ask",
          model: "gemini-2.5-pro",
        },
      );
      expect(result.error).toBeUndefined();
      expect(vi.mocked(setPrimaryAgent)).toHaveBeenCalledWith("gemini-sdk");
      const callArgs = vi.mocked(execPrimaryPrompt).mock.calls.at(-1);
      expect(callArgs?.[1]).toMatchObject({
        sessionId: "primary-gemini-1",
        sessionType: "primary",
        mode: "ask",
        model: "gemini-2.5-pro",
      });
    });

    it("delegate_to_agent appends latest vision summary when available", async () => {
      vi.mocked(sessionTracker.getSessionById).mockReturnValue({
        messages: [
          {
            role: "system",
            content: "[Vision screen] Terminal shows vitest failures in tests/voice-relay.test.mjs.",
          },
        ],
      });

      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "Please fix the failing test and explain why." },
        { sessionId: "primary-vision-1" },
      );
      expect(result.error).toBeUndefined();
      const callArgs = vi.mocked(execPrimaryPrompt).mock.calls.at(-1);
      expect(callArgs?.[0]).toContain("Please fix the failing test");
      expect(callArgs?.[0]).toContain("Live visual context from this call");
      expect(callArgs?.[0]).toContain("[Vision screen]");
    });

    it("run_command returns acknowledgment for safe command", async () => {
      const result = await executeToolCall("run_command", { command: "status" });
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/acknowledged/i);
    });

    it("run_command rejects unsafe command", async () => {
      const result = await executeToolCall("run_command", {
        command: "rm -rf /",
      });
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/not allowed/i);
    });
  });
});
