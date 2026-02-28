/**
 * primary-agent.mjs — Adapter that selects the primary agent implementation.
 *
 * Supports Codex SDK, Copilot SDK, and Claude SDK.
 * Includes timeout detection and automatic failover between adapters.
 */

import { loadConfig } from "./config.mjs";
import { ensureCodexConfig, printConfigSummary } from "./codex-config.mjs";
import { ensureRepoConfigs, printRepoConfigSummary } from "./repo-config.mjs";
import { resolveRepoRoot } from "./repo-root.mjs";
import { getSessionTracker } from "./session-tracker.mjs";
import { execPooledPrompt } from "./agent-pool.mjs";
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
import {
  execOpencodePrompt,
  steerOpencodePrompt,
  isOpencodeBusy,
  getSessionInfo as getOpencodeSessionInfo,
  resetSession as resetOpencodeSession,
  initOpencodeShell,
  getActiveSessionId as getOpencodeSessionId,
  listSessions as listOpencodeSessions,
  switchSession as switchOpencodeSession,
  createSession as createOpencodeSession,
} from "./opencode-shell.mjs";
import {
  execGeminiPrompt,
  steerGeminiPrompt,
  isGeminiBusy,
  getSessionInfo as getGeminiSessionInfo,
  resetSession as resetGeminiSession,
  initGeminiShell,
  getActiveSessionId as getGeminiSessionId,
  listSessions as listGeminiSessions,
  switchSession as switchGeminiSession,
  createSession as createGeminiSession,
} from "./gemini-shell.mjs";
import { getModelsForExecutor, normalizeExecutorKey } from "./task-complexity.mjs";

/** Valid agent interaction modes */
const VALID_MODES = ["ask", "agent", "plan"];

/** Current interaction mode — affects how prompts are framed */
let agentMode = "agent";

/**
 * Mode-specific prompt prefixes prepended to user messages.
 * - "ask"   → brief, direct answer without tool use
 * - "agent" → full agentic behavior (default, no prefix needed)
 * - "plan"  → create a plan but do not execute it
 */
const MODE_PREFIXES = {
  ask: "[MODE: ask] Respond briefly and directly. Avoid using tools unless absolutely necessary. Do not make code changes.\n\n",
  agent: "",
  plan: "[MODE: plan] Create a detailed plan for the following request but do NOT execute it. Outline the steps, files involved, and approach without making any changes.\n\n",
};

function normalizeAttachments(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(Boolean);
}

function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return "";
  const value = Number(bytes);
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(
    units.length - 1,
    Math.floor(Math.log(value) / Math.log(1024)),
  );
  const size = value / Math.pow(1024, idx);
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[idx]}`;
}

function formatAttachmentLine(attachment) {
  const name = attachment.name || attachment.filename || attachment.title || "attachment";
  const kind = attachment.kind ? ` (${attachment.kind})` : "";
  const sizeText = attachment.size ? `, ${formatBytes(attachment.size)}` : "";
  const location =
    attachment.filePath ||
    attachment.path ||
    attachment.url ||
    attachment.uri ||
    "";
  const suffix = location ? ` — ${location}` : "";
  return `- ${name}${kind}${sizeText}${suffix}`;
}

function appendAttachmentsToPrompt(message, attachments) {
  const list = normalizeAttachments(attachments);
  if (!list.length) return { message, appended: false };
  const lines = ["", "Attachments:", ...list.map(formatAttachmentLine)];
  return { message: `${message}${lines.join("\n")}`, appended: true };
}

const ADAPTERS = {
  "codex-sdk": {
    name: "codex-sdk",
    provider: "CODEX",
    displayName: "Codex",
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
    sdkCommands: ["/compact", "/status", "/context", "/mcp", "/model", "/clear"],
    /**
     * Forward an SDK-native command to the Codex shell.
     * /clear is handled specially as a reset; others are sent as user input.
     */
    execSdkCommand: async (command, args, options = {}) => {
      const cmd = command.startsWith("/") ? command : `/${command}`;
      if (cmd === "/clear") {
        await resetThread();
        return "Session cleared.";
      }
      const fullCmd = args ? `${cmd} ${args}` : cmd;
      return execCodexPrompt(fullCmd, {
        persistent: true,
        cwd: options.cwd,
        sessionId: options.sessionId || null,
      });
    },
  },
  "copilot-sdk": {
    name: "copilot-sdk",
    provider: "COPILOT",
    displayName: "Copilot",
    exec: (msg, opts) => execCopilotPrompt(msg, { persistent: true, ...opts }),
    steer: steerCopilotPrompt,
    isBusy: isCopilotBusy,
    getInfo: () => getCopilotSessionInfo(),
    reset: resetCopilotSession,
    init: async () => initCopilotShell(),
    sdkCommands: ["/status", "/model", "/clear"],
    execSdkCommand: async (command, args, options = {}) => {
      const cmd = command.startsWith("/") ? command : `/${command}`;
      if (cmd === "/clear") {
        await resetCopilotSession();
        return "Session cleared.";
      }
      const fullCmd = args ? `${cmd} ${args}` : cmd;
      return execCopilotPrompt(fullCmd, {
        persistent: true,
        cwd: options.cwd,
        sessionId: options.sessionId || null,
      });
    },
  },
  "claude-sdk": {
    name: "claude-sdk",
    provider: "CLAUDE",
    displayName: "Claude",
    exec: execClaudePrompt,
    steer: steerClaudePrompt,
    isBusy: isClaudeBusy,
    getInfo: () => getClaudeSessionInfo(),
    reset: resetClaudeSession,
    init: async () => {
      await initClaudeShell();
      return true;
    },
    sdkCommands: ["/compact", "/status", "/model", "/clear"],
    execSdkCommand: async (command, args, options = {}) => {
      const cmd = command.startsWith("/") ? command : `/${command}`;
      if (cmd === "/clear") {
        await resetClaudeSession();
        return "Session cleared.";
      }
      const fullCmd = args ? `${cmd} ${args}` : cmd;
      return execClaudePrompt(fullCmd, {
        cwd: options.cwd,
        sessionId: options.sessionId || null,
      });
    },
  },
  "gemini-sdk": {
    name: "gemini-sdk",
    provider: "GEMINI",
    displayName: "Gemini",
    exec: (msg, opts) => execGeminiPrompt(msg, { persistent: true, ...opts }),
    steer: steerGeminiPrompt,
    isBusy: isGeminiBusy,
    getInfo: () => getGeminiSessionInfo(),
    reset: resetGeminiSession,
    init: async () => initGeminiShell(),
    getSessionId: getGeminiSessionId,
    listSessions: listGeminiSessions,
    switchSession: switchGeminiSession,
    createSession: createGeminiSession,
    sdkCommands: ["/status", "/model", "/clear"],
    execSdkCommand: async (command, args, options = {}) => {
      const cmd = command.startsWith("/") ? command : `/${command}`;
      if (cmd === "/clear") {
        await resetGeminiSession();
        return "Session cleared.";
      }
      const fullCmd = args ? `${cmd} ${args}` : cmd;
      return execGeminiPrompt(fullCmd, {
        persistent: true,
        cwd: options.cwd,
        sessionId: options.sessionId || null,
      });
    },
  },
  "opencode-sdk": {
    name: "opencode-sdk",
    provider: "OPENCODE",
    displayName: "OpenCode",
    exec: (msg, opts) => execOpencodePrompt(msg, { persistent: true, ...opts }),
    steer: steerOpencodePrompt,
    isBusy: isOpencodeBusy,
    getInfo: () => getOpencodeSessionInfo(),
    reset: resetOpencodeSession,
    init: async () => {
      await initOpencodeShell();
      return true;
    },
    getSessionId: getOpencodeSessionId,
    listSessions: listOpencodeSessions,
    switchSession: switchOpencodeSession,
    createSession: createOpencodeSession,
    sdkCommands: ["/status", "/model", "/sessions", "/clear"],
    execSdkCommand: async (command, args, options = {}) => {
      const cmd = command.startsWith("/") ? command : `/${command}`;
      if (cmd === "/clear") {
        await resetOpencodeSession();
        return "Session cleared.";
      }
      const fullCmd = args ? `${cmd} ${args}` : cmd;
      return execOpencodePrompt(fullCmd, {
        persistent: true,
        cwd: options.cwd,
        sessionId: options.sessionId || null,
      });
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
let activeExecutorSelection = "codex-sdk";
let primaryProfile = null;
let primaryFallbackReason = null;
let initialized = false;

const CONFIG_WARNING_THROTTLE_MS = 5 * 60 * 1000;
const _configWarningCache = new Map();

function warnConfigIssueThrottled(key, message) {
  const now = Date.now();
  const prev = _configWarningCache.get(key) || 0;
  if (now - prev < CONFIG_WARNING_THROTTLE_MS) {
    return;
  }
  _configWarningCache.set(key, now);
  console.warn(message);
}

function normalizePrimarySdkName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/-sdk$/, "");
}

function ensurePrimaryAgentConfigs(primaryName) {
  const primarySdk = normalizePrimarySdkName(primaryName) || "codex";
  const allowRuntimeCodexMutation = envFlagEnabled(
    process.env.BOSUN_ALLOW_RUNTIME_GLOBAL_CODEX_MUTATION,
  );
  const vkBaseUrl = String(
    process.env.VK_BASE_URL ||
      `http://127.0.0.1:${process.env.VK_RECOVERY_PORT || "54089"}`,
  ).trim();
  const vkSelected =
    String(process.env.KANBAN_BACKEND || "").trim().toLowerCase() === "vk" ||
    ["vk", "hybrid"].includes(
      String(process.env.EXECUTOR_MODE || "").trim().toLowerCase(),
    );
  const includeWorkspaceVkMcp = vkSelected && vkBaseUrl.length > 0;
  let repoRoot = "";
  try {
    repoRoot = resolveRepoRoot();
  } catch {
    repoRoot = "";
  }

  if (repoRoot) {
    if (!process.env.REPO_ROOT) process.env.REPO_ROOT = repoRoot;
    if (!process.env.BOSUN_AGENT_REPO_ROOT) {
      process.env.BOSUN_AGENT_REPO_ROOT = repoRoot;
    }
    try {
      const repoResult = ensureRepoConfigs(repoRoot, {
        primarySdk,
        vkBaseUrl,
        skipVk: !includeWorkspaceVkMcp,
      });
      const logLines = [];
      printRepoConfigSummary(repoResult, (msg) => logLines.push(msg));
      if (logLines.some((line) => line.includes("created") || line.includes("updated"))) {
        console.log("[primary-agent] Repo config refresh:");
        for (const line of logLines) console.log(`[primary-agent] ${line}`);
      }
    } catch (err) {
      warnConfigIssueThrottled(
        `repo-config:${repoRoot}`,
        `[primary-agent] failed to ensure repo config for ${repoRoot}: ${err?.message || err}`,
      );
    }
  }

  try {
    const codexResult = ensureCodexConfig({
      env: process.env,
      primarySdk,
      skipVk: true,
      dryRun: !allowRuntimeCodexMutation,
    });
    if (!codexResult?.noChanges) {
      if (!allowRuntimeCodexMutation) {
        console.log(
          "[primary-agent] Codex config drift detected (runtime is read-only; run `node cli.mjs --setup` to apply).",
        );
      } else {
        console.log("[primary-agent] Codex config refresh:");
      }
      printConfigSummary(codexResult, (msg) => console.log(`[primary-agent] ${msg}`));
    }
  } catch (err) {
    warnConfigIssueThrottled(
      "codex-config",
      `[primary-agent] failed to ensure Codex config: ${err?.message || err}`,
    );
  }
}

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
  if (["gemini", "gemini-sdk", "google-gemini"].includes(raw))
    return "gemini-sdk";
  if (["opencode", "opencode-sdk", "open-code"].includes(raw))
    return "opencode-sdk";
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
  const key = normalizeExecutorKey(executor);
  if (key === "copilot") return "copilot-sdk";
  if (key === "claude") return "claude-sdk";
  if (key === "gemini") return "gemini-sdk";
  if (key === "opencode") return "opencode-sdk";
  return "codex-sdk";
}

function readAdapterBusy(adapter) {
  try {
    return adapter.isBusy();
  } catch {
    return false;
  }
}

function getAdapterCapabilities(adapter) {
  return {
    sessions: typeof adapter.listSessions === "function",
    steering: typeof adapter.steer === "function",
    sdkCommands: adapter.sdkCommands || [],
  };
}

function resolveAgentSelection(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  const normalized = normalizePrimaryAgent(raw);
  if (ADAPTERS[normalized]) {
    return { adapterName: normalized, selectionId: normalized };
  }

  const configured = getAvailableAgents();
  const match = configured.find((agent) => agent.id === raw);
  if (!match) return null;
  const adapterName = normalizePrimaryAgent(
    match.adapterId || executorToAdapter(match.executor || match.provider),
  );
  if (!ADAPTERS[adapterName]) return null;
  return { adapterName, selectionId: match.id };
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
  const resolved = resolveAgentSelection(name);
  if (resolved) {
    activeAdapter = ADAPTERS[resolved.adapterName] || ADAPTERS["codex-sdk"];
    activeExecutorSelection =
      resolved.selectionId || activeAdapter.name || "codex-sdk";
    return activeAdapter.name;
  }

  const normalized = normalizePrimaryAgent(name);
  const adapterName = ADAPTERS[normalized] ? normalized : "codex-sdk";
  activeAdapter = ADAPTERS[adapterName] || ADAPTERS["codex-sdk"];
  activeExecutorSelection = adapterName;
  return activeAdapter.name;
}

export function getPrimaryAgentName() {
  return activeAdapter?.name || "codex-sdk";
}

export function getPrimaryAgentSelection() {
  return activeExecutorSelection || getPrimaryAgentName();
}

export async function switchPrimaryAgent(name) {
  const target = resolveAgentSelection(name);
  if (!target) {
    return { ok: false, reason: "unknown_agent" };
  }
  activeAdapter = ADAPTERS[target.adapterName];
  activeExecutorSelection = target.selectionId || target.adapterName;
  primaryFallbackReason = null;
  initialized = false;
  try {
    await initPrimaryAgent(target.selectionId || target.adapterName);
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
    primaryProfile?.name &&
    (activeExecutorSelection === activeAdapter.name || !activeExecutorSelection)
  ) {
    activeExecutorSelection = String(primaryProfile.name).trim() || activeAdapter.name;
  }

  if (
    activeAdapter.name === "codex-sdk" &&
    envFlagEnabled(process.env.CODEX_SDK_DISABLED)
  ) {
    primaryFallbackReason = "Codex SDK disabled — attempting fallback";
    if (!envFlagEnabled(process.env.COPILOT_SDK_DISABLED)) {
      setPrimaryAgent("copilot-sdk");
    } else if (!envFlagEnabled(process.env.CLAUDE_SDK_DISABLED)) {
      setPrimaryAgent("claude-sdk");
    } else if (!envFlagEnabled(process.env.GEMINI_SDK_DISABLED)) {
      setPrimaryAgent("gemini-sdk");
    } else if (!envFlagEnabled(process.env.OPENCODE_SDK_DISABLED)) {
      setPrimaryAgent("opencode-sdk");
    }
  }

  if (
    activeAdapter.name === "claude-sdk" &&
    envFlagEnabled(process.env.CLAUDE_SDK_DISABLED)
  ) {
    primaryFallbackReason = "Claude SDK disabled — falling back to Codex";
    setPrimaryAgent("codex-sdk");
  }

  if (
    activeAdapter.name === "gemini-sdk" &&
    envFlagEnabled(process.env.GEMINI_SDK_DISABLED)
  ) {
    primaryFallbackReason = "Gemini SDK disabled — falling back to Codex";
    setPrimaryAgent("codex-sdk");
  }

  if (
    activeAdapter.name === "opencode-sdk" &&
    envFlagEnabled(process.env.OPENCODE_SDK_DISABLED)
  ) {
    primaryFallbackReason = "OpenCode SDK disabled — falling back to Codex";
    setPrimaryAgent("codex-sdk");
  }

  ensurePrimaryAgentConfigs(activeAdapter.name);

  const ok = await activeAdapter.init();
  if (activeAdapter.name === "copilot-sdk" && ok === false) {
    primaryFallbackReason = "Copilot SDK unavailable — falling back to Codex";
    setPrimaryAgent("codex-sdk");
    ensurePrimaryAgentConfigs(activeAdapter.name);
    await activeAdapter.init();
  }
  if (activeAdapter.name === "gemini-sdk" && ok === false) {
    primaryFallbackReason = "Gemini SDK unavailable — falling back to Codex";
    setPrimaryAgent("codex-sdk");
    ensurePrimaryAgentConfigs(activeAdapter.name);
    await activeAdapter.init();
  }
  if (activeAdapter.name === "opencode-sdk" && ok === false) {
    primaryFallbackReason = "OpenCode SDK unavailable — falling back to Codex";
    setPrimaryAgent("codex-sdk");
    ensurePrimaryAgentConfigs(activeAdapter.name);
    await activeAdapter.init();
  }

  initialized = true;
  return getPrimaryAgentName();
}

/** Default timeout for primary agent execution (45 minutes — agents may work for extended periods) */
const PRIMARY_EXEC_TIMEOUT_MS = Number(process.env.PRIMARY_AGENT_TIMEOUT_MS) || 45 * 60 * 1000;

/** Maximum number of failover attempts across adapters */
const MAX_FAILOVER_ATTEMPTS = 2;

/** Ordered fallback chain — if the current adapter times out, try the next */
const FALLBACK_ORDER = [
  "codex-sdk",
  "copilot-sdk",
  "claude-sdk",
  "gemini-sdk",
  "opencode-sdk",
];

function mapAdapterToPoolSdk(adapterName) {
  const normalized = String(adapterName || "").trim().toLowerCase();
  if (normalized === "copilot-sdk") return "copilot";
  if (normalized === "claude-sdk") return "claude";
  return "codex";
}

function shouldUseIsolatedPoolExecution(adapter, options = {}) {
  if (options.forceIsolated === true) return true;
  if (options.allowConcurrent === false) return false;
  if (!adapter || typeof adapter.isBusy !== "function") return false;
  if (!adapter.isBusy()) return false;

  const requestedSessionId = options.sessionId
    ? String(options.sessionId)
    : "";
  let activeSessionId = "";
  try {
    const info = adapter.getInfo ? adapter.getInfo() : null;
    activeSessionId = String(info?.sessionId || info?.threadId || "");
  } catch {
    activeSessionId = "";
  }

  if (!requestedSessionId || !activeSessionId) return true;
  return requestedSessionId !== activeSessionId;
}

/**
 * Wrap a promise with a timeout. Rejects with a clear error when exceeded.
 * If an AbortController is provided, it will be signalled on timeout so the
 * underlying agent session can clean up (reset activeTurn, unsubscribe, etc.).
 */
function withTimeout(promise, ms, label = "operation", abortController = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (abortController && !abortController.signal.aborted) {
        try { abortController.abort("timeout"); } catch { /* best effort */ }
      }
      reject(new Error(`AGENT_TIMEOUT: ${label} did not respond within ${ms / 1000}s`));
    }, ms);
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
  const attachments = normalizeAttachments(options.attachments);
  const attachmentsAppended = options.attachmentsAppended === true;

  // Apply mode prefix (options.mode overrides the global setting for this call)
  const effectiveMode = options.mode || agentMode;
  const modePrefix = MODE_PREFIXES[effectiveMode] || "";
  const messageWithAttachments = attachments.length && !attachmentsAppended
    ? appendAttachmentsToPrompt(userMessage, attachments).message
    : userMessage;
  const framedMessage = modePrefix ? modePrefix + messageWithAttachments : messageWithAttachments;

  // Record user message (original, without mode prefix)
  tracker.recordEvent(sessionId, {
    role: "user",
    content: userMessage,
    attachments: attachments.length ? attachments : undefined,
    timestamp: new Date().toISOString(),
    _sessionType: sessionType,
    _mode: effectiveMode,
  });

  if (shouldUseIsolatedPoolExecution(activeAdapter, options)) {
    const pooled = await execPooledPrompt(framedMessage, {
      timeoutMs,
      onEvent: options.onEvent,
      abortController: options.abortController,
      cwd: options.cwd,
      model: options.model,
      sdk: mapAdapterToPoolSdk(activeAdapter.name),
    });
    const pooledText =
      typeof pooled === "string"
        ? pooled
        : pooled?.finalResponse || pooled?.text || pooled?.message || JSON.stringify(pooled);
    tracker.recordEvent(sessionId, {
      role: "assistant",
      content: pooledText,
      timestamp: new Date().toISOString(),
      _sessionType: sessionType,
    });
    return pooled;
  }

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
        `[primary-agent] :alert: Failing over from ${adaptersToTry[attempt - 1]} to ${adapterName} (reason: ${lastError?.message || "unknown"})`,
      );
      tracker.recordEvent(sessionId, {
        role: "system",
        type: "failover",
        content: `:alert: Agent "${adaptersToTry[attempt - 1]}" failed — switching to "${adapterName}": ${lastError?.message || "timeout/error"}`,
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
      // Create an AbortController so withTimeout can signal the adapter to
      // cancel its in-flight work (reset activeTurn, unsubscribe events, etc.).
      // If the caller already provided an AbortController, forward its abort
      // to our timeout controller so both caller-initiated and timeout aborts work.
      const timeoutAbort = new AbortController();
      if (options.abortController?.signal) {
        const callerSignal = options.abortController.signal;
        if (callerSignal.aborted) {
          timeoutAbort.abort(callerSignal.reason);
        } else {
          callerSignal.addEventListener("abort", () => {
            timeoutAbort.abort(callerSignal.reason || "user_stop");
          }, { once: true });
        }
      }
      const result = await withTimeout(
        adapter.exec(framedMessage, { ...options, sessionId, abortController: timeoutAbort }),
        timeoutMs,
        `${adapterName}.exec`,
        timeoutAbort,
      );

      if (result) {
        // Extract human-readable text from structured responses
        const text = typeof result === "string"
          ? result
          : result.finalResponse || result.text || result.message || JSON.stringify(result);
        tracker.recordEvent(sessionId, {
          role: "assistant",
          content: text,
          timestamp: new Date().toISOString(),
          _sessionType: sessionType,
        });
      }
      return result;
    } catch (err) {
      lastError = err;
      const isTimeout = err.message?.startsWith("AGENT_TIMEOUT");
      console.error(
        `[primary-agent] ${isTimeout ? ":clock: Timeout" : ":close: Error"} with ${adapterName}: ${err.message}`,
      );

      // If this is the last adapter, report to user
      if (attempt >= Math.min(adaptersToTry.length, MAX_FAILOVER_ATTEMPTS + 1) - 1) {
        tracker.recordEvent(sessionId, {
          role: "system",
          type: "error",
          content: isTimeout
            ? `:clock: All agents timed out. The AI service may be experiencing issues. Your message was saved — please try again shortly.`
            : `:close: Agent error: ${err.message}. Your message was saved — please try again.`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // All adapters failed
  return {
    finalResponse: `:close: All agent adapters failed. Last error: ${lastError?.message || "unknown"}`,
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
    selectionId: activeExecutorSelection || activeAdapter.name,
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

// ── Agent mode & SDK command API ─────────────────────────────────────────────

/**
 * Get the current interaction mode ("ask" | "agent" | "plan").
 * @returns {string}
 */
export function getAgentMode() {
  return agentMode;
}

/**
 * Set the interaction mode.
 * @param {"ask"|"agent"|"plan"} mode
 * @returns {{ ok: boolean, mode: string, error?: string }}
 */
export function setAgentMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (!VALID_MODES.includes(normalized)) {
    return { ok: false, mode: agentMode, error: `Invalid mode "${mode}". Valid: ${VALID_MODES.join(", ")}` };
  }
  agentMode = normalized;
  return { ok: true, mode: agentMode };
}

/**
 * Build the full prompt with mode prefix applied.
 * @param {string} userMessage
 * @returns {string}
 */
export function applyModePrefix(userMessage) {
  const prefix = MODE_PREFIXES[agentMode] || "";
  return prefix ? prefix + userMessage : userMessage;
}

/**
 * Get the list of available agent adapters with capabilities.
 * @returns {Array<{id:string, name:string, provider:string, available:boolean, busy:boolean, capabilities:object}>}
 */
export function getAvailableAgents() {
  let configExecutors = [];
  try {
    const cfg = loadConfig();
    configExecutors = Array.isArray(cfg?.executorConfig?.executors)
      ? cfg.executorConfig.executors
      : [];
  } catch {
    configExecutors = [];
  }

  if (configExecutors.length > 0) {
    return configExecutors.map((entry, index) => {
      const adapterId = executorToAdapter(entry?.executor);
      const adapter = ADAPTERS[adapterId] || ADAPTERS["codex-sdk"];
      const envDisabledKey = `${adapterId.replace("-sdk", "").toUpperCase()}_SDK_DISABLED`;
      const sdkDisabled = envFlagEnabled(process.env[envDisabledKey]);
      const profileEnabled = entry?.enabled !== false;
      const configuredModels = Array.isArray(entry?.models)
        ? entry.models
            .map((model) => String(model || "").trim())
            .filter(Boolean)
        : [];
      const models = configuredModels.length > 0
        ? configuredModels
        : getModelsForExecutor(entry?.executor || adapter.provider);
      const name = String(entry?.name || "").trim() || adapter.displayName || adapter.name;
      return {
        id: name || `${adapterId}-${index + 1}`,
        name,
        provider: adapter.provider,
        executor: String(entry?.executor || "").toUpperCase() || adapter.provider,
        variant: String(entry?.variant || "DEFAULT"),
        adapterId,
        available: profileEnabled && !sdkDisabled,
        busy: profileEnabled && !sdkDisabled ? readAdapterBusy(adapter) : false,
        models,
        capabilities: getAdapterCapabilities(adapter),
      };
    });
  }

  return Object.entries(ADAPTERS).map(([id, adapter]) => {
    const envDisabledKey = `${id.replace("-sdk", "").toUpperCase()}_SDK_DISABLED`;
    const disabled = envFlagEnabled(process.env[envDisabledKey]);
    return {
      id,
      name: adapter.displayName || adapter.name,
      provider: adapter.provider,
      executor: adapter.provider,
      variant: "DEFAULT",
      adapterId: id,
      available: !disabled,
      busy: readAdapterBusy(adapter),
      models: getModelsForExecutor(adapter.provider), // use provider ("CODEX"/"COPILOT"/"CLAUDE") — always in the alias map
      capabilities: getAdapterCapabilities(adapter),
    };
  });
}

/**
 * Get the list of SDK commands supported by a specific adapter (or the active one).
 * @param {string} [adapterName]
 * @returns {string[]}
 */
export function getSdkCommands(adapterName) {
  const adapter = adapterName ? ADAPTERS[adapterName] : activeAdapter;
  return adapter?.sdkCommands || [];
}

/**
 * Forward an SDK-native command to the active (or specified) adapter.
 * @param {string} command  — e.g. "/compact", "/model"
 * @param {string} [args]   — optional arguments string
 * @param {string} [adapterName] — target adapter (defaults to active)
 * @param {object} [options] — execution overrides (e.g. cwd/sessionId)
 * @returns {Promise<string|object>}
 */
export async function execSdkCommand(command, args = "", adapterName, options = {}) {
  const adapter = adapterName ? ADAPTERS[adapterName] : activeAdapter;
  if (!adapter) {
    throw new Error(`Unknown adapter: ${adapterName || "(none)"}`);
  }
  const cmd = command.startsWith("/") ? command : `/${command}`;
  if (!adapter.sdkCommands?.includes(cmd) && cmd !== "/clear") {
    throw new Error(`Command "${cmd}" not supported by ${adapter.name}. Supported: ${(adapter.sdkCommands || []).join(", ")}`);
  }
  if (typeof adapter.execSdkCommand !== "function") {
    throw new Error(`Adapter ${adapter.name} does not support SDK commands.`);
  }
  return adapter.execSdkCommand(cmd, args, options);
}
