import { describe, expect, it, vi } from "vitest";

import {
  buildProviderTurnPayload,
  normalizeProviderResultPayload,
  normalizeProviderStreamEvent,
  normalizeProviderUsage,
} from "../agent/provider-message-transform.mjs";
import { normalizeProviderStreamEnvelope } from "../agent/providers/provider-stream-normalizer.mjs";
import { normalizeProviderUsageMetadata } from "../agent/providers/provider-usage-normalizer.mjs";
import { createTurnRunner } from "../agent/harness/turn-runner.mjs";

vi.mock("../agent/provider-registry.mjs", () => ({
  createProviderRegistry: () => ({
    resolveSelection: () => null,
    getProvider: () => null,
    getDefaultProvider: () => null,
    resolveProviderRuntime: () => ({ selection: null, provider: null }),
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
    expect(normalizeProviderUsageMetadata({ prompt_tokens: 3, completion_tokens: 2 })).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      costUsd: 0,
      raw: {
        prompt_tokens: 3,
        completion_tokens: 2,
      },
    });
    expect(normalizeProviderStreamEnvelope({
      providerId: "codex-sdk",
      type: "message_update",
      text: "wrapped delta",
    })).toMatchObject({
      providerId: "codex-sdk",
      message: {
        text: "wrapped delta",
      },
    });
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
      finalResponse: "Session turn complete.",
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
      metadata: {},
    });
    expect(normalizedEvent).toMatchObject({
      providerId: state.provider,
      sessionId: "provider-session-1",
      threadId: "provider-thread-1",
      reasoningText: "Streaming reasoning",
    });
  });

  it("executes provider-requested tools through the canonical session loop before returning the final answer", async () => {
    const toolRunner = {
      runTool: vi.fn(async (toolName, args) => ({
        toolName,
        args,
        output: "tool-output",
      })),
    };
    const runTurn = vi.fn(async (payload) => {
      const hasToolResult = Array.isArray(payload.messages)
        && payload.messages.some((message) => Array.isArray(message.toolResults) && message.toolResults.length > 0);
      if (!hasToolResult) {
        return {
          sessionId: "provider-session-loop",
          threadId: "provider-thread-loop",
          status: "in_progress",
          finish_reason: "tool_calls",
          toolCalls: [
            {
              id: "tool-call-1",
              name: "search_files",
              input: { query: "provider loop" },
            },
          ],
        };
      }
      return {
        sessionId: "provider-session-loop",
        threadId: "provider-thread-loop",
        status: "completed",
        finish_reason: "stop",
        finalResponse: "Tool loop complete.",
      };
    });
    const session = createProviderSession("openai-compatible", {
      model: "qwen2.5-coder:latest",
      runTurn,
      toolRunner,
    });

    const result = await session.runTurn("Use the tool loop.", {
      toolRunner,
      tools: [{ id: "search_files" }],
    });

    expect(toolRunner.runTool).toHaveBeenCalledWith("search_files", { query: "provider loop" }, expect.objectContaining({
      providerId: "openai-compatible",
      sessionId: "provider-session-loop",
      threadId: "provider-thread-loop",
    }));
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      finalResponse: "Tool loop complete.",
      toolCalls: [
        expect.objectContaining({
          id: "tool-call-1",
          name: "search_files",
        }),
      ],
      toolResults: [
        expect.objectContaining({
          toolCallId: "tool-call-1",
        }),
      ],
    });
  });

  it("routes harness stage turns through the provider kernel instead of constructing provider sessions directly", async () => {
    const exec = vi.fn(async (message, options) => ({
      finalResponse: `kernel:${message}`,
      sessionId: options.sessionId || "stage-session",
      threadId: options.threadId || "stage-thread",
      providerId: options.provider,
    }));
    const runner = await createTurnRunner({
      providerRegistry: {
        listProviders: () => [{
          id: "openai-compatible",
          providerId: "openai-compatible",
          adapterId: "opencode-sdk",
          defaultModel: "qwen2.5-coder:latest",
          auth: {
            settings: {
              defaultModel: "qwen2.5-coder:latest",
              baseUrl: "http://127.0.0.1:11434/v1",
            },
          },
        }],
        listEnabledProviders: () => [{
          id: "openai-compatible",
          providerId: "openai-compatible",
          adapterId: "opencode-sdk",
          defaultModel: "qwen2.5-coder:latest",
          auth: {
            settings: {
              defaultModel: "qwen2.5-coder:latest",
              baseUrl: "http://127.0.0.1:11434/v1",
            },
          },
        }],
        resolveSelection: () => ({
          providerId: "openai-compatible",
          selectionId: "openai-compatible",
          adapterName: "opencode-sdk",
          model: "qwen2.5-coder:latest",
        }),
        resolveProviderRuntime: () => ({
          selection: {
            providerId: "openai-compatible",
            selectionId: "openai-compatible",
            adapterName: "opencode-sdk",
            model: "qwen2.5-coder:latest",
          },
          provider: {
            id: "openai-compatible",
            providerId: "openai-compatible",
            adapterId: "opencode-sdk",
            defaultModel: "qwen2.5-coder:latest",
            auth: {
              settings: {
                defaultModel: "qwen2.5-coder:latest",
                baseUrl: "http://127.0.0.1:11434/v1",
              },
            },
          },
        }),
        getProvider: () => ({
          id: "openai-compatible",
          providerId: "openai-compatible",
          adapterId: "opencode-sdk",
          defaultModel: "qwen2.5-coder:latest",
          auth: {
            settings: {
              defaultModel: "qwen2.5-coder:latest",
              baseUrl: "http://127.0.0.1:11434/v1",
            },
          },
        }),
        getDefaultProvider: () => ({
          id: "openai-compatible",
          providerId: "openai-compatible",
          adapterId: "opencode-sdk",
          defaultModel: "qwen2.5-coder:latest",
          auth: {
            settings: {
              defaultModel: "qwen2.5-coder:latest",
              baseUrl: "http://127.0.0.1:11434/v1",
            },
          },
        }),
      },
      adapters: {
        "opencode-sdk": {
          name: "opencode-sdk",
          provider: "OPENCODE",
          exec,
        },
      },
      config: {
        providers: {
          defaultProvider: "openai-compatible",
          openaiCompatible: {
            enabled: true,
            defaultModel: "qwen2.5-coder:latest",
            baseUrl: "http://127.0.0.1:11434/v1",
          },
        },
      },
      env: {},
    });

    const result = await runner.runStageTurn({
      provider: "openai-compatible",
      model: "qwen2.5-coder:latest",
      stage: {
        id: "kernel-stage",
        prompt: "Use kernel routing",
      },
    });

    expect(exec).toHaveBeenCalledWith(
      "Use kernel routing",
      expect.objectContaining({
        provider: "openai-compatible",
        providerConfig: expect.objectContaining({
          provider: "openai-compatible",
          model: "qwen2.5-coder:latest",
        }),
      }),
    );
    expect(result).toMatchObject({
      output: "kernel:Use kernel routing",
      providerId: "openai-compatible",
    });
  });

  it("passes tool definitions and runner context through the harness turn-runner", async () => {
    const captured = [];
    const runner = await createTurnRunner({
      toolOrchestrator: {
        listTools: () => [{ id: "search_files" }],
        execute: async () => ({ ok: true }),
      },
      runProviderTurn: async (payload, options) => {
        captured.push({ payload, options });
        return {
          success: true,
          finalResponse: "Harness provider call complete.",
          sessionId: options.sessionId || "runner-session",
          threadId: options.threadId || "runner-thread",
        };
      },
      sessionManager: { marker: "session-manager" },
    });

    const result = await runner.runStageTurn({
      profile: { provider: "openai-compatible" },
      stage: { id: "plan", prompt: "Plan with tools." },
      sessionId: "runner-session",
      threadId: "runner-thread",
      taskKey: "runner-task",
    });

    expect(captured[0]?.payload?.tools).toEqual([{ id: "search_files" }]);
    expect(result.toolRunner.listTools()).toEqual([{ id: "search_files" }]);
  });
});
