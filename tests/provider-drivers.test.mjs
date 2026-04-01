import { describe, expect, it } from "vitest";

import {
  getBuiltInProviderDriver,
  hasBuiltInProviderDriver,
  listBuiltInProviderDrivers,
  listBuiltInProviderIds,
  normalizeProviderDriverId,
} from "../agent/providers/index.mjs";

describe("provider driver modules", () => {
  it("registers every Step 3 built-in provider driver", () => {
    expect(listBuiltInProviderIds()).toEqual([
      "openai-responses",
      "openai-codex-subscription",
      "azure-openai-responses",
      "anthropic-messages",
      "claude-subscription-shim",
      "openai-compatible",
      "ollama",
      "copilot-oauth",
    ]);
    expect(listBuiltInProviderDrivers()).toHaveLength(8);
  });

  it("normalizes provider aliases and exposes driver metadata", () => {
    expect(normalizeProviderDriverId("GitHub_Copilot")).toBe("github-copilot");
    expect(hasBuiltInProviderDriver("github-copilot")).toBe(true);
    expect(hasBuiltInProviderDriver("chatgpt-subscription")).toBe(true);

    const driver = getBuiltInProviderDriver("azure-openai");
    expect(driver).toMatchObject({
      id: "azure-openai-responses",
      metadata: {
        vendor: "microsoft",
        family: "openai",
      },
      adapterHints: {
        adapterId: "codex-sdk",
        executor: "AZURE_OPENAI",
      },
      capabilities: {
        apiKey: true,
        oauth: true,
        tools: true,
        reasoning: true,
      },
      auth: {
        preferredMode: "apiKey",
        supportedModes: ["apiKey", "oauth"],
      },
    });
  });

  it("builds normalized session config for API-key providers", () => {
    const driver = getBuiltInProviderDriver("openai");
    const config = driver.createSessionConfig({
      env: {
        OPENAI_API_KEY: "sk-test",
        OPENAI_PROJECT_ID: "proj_123",
      },
      settings: {
        defaultModel: "gpt5.4-mini",
      },
    });

    expect(config).toMatchObject({
      providerId: "openai-responses",
      model: "gpt-5.4-mini",
      authMode: "apiKey",
      credentials: {
        apiKeyConfigured: true,
        oauthConfigured: false,
        subscriptionConfigured: false,
      },
      project: "proj_123",
    });
    expect(config.transport.apiStyle).toBe("responses");
  });

  it("builds normalized session config for deployment and local providers", () => {
    const azure = getBuiltInProviderDriver("azure-responses").createSessionConfig({
      env: {
        AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
        AZURE_OPENAI_DEPLOYMENT: "gpt-5-prod",
        AZURE_OPENAI_API_VERSION: "2026-01-01-preview",
      },
    });
    const ollama = getBuiltInProviderDriver("ollama").createSessionConfig({
      env: {
        OLLAMA_HOST: "http://127.0.0.1:11434",
      },
    });

    expect(azure).toMatchObject({
      providerId: "azure-openai-responses",
      endpoint: "https://example.openai.azure.com",
      deployment: "gpt-5-prod",
      apiVersion: "2026-01-01-preview",
      credentials: {
        apiKeyConfigured: false,
        oauthConfigured: false,
      },
    });
    expect(ollama).toMatchObject({
      providerId: "ollama",
      authMode: "local",
      endpoint: "http://127.0.0.1:11434",
      model: "qwen2.5-coder:latest",
      capabilities: {
        local: true,
        openaiCompatible: true,
      },
    });
  });

  it("normalizes usage snapshots and model aliases from drivers", () => {
    const copilot = getBuiltInProviderDriver("copilot");
    const usage = copilot.normalizeUsage({
      prompt_tokens: 120,
      completion_tokens: 40,
    });

    expect(copilot.normalizeModel("copilot-claude")).toBe("claude-sonnet-4");
    expect(usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 40,
      totalTokens: 160,
      costUsd: 0,
    });
  });
});
