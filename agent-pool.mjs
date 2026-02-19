/**
 * agent-pool.mjs — Universal SDK-Aware Ephemeral Agent Pool
 *
 * WHY THIS EXISTS:
 * ────────────────
 * The primary agent in monitor.mjs is a long-lived singleton thread.
 * Every operation that calls `execPrimaryPrompt` serialises behind that single
 * thread — task attempts, conflict resolution, follow-ups, and health-checks
 * all compete for the same lock.  Under load (or when a single prompt is
 * slow) this creates a bottleneck that stalls the entire monitor pipeline.
 *
 * This module provides **ephemeral, per-operation SDK threads** that spin up
 * on demand and tear down after a single prompt completes.  Each call gets its
 * own isolated thread, so multiple operations can run concurrently without
 * blocking each other.
 *
 * MULTI-SDK SUPPORT:
 * ──────────────────
 * The pool dynamically selects the correct SDK adapter (Codex, Copilot, or
 * Claude) based on configuration.  Resolution order:
 *   1. `AGENT_POOL_SDK` env var (explicit override)
 *   2. `PRIMARY_AGENT` env var → maps to SDK
 *   3. `loadConfig().agentPool.sdk` from `openfleet.config.json`
 *   4. Fallback chain through available SDKs
 *
 * EXPORTS:
 *   launchEphemeralThread(prompt, cwd, timeoutMs, extra?)
 *     → Low-level: spawns a fresh SDK thread, runs one prompt,
 *       returns { success, output, items, error, sdk }.
 *
 *   execPooledPrompt(userMessage, options?)
 *     → High-level: matches the execPrimaryPrompt signature
 *       ({ finalResponse, items, usage }) so callers in monitor.mjs can
 *       swap in without changing surrounding code.
 *
 *   getPoolSdkName()     → returns current pool SDK name
 *   setPoolSdk(name)     → override pool SDK at runtime
 *   resetPoolSdkCache()  → force re-resolution
 *   getAvailableSdks()   → returns list of non-disabled SDKs
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { resolveRepoRoot } from "./repo-root.mjs";
import { resolveCodexProfileRuntime } from "./codex-model-profiles.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Repository root for the active workspace */
const REPO_ROOT = resolveRepoRoot();

/** Default timeout: 6 hours — agents should run until the stream-based watchdog detects real issues */
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Hard timeout buffer: added on top of the soft timeout.
 * If the SDK's async iterator ignores the AbortSignal, this hard timeout
 * forcibly breaks the Promise.race to prevent infinite hangs.
 */
const HARD_TIMEOUT_BUFFER_MS = 5 * 60_000; // 5 minutes

/** Tag for console logging */
const TAG = "[agent-pool]";

function envFlagEnabled(value) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on", "y"].includes(raw);
}

function shouldAutoApproveCopilotPermissions() {
  const raw = process.env.COPILOT_AUTO_APPROVE_PERMISSIONS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return true;
  }
  return envFlagEnabled(raw);
}

function buildCopilotPermissionHandler() {
  if (!shouldAutoApproveCopilotPermissions()) return undefined;
  return async () => ({ kind: "approved" });
}

function shouldFallbackForSdkError(error) {
  if (!error) return false;
  const message = String(error).toLowerCase();
  if (!message) return false;
  if (message.includes("not available")) return true;
  if (message.includes("missing finish_reason")) return true;
  if (message.includes("missing") && message.includes("finish_reason")) return true;
  return false;
}

const OPENAI_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
];

async function withSanitizedOpenAiEnv(fn) {
  const saved = {};
  for (const key of OPENAI_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

/**
 * Build Codex SDK constructor options with Azure auto-detection.
 * When OPENAI_BASE_URL points to Azure, configures the SDK with Azure
 * provider settings via `config` and maps the API key via `env`.
 * Otherwise strips OPENAI_BASE_URL so the SDK uses its default auth.
 */
function buildCodexSdkOptions() {
  const { env: resolvedEnv } = resolveCodexProfileRuntime(process.env);
  const baseUrl = resolvedEnv.OPENAI_BASE_URL || "";
  const isAzure = baseUrl.includes(".openai.azure.com");
  const env = { ...resolvedEnv };
  // Always strip OPENAI_BASE_URL — for Azure we use config overrides,
  // for non-Azure the CLI should use its built-in endpoint.
  delete env.OPENAI_BASE_URL;

  if (isAzure) {
    // Map OPENAI_API_KEY → AZURE_OPENAI_API_KEY for Azure auth
    if (env.OPENAI_API_KEY && !env.AZURE_OPENAI_API_KEY) {
      env.AZURE_OPENAI_API_KEY = env.OPENAI_API_KEY;
    }
    const azureModel = env.CODEX_MODEL || undefined;
    return {
      env,
      config: {
        model_provider: "azure",
        model_providers: {
          azure: {
            name: "Azure OpenAI",
            base_url: baseUrl,
            env_key: "AZURE_OPENAI_API_KEY",
            wire_api: "responses",
          },
        },
        ...(azureModel ? { model: azureModel } : {}),
      },
    };
  }
  return { env };
}

// ---------------------------------------------------------------------------
// SDK Adapter Registry
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SdkAdapter
 * @property {string}   name           Human-readable SDK name.
 * @property {Function} load           Async loader returning the launcher fn.
 * @property {string}   envDisableKey  Env var name that disables this SDK.
 */

/**
 * Registry of supported SDK adapters.
 * Each entry maps a canonical name to its loader and disable-check env var.
 * @type {Record<string, SdkAdapter>}
 */
const SDK_ADAPTERS = {
  codex: {
    name: "codex",
    load: loadCodexAdapter,
    envDisableKey: "CODEX_SDK_DISABLED",
  },
  copilot: {
    name: "copilot",
    load: loadCopilotAdapter,
    envDisableKey: "COPILOT_SDK_DISABLED",
  },
  claude: {
    name: "claude",
    load: loadClaudeAdapter,
    envDisableKey: "CLAUDE_SDK_DISABLED",
  },
};

/** Ordered fallback chain for SDK resolution */
const SDK_FALLBACK_ORDER = ["codex", "copilot", "claude"];

// ---------------------------------------------------------------------------
// SDK Resolution & Cache
// ---------------------------------------------------------------------------

/** @type {string|null} Cached resolved SDK name */
let resolvedSdkName = null;

/** @type {boolean} Whether initial resolution has been logged */
let resolutionLogged = false;

/**
 * Check whether an SDK is disabled via its env var.
 * @param {string} name SDK canonical name.
 * @returns {boolean}
 */
function isDisabled(name) {
  const adapter = SDK_ADAPTERS[name];
  if (!adapter) return true;
  return envFlagEnabled(process.env[adapter.envDisableKey]);
}

const MONITOR_MONITOR_TASK_KEY = "monitor-monitor";
let monitorMonitorTimeoutBoundsWarningKey = "";
let monitorMonitorTimeoutAdjustmentKey = "";

function parsePositiveTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

function clampMonitorMonitorTimeout(timeoutMs, taskKey) {
  if (String(taskKey || "").trim() !== MONITOR_MONITOR_TASK_KEY) {
    return timeoutMs;
  }
  const baseTimeoutMs = parsePositiveTimeoutMs(timeoutMs);
  if (baseTimeoutMs === null) return timeoutMs;

  const minMs = parsePositiveTimeoutMs(
    process.env.DEVMODE_MONITOR_MONITOR_TIMEOUT_MIN_MS,
  );
  const maxEnv = parsePositiveTimeoutMs(
    process.env.DEVMODE_MONITOR_MONITOR_TIMEOUT_MAX_MS,
  );

  let maxMs = maxEnv;
  if (minMs !== null && maxMs !== null && maxMs < minMs) {
    const warningKey = `${minMs}:${maxMs}`;
    if (monitorMonitorTimeoutBoundsWarningKey !== warningKey) {
      monitorMonitorTimeoutBoundsWarningKey = warningKey;
      console.warn(
        `${TAG} invalid monitor-monitor timeout bounds: DEVMODE_MONITOR_MONITOR_TIMEOUT_MAX_MS=${maxMs} is lower than DEVMODE_MONITOR_MONITOR_TIMEOUT_MIN_MS=${minMs}. Ignoring max bound.`,
      );
    }
    maxMs = null;
  }

  if (minMs === null && maxMs === null) {
    return baseTimeoutMs;
  }

  let bounded = baseTimeoutMs;
  if (minMs !== null && bounded < minMs) bounded = minMs;
  if (maxMs !== null && bounded > maxMs) bounded = maxMs;

  if (bounded !== baseTimeoutMs) {
    const adjustmentKey = `${baseTimeoutMs}:${bounded}:${minMs ?? "off"}:${maxMs ?? "off"}`;
    if (monitorMonitorTimeoutAdjustmentKey !== adjustmentKey) {
      monitorMonitorTimeoutAdjustmentKey = adjustmentKey;
      console.log(
        `${TAG} monitor-monitor timeout adjusted ${baseTimeoutMs}ms -> ${bounded}ms (min=${minMs ?? "off"}, max=${maxMs ?? "off"})`,
      );
    }
  }
  return bounded;
}

/**
 * Log which SDK was selected (only on first resolution).
 * @param {string} name SDK name.
 * @param {string} source How it was determined.
 */
function logResolution(name, source) {
  if (!resolutionLogged) {
    console.log(`${TAG} SDK selected: ${name} (via ${source})`);
    resolutionLogged = true;
  }
}

/**
 * Resolve which SDK the pool should use.
 *
 * Resolution order:
 *   1. Runtime override via `setPoolSdk()` (already cached)
 *   2. `AGENT_POOL_SDK` env var
 *   3. `PRIMARY_AGENT` env var
 *   4. `loadConfig().agentPool.sdk` from openfleet.config.json
 *   5. First non-disabled SDK in fallback chain
 *
 * @returns {string} Canonical SDK name (e.g. "codex", "copilot", "claude").
 */
function resolvePoolSdkName() {
  if (resolvedSdkName) return resolvedSdkName;

  // 1. AGENT_POOL_SDK env var (explicit override)
  const envPoolSdk = (process.env.AGENT_POOL_SDK || "").trim().toLowerCase();
  if (envPoolSdk && SDK_ADAPTERS[envPoolSdk] && !isDisabled(envPoolSdk)) {
    resolvedSdkName = envPoolSdk;
    logResolution(envPoolSdk, "AGENT_POOL_SDK env");
    return resolvedSdkName;
  }

  // 2. PRIMARY_AGENT env var
  const envPrimaryRaw = (process.env.PRIMARY_AGENT || "").trim().toLowerCase();
  // Normalize: "copilot-sdk" → "copilot", "codex-sdk" → "codex", etc.
  const envPrimary = envPrimaryRaw.replace(/-sdk$/, "");
  if (envPrimary && SDK_ADAPTERS[envPrimary] && !isDisabled(envPrimary)) {
    resolvedSdkName = envPrimary;
    logResolution(envPrimary, "PRIMARY_AGENT env");
    return resolvedSdkName;
  }

  // 3. openfleet.config.json → agentPool.sdk
  try {
    const config = loadConfig();
    const configSdk = (
      config?.agentPool?.sdk ||
      config?.primaryAgent ||
      ""
    ).toLowerCase();
    if (configSdk && SDK_ADAPTERS[configSdk] && !isDisabled(configSdk)) {
      resolvedSdkName = configSdk;
      logResolution(configSdk, "openfleet.config.json");
      return resolvedSdkName;
    }
  } catch {
    // config.mjs not available — continue with fallback
  }

  // 4. Fallback chain: first non-disabled SDK
  for (const name of SDK_FALLBACK_ORDER) {
    if (!isDisabled(name)) {
      resolvedSdkName = name;
      logResolution(name, "fallback chain");
      return resolvedSdkName;
    }
  }

  // All disabled — default to codex anyway (will fail at load time)
  resolvedSdkName = "codex";
  logResolution("codex", "last resort (all SDKs disabled)");
  return resolvedSdkName;
}

// ---------------------------------------------------------------------------
// Public SDK management API
// ---------------------------------------------------------------------------

/**
 * Get the name of the currently resolved pool SDK.
 * @returns {string} SDK name ("codex", "copilot", or "claude").
 */
export function getPoolSdkName() {
  return resolvePoolSdkName();
}

/**
 * Override the pool SDK at runtime.
 * @param {string} name SDK name ("codex", "copilot", or "claude").
 * @throws {Error} If the name is not a recognised SDK.
 */
export function setPoolSdk(name) {
  const normalised = (name || "").trim().toLowerCase();
  if (!SDK_ADAPTERS[normalised]) {
    throw new Error(
      `${TAG} unknown SDK "${name}". Valid: ${Object.keys(SDK_ADAPTERS).join(", ")}`,
    );
  }
  resolvedSdkName = normalised;
  resolutionLogged = false;
  logResolution(normalised, "setPoolSdk() runtime override");
}

/**
 * Force re-resolution of the pool SDK on next use.
 * Useful after environment changes.
 */
export function resetPoolSdkCache() {
  resolvedSdkName = null;
  resolutionLogged = false;
}

/**
 * Returns the list of SDK names that are not disabled.
 * @returns {string[]}
 */
export function getAvailableSdks() {
  return Object.keys(SDK_ADAPTERS).filter((name) => !isDisabled(name));
}

// ---------------------------------------------------------------------------
// Per-SDK Ephemeral Thread Launchers
// ---------------------------------------------------------------------------

/**
 * Launch a single ephemeral prompt via the **Codex SDK**.
 *
 * Creates a fresh `Codex` instance + thread, streams one turn, tears down.
 *
 * @param {string}  prompt     Prompt text.
 * @param {string}  cwd        Working directory.
 * @param {number}  timeoutMs  Abort timeout in ms.
 * @param {object}  extra      Optional { onEvent, abortController }.
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string }>}
 */
async function launchCodexThread(prompt, cwd, timeoutMs, extra = {}) {
  const { onEvent, abortController: externalAC, onThreadReady = null } = extra;

  let reportedThreadId = null;
  const emitThreadReady = (threadId) => {
    if (!threadId || threadId === reportedThreadId) return;
    reportedThreadId = threadId;
    if (typeof onThreadReady === "function") {
      try {
        onThreadReady(threadId, "codex");
      } catch {
        /* best effort */
      }
    }
  };

  // ── 1. Load the SDK ──────────────────────────────────────────────────────
  let CodexClass;
  try {
    const mod = await import("@openai/codex-sdk");
    CodexClass = mod.Codex;
    if (!CodexClass) throw new Error("Codex export not found in SDK module");
  } catch (err) {
    return {
      success: false,
      output: "",
      items: [],
      error: `Codex SDK not available: ${err.message}`,
      sdk: "codex",
      threadId: null,
    };
  }

  // ── 2. Create an ephemeral thread ────────────────────────────────────────
  // Sandbox policy: configurable via CODEX_SANDBOX env var.
  // Default is workspace-write: permissive for repo tasks while avoiding full host access.
  const sandboxPolicy = process.env.CODEX_SANDBOX || "workspace-write";

  // Pass feature overrides via --config so sub-agent and memory features are
  // available even if ~/.codex/config.toml hasn't been patched yet.
  const codexOpts = buildCodexSdkOptions();
  codexOpts.config = {
    ...(codexOpts.config || {}),
    features: {
      child_agents_md: true,
      collab: true,
      memory_tool: true,
      undo: true,
      steer: true,
    },
  };
  const codex = new CodexClass(codexOpts);
  const thread = codex.startThread({
    sandboxMode: sandboxPolicy,
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    webSearchMode: "live",
  });

  if (!thread) {
    return {
      success: false,
      output: "",
      items: [],
      error:
        "Codex SDK startThread() returned null — SDK may be misconfigured or API unreachable",
      sdk: "codex",
      threadId: null,
    };
  }
  emitThreadReady(thread.id || null);

  // ── 3. Timeout / abort wiring ────────────────────────────────────────────
  const controller = externalAC || new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  // Hard timeout: safety net if the SDK's async iterator ignores AbortSignal.
  // Fires HARD_TIMEOUT_BUFFER_MS after the soft timeout to forcibly break the loop.
  let hardTimer;

  // ── 4. Stream the turn ───────────────────────────────────────────────────
  try {
    const turn = await thread.runStreamed(prompt, {
      signal: controller.signal,
    });

    let finalResponse = "";
    const allItems = [];

    // Race the event iterator against a hard timeout.
    // The soft timeout fires controller.abort() which the SDK should honor.
    // The hard timeout is a safety net in case the SDK iterator ignores the abort.
    const hardTimeoutPromise = new Promise((_, reject) => {
      hardTimer = setTimeout(
        () => reject(new Error("hard_timeout")),
        timeoutMs + HARD_TIMEOUT_BUFFER_MS,
      );
    });

    const iterateEvents = async () => {
      for await (const event of turn.events) {
        if (controller.signal.aborted) break;
        if (event?.type === "thread.started" && event?.thread_id) {
          emitThreadReady(event.thread_id);
        }
        if (typeof onEvent === "function") {
          try {
            onEvent(event);
          } catch {
            /* caller errors must not kill stream */
          }
        }
        if (event.type === "item.completed") {
          allItems.push(event.item);
          if (event.item.type === "agent_message" && event.item.text) {
            finalResponse += event.item.text + "\n";
          }
        }
      }
    };

    await Promise.race([iterateEvents(), hardTimeoutPromise]);
    clearTimeout(hardTimer);
    clearTimeout(timer);

    const output =
      finalResponse.trim() || "(Agent completed with no text output)";
    return {
      success: true,
      output,
      items: allItems,
      error: null,
      sdk: "codex",
      threadId: thread.id || null,
    };
  } catch (err) {
    clearTimeout(timer);
    if (hardTimer) clearTimeout(hardTimer);
    const isTimeout =
      err.name === "AbortError" ||
      String(err) === "timeout" ||
      err.message === "hard_timeout";
    if (isTimeout) {
      return {
        success: false,
        output: "",
        items: [],
        error: `${TAG} codex timeout after ${timeoutMs}ms${err.message === "hard_timeout" ? " (hard timeout — SDK iterator unresponsive)" : ""}`,
        sdk: "codex",
        threadId: null,
      };
    }
    return {
      success: false,
      output: "",
      items: [],
      error: err.message,
      sdk: "codex",
      threadId: null,
    };
  }
}

/**
 * Build CLI arguments for ephemeral Copilot agent-pool sessions.
 * Mirrors copilot-shell.mjs buildCliArgs() for feature parity.
 */
function buildPoolCopilotCliArgs() {
  const args = [];
  if (!envFlagEnabled(process.env.COPILOT_NO_EXPERIMENTAL)) {
    args.push("--experimental");
  }
  if (!envFlagEnabled(process.env.COPILOT_NO_ALLOW_ALL)) {
    args.push("--allow-all");
  }
  if (!envFlagEnabled(process.env.COPILOT_ENABLE_ASK_USER)) {
    args.push("--no-ask-user");
  }
  args.push("--no-auto-update");
  if (envFlagEnabled(process.env.COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS)) {
    args.push("--enable-all-github-mcp-tools");
  }
  if (envFlagEnabled(process.env.COPILOT_DISABLE_BUILTIN_MCPS)) {
    args.push("--disable-builtin-mcps");
  }
  const mcpConfigPath = process.env.COPILOT_ADDITIONAL_MCP_CONFIG;
  if (mcpConfigPath) {
    args.push("--additional-mcp-config", mcpConfigPath);
  }
  return args;
}

/**
 * Auto-respond to agent user-input requests in pool sessions.
 * Ensures ephemeral agents never block waiting for human input.
 */
function autoRespondToUserInput(request) {
  if (request.choices && request.choices.length > 0) {
    return { answer: request.choices[0], wasFreeform: false };
  }
  const question = (request.question || "").toLowerCase();
  if (/\b(y\/n|yes\/no|confirm|proceed|continue)\b/i.test(question)) {
    return { answer: "yes", wasFreeform: true };
  }
  return {
    answer: "Proceed with your best judgment. Do not wait for human input.",
    wasFreeform: true,
  };
}

/**
 * Launch a single ephemeral prompt via the **Copilot SDK**.
 *
 * Creates a `CopilotClient` in LOCAL mode (stdio), starts it, resumes an
 * existing session when available, otherwise creates a new one, sends the
 * prompt, and collects the response.
 *
 * LOCAL mode ensures:
 * - Full model access (gpt-5.3-codex, claude-sonnet-4.5, etc.)
 * - MCP tool availability
 * - Sub-agent support
 * - No background session restrictions
 *
 * @param {string}  prompt     Prompt text.
 * @param {string}  cwd        Working directory.
 * @param {number}  timeoutMs  Abort timeout in ms.
 * @param {object}  extra      Optional { onEvent, abortController, resumeThreadId, onThreadReady }.
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string }>}
 */
async function launchCopilotThread(prompt, cwd, timeoutMs, extra = {}) {
  const {
    onEvent,
    abortController: externalAC,
    resumeThreadId = null,
    onThreadReady = null,
    model: requestedModel = null,
  } = extra;

  // ── 1. Load the SDK ──────────────────────────────────────────────────────
  let CopilotClientClass;
  try {
    const mod = await import("@github/copilot-sdk");
    CopilotClientClass = mod.CopilotClient || mod.default?.CopilotClient;
    if (!CopilotClientClass) throw new Error("CopilotClient export not found");
  } catch (err) {
    return {
      success: false,
      output: "",
      items: [],
      error: `Copilot SDK not available: ${err.message}`,
      sdk: "copilot",
      threadId: null,
    };
  }

  // ── 2. Detect auth token ─────────────────────────────────────────────────
  const token =
    process.env.COPILOT_CLI_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_PAT ||
    undefined;

  // ── 3. Create & start ephemeral client (LOCAL mode) ──────────────────────
  // Use stdio transport (local) by default for full model/tool access.
  // Only use cliUrl (remote) if COPILOT_SESSION_MODE=remote is explicit.
  const sessionMode = (process.env.COPILOT_SESSION_MODE || "local").trim().toLowerCase();
  const cliUrl = process.env.COPILOT_CLI_URL || undefined;

  const controller = externalAC || new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  let client;
  let unsubscribe = null;
  let finalResponse = "";
  const allItems = [];
  const autoApprovePermissions = shouldAutoApproveCopilotPermissions();
  const clientEnv = autoApprovePermissions
    ? {
        ...process.env,
        COPILOT_ALLOW_ALL: process.env.COPILOT_ALLOW_ALL || "true",
      }
    : process.env;
  try {
    await withSanitizedOpenAiEnv(async () => {
      let clientOpts;
      if (sessionMode === "remote" && cliUrl) {
        // Remote mode: connect to existing server (limited model/tool access)
        clientOpts = { cliUrl, env: clientEnv };
      } else {
        // Local mode (default): stdio for full capability
        const cliArgs = buildPoolCopilotCliArgs();
        clientOpts = {
          cwd,
          env: clientEnv,
          cliArgs,
          useStdio: true,
        };
        if (token) {
          clientOpts.githubToken = token;
          clientOpts.token = token;
        }
        const cliPath =
          process.env.COPILOT_CLI_PATH ||
          process.env.GITHUB_COPILOT_CLI_PATH ||
          undefined;
        if (cliPath) clientOpts.cliPath = cliPath;
      }
      client = new CopilotClientClass(clientOpts);
      await client.start();
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      success: false,
      output: "",
      items: [],
      error: `Copilot client start failed: ${err.message}`,
      sdk: "copilot",
      threadId: null,
    };
  }

  // ── 4. Resume/create session ─────────────────────────────────────────────
  try {
    const sessionConfig = {
      streaming: true,
      workingDirectory: cwd,
      systemMessage: {
        mode: "replace",
        content:
          "You are an ephemeral task agent. Execute the given task immediately. " +
          "Do NOT ask for confirmation. Produce concise, actionable output.",
      },
      infiniteSessions: { enabled: true },
      // Auto-respond to user input requests — agent should never block
      onUserInputRequest: autoRespondToUserInput,
    };
    const permissionHandler = buildCopilotPermissionHandler();
    if (permissionHandler) {
      sessionConfig.onPermissionRequest = permissionHandler;
    }
    const copilotModel = String(
      requestedModel ||
        process.env.COPILOT_MODEL ||
        process.env.COPILOT_SDK_MODEL ||
        "",
    ).trim();
    if (copilotModel) sessionConfig.model = copilotModel;

    // Reasoning effort: pass through if model supports it
    const effort = (
      process.env.COPILOT_REASONING_EFFORT ||
      process.env.COPILOT_SDK_REASONING_EFFORT ||
      ""
    ).toLowerCase();
    if (["low", "medium", "high", "xhigh"].includes(effort)) {
      sessionConfig.reasoningEffort = effort;
    }

    let session = null;
    if (resumeThreadId && typeof client.resumeSession === "function") {
      try {
        session = await client.resumeSession(resumeThreadId, sessionConfig);
      } catch (resumeErr) {
        console.warn(
          `${TAG} copilot resume failed for session ${resumeThreadId}: ${resumeErr.message || resumeErr}. Starting fresh session.`,
        );
      }
    }
    if (!session) {
      session = await client.createSession(sessionConfig);
    }
    const copilotSessionId =
      session?.sessionId || session?.id || resumeThreadId || null;
    if (copilotSessionId && typeof onThreadReady === "function") {
      try {
        onThreadReady(copilotSessionId, "copilot");
      } catch {
        /* best effort */
      }
    }

    // ── 5. Send prompt & collect response ──────────────────────────────────
    // Wire up event listener if session supports it
    if (typeof session.on === "function") {
      unsubscribe = session.on((event) => {
        if (!event) return;
        allItems.push(event);
        if (event.type === "assistant.message" && event.data?.content) {
          finalResponse = event.data.content;
        }
        if (
          event.type === "assistant.message_delta" &&
          event.data?.deltaContent
        ) {
          finalResponse += event.data.deltaContent;
        }
        if (typeof onEvent === "function") {
          try {
            onEvent(event);
          } catch {
            /* best effort */
          }
        }
      });
    }

    const formattedPrompt =
      `# YOUR TASK — EXECUTE NOW\n\n${prompt}\n\n---\n` +
      'Do NOT respond with "Ready" or ask what to do. EXECUTE this task.';

    const hasSend = typeof session.send === "function";
    const hasSendAndWait = typeof session.sendAndWait === "function";
    if (!hasSend && !hasSendAndWait) {
      throw new Error("Copilot session does not support send");
    }

    // Prefer send()+idle when available. Some Copilot SDK builds enforce a
    // fixed internal 300s idle timeout in sendAndWait() that ignores caller
    // timeout, which can cause monitor-monitor failover loops.
    const useRawSend = hasSend;
    const sendPromise = useRawSend
      ? session.send.call(session, { prompt: formattedPrompt })
      : session.sendAndWait.call(
          session,
          { prompt: formattedPrompt },
          timeoutMs,
        );

    if (useRawSend && typeof session.on === "function") {
      await new Promise((resolveP, rejectP) => {
        let settled = false;
        let off = null;
        let idleTimer = null;

        const finish = (cb) => {
          if (settled) return;
          settled = true;
          if (idleTimer) clearTimeout(idleTimer);
          if (typeof off === "function") off();
          cb();
        };

        const idleHandler = (event) => {
          if (event?.type === "session.idle") return finish(resolveP);
          if (event?.type === "session.error") {
            return finish(() =>
              rejectP(new Error(event.data?.message || "session error")),
            );
          }
        };
        off = session.on(idleHandler);
        Promise.resolve(sendPromise).catch((err) => finish(() => rejectP(err)));

        // Wire abort signal into this inner promise
        if (controller.signal) {
          const onAbort = () => finish(() => rejectP(new Error("timeout")));
          if (controller.signal.aborted) {
            onAbort();
          } else {
            controller.signal.addEventListener("abort", onAbort, {
              once: true,
            });
          }
        }

        idleTimer = setTimeout(() => {
          // If assistant output arrived but session.idle is missing/late, allow
          // the run to continue rather than stalling for the full hard timeout.
          if (finalResponse.trim()) return finish(resolveP);
          finish(() => rejectP(new Error("timeout_waiting_for_idle")));
        }, timeoutMs + 1000);
        if (idleTimer && typeof idleTimer.unref === "function") {
          idleTimer.unref();
        }
      });
    } else {
      // Hard timeout safety net for sendAndWait — mirrors the Codex SDK path.
      // If sendAndWait ignores the abort signal, this forcibly breaks the hang.
      const copilotHardTimeout = new Promise((_, reject) => {
        const ht = setTimeout(
          () => reject(new Error("hard_timeout")),
          timeoutMs + HARD_TIMEOUT_BUFFER_MS,
        );
        // Don't let this timer keep the process alive
        if (ht && typeof ht.unref === "function") ht.unref();
      });
      await Promise.race([sendPromise, copilotHardTimeout]);
    }

    const output =
      finalResponse.trim() || "(Agent completed with no text output)";
    return {
      success: true,
      output,
      items: allItems,
      error: null,
      sdk: "copilot",
      threadId: copilotSessionId,
    };
  } catch (err) {
    const errMsg = String(err?.message || err || "");
    const hasAssistantOutput = !!finalResponse.trim();
    const isIdleWaitTimeout =
      /session\.idle/i.test(errMsg) && /timeout/i.test(errMsg);
    const isTimeout =
      err?.name === "AbortError" ||
      errMsg === "timeout" ||
      errMsg === "hard_timeout" ||
      errMsg === "timeout_waiting_for_idle" ||
      isIdleWaitTimeout;

    // Copilot SDK can occasionally emit the full assistant message but still
    // reject sendAndWait() due to a missing/late session.idle event. In that
    // case, keep the run progressing by accepting the captured assistant output.
    if (isIdleWaitTimeout && hasAssistantOutput) {
      console.warn(
        `${TAG} copilot sendAndWait timed out waiting for session.idle, but assistant output was received; accepting response`,
      );
      return {
        success: true,
        output: finalResponse.trim(),
        items: allItems,
        error: null,
        sdk: "copilot",
        threadId: resumeThreadId,
      };
    }

    if (isTimeout) {
      return {
        success: false,
        output: "",
        items: allItems,
        error: `${TAG} copilot timeout after ${timeoutMs}ms${isIdleWaitTimeout ? " waiting for session.idle" : ""}`,
        sdk: "copilot",
        threadId: resumeThreadId,
      };
    }
    return {
      success: false,
      output: "",
      items: allItems,
      error: errMsg || "unknown copilot error",
      sdk: "copilot",
      threadId: resumeThreadId,
    };
  } finally {
    clearTimeout(timer);
    try {
      if (typeof unsubscribe === "function") unsubscribe();
    } catch {
      /* ignore */
    }
    // Best-effort teardown — don't let cleanup errors propagate
    try {
      if (client && typeof client.stop === "function") client.stop();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Resume an existing Copilot session and run a follow-up prompt.
 * Falls back to fresh session if resume fails.
 *
 * @param {string} threadId
 * @param {string} prompt
 * @param {string} cwd
 * @param {number} timeoutMs
 * @param {object} extra
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string, threadId: string|null }>}
 */
async function resumeCopilotThread(
  threadId,
  prompt,
  cwd,
  timeoutMs,
  extra = {},
) {
  return launchCopilotThread(prompt, cwd, timeoutMs, {
    ...extra,
    resumeThreadId: threadId,
  });
}

/**
 * Launch a single ephemeral prompt via the **Claude Agent SDK**.
 *
 * Creates a fresh message queue, pushes the user message, iterates the
 * response stream, and collects text output.  Fully ephemeral — no session
 * reuse.
 *
 * @param {string}  prompt     Prompt text.
 * @param {string}  cwd        Working directory.
 * @param {number}  timeoutMs  Abort timeout in ms.
 * @param {object}  extra      Optional { onEvent, abortController, resumeThreadId, onThreadReady }.
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string }>}
 */
async function launchClaudeThread(prompt, cwd, timeoutMs, extra = {}) {
  const {
    onEvent,
    abortController: externalAC,
    claudeAllowedTools = null,
    claudePermissionMode = null,
    resumeThreadId = null,
    onThreadReady = null,
    model: requestedModel = null,
  } = extra;

  // ── 1. Load the SDK ──────────────────────────────────────────────────────
  let queryFn;
  try {
    const mod = await import("@anthropic-ai/claude-agent-sdk");
    queryFn = mod.query;
    if (!queryFn) throw new Error("query() not found in Claude SDK");
  } catch (err) {
    return {
      success: false,
      output: "",
      items: [],
      error: `Claude SDK not available: ${err.message}`,
      sdk: "claude",
      threadId: null,
    };
  }

  // ── 2. Detect auth ──────────────────────────────────────────────────────
  const apiKey =
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    process.env.CLAUDE_KEY ||
    undefined;

  // ── 3. Build message queue ───────────────────────────────────────────────
  const controller = externalAC || new AbortController();
  const softTimer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  // Hard timeout: force-break Promise.race if SDK ignores abort signal
  const hardTimeoutMs = timeoutMs + HARD_TIMEOUT_BUFFER_MS;

  /**
   * Minimal async message queue for the Claude SDK streaming interface.
   * @returns {{ iterator: Function, push: Function, close: Function }}
   */
  function createMessageQueue() {
    const q = [];
    let resolver = null;
    let closed = false;

    async function* iterator() {
      while (true) {
        if (q.length > 0) {
          yield q.shift();
          continue;
        }
        if (closed) return;
        // Wire abort signal: if the controller fires while we're waiting
        // for the next message, break out of the wait instead of hanging forever.
        await new Promise((r) => {
          resolver = r;
          if (controller.signal) {
            const onAbort = () => {
              closed = true;
              r();
            };
            if (controller.signal.aborted) {
              closed = true;
              r();
              return;
            }
            controller.signal.addEventListener("abort", onAbort, {
              once: true,
            });
          }
        });
        resolver = null;
      }
    }
    function push(msg) {
      if (closed) return false;
      q.push(msg);
      if (resolver) {
        resolver();
        resolver = null;
      }
      return true;
    }
    function close() {
      closed = true;
      if (resolver) {
        resolver();
        resolver = null;
      }
    }
    return { iterator, push, close };
  }

  /**
   * Build a Claude-format user message.
   * @param {string} text
   * @returns {object}
   */
  function makeUserMessage(text) {
    return {
      type: "user",
      session_id: resumeThreadId || "",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
      parent_tool_use_id: null,
    };
  }

  // ── 4. Execute query ─────────────────────────────────────────────────────
  try {
    const msgQueue = createMessageQueue();

    const formattedPrompt =
      `# YOUR TASK — EXECUTE NOW\n\n${prompt}\n\n---\n` +
      'Do NOT respond with "Ready" or ask what to do. EXECUTE this task.';

    msgQueue.push(makeUserMessage(formattedPrompt));

    const normalizeList = (value) => {
      if (Array.isArray(value)) {
        return value.map((entry) => String(entry || "").trim()).filter(Boolean);
      }
      return String(value || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    };

    /** @type {object} */
    const options = {
      cwd,
      settingSources: ["user", "project"],
      permissionMode:
        claudePermissionMode ||
        process.env.CLAUDE_PERMISSION_MODE ||
        "bypassPermissions",
    };
    if (apiKey) options.apiKey = apiKey;
    const explicitAllowedTools = normalizeList(claudeAllowedTools);
    const allowedTools = explicitAllowedTools.length
      ? explicitAllowedTools
      : normalizeList(process.env.CLAUDE_ALLOWED_TOOLS);
    if (allowedTools.length) {
      options.allowedTools = allowedTools;
    }

    const model = String(
      requestedModel ||
        process.env.CLAUDE_MODEL ||
        process.env.CLAUDE_CODE_MODEL ||
        process.env.ANTHROPIC_MODEL ||
        "",
    ).trim();
    if (model) options.model = model;

    const result = queryFn({
      prompt: msgQueue.iterator(),
      options,
    });

    let finalResponse = "";
    let activeClaudeSessionId = resumeThreadId || null;
    const allItems = [];

    // Wrap SDK execution in Promise.race to enforce hard timeout even if
    // the SDK's async iterator ignores the abort signal.
    const sdkExecution = (async () => {
      for await (const message of result) {
        // Check abort signal on every iteration
        if (controller.signal.aborted) {
          msgQueue.close();
          throw new Error("timeout");
        }

        const messageSessionId =
          message?.session_id || message?.sessionId || null;
        if (messageSessionId && messageSessionId !== activeClaudeSessionId) {
          activeClaudeSessionId = messageSessionId;
          if (typeof onThreadReady === "function") {
            try {
              onThreadReady(messageSessionId, "claude");
            } catch {
              /* best effort */
            }
          }
        }

        // Extract text from assistant messages
        const contentBlocks =
          message?.message?.content || message?.content || [];

        if (message?.type === "assistant" && Array.isArray(contentBlocks)) {
          for (const block of contentBlocks) {
            if (block?.type === "text" && block.text) {
              finalResponse += block.text + "\n";
            }
          }
        }

        // Normalise to item-style events for the onEvent callback
        const syntheticEvent = { type: message?.type || "unknown", message };
        allItems.push(syntheticEvent);
        if (typeof onEvent === "function") {
          try {
            onEvent(syntheticEvent);
          } catch {
            /* best effort */
          }
        }

        // If the SDK signals completion, close the queue
        if (message?.type === "result") {
          msgQueue.close();
        }
      }
    })();

    const hardTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("hard-timeout")), hardTimeoutMs),
    );

    await Promise.race([sdkExecution, hardTimeout]);

    clearTimeout(softTimer);
    msgQueue.close();

    const output =
      finalResponse.trim() || "(Agent completed with no text output)";
    return {
      success: true,
      output,
      items: allItems,
      error: null,
      sdk: "claude",
      threadId: activeClaudeSessionId,
    };
  } catch (err) {
    clearTimeout(softTimer);
    const isTimeout =
      err.name === "AbortError" ||
      String(err).includes("timeout") ||
      String(err.message).includes("timeout");
    if (isTimeout) {
      return {
        success: false,
        output: "",
        items: [],
        error: `${TAG} claude timeout after ${timeoutMs}ms`,
        sdk: "claude",
        threadId: resumeThreadId,
      };
    }
    return {
      success: false,
      output: "",
      items: [],
      error: err.message,
      sdk: "claude",
      threadId: resumeThreadId,
    };
  }
}

/**
 * Resume an existing Claude session and run a follow-up prompt.
 * Falls back to fresh session semantics if resume is not supported upstream.
 *
 * @param {string} threadId
 * @param {string} prompt
 * @param {string} cwd
 * @param {number} timeoutMs
 * @param {object} extra
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string, threadId: string|null }>}
 */
async function resumeClaudeThread(
  threadId,
  prompt,
  cwd,
  timeoutMs,
  extra = {},
) {
  return launchClaudeThread(prompt, cwd, timeoutMs, {
    ...extra,
    resumeThreadId: threadId,
  });
}

// ---------------------------------------------------------------------------
// Adapter loader functions (return the per-SDK launcher)
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<Function>} The Codex launcher function.
 */
async function loadCodexAdapter() {
  return launchCodexThread;
}

/**
 * @returns {Promise<Function>} The Copilot launcher function.
 */
async function loadCopilotAdapter() {
  return launchCopilotThread;
}

/**
 * @returns {Promise<Function>} The Claude launcher function.
 */
async function loadClaudeAdapter() {
  return launchClaudeThread;
}

// ---------------------------------------------------------------------------
// Unified ephemeral thread launcher
// ---------------------------------------------------------------------------

/**
 * Spin up a fresh, isolated SDK thread, execute a single prompt, and return
 * the result.  The thread is not reused — it exists only for this one
 * operation, which means it cannot block (or be blocked by) any other thread.
 *
 * SDK selection:
 *   - Pass `extra.sdk` to force a specific SDK for this call.
 *   - Otherwise uses the resolved pool SDK (env / config / fallback).
 *   - If the primary SDK fails with "not available", tries the fallback chain.
 *
 * @param {string}  prompt      The prompt to send to the agent.
 * @param {string}  [cwd]       Working directory (defaults to REPO_ROOT).
 * @param {number}  [timeoutMs] Abort after this many ms (default 90 min).
 * @param {object}  [extra]     Optional extras:
 * @param {string}  [extra.sdk]             Force a specific SDK for this call.
 * @param {string}  [extra.model]           Force model for SDKs that support it.
 * @param {Function} [extra.onEvent]        Callback for raw SDK events.
 * @param {AbortController} [extra.abortController] External abort controller.
 * @param {string[]|string} [extra.claudeAllowedTools] Claude tool allow-list.
 * @param {string} [extra.claudePermissionMode] Claude permission mode override.
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string }>}
 */
export async function launchEphemeralThread(
  prompt,
  cwd = REPO_ROOT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  extra = {},
) {
  // Determine the primary SDK to try
  const requestedSdk = extra.sdk
    ? String(extra.sdk).trim().toLowerCase()
    : null;

  const primaryName =
    requestedSdk && SDK_ADAPTERS[requestedSdk]
      ? requestedSdk
      : resolvePoolSdkName();

  const primaryAdapter = SDK_ADAPTERS[primaryName];

  // ── Try primary SDK ──────────────────────────────────────────────────────
  if (primaryAdapter && !isDisabled(primaryName)) {
    const launcher = await primaryAdapter.load();
    const result = await launcher(prompt, cwd, timeoutMs, extra);

    // If it succeeded, or if the error isn't "not available", return as-is
    if (result.success || !shouldFallbackForSdkError(result.error)) {
      return result;
    }

    // Primary SDK not installed — fall through to fallback chain
    console.warn(
      `${TAG} primary SDK "${primaryName}" failed (${result.error}); trying fallback chain`,
    );
  }

  // ── Fallback chain ───────────────────────────────────────────────────────
  for (const name of SDK_FALLBACK_ORDER) {
    if (name === primaryName) continue; // already tried
    if (isDisabled(name)) continue;

    const adapter = SDK_ADAPTERS[name];
    if (!adapter) continue;

    console.log(`${TAG} trying fallback SDK: ${name}`);
    const launcher = await adapter.load();
    const result = await launcher(prompt, cwd, timeoutMs, extra);

    if (result.success || !shouldFallbackForSdkError(result.error)) {
      return result;
    }
  }

  // ── All SDKs exhausted ───────────────────────────────────────────────────
  const triedSdks = SDK_FALLBACK_ORDER.filter((n) => !isDisabled(n));
  return {
    success: false,
    output: "",
    items: [],
    error: `${TAG} no SDK available. Tried: ${triedSdks.join(", ") || "(all disabled)"}`,
    sdk: primaryName,
    threadId: null,
  };
}

// ---------------------------------------------------------------------------
// High-level: drop-in replacement for execPrimaryPrompt
// ---------------------------------------------------------------------------

/**
 * Execute a prompt on a pooled ephemeral thread with the **same signature** as
 * `execPrimaryPrompt` from codex-shell.mjs.  This allows callers in
 * monitor.mjs to swap from the singleton agent to a concurrent pool thread
 * without changing any surrounding code.
 *
 * @param {string} userMessage  The prompt / instruction to execute.
 * @param {object} [options]    Compatible with execPrimaryPrompt options.
 * @param {Function}           [options.onEvent]         Callback for raw SDK events.
 * @param {object}             [options.statusData]      (Unused — accepted for compat.)
 * @param {number}             [options.timeoutMs]       Override default timeout.
 * @param {boolean}            [options.sendRawEvents]   (Unused — accepted for compat.)
 * @param {AbortController}    [options.abortController] External abort controller.
 * @param {string}             [options.cwd]             Working directory override.
 * @param {string}             [options.sdk]             Force a specific SDK.
 * @param {string}             [options.model]           Force model for SDKs that support it.
 * @returns {Promise<{ finalResponse: string, items: Array, usage: object|null }>}
 */
export async function execPooledPrompt(userMessage, options = {}) {
  const {
    onEvent,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    abortController,
    cwd = REPO_ROOT,
    sdk,
    model,
    // statusData and sendRawEvents are accepted but not used — keeps the
    // call-site compatible with execPrimaryPrompt without modification.
  } = options;

  const result = await launchEphemeralThread(userMessage, cwd, timeoutMs, {
    onEvent,
    abortController,
    sdk,
    model,
  });

  if (!result.success) {
    // Match execPrimaryPrompt behaviour: always return the triple, let the
    // caller inspect finalResponse for error handling.
    return {
      finalResponse: result.error
        ? `[agent-pool error] ${result.error}`
        : "(no output)",
      items: result.items || [],
      usage: null,
    };
  }

  return {
    finalResponse: result.output,
    items: result.items,
    usage: null, // ephemeral threads don't aggregate usage today
  };
}

// ---------------------------------------------------------------------------
// Thread Persistence & Resume Registry
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ThreadRecord
 * @property {string}      threadId   SDK-specific thread/session ID.
 * @property {string}      sdk        Which SDK owns this thread.
 * @property {string}      taskKey    Caller-defined key (task ID, PR#, etc.).
 * @property {string}      cwd        Working directory used.
 * @property {number}      turnCount  How many turns have been run.
 * @property {number}      createdAt  Unix ms when first created.
 * @property {number}      lastUsedAt Unix ms of most recent run.
 * @property {string|null} lastError  Last error message if any.
 * @property {boolean}     alive      Whether this thread is still usable.
 */

/** @type {Map<string, ThreadRecord>} In-memory registry keyed by taskKey */
const threadRegistry = new Map();

const THREAD_REGISTRY_FILE = resolve(__dirname, "logs", "thread-registry.json");
const THREAD_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

/** Maximum turns before a thread is considered exhausted and must be replaced */
const MAX_THREAD_TURNS = 100;

/** Maximum absolute age for a thread (regardless of lastUsedAt) */
const THREAD_MAX_ABSOLUTE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** SDKs that provide real resumable thread IDs */
const PERSISTENT_THREAD_SDKS = new Set(["codex", "copilot", "claude"]);

function sdkSupportsPersistentThreads(sdkName) {
  return PERSISTENT_THREAD_SDKS.has(String(sdkName || "").toLowerCase());
}

/** @type {Promise<void>|null} */
let threadRegistryLoadPromise = null;
let threadRegistryLoaded = false;

/**
 * Load thread registry from disk (best-effort).
 */
async function loadThreadRegistry() {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(THREAD_REGISTRY_FILE, "utf8");
    const entries = JSON.parse(raw);
    const now = Date.now();
    let pruned = 0;
    for (const [key, record] of Object.entries(entries)) {
      const recordSdk = String(record?.sdk || "").toLowerCase();

      // Expire old threads (by lastUsedAt)
      if (now - record.lastUsedAt > THREAD_MAX_AGE_MS) {
        pruned++;
        continue;
      }
      // Expire threads that have been alive too long (absolute age)
      if (now - record.createdAt > THREAD_MAX_ABSOLUTE_AGE_MS) {
        pruned++;
        continue;
      }
      // Expire high-turn threads (context exhaustion)
      if (record.turnCount >= MAX_THREAD_TURNS) {
        console.log(
          `${TAG} expiring exhausted thread for task "${key}" (${record.turnCount} turns)`,
        );
        pruned++;
        continue;
      }
      if (!record.alive) {
        pruned++;
        continue;
      }
      threadRegistry.set(key, record);
    }
    // Persist the cleaned registry back to disk so stale entries don't linger
    if (pruned > 0) {
      saveThreadRegistry().catch(() => {});
    }
  } catch {
    // No registry file yet — that's fine
  }
}

/**
 * Persist thread registry to disk (best-effort).
 */
async function saveThreadRegistry() {
  try {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(resolve(__dirname, "logs"), { recursive: true });
    const obj = Object.fromEntries(threadRegistry);
    await writeFile(THREAD_REGISTRY_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // Non-critical — registry is an optimisation, not a requirement
  }
}

/**
 * Ensure thread registry has been loaded from disk before use.
 * This avoids a startup race where first tasks run before registry restore.
 */
export async function ensureThreadRegistryLoaded() {
  if (threadRegistryLoaded) return;
  if (!threadRegistryLoadPromise) {
    threadRegistryLoadPromise = loadThreadRegistry()
      .catch(() => {
        /* best-effort */
      })
      .finally(() => {
        threadRegistryLoaded = true;
      });
  }
  await threadRegistryLoadPromise;
}

// Kick off async load at module init (non-blocking), callers can await explicitly.
void ensureThreadRegistryLoaded();

// ---------------------------------------------------------------------------
// Per-SDK Resume Launchers
// ---------------------------------------------------------------------------

/**
 * Detect unrecoverable Codex resume errors that indicate poisoned thread state.
 * These failures should force dropping cached thread metadata.
 *
 * @param {unknown} errorValue
 * @returns {boolean}
 */
function isPoisonedCodexResumeError(errorValue) {
  const lower = String(errorValue || "").toLowerCase();
  return (
    lower.includes("invalid_encrypted_content") ||
    lower.includes("encrypted content") ||
    lower.includes("could not be verified") ||
    lower.includes("state db missing rollout path") ||
    lower.includes("missing rollout path") ||
    lower.includes("tool call must have a tool call id") ||
    lower.includes("tool_call_id") ||
    (lower.includes("400") && lower.includes("tool call"))
  );
}

/**
 * Resume an existing Codex thread and run a follow-up prompt.
 * Uses `codex.resumeThread(threadId)` from @openai/codex-sdk.
 *
 * @param {string} threadId  Thread ID from a previous launchCodexThread.
 * @param {string} prompt    Follow-up prompt.
 * @param {string} cwd       Working directory.
 * @param {number} timeoutMs Abort timeout in ms.
 * @param {object} extra     Optional { onEvent, abortController }.
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string, threadId: string|null }>}
 */
async function resumeCodexThread(threadId, prompt, cwd, timeoutMs, extra = {}) {
  const { onEvent, abortController: externalAC } = extra;

  let CodexClass;
  try {
    const mod = await import("@openai/codex-sdk");
    CodexClass = mod.Codex;
    if (!CodexClass) throw new Error("Codex export not found");
  } catch (err) {
    return {
      success: false,
      output: "",
      items: [],
      error: `Codex SDK not available: ${err.message}`,
      sdk: "codex",
      threadId: null,
    };
  }

  const codex = new CodexClass(buildCodexSdkOptions());

  let thread;
  try {
    const sandboxPolicy = process.env.CODEX_SANDBOX || "workspace-write";
    thread = codex.resumeThread(threadId, {
      sandboxMode: sandboxPolicy,
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
    });
  } catch (err) {
    // Resume failed (thread expired, not found, etc.) — signal caller to start fresh
    return {
      success: false,
      output: "",
      items: [],
      error: `Thread resume failed: ${err.message}`,
      sdk: "codex",
      threadId: null,
      poisonedResumeState: isPoisonedCodexResumeError(err.message),
    };
  }

  if (!thread) {
    return {
      success: false,
      output: "",
      items: [],
      error: "Codex SDK resumeThread() returned null — thread may have expired",
      sdk: "codex",
      threadId: null,
    };
  }

  const controller = externalAC || new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  let hardTimer;

  try {
    const turn = await thread.runStreamed(prompt, {
      signal: controller.signal,
    });
    let finalResponse = "";
    const allItems = [];

    // Hard timeout safety net (same as launchCodexThread)
    const hardTimeoutPromise = new Promise((_, reject) => {
      hardTimer = setTimeout(
        () => reject(new Error("hard_timeout")),
        timeoutMs + HARD_TIMEOUT_BUFFER_MS,
      );
    });

    const iterateEvents = async () => {
      for await (const event of turn.events) {
        if (controller.signal.aborted) break;
        if (typeof onEvent === "function")
          try {
            onEvent(event);
          } catch {
            /* */
          }
        if (event.type === "item.completed") {
          allItems.push(event.item);
          if (event.item.type === "agent_message" && event.item.text) {
            finalResponse += event.item.text + "\n";
          }
        }
      }
    };

    await Promise.race([iterateEvents(), hardTimeoutPromise]);
    clearTimeout(hardTimer);
    clearTimeout(timer);

    const newThreadId = thread.id || threadId;
    return {
      success: true,
      output: finalResponse.trim() || "(resumed — no text output)",
      items: allItems,
      error: null,
      sdk: "codex",
      threadId: newThreadId,
    };
  } catch (err) {
    clearTimeout(timer);
    if (hardTimer) clearTimeout(hardTimer);
    const isTimeout =
      err.name === "AbortError" ||
      String(err) === "timeout" ||
      err.message === "hard_timeout";
    return {
      success: false,
      output: "",
      items: [],
      error: isTimeout
        ? `${TAG} codex resume timeout after ${timeoutMs}ms${err.message === "hard_timeout" ? " (hard timeout)" : ""}`
        : `Thread resume error: ${err.message}`,
      sdk: "codex",
      threadId: null,
      poisonedResumeState:
        !isTimeout && isPoisonedCodexResumeError(err.message),
    };
  }
}

/**
 * "Resume" for SDKs without native thread persistence.
 * Falls back to starting a fresh thread with a context-carrying preamble.
 *
 * @param {string} _threadId  Ignored — no native resume available.
 * @param {string} prompt     Follow-up prompt.
 * @param {string} cwd        Working directory.
 * @param {number} timeoutMs  Abort timeout.
 * @param {object} extra      Optional extras.
 * @param {string} sdkName    "copilot" or "claude".
 * @returns {Promise<Object>}
 */
async function resumeGenericThread(
  _threadId,
  prompt,
  cwd,
  timeoutMs,
  extra = {},
  sdkName = "copilot",
) {
  // No native resume — launch fresh with context preamble
  const contextPrompt = `# CONTINUATION — Resuming Prior Context\n\nYou are continuing work from a previous session. Pick up where you left off.\n\n---\n\n${prompt}`;
  const launcher =
    sdkName === "claude" ? launchClaudeThread : launchCopilotThread;
  const result = await launcher(contextPrompt, cwd, timeoutMs, extra);
  return { ...result, threadId: null }; // No persistent ID available
}

// ---------------------------------------------------------------------------
// Thread-Persistent Launcher
// ---------------------------------------------------------------------------

/**
 * Launch a new thread OR resume an existing one for the given task key.
 *
 * When a `taskKey` is provided:
 *   1. Check the thread registry for an existing, alive thread.
 *   2. If found and the same SDK — attempt resume (Codex) or context-carry (others).
 *   3. If resume fails or no prior thread — start fresh.
 *   4. Register the new thread for future resume.
 *
 * Without `taskKey`, behaves identically to `launchEphemeralThread`.
 *
 * @param {string}  prompt      Prompt to run.
 * @param {string}  [cwd]       Working directory.
 * @param {number}  [timeoutMs] Timeout in ms.
 * @param {object}  [extra]     Options:
 * @param {string}  [extra.taskKey]    Key for thread registry (task ID, PR number, etc.)
 * @param {string}  [extra.sdk]        Force a specific SDK.
 * @param {string}  [extra.model]      Force model for SDKs that support it.
 * @param {Function} [extra.onEvent]   Event callback.
 * @param {AbortController} [extra.abortController]
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string, threadId: string|null, resumed: boolean }>}
 */
export async function launchOrResumeThread(
  prompt,
  cwd = REPO_ROOT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  extra = {},
) {
  await ensureThreadRegistryLoaded();
  const { taskKey, ...restExtra } = extra;
  timeoutMs = clampMonitorMonitorTimeout(timeoutMs, taskKey);

  // No taskKey — pure ephemeral (backward compatible)
  if (!taskKey) {
    const result = await launchEphemeralThread(
      prompt,
      cwd,
      timeoutMs,
      restExtra,
    );
    return { ...result, threadId: result.threadId || null, resumed: false };
  }

  // Check registry for existing thread
  const existing = threadRegistry.get(taskKey);
  if (existing && existing.alive && existing.threadId) {
    // Check if thread has exceeded max turns — force fresh start
    if (existing.turnCount >= MAX_THREAD_TURNS) {
      console.warn(
        `${TAG} thread for task "${taskKey}" exceeded ${MAX_THREAD_TURNS} turns (has ${existing.turnCount}) — invalidating and starting fresh`,
      );
      existing.alive = false;
      threadRegistry.set(taskKey, existing);
      saveThreadRegistry().catch(() => {});
      // Fall through to fresh launch below
    } else if (Date.now() - existing.createdAt > THREAD_MAX_ABSOLUTE_AGE_MS) {
      console.warn(
        `${TAG} thread for task "${taskKey}" exceeded absolute age limit — invalidating and starting fresh`,
      );
      existing.alive = false;
      threadRegistry.set(taskKey, existing);
      saveThreadRegistry().catch(() => {});
      // Fall through to fresh launch below
    } else {
      const sdkName = restExtra.sdk || existing.sdk || resolvePoolSdkName();

      // Native resume for Codex threads
      if (sdkName === "codex" && existing.sdk === "codex") {
        console.log(
          `${TAG} resuming Codex thread ${existing.threadId} for task "${taskKey}" (turn ${existing.turnCount + 1})`,
        );
        const result = await resumeCodexThread(
          existing.threadId,
          prompt,
          cwd,
          timeoutMs,
          restExtra,
        );

        if (result.success) {
          // Update registry
          existing.turnCount += 1;
          existing.lastUsedAt = Date.now();
          existing.lastError = null;
          if (result.threadId) existing.threadId = result.threadId;
          threadRegistry.set(taskKey, existing);
          saveThreadRegistry().catch(() => {});
          return { ...result, resumed: true };
        }

        // Resume failed — fall through to fresh launch
        if (
          result.poisonedResumeState ||
          isPoisonedCodexResumeError(result.error)
        ) {
          console.warn(
            `${TAG} resume failed for task "${taskKey}" with corrupted state: ${result.error}. Dropping cached thread metadata and starting fresh.`,
          );
          threadRegistry.delete(taskKey);
        } else {
          console.warn(
            `${TAG} resume failed for task "${taskKey}": ${result.error}. Starting fresh.`,
          );
          existing.alive = false;
          existing.lastError = result.error || existing.lastError || null;
          threadRegistry.set(taskKey, existing);
        }
        saveThreadRegistry().catch(() => {});
      } else if (sdkName === "copilot" && existing.sdk === "copilot") {
        console.log(
          `${TAG} resuming Copilot session ${existing.threadId} for task "${taskKey}" (turn ${existing.turnCount + 1})`,
        );
        const result = await resumeCopilotThread(
          existing.threadId,
          prompt,
          cwd,
          timeoutMs,
          restExtra,
        );

        if (result.success) {
          existing.turnCount += 1;
          existing.lastUsedAt = Date.now();
          existing.lastError = null;
          if (result.threadId) existing.threadId = result.threadId;
          existing.alive = !!existing.threadId;
          threadRegistry.set(taskKey, existing);
          saveThreadRegistry().catch(() => {});
          return { ...result, resumed: true };
        }

        console.warn(
          `${TAG} resume failed for task "${taskKey}": ${result.error}. Starting fresh.`,
        );
        existing.alive = false;
        existing.lastError = result.error || existing.lastError || null;
        threadRegistry.set(taskKey, existing);
        saveThreadRegistry().catch(() => {});
      } else if (sdkName === "claude" && existing.sdk === "claude") {
        console.log(
          `${TAG} resuming Claude session ${existing.threadId} for task "${taskKey}" (turn ${existing.turnCount + 1})`,
        );
        const result = await resumeClaudeThread(
          existing.threadId,
          prompt,
          cwd,
          timeoutMs,
          restExtra,
        );

        if (result.success) {
          existing.turnCount += 1;
          existing.lastUsedAt = Date.now();
          existing.lastError = null;
          if (result.threadId) existing.threadId = result.threadId;
          existing.alive = !!existing.threadId;
          threadRegistry.set(taskKey, existing);
          saveThreadRegistry().catch(() => {});
          return { ...result, resumed: true };
        }

        console.warn(
          `${TAG} resume failed for task "${taskKey}": ${result.error}. Starting fresh.`,
        );
        existing.alive = false;
        existing.lastError = result.error || existing.lastError || null;
        threadRegistry.set(taskKey, existing);
        saveThreadRegistry().catch(() => {});
      } else if (existing.sdk !== sdkName) {
        // SDK changed — invalidate old thread
        console.log(
          `${TAG} SDK changed from ${existing.sdk} to ${sdkName} for task "${taskKey}", starting fresh`,
        );
        existing.alive = false;
        threadRegistry.set(taskKey, existing);
        saveThreadRegistry().catch(() => {});
      } else {
        // Non-Codex SDK: use context-carry resume
        console.log(
          `${TAG} context-carry resume for ${sdkName} thread, task "${taskKey}"`,
        );
        const result = await resumeGenericThread(
          existing.threadId,
          prompt,
          cwd,
          timeoutMs,
          restExtra,
          sdkName,
        );

        if (result.success) {
          existing.turnCount += 1;
          existing.lastUsedAt = Date.now();
          existing.lastError = null;
          threadRegistry.set(taskKey, existing);
          saveThreadRegistry().catch(() => {});
          return { ...result, resumed: true };
        }

        console.warn(
          `${TAG} context-carry resume failed for task "${taskKey}": ${result.error}`,
        );
        existing.alive = false;
        existing.lastError = result.error || existing.lastError || null;
        threadRegistry.set(taskKey, existing);
        saveThreadRegistry().catch(() => {});
      }
    } // close else for turn-count / absolute-age guard
  }

  // Fresh launch — pre-register a thread as soon as the SDK exposes one.
  // This improves restart recovery for long-running tasks interrupted mid-turn.
  const callerOnThreadReady =
    typeof restExtra.onThreadReady === "function"
      ? restExtra.onThreadReady
      : null;
  const launchExtra = { ...restExtra };
  launchExtra.onThreadReady = (threadId, sdkName = null) => {
    const resolvedSdk =
      sdkName || launchExtra.sdk || resolvePoolSdkName() || "unknown";
    const sdkCanPersist = sdkSupportsPersistentThreads(resolvedSdk);

    if (threadId && sdkCanPersist) {
      const existing = threadRegistry.get(taskKey);
      const createdAt = existing?.createdAt || Date.now();
      const turnCount = Number(existing?.turnCount || 1);
      threadRegistry.set(taskKey, {
        threadId,
        sdk: resolvedSdk,
        taskKey,
        cwd,
        turnCount,
        createdAt,
        lastUsedAt: Date.now(),
        lastError: null,
        alive: true,
      });
      saveThreadRegistry().catch(() => {});
    }
    if (callerOnThreadReady) {
      try {
        callerOnThreadReady(threadId, sdkName);
      } catch {
        /* caller errors must not break execution */
      }
    }
  };

  const result = await launchEphemeralThread(
    prompt,
    cwd,
    timeoutMs,
    launchExtra,
  );

  // Register/update thread record for future resume
  const existingRecord = threadRegistry.get(taskKey);
  const resultSdk =
    result.sdk ||
    launchExtra.sdk ||
    existingRecord?.sdk ||
    resolvePoolSdkName() ||
    "unknown";
  const sdkCanPersist = sdkSupportsPersistentThreads(resultSdk);
  const finalThreadId = sdkCanPersist
    ? result.threadId ||
      (existingRecord?.sdk === resultSdk ? existingRecord?.threadId : null) ||
      null
    : null;
  const record = {
    threadId: finalThreadId,
    sdk: resultSdk,
    taskKey,
    cwd,
    turnCount: Number(existingRecord?.turnCount || 1),
    createdAt: existingRecord?.createdAt || Date.now(),
    lastUsedAt: Date.now(),
    lastError: result.success ? null : result.error,
    alive: result.success && sdkCanPersist && !!finalThreadId,
  };
  threadRegistry.set(taskKey, record);
  saveThreadRegistry().catch(() => {});

  return { ...result, threadId: finalThreadId, resumed: false };
}

// ---------------------------------------------------------------------------
// Error Recovery Wrapper
// ---------------------------------------------------------------------------

/**
 * Execute a prompt with automatic error recovery via thread resume.
 *
 * If the initial run fails, this will:
 *   1. Resume the same thread with the error context
 *   2. Ask the agent to diagnose and fix the issue
 *   3. Retry up to `maxRetries` times
 *
 * Supports mid-execution CONTINUE signals:
 *   When the AbortController is aborted with reason "idle_continue",
 *   the current attempt is treated as a soft failure and retried with a
 *   CONTINUE prompt. A fresh AbortController is created for the next attempt.
 *   Up to `maxContinues` additional attempts are allowed for idle continues.
 *
 * @param {string}  prompt      Initial prompt.
 * @param {object}  options     Options:
 * @param {string}  options.taskKey       Required — identifies the thread.
 * @param {string}  [options.cwd]         Working directory.
 * @param {number}  [options.timeoutMs]   Per-attempt timeout.
 * @param {number}  [options.maxRetries]  Max follow-up attempts (default: 2).
 * @param {number}  [options.maxContinues] Max idle-continue attempts (default: 3).
 * @param {Function} [options.shouldRetry] Custom predicate: (result) => boolean.
 * @param {Function} [options.buildRetryPrompt] Custom retry prompt builder: (result, attempt) => string.
 * @param {Function} [options.buildContinuePrompt] Custom continue prompt builder: (result, attempt) => string.
 * @param {string}  [options.sdk]         Force SDK.
 * @param {string}  [options.model]       Force model for SDKs that support it.
 * @param {Function} [options.onEvent]    Event callback.
 * @param {Function} [options.onAbortControllerReplaced] Called when AbortController is replaced after idle_continue.
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string, attempts: number, continues: number, resumed: boolean }>}
 */
export async function execWithRetry(prompt, options = {}) {
  const {
    taskKey,
    cwd = REPO_ROOT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = 2,
    maxContinues = 3,
    shouldRetry,
    buildRetryPrompt,
    buildContinuePrompt,
    sdk,
    model,
    onEvent,
    onAbortControllerReplaced,
  } = options;

  // AbortController can be replaced on idle_continue, so track it mutably
  let abortController = options.abortController ?? null;

  if (!taskKey) {
    throw new Error(
      `${TAG} execWithRetry requires a taskKey for thread persistence`,
    );
  }

  let lastResult = null;
  const totalAttempts = 1 + maxRetries;
  let continuesUsed = 0;
  let attempt = 0;

  while (attempt < totalAttempts + continuesUsed) {
    attempt++;
    const isIdleContinue =
      lastResult?.error === "idle_continue" ||
      lastResult?._idleContinue === true;

    const currentPrompt =
      attempt === 1
        ? prompt
        : isIdleContinue && typeof buildContinuePrompt === "function"
          ? buildContinuePrompt(lastResult, attempt)
          : typeof buildRetryPrompt === "function"
            ? buildRetryPrompt(lastResult, attempt)
            : `# ERROR RECOVERY — Attempt ${attempt}/${totalAttempts}\n\nYour previous attempt failed with:\n\`\`\`\n${lastResult?.error || lastResult?.output || "(unknown error)"}\n\`\`\`\n\nPlease diagnose the issue, fix it, and try again. Here was the original task:\n\n${prompt}`;

    console.log(
      `${TAG} execWithRetry: attempt ${attempt}/${totalAttempts + continuesUsed} for task "${taskKey}"${attempt > 1 ? (isIdleContinue ? " (idle-continue)" : " (resume)") : ""}`,
    );

    // Check if externally aborted (hard kill, not idle_continue)
    if (abortController?.signal?.aborted) {
      const reason = abortController.signal.reason;

      if (reason === "idle_continue" && continuesUsed < maxContinues) {
        // Soft abort — agent went idle, send CONTINUE
        continuesUsed++;
        console.log(
          `${TAG} idle_continue detected for "${taskKey}" (continue ${continuesUsed}/${maxContinues}) — sending CONTINUE prompt`,
        );

        // Replace the AbortController so the next attempt isn't pre-aborted
        abortController = new AbortController();
        if (typeof onAbortControllerReplaced === "function") {
          try {
            onAbortControllerReplaced(abortController);
          } catch {
            /* caller errors must not break execution */
          }
        }

        lastResult = {
          success: false,
          output: lastResult?.output || "",
          items: lastResult?.items || [],
          error: "idle_continue",
          sdk: sdk || "unknown",
          threadId: lastResult?.threadId || null,
          _idleContinue: true,
        };
        continue;
      }

      // Hard abort (watchdog_timeout or unknown)
      lastResult = {
        success: false,
        output: "",
        items: [],
        error: `Externally aborted (${reason || "watchdog or manual kill"})`,
        sdk: sdk || "unknown",
        threadId: null,
      };
      break;
    }

    lastResult = await launchOrResumeThread(currentPrompt, cwd, timeoutMs, {
      taskKey,
      sdk,
      model,
      onEvent,
      abortController,
    });

    // Check post-launch if aborted with idle_continue (race: abort fired during execution)
    if (
      !lastResult.success &&
      abortController?.signal?.aborted &&
      abortController.signal.reason === "idle_continue" &&
      continuesUsed < maxContinues
    ) {
      continuesUsed++;
      console.log(
        `${TAG} idle_continue (post-launch) for "${taskKey}" (continue ${continuesUsed}/${maxContinues})`,
      );

      abortController = new AbortController();
      if (typeof onAbortControllerReplaced === "function") {
        try {
          onAbortControllerReplaced(abortController);
        } catch {
          /* best-effort */
        }
      }

      lastResult._idleContinue = true;
      continue;
    }

    // Check if we should retry
    if (lastResult.success) {
      // If caller has custom shouldRetry (e.g. "output must contain 'PASS'"), check it
      if (typeof shouldRetry === "function" && shouldRetry(lastResult)) {
        console.log(
          `${TAG} attempt ${attempt} succeeded but shouldRetry returned true`,
        );
        continue;
      }
      return { ...lastResult, attempts: attempt, continues: continuesUsed };
    }

    // Failed — should we retry?
    const retriesLeft = totalAttempts + continuesUsed - attempt;
    if (retriesLeft > 0) {
      if (typeof shouldRetry === "function" && !shouldRetry(lastResult)) {
        // Custom predicate says don't retry
        console.log(`${TAG} shouldRetry returned false — not retrying`);
        return { ...lastResult, attempts: attempt, continues: continuesUsed };
      }
      console.warn(
        `${TAG} attempt ${attempt} failed, will retry (${retriesLeft} left): ${lastResult.error}`,
      );
    }
  }

  return { ...lastResult, attempts: attempt, continues: continuesUsed };
}

// ---------------------------------------------------------------------------
// Thread Management Exports
// ---------------------------------------------------------------------------

/**
 * Get the thread record for a task key.
 * @param {string} taskKey
 * @returns {ThreadRecord|null}
 */
export function getThreadRecord(taskKey) {
  return threadRegistry.get(taskKey) || null;
}

function markThreadRecordDead(taskKey) {
  const record = threadRegistry.get(taskKey);
  if (!record) return false;
  if (!record.alive) return false;
  record.alive = false;
  threadRegistry.set(taskKey, record);
  return true;
}

/**
 * Async invalidate helper that first loads persisted registry state.
 * Useful at process startup to avoid races with lazy registry restore.
 *
 * @param {string} taskKey
 * @returns {Promise<void>}
 */
export async function invalidateThreadAsync(taskKey) {
  if (!taskKey) return;
  await ensureThreadRegistryLoaded();
  if (markThreadRecordDead(taskKey)) {
    await saveThreadRegistry().catch(() => {});
  }
}

/**
 * Invalidate (kill) a thread record so it won't be resumed.
 * @param {string} taskKey
 */
export function invalidateThread(taskKey) {
  if (!taskKey) return;
  if (markThreadRecordDead(taskKey)) {
    saveThreadRegistry().catch(() => {});
    return;
  }
  // If registry hasn't loaded yet, defer invalidation until load completes.
  if (!threadRegistryLoaded) {
    void invalidateThreadAsync(taskKey);
  }
}

/**
 * Invalidate a thread and force a fresh start on next attempt.
 * Unlike invalidateThread which just sets alive=false, this also logs the reason.
 * @param {string} taskKey
 * @param {string} reason
 */
export function forceNewThread(taskKey, reason = "manual") {
  const record = threadRegistry.get(taskKey);
  if (record) {
    console.log(
      `${TAG} force-invalidating thread for task "${taskKey}": ${reason} (was turn ${record.turnCount})`,
    );
  }
  invalidateThread(taskKey);
}

/**
 * Clear all thread records (e.g. on monitor restart).
 */
export function clearThreadRegistry() {
  threadRegistry.clear();
  saveThreadRegistry().catch(() => {});
}

/**
 * Prune all threads that have exceeded MAX_THREAD_TURNS or are older than THREAD_MAX_ABSOLUTE_AGE_MS.
 * Call on startup to clean up zombie threads from prior runs.
 * @returns {number} Number of threads pruned
 */
export function pruneAllExhaustedThreads() {
  let pruned = 0;
  const now = Date.now();
  for (const [key, record] of threadRegistry) {
    let reason = null;
    if (record.turnCount >= MAX_THREAD_TURNS) {
      reason = `${record.turnCount} turns (max ${MAX_THREAD_TURNS})`;
    } else if (now - record.createdAt > THREAD_MAX_ABSOLUTE_AGE_MS) {
      reason = `absolute age ${Math.round((now - record.createdAt) / 3600000)}h`;
    } else if (!record.alive) {
      reason = "already dead";
    }
    if (reason) {
      console.log(`${TAG} pruning thread for task "${key}": ${reason}`);
      record.alive = false;
      threadRegistry.set(key, record);
      pruned++;
    }
  }
  if (pruned > 0) {
    saveThreadRegistry().catch(() => {});
    console.log(`${TAG} pruned ${pruned} exhausted/stale threads`);
  }
  return pruned;
}

/**
 * Get summary of all active threads.
 * @returns {Array<{ taskKey: string, sdk: string, threadId: string|null, turnCount: number, age: number }>}
 */
export function getActiveThreads() {
  const now = Date.now();
  const result = [];
  for (const [key, record] of threadRegistry) {
    if (!record.alive) continue;
    if (now - record.lastUsedAt > THREAD_MAX_AGE_MS) continue;
    if (now - record.createdAt > THREAD_MAX_ABSOLUTE_AGE_MS) continue;
    if (record.turnCount >= MAX_THREAD_TURNS) continue;
    result.push({
      taskKey: key,
      sdk: record.sdk,
      threadId: record.threadId,
      turnCount: record.turnCount,
      age: now - record.createdAt,
    });
  }
  return result;
}
