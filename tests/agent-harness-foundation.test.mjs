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
import { createToolRunner } from "../agent/harness/tool-runner.mjs";
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

  it("blocks approval-gated tools before execution and emits an approval request event", async () => {
    const events = [];
    const executeTool = vi.fn(async () => ({ ok: true }));
    const orchestrator = createToolOrchestrator({
      onEvent: (event) => events.push(event),
      toolSources: [{
        source: "test",
        definitions: [{
          id: "push_branch",
          requiresApproval: true,
        }],
      }],
      executeTool,
    });

    await expect(orchestrator.execute("push_branch", { branch: "feature/test" }, {
      sessionId: "session-approval",
      approval: { mode: "manual" },
    })).rejects.toThrow(/requires operator approval/i);

    expect(executeTool).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        type: "approval_requested",
        toolName: "push_branch",
        approval: expect.objectContaining({
          blocked: true,
          approvalState: "pending",
          approvalRequired: true,
        }),
      }),
    ]);
  });

  it("blocks disallowed network access before execution and emits an execution error event", async () => {
    const events = [];
    const executeTool = vi.fn(async () => ({ ok: true }));
    const orchestrator = createToolOrchestrator({
      onEvent: (event) => events.push(event),
      toolSources: [{
        source: "test",
        definitions: [{
          id: "fetch_remote_context",
          networkAccess: "restricted",
          allowedHosts: ["api.openai.com"],
        }],
      }],
      executeTool,
    });

    await expect(orchestrator.execute("fetch_remote_context", {}, {
      sessionId: "session-network",
      requestedHosts: ["169.254.169.254"],
    })).rejects.toThrow(/blocked by policy|not allowlisted/i);

    expect(executeTool).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        type: "tool_execution_error",
        toolName: "fetch_remote_context",
        error: expect.stringMatching(/blocked by policy|not allowlisted/i),
      }),
    ]);
  });

  it("emits truncated end-event payloads but returns the full tool result", async () => {
    const events = [];
    const longOutput = { lines: Array.from({ length: 20 }, (_, index) => `line-${index}-${"x".repeat(24)}`) };
    const orchestrator = createToolOrchestrator({
      onEvent: (event) => events.push(event),
      toolSources: [{
        source: "test",
        definitions: [{
          id: "collect_logs",
          networkAccess: "allow",
        }],
      }],
      truncation: { maxChars: 96, tailChars: 12 },
      executeTool: vi.fn(async () => longOutput),
    });

    const result = await orchestrator.execute("collect_logs", {}, { sessionId: "session-truncation" });

    expect(result).toEqual(longOutput);
    expect(events.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "tool_execution_end",
    ]);
    expect(events[1]).toEqual(expect.objectContaining({
      type: "tool_execution_end",
      result: expect.objectContaining({
        truncated: true,
        preview: expect.stringContaining("…truncated"),
      }),
    }));
  });

  it("emits execution error events when the tool hook throws", async () => {
    const events = [];
    const orchestrator = createToolOrchestrator({
      onEvent: (event) => events.push(event),
      toolSources: [{
        source: "test",
        definitions: [{ id: "run_failing_tool", networkAccess: "allow" }],
      }],
      executeTool: vi.fn(async () => {
        throw new Error("tool exploded");
      }),
    });

    await expect(orchestrator.execute("run_failing_tool", {}, {
      sessionId: "session-error",
    })).rejects.toThrow("tool exploded");

    expect(events.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "tool_execution_error",
    ]);
    expect(events[1]).toEqual(expect.objectContaining({
      toolName: "run_failing_tool",
      error: "tool exploded",
    }));
  });

  it("retries transient tool failures and emits retry telemetry before succeeding", async () => {
    const events = [];
    const executeTool = vi.fn()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce({ ok: true, recovered: true });
    const orchestrator = createToolOrchestrator({
      onEvent: (event) => events.push(event),
      retryPolicy: {
        maxAttempts: 2,
      },
      toolSources: [{
        source: "test",
        definitions: [{ id: "retryable_tool", networkAccess: "allow" }],
      }],
      executeTool,
    });

    const result = await orchestrator.execute("retryable_tool", {}, {
      sessionId: "session-retry",
    });

    expect(result).toEqual({ ok: true, recovered: true });
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "tool_execution_retry",
      "tool_execution_end",
    ]);
    expect(events[1]).toEqual(expect.objectContaining({
      toolName: "retryable_tool",
      attempt: 1,
      nextAttempt: 2,
      error: "transient failure",
    }));
    expect(events[2]).toEqual(expect.objectContaining({
      toolName: "retryable_tool",
      attempt: 2,
      attemptCount: 2,
    }));
  });
});

describe("tool runner bridge", () => {
  it("delegates list and run calls through the orchestrator and forwards the event hook", async () => {
    const executeTool = vi.fn(async () => ({ ok: true }));
    const toolOrchestrator = {
      listTools: vi.fn(() => [{ id: "list_tasks" }]),
      executeTool,
    };
    const onEvent = vi.fn();
    const runner = await createToolRunner({
      toolOrchestrator,
      onEvent,
    });

    const tools = runner.listTools();
    const result = await runner.runTool("list_tasks", { limit: 2 }, {
      sessionId: "runner-session",
    });

    expect(tools).toEqual([{ id: "list_tasks" }]);
    expect(result).toEqual({ ok: true });
    expect(toolOrchestrator.listTools).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith("list_tasks", { limit: 2 }, {
      sessionId: "runner-session",
      onEvent,
    });
  });

  it("fails fast when the orchestrator execute hook is missing", async () => {
    const runner = await createToolRunner({
      toolOrchestrator: {
        listTools: () => [],
      },
    });

    await expect(runner.runTool("list_tasks", {}, {})).rejects.toThrow(
      "Tool orchestrator is not configured",
    );
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
