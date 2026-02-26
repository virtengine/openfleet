import { describe, it, expect, beforeEach, vi } from "vitest";

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
const mockExecPooledPrompt = vi.hoisted(() => vi.fn(async () => ({ finalResponse: "pooled-ok", items: [] })));

vi.mock("../config.mjs", () => ({
  loadConfig: () => ({ primaryAgent: "codex-sdk" }),
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

vi.mock("../agent-pool.mjs", () => ({
  execPooledPrompt: mockExecPooledPrompt,
}));

describe("primary-agent runtime safeguards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BOSUN_ALLOW_RUNTIME_GLOBAL_CODEX_MUTATION;
    mockIsCodexBusy.mockReturnValue(false);
    mockGetThreadInfo.mockReturnValue({
      sessionId: "active-codex-session",
      threadId: "thread-1",
      isBusy: false,
    });
  });

  it("uses dryRun codex config checks at runtime by default", async () => {
    vi.resetModules();
    const primaryAgent = await import("../scripts/bosun/agents/primary-agent.mjs"");

    await primaryAgent.initPrimaryAgent("codex-sdk");

    expect(mockEnsureCodexConfig).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  it("falls back to pooled execution when active adapter is busy on another session", async () => {
    vi.resetModules();
    const primaryAgent = await import("../scripts/bosun/agents/primary-agent.mjs"");
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
});
