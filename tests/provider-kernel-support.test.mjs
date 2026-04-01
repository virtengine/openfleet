import { describe, expect, it } from "vitest";

import {
  createProviderAuthManager,
  normalizeProviderAuthState,
} from "../agent/provider-auth-manager.mjs";
import {
  buildProviderTurnPayload,
  normalizeProviderResultPayload,
  normalizeProviderStreamEvent,
  normalizeProviderUsage,
} from "../agent/provider-message-transform.mjs";
import {
  getProviderModelCatalog,
  listProviderModels,
} from "../agent/provider-model-catalog.mjs";

describe("provider kernel support", () => {
  it("normalizes provider auth state across env and runtime credentials", () => {
    const manager = createProviderAuthManager({
      env: {
        OPENAI_API_KEY: "test-key",
      },
    });
    const state = manager.resolve("codex-sdk", {
      connected: false,
    });
    const oauthState = normalizeProviderAuthState("copilot-sdk", {
      accessToken: "oauth-token",
      connected: true,
    });

    expect(state).toMatchObject({
      providerId: "codex-sdk",
      available: true,
      authenticated: true,
      canRun: true,
      preferredMode: "apiKey",
      status: "authenticated",
    });
    expect(oauthState).toMatchObject({
      providerId: "copilot-sdk",
      authenticated: true,
      preferredMode: "oauth",
    });
  });

  it("normalizes turn payloads, stream events, and provider results", () => {
    const payload = buildProviderTurnPayload({
      providerId: "codex-sdk",
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "You are Bosun." },
        { role: "user", content: [{ type: "text", text: "Plan the refactor." }] },
      ],
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

  it("builds a provider model catalog from configured, adapter, and fallback models", () => {
    const models = listProviderModels("codex-sdk", {
      configuredModels: ["gpt-5.4", "gpt-5.4-mini"],
      adapterModels: [{ id: "gpt-5.4", default: true }, "o4-mini"],
      defaultModel: "gpt-5.4",
    });
    const catalog = getProviderModelCatalog("opencode-sdk", {
      configuredModels: ["qwen2.5-coder:latest"],
      adapterModels: ["llama3.3"],
      local: true,
    });

    expect(models.map((entry) => entry.id)).toContain("gpt-5.4");
    expect(models.find((entry) => entry.id === "gpt-5.4")).toMatchObject({
      default: true,
      family: "openai",
    });
    expect(catalog.defaultModel).toBeTruthy();
    expect(catalog.models.some((entry) => entry.local)).toBe(true);
  });
});
