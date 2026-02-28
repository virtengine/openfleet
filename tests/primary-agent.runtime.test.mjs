import { describe, it, expect, beforeEach, vi } from "vitest";

const mockConfigState = vi.hoisted(() => ({
  current: { primaryAgent: "codex-sdk" },
}));

const mockEnsureCodexConfig = vi.hoisted(() => vi.fn(() => ({ noChanges: true })));
const mockPrintConfigSummary = vi.hoisted(() => vi.fn());
const mockEnsureRepoConfigs = vi.hoisted(() => vi.fn(() => ({})));
const mockPrintRepoConfigSummary = vi.hoisted(() => vi.fn());
const mockResolveRepoRoot = vi.hoisted(() => vi.fn(() => "C:/repo"));
const mockRecordEvent = vi.hoisted(() => vi.fn());
const mockExecCodexPrompt = vi.hoisted(() => vi.fn(async () => ({ finalResponse: "codex-ok", items: [] })));
const mockIsCodexBusy = vi.hoisted(() => vi.fn(() => false));
const mockGetThreadInfo = vi.hoisted(() => vi.fn(() => ({ sessionId: "active-codex-session", threadId: "thread-1", isBusy: true })));
const mockResetThread = vi.hoisted(() => vi.fn(async () => {}));
const mockInitCodexShell = vi.hoisted(() => vi.fn(async () => true));
const mockGetCodexSessionId = vi.hoisted(() => vi.fn(() => "active-codex-session"));
const mockListCodexSessions = vi.hoisted(() => vi.fn(async () => []));
const mockSwitchCodexSession = vi.hoisted(() => vi.fn(async () => {}));
const mockCreateCodexSession = vi.hoisted(() => vi.fn(async () => {}));
const mockExecCopilotPrompt = vi.hoisted(() => vi.fn(async () => ({ finalResponse: "copilot-ok", items: [] })));
const mockSteerCopilotPrompt = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const mockIsCopilotBusy = vi.hoisted(() => vi.fn(() => false));
const mockGetCopilotSessionInfo = vi.hoisted(() => vi.fn(() => ({ isBusy: false })));
const mockResetCopilotSession = vi.hoisted(() => vi.fn(async () => {}));
const mockInitCopilotShell = vi.hoisted(() => vi.fn(async () => true));
const mockExecClaudePrompt = vi.hoisted(() => vi.fn(async () => ({ finalResponse: "claude-ok", items: [] })));
const mockSteerClaudePrompt = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const mockIsClaudeBusy = vi.hoisted(() => vi.fn(() => false));
const mockGetClaudeSessionInfo = vi.hoisted(() => vi.fn(() => ({ isBusy: false })));
const mockResetClaudeSession = vi.hoisted(() => vi.fn(async () => {}));
const mockInitClaudeShell = vi.hoisted(() => vi.fn(async () => true));
const mockExecGeminiPrompt = vi.hoisted(() => vi.fn(async () => ({ finalResponse: "gemini-ok", items: [] })));
const mockSteerGeminiPrompt = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const mockIsGeminiBusy = vi.hoisted(() => vi.fn(() => false));
const mockGetGeminiSessionInfo = vi.hoisted(() => vi.fn(() => ({ isBusy: false })));
const mockResetGeminiSession = vi.hoisted(() => vi.fn(async () => {}));
const mockInitGeminiShell = vi.hoisted(() => vi.fn(async () => true));
const mockExecPooledPrompt = vi.hoisted(() => vi.fn(async () => ({ finalResponse: "pooled-ok", items: [] })));

vi.mock("../config.mjs", () => ({
  loadConfig: () => mockConfigState.current,
}));

vi.mock("../codex-config.mjs", () => ({
  ensureCodexConfig: mockEnsureCodexConfig,
  printConfigSummary: mockPrintConfigSummary,
}));

vi.mock("../repo-config.mjs", () => ({
  ensureRepoConfigs: mockEnsureRepoConfigs,
  printRepoConfigSummary: mockPrintRepoConfigSummary,
}));

vi.mock("../repo-root.mjs", () => ({
  resolveRepoRoot: mockResolveRepoRoot,
}));

vi.mock("../session-tracker.mjs", () => ({
  getSessionTracker: () => ({
    recordEvent: mockRecordEvent,
  }),
}));

vi.mock("../codex-shell.mjs", () => ({
  execCodexPrompt: mockExecCodexPrompt,
  steerCodexPrompt: vi.fn(async () => ({ ok: true })),
  isCodexBusy: mockIsCodexBusy,
  getThreadInfo: mockGetThreadInfo,
  resetThread: mockResetThread,
  initCodexShell: mockInitCodexShell,
  getActiveSessionId: mockGetCodexSessionId,
  listSessions: mockListCodexSessions,
  switchSession: mockSwitchCodexSession,
  createSession: mockCreateCodexSession,
}));

vi.mock("../copilot-shell.mjs", () => ({
  execCopilotPrompt: mockExecCopilotPrompt,
  steerCopilotPrompt: mockSteerCopilotPrompt,
  isCopilotBusy: mockIsCopilotBusy,
  getSessionInfo: mockGetCopilotSessionInfo,
  resetSession: mockResetCopilotSession,
  initCopilotShell: mockInitCopilotShell,
}));

vi.mock("../claude-shell.mjs", () => ({
  execClaudePrompt: mockExecClaudePrompt,
  steerClaudePrompt: mockSteerClaudePrompt,
  isClaudeBusy: mockIsClaudeBusy,
  getSessionInfo: mockGetClaudeSessionInfo,
  resetClaudeSession: mockResetClaudeSession,
  initClaudeShell: mockInitClaudeShell,
}));

vi.mock("../gemini-shell.mjs", () => ({
  execGeminiPrompt: mockExecGeminiPrompt,
  steerGeminiPrompt: mockSteerGeminiPrompt,
  isGeminiBusy: mockIsGeminiBusy,
  getSessionInfo: mockGetGeminiSessionInfo,
  resetSession: mockResetGeminiSession,
  initGeminiShell: mockInitGeminiShell,
  getActiveSessionId: vi.fn(() => null),
  listSessions: vi.fn(async () => []),
  switchSession: vi.fn(async () => {}),
  createSession: vi.fn(async (id) => ({ id })),
}));

vi.mock("../opencode-shell.mjs", () => ({
  execOpencodePrompt: vi.fn(async () => ({ finalResponse: "opencode stub", items: [], usage: null })),
  steerOpencodePrompt: vi.fn(async () => ({ ok: true, mode: "abort" })),
  isOpencodeBusy: vi.fn(() => false),
  getSessionInfo: vi.fn(() => ({ turnCount: 0, isActive: false, isBusy: false, sessionCount: 0, namedSessionId: null })),
  resetSession: vi.fn(async () => {}),
  initOpencodeShell: vi.fn(async () => {}),
  getActiveSessionId: vi.fn(() => null),
  listSessions: vi.fn(async () => []),
  switchSession: vi.fn(async () => {}),
  createSession: vi.fn(async (id) => ({ id, serverSessionId: null })),
}));

vi.mock("../agent-pool.mjs", () => ({
  execPooledPrompt: mockExecPooledPrompt,
}));

describe("primary-agent runtime safeguards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigState.current = { primaryAgent: "codex-sdk" };
    delete process.env.BOSUN_ALLOW_RUNTIME_GLOBAL_CODEX_MUTATION;
    delete process.env.CODEX_SDK_DISABLED;
    delete process.env.COPILOT_SDK_DISABLED;
    delete process.env.CLAUDE_SDK_DISABLED;
    delete process.env.GEMINI_SDK_DISABLED;
    delete process.env.OPENCODE_SDK_DISABLED;
    mockIsCodexBusy.mockReturnValue(false);
    mockGetThreadInfo.mockReturnValue({
      sessionId: "active-codex-session",
      threadId: "thread-1",
      isBusy: false,
    });
  });

  it("uses dryRun codex config checks at runtime by default", async () => {
    vi.resetModules();
    const primaryAgent = await import("../primary-agent.mjs");

    await primaryAgent.initPrimaryAgent("codex-sdk");

    expect(mockEnsureCodexConfig).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  it("falls back to pooled execution when active adapter is busy on another session", async () => {
    vi.resetModules();
    const primaryAgent = await import("../primary-agent.mjs");
    await primaryAgent.initPrimaryAgent("codex-sdk");

    mockIsCodexBusy.mockReturnValue(true);
    mockGetThreadInfo.mockReturnValue({
      sessionId: "session-a",
      threadId: "thread-a",
      isBusy: true,
    });

    const result = await primaryAgent.execPrimaryPrompt("hello", {
      sessionId: "session-b",
      allowConcurrent: true,
    });

    expect(mockExecPooledPrompt).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ sdk: "codex" }),
    );
    expect(result.finalResponse).toBe("pooled-ok");
  });

  it("surfaces configured executor profiles with model allow-lists and enabled flags", async () => {
    mockConfigState.current = {
      primaryAgent: "codex-sdk",
      executorConfig: {
        executors: [
          {
            name: "copilot-claude",
            executor: "COPILOT",
            variant: "CLAUDE_OPUS_4_6",
            enabled: true,
            models: ["claude-opus-4.6"],
          },
          {
            name: "codex-backup",
            executor: "CODEX",
            variant: "DEFAULT",
            enabled: false,
            models: ["gpt-5.3-codex"],
          },
        ],
      },
    };

    vi.resetModules();
    const primaryAgent = await import("../primary-agent.mjs");

    const agents = primaryAgent.getAvailableAgents();
    const copilotClaude = agents.find((agent) => agent.id === "copilot-claude");
    const codexBackup = agents.find((agent) => agent.id === "codex-backup");

    expect(copilotClaude).toEqual(
      expect.objectContaining({
        available: true,
        adapterId: "copilot-sdk",
        models: ["claude-opus-4.6"],
      }),
    );
    expect(codexBackup).toEqual(
      expect.objectContaining({
        available: false,
        adapterId: "codex-sdk",
        models: ["gpt-5.3-codex"],
      }),
    );
  });

  it("switches by configured profile id and preserves selection id", async () => {
    mockConfigState.current = {
      primaryAgent: "codex-sdk",
      executorConfig: {
        executors: [
          {
            name: "copilot-claude",
            executor: "COPILOT",
            variant: "CLAUDE_OPUS_4_6",
            enabled: true,
            models: ["claude-opus-4.6"],
          },
        ],
      },
    };

    vi.resetModules();
    const primaryAgent = await import("../primary-agent.mjs");

    const switched = await primaryAgent.switchPrimaryAgent("copilot-claude");

    expect(switched.ok).toBe(true);
    expect(primaryAgent.getPrimaryAgentName()).toBe("copilot-sdk");
    expect(primaryAgent.getPrimaryAgentSelection()).toBe("copilot-claude");
  });

  it("maps GEMINI executor profiles to gemini-sdk adapter", async () => {
    mockConfigState.current = {
      primaryAgent: "codex-sdk",
      executorConfig: {
        executors: [
          {
            name: "gemini-default",
            executor: "GEMINI",
            variant: "DEFAULT",
            enabled: true,
            models: ["gemini-2.5-pro"],
          },
        ],
      },
    };

    vi.resetModules();
    const primaryAgent = await import("../primary-agent.mjs");
    const switched = await primaryAgent.switchPrimaryAgent("gemini-default");

    expect(switched.ok).toBe(true);
    expect(primaryAgent.getPrimaryAgentName()).toBe("gemini-sdk");
    expect(primaryAgent.getPrimaryAgentSelection()).toBe("gemini-default");
  });
});
