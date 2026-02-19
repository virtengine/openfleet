/**
 * primary-agent.mjs — Adapter that selects the primary agent implementation.
 *
 * Supports Codex SDK, Copilot SDK, and Claude SDK.
 */

import { loadConfig } from "./config.mjs";
import { getSessionTracker } from "./session-tracker.mjs";
import {
  execCodexPrompt,
  steerCodexPrompt,
  isCodexBusy,
  getThreadInfo,
  resetThread,
  initCodexShell,
  getActiveSessionId as getCodexSessionId,
  listSessions as listCodexSessions,
  switchSession as switchCodexSession,
  createSession as createCodexSession,
} from "./codex-shell.mjs";
import {
  execCopilotPrompt,
  steerCopilotPrompt,
  isCopilotBusy,
  getSessionInfo as getCopilotSessionInfo,
  resetSession as resetCopilotSession,
  initCopilotShell,
} from "./copilot-shell.mjs";
import {
  execClaudePrompt,
  steerClaudePrompt,
  isClaudeBusy,
  getSessionInfo as getClaudeSessionInfo,
  resetClaudeSession,
  initClaudeShell,
} from "./claude-shell.mjs";

const ADAPTERS = {
  "codex-sdk": {
    name: "codex-sdk",
    provider: "CODEX",
    exec: (msg, opts) => execCodexPrompt(msg, { persistent: true, ...opts }),
    steer: steerCodexPrompt,
    isBusy: isCodexBusy,
    getInfo: () => {
      const info = getThreadInfo();
      return { ...info, sessionId: info.sessionId || info.threadId };
    },
    reset: resetThread,
    init: async () => {
      await initCodexShell();
      return true;
    },
    getSessionId: getCodexSessionId,
    listSessions: listCodexSessions,
    switchSession: switchCodexSession,
    createSession: createCodexSession,
  },
  "copilot-sdk": {
    name: "copilot-sdk",
    provider: "COPILOT",
    exec: (msg, opts) => execCopilotPrompt(msg, { persistent: true, ...opts }),
    steer: steerCopilotPrompt,
    isBusy: isCopilotBusy,
    getInfo: () => getCopilotSessionInfo(),
    reset: resetCopilotSession,
    init: async () => initCopilotShell(),
  },
  "claude-sdk": {
    name: "claude-sdk",
    provider: "CLAUDE",
    exec: execClaudePrompt,
    steer: steerClaudePrompt,
    isBusy: isClaudeBusy,
    getInfo: () => getClaudeSessionInfo(),
    reset: resetClaudeSession,
    init: async () => {
      await initClaudeShell();
      return true;
    },
  },
};

function envFlagEnabled(value) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on", "y"].includes(raw);
}

let activeAdapter = ADAPTERS["codex-sdk"];
let primaryProfile = null;
let primaryFallbackReason = null;
let initialized = false;

function normalizePrimaryAgent(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return "codex-sdk";
  if (["codex", "codex-sdk"].includes(raw)) return "codex-sdk";
  if (["copilot", "copilot-sdk", "github-copilot"].includes(raw))
    return "copilot-sdk";
  if (["claude", "claude-sdk", "claude_code", "claude-code"].includes(raw))
    return "claude-sdk";
  return raw;
}

function selectPrimaryExecutor(config) {
  const executors = config?.executorConfig?.executors || [];
  if (!executors.length) return null;
  const primary = executors.find(
    (e) => (e.role || "").toLowerCase() === "primary",
  );
  return primary || executors[0];
}

function executorToAdapter(executor) {
  if (!executor) return null;
  const normalized = String(executor).toUpperCase();
  if (normalized === "COPILOT") return "copilot-sdk";
  if (normalized === "CLAUDE") return "claude-sdk";
  return "codex-sdk";
}

function resolvePrimaryAgent(nameOrConfig) {
  if (typeof nameOrConfig === "string" && nameOrConfig.trim()) {
    return normalizePrimaryAgent(nameOrConfig);
  }
  if (nameOrConfig && typeof nameOrConfig === "object") {
    const direct = normalizePrimaryAgent(nameOrConfig.primaryAgent);
    if (direct) return direct;
  }
  if (process.env.PRIMARY_AGENT || process.env.PRIMARY_AGENT_SDK) {
    return normalizePrimaryAgent(
      process.env.PRIMARY_AGENT || process.env.PRIMARY_AGENT_SDK,
    );
  }
  const cfg = loadConfig();
  const direct = normalizePrimaryAgent(cfg?.primaryAgent || "");
  if (direct) return direct;
  primaryProfile = selectPrimaryExecutor(cfg);
  const mapped = executorToAdapter(primaryProfile?.executor);
  return mapped || "codex-sdk";
}

export function setPrimaryAgent(name) {
  const normalized = normalizePrimaryAgent(name);
  activeAdapter = ADAPTERS[normalized] || ADAPTERS["codex-sdk"];
  return activeAdapter.name;
}

export function getPrimaryAgentName() {
  return activeAdapter?.name || "codex-sdk";
}

export async function switchPrimaryAgent(name) {
  const normalized = normalizePrimaryAgent(name);
  if (!ADAPTERS[normalized]) {
    return { ok: false, reason: "unknown_agent" };
  }
  activeAdapter = ADAPTERS[normalized];
  primaryFallbackReason = null;
  initialized = false;
  try {
    await initPrimaryAgent(normalized);
    return { ok: true, name: getPrimaryAgentName() };
  } catch (err) {
    return { ok: false, reason: err?.message || "init_failed" };
  }
}

export async function initPrimaryAgent(nameOrConfig = null) {
  if (initialized) return getPrimaryAgentName();
  const desired = resolvePrimaryAgent(nameOrConfig);
  setPrimaryAgent(desired);

  if (
    activeAdapter.name === "codex-sdk" &&
    envFlagEnabled(process.env.CODEX_SDK_DISABLED)
  ) {
    primaryFallbackReason = "Codex SDK disabled — attempting fallback";
    if (!envFlagEnabled(process.env.COPILOT_SDK_DISABLED)) {
      setPrimaryAgent("copilot-sdk");
    } else if (!envFlagEnabled(process.env.CLAUDE_SDK_DISABLED)) {
      setPrimaryAgent("claude-sdk");
    }
  }

  if (
    activeAdapter.name === "claude-sdk" &&
    envFlagEnabled(process.env.CLAUDE_SDK_DISABLED)
  ) {
    primaryFallbackReason = "Claude SDK disabled — falling back to Codex";
    setPrimaryAgent("codex-sdk");
  }

  const ok = await activeAdapter.init();
  if (activeAdapter.name === "copilot-sdk" && ok === false) {
    primaryFallbackReason = "Copilot SDK unavailable — falling back to Codex";
    setPrimaryAgent("codex-sdk");
    await activeAdapter.init();
  }

  initialized = true;
  return getPrimaryAgentName();
}

export async function execPrimaryPrompt(userMessage, options = {}) {
  if (!initialized) {
    await initPrimaryAgent();
  }
  const sessionId = `primary-${activeAdapter.name}`;
  const tracker = getSessionTracker();
  tracker.recordEvent(sessionId, {
    role: "user",
    content: userMessage,
    timestamp: new Date().toISOString(),
    _sessionType: "primary",
  });
  const result = await activeAdapter.exec(userMessage, options);
  if (result) {
    tracker.recordEvent(sessionId, {
      role: "assistant",
      content: typeof result === "string" ? result : JSON.stringify(result),
      timestamp: new Date().toISOString(),
      _sessionType: "primary",
    });
  }
  return result;
}

export async function steerPrimaryPrompt(message) {
  if (!initialized) {
    await initPrimaryAgent();
  }
  return activeAdapter.steer(message);
}

export function isPrimaryBusy() {
  return activeAdapter.isBusy();
}

export function getPrimaryAgentInfo() {
  const info = activeAdapter.getInfo ? activeAdapter.getInfo() : {};
  return {
    adapter: activeAdapter.name,
    provider: activeAdapter.provider,
    profile: primaryProfile,
    fallbackReason: primaryFallbackReason,
    sessionId: info.sessionId || info.threadId || null,
    threadId: info.threadId || null,
    turnCount: info.turnCount || 0,
    isActive: !!info.isActive,
    isBusy: !!info.isBusy,
  };
}

export async function resetPrimaryAgent() {
  if (!initialized) {
    await initPrimaryAgent();
  }
  if (activeAdapter.reset) {
    await activeAdapter.reset();
  }
}

export function getPrimarySessionId() {
  return activeAdapter.getSessionId ? activeAdapter.getSessionId() : null;
}

export async function listPrimarySessions() {
  return activeAdapter.listSessions ? activeAdapter.listSessions() : [];
}

export async function switchPrimarySession(id) {
  return activeAdapter.switchSession ? activeAdapter.switchSession(id) : undefined;
}

export async function createPrimarySession(id) {
  return activeAdapter.createSession ? activeAdapter.createSession(id) : undefined;
}
