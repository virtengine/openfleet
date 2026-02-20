/**
 * primary-agent.mjs — Adapter that selects the primary agent implementation.
 *
 * Supports Codex SDK, Copilot SDK, and Claude SDK.
 * Includes timeout detection and automatic failover between adapters.
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

/** Default timeout for primary agent execution (2 minutes for interactive use) */
const PRIMARY_EXEC_TIMEOUT_MS = Number(process.env.PRIMARY_AGENT_TIMEOUT_MS) || 2 * 60 * 1000;

/** Maximum number of failover attempts across adapters */
const MAX_FAILOVER_ATTEMPTS = 2;

/** Ordered fallback chain — if the current adapter times out, try the next */
const FALLBACK_ORDER = ["codex-sdk", "copilot-sdk", "claude-sdk"];

/**
 * Wrap a promise with a timeout. Rejects with a clear error when exceeded.
 */
function withTimeout(promise, ms, label = "operation") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`AGENT_TIMEOUT: ${label} did not respond within ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export async function execPrimaryPrompt(userMessage, options = {}) {
  if (!initialized) {
    await initPrimaryAgent();
  }
  const sessionId =
    (options && options.sessionId ? String(options.sessionId) : "") ||
    `primary-${activeAdapter.name}`;
  const sessionType =
    (options && options.sessionType ? String(options.sessionType) : "") ||
    "primary";
  const timeoutMs = options.timeoutMs || PRIMARY_EXEC_TIMEOUT_MS;
  const tracker = getSessionTracker();

  // Record user message
  tracker.recordEvent(sessionId, {
    role: "user",
    content: userMessage,
    timestamp: new Date().toISOString(),
    _sessionType: sessionType,
  });

  // Build ordered list of adapters to try: current first, then fallbacks
  const adaptersToTry = [activeAdapter.name];
  for (const name of FALLBACK_ORDER) {
    if (name !== activeAdapter.name && ADAPTERS[name]) {
      const envDisabledKey = `${name.replace("-sdk", "").toUpperCase()}_SDK_DISABLED`;
      if (!envFlagEnabled(process.env[envDisabledKey])) {
        adaptersToTry.push(name);
      }
    }
  }

  let lastError = null;

  for (let attempt = 0; attempt < Math.min(adaptersToTry.length, MAX_FAILOVER_ATTEMPTS + 1); attempt++) {
    const adapterName = adaptersToTry[attempt];
    const adapter = ADAPTERS[adapterName];
    if (!adapter) continue;

    // If failing over to a different adapter, switch and init
    if (attempt > 0) {
      console.warn(
        `[primary-agent] ⚠️ Failing over from ${adaptersToTry[attempt - 1]} to ${adapterName} (reason: ${lastError?.message || "unknown"})`,
      );
      tracker.recordEvent(sessionId, {
        role: "system",
        type: "failover",
        content: `⚠️ Agent "${adaptersToTry[attempt - 1]}" failed — switching to "${adapterName}": ${lastError?.message || "timeout/error"}`,
        timestamp: new Date().toISOString(),
      });
      setPrimaryAgent(adapterName);
      primaryFallbackReason = `Failover from ${adaptersToTry[attempt - 1]}: ${lastError?.message || "timeout"}`;
      try {
        await adapter.init();
      } catch (initErr) {
        console.error(`[primary-agent] Failed to init ${adapterName}:`, initErr.message);
        lastError = initErr;
        continue;
      }
    }

    try {
      const result = await withTimeout(
        adapter.exec(userMessage, { ...options, sessionId }),
        timeoutMs,
        `${adapterName}.exec`,
      );

      if (result) {
        tracker.recordEvent(sessionId, {
          role: "assistant",
          content: typeof result === "string" ? result : JSON.stringify(result),
          timestamp: new Date().toISOString(),
          _sessionType: sessionType,
        });
      }
      return result;
    } catch (err) {
      lastError = err;
      const isTimeout = err.message?.startsWith("AGENT_TIMEOUT");
      console.error(
        `[primary-agent] ${isTimeout ? "⏱️ Timeout" : "❌ Error"} with ${adapterName}: ${err.message}`,
      );

      // If this is the last adapter, report to user
      if (attempt >= Math.min(adaptersToTry.length, MAX_FAILOVER_ATTEMPTS + 1) - 1) {
        tracker.recordEvent(sessionId, {
          role: "system",
          type: "error",
          content: isTimeout
            ? `⏱️ All agents timed out. The AI service may be experiencing issues. Your message was saved — please try again shortly.`
            : `❌ Agent error: ${err.message}. Your message was saved — please try again.`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // All adapters failed
  return {
    finalResponse: `❌ All agent adapters failed. Last error: ${lastError?.message || "unknown"}`,
    items: [],
    usage: null,
  };
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
