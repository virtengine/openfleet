import { describe, expect, it } from "vitest";

import { createProviderKernel } from "../agent/provider-kernel.mjs";
import { createProviderRegistry } from "../agent/provider-registry.mjs";

function createBenchKernel() {
  const adapters = {
    "opencode-sdk": {
      name: "opencode-sdk",
      provider: "OPENCODE",
      exec: async (message, options = {}) => ({
        finalResponse: `provider:${message}`,
        sessionId: options.sessionId || "provider-session",
        threadId: options.threadId || "provider-thread",
        providerId: options.provider || null,
        usage: {
          inputTokens: 24,
          outputTokens: 12,
          totalTokens: 36,
        },
      }),
    },
  };
  const config = {
    providers: {
      defaultProvider: "openai-compatible",
      openaiCompatible: {
        enabled: true,
        defaultModel: "qwen2.5-coder:latest",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
    },
  };
  const registry = createProviderRegistry({
    adapters,
    configExecutors: [],
    includeBuiltins: true,
    env: {},
    settings: {
      BOSUN_PROVIDER_DEFAULT: "openai-compatible",
      BOSUN_PROVIDER_OPENAI_COMPATIBLE_ENABLED: "true",
      BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODEL: "qwen2.5-coder:latest",
      BOSUN_PROVIDER_OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:11434/v1",
    },
  });
  const kernel = createProviderKernel({
    adapters,
    config,
    env: {},
    providerRegistry: registry,
  });
  return { registry, kernel };
}

describe("provider kernel cutover", () => {
  it("exposes one authoritative registry snapshot for default provider, auth, models, and capabilities", () => {
    const { registry } = createBenchKernel();

    const snapshot = registry.getRegistrySnapshot();
    const provider = registry.getDefaultProvider();
    const runtime = registry.resolveProviderRuntime("openai-compatible");

    expect(snapshot.contractVersion).toBe("bosun.provider-registry.v1");
    expect(snapshot.defaultProviderId).toBe("openai-compatible");
    expect(provider).toMatchObject({
      providerId: "openai-compatible",
      enabled: true,
      available: true,
      defaultModel: expect.any(String),
    });
    expect(snapshot.modelCatalogs["openai-compatible"]).toMatchObject({
      providerId: "openai-compatible",
      defaultModel: "qwen2.5-coder:latest",
      models: expect.arrayContaining([
        expect.objectContaining({
          id: "qwen2.5-coder:latest",
        }),
      ]),
    });
    expect(snapshot.capabilities["openai-compatible"]).toEqual(
      expect.objectContaining({
        streaming: true,
      }),
    );
    expect(snapshot.authHealth["openai-compatible"]).toEqual(
      expect.objectContaining({
        providerId: "openai-compatible",
        enabled: true,
        canRun: true,
      }),
    );
    expect(runtime).toEqual(
      expect.objectContaining({
        selection: expect.objectContaining({
          providerId: "openai-compatible",
          adapterName: "opencode-sdk",
        }),
        provider: expect.objectContaining({
          providerId: "openai-compatible",
        }),
      }),
    );
  });

  it("creates normalized execution sessions only through the provider kernel", async () => {
    const { kernel } = createBenchKernel();

    const runtime = kernel.resolveRuntime("openai-compatible", "opencode-sdk");
    const session = kernel.createExecutionSession({
      selectionId: "openai-compatible",
      adapterName: "opencode-sdk",
      sessionId: "cutover-provider-session",
      threadId: "cutover-provider-thread",
      model: "qwen2.5-coder:latest",
      metadata: {
        surface: "chat",
      },
    });

    const result = await session.runTurn("Normalize provider runtime.");

    expect(runtime.providerId).toBe("openai-compatible");
    expect(runtime.providerConfig).toEqual(
      expect.objectContaining({
        provider: "openai-compatible",
        model: "qwen2.5-coder:latest",
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    );
    expect(result).toMatchObject({
      output: "provider:Normalize provider runtime.",
      finalResponse: "provider:Normalize provider runtime.",
      providerId: "openai-compatible",
      sessionId: "cutover-provider-session",
      threadId: "cutover-provider-thread",
      usage: {
        inputTokens: 24,
        outputTokens: 12,
        totalTokens: 36,
      },
    });
    expect(session.getState()).toEqual(
      expect.objectContaining({
        provider: "openai-compatible",
        model: "qwen2.5-coder:latest",
        sessionId: "cutover-provider-session",
        threadId: "cutover-provider-thread",
      }),
    );
  });
});
