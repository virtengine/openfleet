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
  getKanbanAdapter: vi.fn(() => ({
    listProjects: vi.fn(async () => [{ id: "proj-1", name: "Test Project" }]),
    listTasks: vi.fn(async () => [{ id: "1", title: "Test Task", status: "todo" }]),
    getTask: vi.fn(async () => ({
      id: "1",
      title: "Test Task",
      status: "todo",
      body: "desc",
    })),
    createTask: vi.fn(async () => ({ id: "2", title: "New Task" })),
    updateTaskStatus: vi.fn(async () => {}),
    deleteTask: vi.fn(async () => true),
    addComment: vi.fn(async () => true),
  })),
}));

vi.mock("../session-tracker.mjs", () => ({
  listSessions: vi.fn(() => []),
  getSession: vi.fn(() => null),
  getSessionById: vi.fn(() => null),
  recordEvent: vi.fn(),
}));

vi.mock("../fleet-coordinator.mjs", () => ({
  getFleetStatus: vi.fn(() => ({ instances: [] })),
}));

vi.mock("../agent-supervisor.mjs", () => ({}));
vi.mock("../shared-state-manager.mjs", () => ({}));

vi.mock("../agent-pool.mjs", () => ({
  execPooledPrompt: vi.fn(async () => ({
    finalResponse: "pooled agent response",
    items: [],
    usage: null,
  })),
}));

vi.mock("../vision-session-state.mjs", () => ({
  getVisionSessionState: vi.fn(() => ({
    lastFrameDataUrl: "data:image/jpeg;base64,ZmFrZQ==",
    lastFrameSource: "screen",
  })),
}));

vi.mock("../voice-relay.mjs", () => ({
  analyzeVisionFrame: vi.fn(async () => ({
    summary: "The terminal shows a syntax error in voice-tools.mjs.",
    provider: "openai",
    model: "gpt-4o",
  })),
}));

// ── Lazy import (after mocks are set up) ─────────────────────────────────────

const {
  getToolDefinitions,
  executeToolCall,
  VOICE_TOOLS,
} = await import("../voice-tools.mjs");

const { execPrimaryPrompt, setPrimaryAgent } = await import("../primary-agent.mjs");
const { execPooledPrompt } = await import("../agent-pool.mjs");
const sessionTracker = await import("../session-tracker.mjs");
const { analyzeVisionFrame } = await import("../voice-relay.mjs");

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

    it("delegate_to_agent returns immediately with delegation confirmation", async () => {
      const result = await executeToolCall("delegate_to_agent", {
        message: "test instruction",
      });
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/\{RESPONSE\}/i);
      expect(vi.mocked(execPooledPrompt)).toHaveBeenCalled();
      const callArgs = vi.mocked(execPooledPrompt).mock.calls[0];
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
      expect(result.result).toMatch(/\{RESPONSE\}/i);
      const callArgs = vi.mocked(execPooledPrompt).mock.calls.at(-1);
      expect(callArgs?.[0]).toBe("ship it");
      expect(callArgs?.[1]).toMatchObject({
        sdk: "claude-sdk",
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
      expect(result.result).toMatch(/\{RESPONSE\}/i);
      const callArgs = vi.mocked(execPooledPrompt).mock.calls.at(-1);
      expect(callArgs?.[1]).toMatchObject({
        sdk: "gemini-sdk",
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
      expect(result.result).toMatch(/\{RESPONSE\}/i);
      const callArgs = vi.mocked(execPooledPrompt).mock.calls.at(-1);
      expect(callArgs?.[0]).toContain("Please fix the failing test");
      expect(callArgs?.[0]).toContain("Live visual context from this call");
      expect(callArgs?.[0]).toContain("[Vision screen]");
    });

    it("ask_agent_context returns quick response from pooled prompt", async () => {
      const result = await executeToolCall("ask_agent_context", { message: "What is this repo?" });
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/\{RESPONSE\}:/i);
      expect(result.result).toMatch(/pooled agent response/i);
      const callArgs = vi.mocked(execPooledPrompt).mock.calls.at(-1);
      expect(callArgs?.[1]).toMatchObject({ mode: "instant" });
    });

    it("ask_agent_context derives prompt from nested context history when message is missing", async () => {
      const result = await executeToolCall("ask_agent_context", {
        context: {
          history: [
            {
              role: "user",
              content: [{ type: "input_audio", transcript: "Can you check our current backlog tasks?" }],
            },
          ],
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/\{RESPONSE\}:/i);
      const callArgs = vi.mocked(execPooledPrompt).mock.calls.at(-1);
      expect(String(callArgs?.[0] || "")).toContain("check our current backlog tasks");
    });

    it("run_command returns system status for 'status'", async () => {
      const result = await executeToolCall("run_command", { command: "status" });
      expect(result.error).toBeUndefined();
      // Now actually dispatches to get_system_status — expect a structured result
      const parsed = JSON.parse(result.result);
      expect(parsed).toMatchObject({ primaryAgent: expect.any(String) });
    });

    it("run_command returns informative error for unknown command", async () => {
      const result = await executeToolCall("run_command", {
        command: "rm -rf /",
      });
      expect(result.error).toBeUndefined();
      // The new handler returns a help message pointing to run_workspace_command
      expect(result.result).toMatch(/unknown command|not recognized|supported|run_workspace_command/i);
    });

    it("query_live_view infers query from nested context history when query is missing", async () => {
      const result = await executeToolCall(
        "query_live_view",
        {
          context: {
            history: [
              {
                role: "user",
                content: [
                  { type: "input_audio", transcript: "what exact error is visible on screen right now?" },
                ],
              },
            ],
          },
        },
        { sessionId: "voice-session-1", executor: "codex-sdk", mode: "instant", model: "gpt-realtime-1.5" },
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/\{RESPONSE\}:/i);
      expect(result.result).toMatch(/syntax error/i);
      const callArgs = vi.mocked(analyzeVisionFrame).mock.calls.at(-1);
      expect(String(callArgs?.[1]?.prompt || "")).toMatch(/error is visible on screen/i);
    });

    it("query_live_view uses default query when no user query context is present", async () => {
      const result = await executeToolCall(
        "query_live_view",
        {},
        { sessionId: "voice-session-2", executor: "codex-sdk", mode: "instant", model: "gpt-realtime-1.5" },
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/\{RESPONSE\}:/i);
      const callArgs = vi.mocked(analyzeVisionFrame).mock.calls.at(-1);
      expect(String(callArgs?.[1]?.prompt || "")).toMatch(/Describe what is visible right now/i);
    });
  });
});
