import { describe, expect, it, vi } from "vitest";

import {
  createProviderRegistry,
  listRegisteredProviders,
  resolveProviderSelection,
} from "../agent/provider-registry.mjs";
import { getProviderCapabilities } from "../agent/provider-capabilities.mjs";
import {
  buildToolCapabilityContract,
  createToolCapabilityManifest,
  createToolOrchestrator,
} from "../agent/tool-orchestrator.mjs";
import {
  createCompiledHarnessSession,
  createBosunSessionManager,
  createHarnessSessionManager,
} from "../agent/session-manager.mjs";

describe("provider registry foundation", () => {
  const adapters = {
    "codex-sdk": {
      name: "codex-sdk",
      displayName: "Codex",
      provider: "CODEX",
      sdkCommands: ["/status"],
      steer: () => true,
      listSessions: () => [],
    },
    "claude-sdk": {
      name: "claude-sdk",
      displayName: "Claude",
      provider: "CLAUDE",
      sdkCommands: ["/model"],
      steer: () => true,
    },
  };

  it("lists configured providers with normalized capabilities", () => {
    const providers = listRegisteredProviders({
      adapters,
      env: { OPENAI_API_KEY: "test-key" },
      configExecutors: [
        {
          name: "codex-primary",
          executor: "CODEX",
          enabled: true,
          models: ["gpt-5.4"],
        },
        {
          name: "claude-review",
          executor: "CLAUDE",
          enabled: false,
          models: ["claude-opus-4.1"],
        },
      ],
      readBusy: (adapter) => adapter.provider === "CODEX",
      getAdapterCapabilities: (adapter) => ({
        steering: typeof adapter.steer === "function",
        sessions: typeof adapter.listSessions === "function",
        sdkCommands: adapter.sdkCommands || [],
      }),
    });

    expect(providers).toHaveLength(2);
    expect(providers[0]).toEqual(expect.objectContaining({
      id: "codex-primary",
      providerId: "openai-codex-subscription",
      adapterId: "codex-sdk",
      available: true,
      busy: true,
      models: ["gpt-5.4"],
      defaultModel: "gpt-5.4",
      auth: expect.objectContaining({
        providerId: "openai-codex-subscription",
        authenticated: true,
        canRun: true,
      }),
      capabilities: expect.objectContaining({
        streaming: true,
        steering: true,
        sessions: true,
        subscription: true,
      }),
    }));
    expect(providers[1]).toEqual(expect.objectContaining({
      id: "claude-review",
      providerId: "claude-subscription-shim",
      adapterId: "claude-sdk",
      available: false,
      models: ["claude-opus-4.1"],
    }));
  });

  it("resolves provider selections by adapter alias or configured id", () => {
    const options = {
      adapters,
      configExecutors: [{ name: "codex-primary", executor: "CODEX", enabled: true }],
    };
    expect(resolveProviderSelection("codex", options)).toEqual({
      providerId: "openai-codex-subscription",
      adapterName: "codex-sdk",
      selectionId: "openai-codex-subscription",
    });
    expect(resolveProviderSelection("codex-primary", options)).toEqual({
      providerId: "openai-codex-subscription",
      adapterName: "codex-sdk",
      selectionId: "codex-primary",
    });

    const registry = createProviderRegistry(options);
    expect(registry.getCapabilities("claude-sdk")).toEqual(expect.objectContaining({
      streaming: true,
      subscription: true,
    }));
    expect(getProviderCapabilities("opencode-sdk")).toEqual(expect.objectContaining({
      local: true,
      openaiCompatible: true,
    }));
  });

  it("honors provider-kernel enablement and default provider selection", () => {
    const registry = createProviderRegistry({
      adapters,
      includeBuiltins: true,
      settings: {
        BOSUN_PROVIDER_DEFAULT: "openai-compatible",
        BOSUN_PROVIDER_OPENAI_COMPATIBLE_ENABLED: "true",
      },
    });

    const defaultProvider = registry.getDefaultProvider();
    const openaiCompatible = registry.getProvider("openai-compatible");
    const ollama = registry.getProvider("ollama");

    expect(defaultProvider).toEqual(expect.objectContaining({
      providerId: "openai-compatible",
      adapterId: "opencode-sdk",
    }));
    expect(openaiCompatible).toEqual(expect.objectContaining({
      enabled: true,
      available: true,
    }));
    expect(ollama).toEqual(expect.objectContaining({
      enabled: false,
      available: false,
    }));
  });
});

describe("tool orchestrator foundation", () => {
  it("builds a stable capability contract and emits structured execution events", async () => {
    const events = [];
    const orchestrator = createToolOrchestrator({
      cwd: process.cwd(),
      onEvent: (event) => events.push(event),
      toolSources: [{
        source: "test",
        definitions: [{
          id: "list_sessions",
          handler: async () => ({ ok: true }),
          networkAccess: "allow",
        }],
      }],
      executeTool: vi.fn(async (toolName, args) => ({
        ok: true,
        toolName,
        args,
      })),
    });

    const manifest = createToolCapabilityManifest({ cwd: process.cwd() });
    const contract = buildToolCapabilityContract({ cwd: process.cwd() });
    const result = await orchestrator.execute("list_sessions", { limit: 3 }, {
      sessionId: "session-1",
      agentProfileId: "voice-agent",
    });

    expect(manifest.toolBridge.function).toContain("executeToolCall");
    expect(contract).toContain("## Tool Capability Contract");
    expect(result).toEqual({
      ok: true,
      toolName: "list_sessions",
      args: { limit: 3 },
    });
    expect(events.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "tool_execution_end",
    ]);
  });
});

describe("session manager foundation", () => {
  const compiledProfile = {
    agentId: "harness-foundation",
    taskKey: "task-harness",
    entryStageId: "plan",
    metadata: { stageCount: 2 },
    stages: [
      {
        id: "plan",
        type: "prompt",
        prompt: "Plan the change.",
        transitions: [{ on: "success", to: "done" }],
      },
      {
        id: "done",
        type: "finalize",
        prompt: "Finish.",
      },
    ],
  };

  it("creates compiled sessions that run through the internal harness runtime", async () => {
    const seenTurns = [];
    const session = createCompiledHarnessSession(compiledProfile, {
      runId: "run-1",
      taskKey: "task-harness",
      executeTurn: vi.fn(async ({ stage, mode }) => {
        seenTurns.push({ stageId: stage.id, mode });
        return {
          success: true,
          outcome: "success",
          status: "completed",
          output: `completed ${stage.id}`,
        };
      }),
      steerActiveTurn: vi.fn(() => true),
    });

    const result = await session.run();

    expect(result.success).toBe(true);
    expect(result.status).toBe("completed");
    expect(seenTurns).toEqual([
      { stageId: "plan", mode: "initial" },
      { stageId: "done", mode: "continue" },
    ]);
    expect(session.canSteer()).toBe(false);
  });

  it("supports compiled and source sessions through the manager facade", async () => {
    const manager = createHarnessSessionManager({
      buildTurnExecutor: () => async ({ stage }) => ({
        success: true,
        outcome: "success",
        status: "completed",
        output: stage.id,
      }),
    });

    const compiledRun = await manager.runCompiledSession(compiledProfile, {
      runId: "run-compiled",
    });
    expect(compiledRun.result.success).toBe(true);

    const sourceRun = await manager.runSession({
      name: "Foundation Harness",
      entryStageId: "plan",
      stages: [
        {
          id: "plan",
          type: "prompt",
          prompt: "Plan.",
          transitions: [{ on: "success", to: "done" }],
        },
        {
          id: "done",
          type: "finalize",
          prompt: "Done.",
        },
      ],
    }, {
      runId: "run-source",
    });
    expect(sourceRun.isValid).toBe(true);
    expect(sourceRun.result.success).toBe(true);
  });

  it("tracks Bosun-native sessions, child lineage, and replay snapshots", async () => {
    const trackerMod = await import("../infra/session-tracker.mjs");
    trackerMod._resetSingleton();
    const tracker = trackerMod.getSessionTracker();
    const manager = createBosunSessionManager();

    manager.switchSession("primary-session", {
      scope: "primary",
      sessionType: "primary",
      adapterName: "codex-sdk",
      providerSelection: "codex-sdk",
      taskKey: "primary-session",
      cwd: "C:/repo",
    });
    manager.createChildSession("primary-session", {
      sessionId: "child-session",
      scope: "task",
      sessionType: "task",
      adapterName: "codex",
      providerSelection: "codex",
      taskKey: "child-session",
      cwd: "C:/repo",
    });
    tracker.recordEvent("primary-session", {
      role: "user",
      content: "resume this task",
      timestamp: new Date().toISOString(),
    });

    const sessions = manager.listSessions({ scope: "primary" });
    const replay = manager.getReplaySnapshot("primary-session");

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: "primary-session",
        scope: "primary",
        sessionType: "primary",
      }),
    ]);
    expect(replay).toEqual(expect.objectContaining({
      sessionId: "primary-session",
      taskKey: "primary-session",
      lineage: expect.objectContaining({
        childSessionIds: ["child-session"],
      }),
      messages: [
        expect.objectContaining({
          role: "user",
          content: "resume this task",
        }),
      ],
    }));
  });
});
