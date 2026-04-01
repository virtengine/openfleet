import { describe, expect, it, vi } from "vitest";

import {
  buildProviderTurnPayload,
  normalizeProviderResultPayload,
  normalizeProviderStreamEvent,
  normalizeProviderUsage,
} from "../agent/provider-message-transform.mjs";

vi.mock("../agent/provider-registry.mjs", () => ({
  createProviderRegistry: () => ({
    resolveSelection: () => null,
    getProvider: () => null,
    getDefaultProvider: () => null,
  }),
}));

import { createProviderSession } from "../agent/provider-session.mjs";

describe("provider kernel support", () => {
  it("normalizes turn payloads, stream events, and provider results", () => {
    const payload = buildProviderTurnPayload({
      providerId: "codex-sdk",
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "You are Bosun." },
        { role: "user", content: [{ type: "text", text: "Plan the refactor." }] },
      ],
      tools: [{ id: "list_tasks" }],
      reasoningEffort: "high",
      sessionId: "session-1",
    });
    const streamEvent = normalizeProviderStreamEvent({
      type: "message_update",
      providerId: "codex-sdk",
      sessionId: "session-1",
      role: "assistant",
      text: "Streaming delta",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const result = normalizeProviderResultPayload({
      finalResponse: "Harness complete.",
      usage: { inputTokens: 100, outputTokens: 25, costUsd: 0.12 },
      items: [{ role: "assistant", content: "Harness complete." }],
      sessionId: "session-1",
    }, {
      providerId: "codex-sdk",
      model: "gpt-5.4",
    });

    expect(payload).toMatchObject({
      providerId: "codex-sdk",
      model: "gpt-5.4",
      prompt: "Plan the refactor.",
      reasoningEffort: "high",
      sessionId: "session-1",
      threadId: "session-1",
      tools: [{ id: "list_tasks" }],
    });
    expect(streamEvent).toMatchObject({
      type: "message_update",
      providerId: "codex-sdk",
      sessionId: "session-1",
      message: {
        role: "assistant",
        text: "Streaming delta",
      },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    });
    expect(result).toMatchObject({
      text: "Harness complete.",
      providerId: "codex-sdk",
      model: "gpt-5.4",
      sessionId: "session-1",
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        costUsd: 0.12,
      },
    });
    expect(normalizeProviderUsage(null)).toBeNull();
  });

  it("normalizes tool calls, tool results, reasoning, and finish metadata", () => {
    const streamEvent = normalizeProviderStreamEvent({
      type: "item.started",
      providerId: "claude-sdk",
      sessionId: "session-2",
      item: {
        type: "mcp_tool_call",
        server: "filesystem",
        tool: "read_file",
        status: "started",
      },
    });
    const result = normalizeProviderResultPayload({
      items: [
        {
          type: "assistant.message",
          data: { content: "Investigating provider contract." },
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "Need to inspect provider output shapes." },
            { type: "tool_use", id: "tool-1", name: "Read", input: { path: "agent/provider-session.mjs" } },
            { type: "tool_result", tool_use_id: "tool-1", content: "file contents" },
          ],
        },
      ],
      tool_calls: [
        { id: "tool-2", name: "Write", input: { path: "agent/provider-message-transform.mjs" } },
      ],
      reasoning: [
        { type: "reasoning", text: "Use additive changes only." },
      ],
      finish_reason: "tool_calls",
      status: "in_progress",
      sessionId: "session-2",
      threadId: "thread-2",
    }, {
      providerId: "claude-sdk",
      model: "claude-opus-4.1",
    });

    expect(streamEvent.toolCall).toMatchObject({
      name: "mcp__filesystem__read_file",
      server: "filesystem",
      tool: "read_file",
      originalType: "mcp_tool_call",
    });
    expect(result.messages[0]).toMatchObject({
      role: "assistant",
      text: "Investigating provider contract.",
    });
    expect(result.toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "tool-1",
        name: "Read",
      }),
      expect.objectContaining({
        id: "tool-2",
        name: "Write",
      }),
    ]));
    expect(result.toolResults).toEqual([
      expect.objectContaining({
        toolCallId: "tool-1",
        output: "file contents",
      }),
    ]);
    expect(result.reasoningText).toContain("Need to inspect provider output shapes.");
    expect(result.reasoningText).toContain("Use additive changes only.");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.status).toBe("in_progress");
  });

  it("tracks normalized provider session state across turns and stream events", async () => {
    const session = createProviderSession("codex-sdk", {
      model: "gpt-5.4",
      runTurn: async () => ({
        finalResponse: "Session turn complete.",
        sessionId: "provider-session-1",
        threadId: "provider-thread-1",
        finish_reason: "stop",
        items: [
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "Carry state forward." },
              { type: "tool_use", id: "tool-3", name: "Bash", input: { command: "npm test" } },
            ],
          },
        ],
      }),
    });

    const result = await session.runTurn("Continue the harness.");
    const state = session.getState();
    const normalizedEvent = session.normalizeStreamEvent({
      type: "item.updated",
      item: { type: "reasoning", text: "Streaming reasoning" },
    });

    expect(result).toMatchObject({
      output: "Session turn complete.",
      sessionId: "provider-session-1",
      threadId: "provider-thread-1",
      finishReason: "stop",
      toolCalls: [
        expect.objectContaining({
          id: "tool-3",
          name: "Bash",
        }),
      ],
    });
    expect(state).toEqual({
      provider: state.provider,
      model: "gpt-5.4",
      sessionId: "provider-session-1",
      threadId: "provider-thread-1",
    });
    expect(normalizedEvent).toMatchObject({
      providerId: state.provider,
      sessionId: "provider-session-1",
      threadId: "provider-thread-1",
      reasoningText: "Streaming reasoning",
    });
  });
});
