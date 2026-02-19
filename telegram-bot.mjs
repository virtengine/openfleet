/**
 * telegram-bot.mjs — Two-way Telegram ↔ primary agent for openfleet.
 *
 * Polls Telegram Bot API for incoming messages, routes slash commands to
 * built-in handlers, and forwards free-text to the persistent primary agent.
 *
 * Architecture:
 *   Telegram → getUpdates long-poll → handleUpdate()
 *     ├─ /command → built-in handler (fast, no agent)
 *     └─ free-text → PrimaryAgent.exec() → response back to Telegram
 *
 * Security: Only accepts messages from the configured TELEGRAM_CHAT_ID.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRoot } from "./repo-root.mjs";
import {
  execPrimaryPrompt,
  isPrimaryBusy,
  getPrimaryAgentInfo,
  resetPrimaryAgent,
  initPrimaryAgent,
  steerPrimaryPrompt,
  getPrimaryAgentName,
  switchPrimaryAgent,
} from "./primary-agent.mjs";
import {
  getPoolSdkName,
  setPoolSdk,
  resetPoolSdkCache,
  getAvailableSdks,
  getActiveThreads,
  clearThreadRegistry,
  invalidateThread,
} from "./agent-pool.mjs";
import { fetchWithFallback } from "./fetch-runtime.mjs";
import {
  getKanbanAdapter,
  setKanbanBackend,
  getAvailableBackends,
  getKanbanBackendName,
} from "./kanban-adapter.mjs";
import {
  getWorktreeManager,
  listActiveWorktrees as listManagedWorktrees,
  pruneStaleWorktrees,
  getWorktreeStats,
} from "./worktree-manager.mjs";
import { loadExecutorConfig } from "./config.mjs";
import {
  getTelegramUiUrl,
  startTelegramUiServer,
  stopTelegramUiServer,
  getLocalLanIp,
  getFirewallState,
  openFirewallPort,
  getSessionToken,
  getTunnelUrl,
} from "./ui-server.mjs";
import {
  loadWorkspaceRegistry,
  formatRegistryDiagnostics,
  getDefaultModelPriority,
  getLocalWorkspace,
} from "./workspace-registry.mjs";
import {
  claimSharedWorkspace,
  formatSharedWorkspaceDetail,
  formatSharedWorkspaceSummary,
  getSharedAvailabilityMap,
  loadSharedWorkspaceRegistry as loadSharedRegistry,
  releaseSharedWorkspace,
  resolveSharedWorkspace,
  sweepExpiredLeases as sweepSharedLeases,
} from "./shared-workspace-registry.mjs";
import {
  buildLocalPresence,
  formatCoordinatorSummary,
  formatPresenceMessage,
  formatPresenceSummary,
  initPresence,
  notePresence,
  parsePresenceMessage,
} from "./presence.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolveRepoRoot();
const OpenFleetDir = __dirname;
const statusPath = resolve(repoRoot, ".cache", "ve-orchestrator-status.json");
const telegramPollLockPath = resolve(
  repoRoot,
  ".cache",
  "telegram-getupdates.lock",
);
const liveDigestStatePath = resolve(repoRoot, ".cache", "ve-live-digest.json");
const fwCooldownPath = resolve(repoRoot, ".cache", "ve-fw-cooldown.json");
const FW_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

function resolveVeKanbanPs1Path() {
  const modulePath = resolve(OpenFleetDir, "ve-kanban.ps1");
  if (existsSync(modulePath)) return modulePath;
  return resolve(repoRoot, "scripts", "openfleet", "ve-kanban.ps1");
}

// ── Configuration ────────────────────────────────────────────────────────────

let telegramToken = process.env.TELEGRAM_BOT_TOKEN;
let telegramChatId = process.env.TELEGRAM_CHAT_ID;
let TELEGRAM_API_BASE = String(
  process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org",
).replace(/\/+$/, "");
const POLL_TIMEOUT_S = 30; // long-poll timeout
const MAX_MESSAGE_LEN = 4000; // Telegram max is 4096, leave margin
const POLL_ERROR_BACKOFF_MS = 5000;
const TELEGRAM_FETCH_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
let TELEGRAM_HTTP_TIMEOUT_MS = Math.max(
  2000,
  Number(process.env.TELEGRAM_HTTP_TIMEOUT_MS || "15000") || 15000,
);
let TELEGRAM_RETRY_ATTEMPTS = Math.max(
  1,
  Number(process.env.TELEGRAM_RETRY_ATTEMPTS || "4") || 4,
);
let TELEGRAM_RETRY_BASE_MS = Math.max(
  100,
  Number(process.env.TELEGRAM_RETRY_BASE_MS || "600") || 600,
);
let TELEGRAM_CURL_CONNECT_TIMEOUT_SEC = Math.max(
  2,
  Number(process.env.TELEGRAM_CURL_CONNECT_TIMEOUT_SEC || "8") || 8,
);
let TELEGRAM_CURL_POLL_TIMEOUT_SEC = Math.max(
  1,
  Number(process.env.TELEGRAM_CURL_POLL_TIMEOUT_SEC || "5") || 5,
);
let TELEGRAM_CURL_FALLBACK = !["0", "false", "no"].includes(
  String(
    process.env.TELEGRAM_CURL_FALLBACK ||
      (process.platform === "win32" ? "false" : "true"),
  ).toLowerCase(),
);
let telegramAllowedChatIds = new Set();
let telegramPreferCurlUntilMs = 0;
let lastPollErrorLogAtMs = 0;
let lastFallbackSwitchLogMs = 0;
let pollFailureStreak = 0;
let telegramApiReachable = null; // null = unknown, true/false after probe

function parseAllowedTelegramIds(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAuthorizedTelegramActor(chatId, fromId) {
  if (!telegramAllowedChatIds || telegramAllowedChatIds.size === 0) return true;
  if (chatId && telegramAllowedChatIds.has(String(chatId))) return true;
  if (fromId && telegramAllowedChatIds.has(String(fromId))) return true;
  return false;
}

function refreshTelegramConfigFromEnv() {
  telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  telegramChatId = process.env.TELEGRAM_CHAT_ID;
  TELEGRAM_API_BASE = String(
    process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org",
  ).replace(/\/+$/, "");
  TELEGRAM_HTTP_TIMEOUT_MS = Math.max(
    2000,
    Number(process.env.TELEGRAM_HTTP_TIMEOUT_MS || "15000") || 15000,
  );
  TELEGRAM_RETRY_ATTEMPTS = Math.max(
    1,
    Number(process.env.TELEGRAM_RETRY_ATTEMPTS || "4") || 4,
  );
  TELEGRAM_RETRY_BASE_MS = Math.max(
    100,
    Number(process.env.TELEGRAM_RETRY_BASE_MS || "600") || 600,
  );
  TELEGRAM_CURL_CONNECT_TIMEOUT_SEC = Math.max(
    2,
    Number(process.env.TELEGRAM_CURL_CONNECT_TIMEOUT_SEC || "8") || 8,
  );
  TELEGRAM_CURL_POLL_TIMEOUT_SEC = Math.max(
    1,
    Number(process.env.TELEGRAM_CURL_POLL_TIMEOUT_SEC || "5") || 5,
  );
  TELEGRAM_CURL_FALLBACK = !["0", "false", "no"].includes(
    String(
      process.env.TELEGRAM_CURL_FALLBACK ||
        (process.platform === "win32" ? "false" : "true"),
    ).toLowerCase(),
  );
  const allowedIds = new Set([
    ...parseAllowedTelegramIds(
      process.env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.TELEGRAM_CHAT_IDS,
    ),
    ...parseAllowedTelegramIds(process.env.TELEGRAM_CHAT_ID),
  ]);
  telegramAllowedChatIds = allowedIds;
}
const AGENT_TIMEOUT_MS = (() => {
  const minRaw = Number(process.env.TELEGRAM_AGENT_TIMEOUT_MIN || "");
  if (Number.isFinite(minRaw) && minRaw > 0) return minRaw * 60 * 1000;
  const raw = Number(
    process.env.TELEGRAM_AGENT_TIMEOUT_MS ||
      process.env.PRIMARY_AGENT_TIMEOUT_MS ||
      process.env.INTERNAL_EXECUTOR_TIMEOUT_MS ||
      "",
  );
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 90 * 60 * 1000; // 90 min default
})();
let telegramPollLockHeld = false;
const presenceIntervalSec = Number(
  process.env.TELEGRAM_PRESENCE_INTERVAL_SEC || "60",
);
const presenceTtlSec = Number(
  process.env.TELEGRAM_PRESENCE_TTL_SEC || String(presenceIntervalSec * 3),
);
const presenceDisabled = ["1", "true", "yes"].includes(
  String(process.env.TELEGRAM_PRESENCE_DISABLED || "").toLowerCase(),
);
const presenceSilent = ["1", "true", "yes"].includes(
  String(process.env.TELEGRAM_PRESENCE_SILENT || "").toLowerCase(),
);
const presenceOnlyOnChange = ["1", "true", "yes"].includes(
  String(process.env.TELEGRAM_PRESENCE_ONLY_ON_CHANGE || "true").toLowerCase(),
);
const presenceChatId = process.env.TELEGRAM_PRESENCE_CHAT_ID;
const presenceTtlMs = Number.isFinite(presenceTtlSec)
  ? Math.max(0, presenceTtlSec * 1000)
  : 0;

console.log(
  `[telegram-bot] agent timeout set to ${Math.round(AGENT_TIMEOUT_MS / 60000)} min`,
);

// ── Message Batching Configuration ──────────────────────────────────────────
const batchingEnabled = !["0", "false", "no"].includes(
  String(process.env.TELEGRAM_BATCH_NOTIFICATIONS || "true").toLowerCase(),
);
const batchIntervalSec = Number(
  process.env.TELEGRAM_BATCH_INTERVAL_SEC || "300",
); // 5 minutes default
const batchMaxSize = Number(process.env.TELEGRAM_BATCH_MAX_SIZE || "50");
// Priority threshold: only messages >= this priority bypass batching (1=critical, 2=error, 3=warning, 4=info, 5=debug)
const immediateThreshold = Number(
  process.env.TELEGRAM_IMMEDIATE_PRIORITY || "1",
);

// ── Live Digest Configuration ──────────────────────────────────────────────
// Instead of batching and flushing, we maintain a single "live" Telegram message
// per digest window that gets continuously edited as new events arrive.
const liveDigestEnabled = !["0", "false", "no"].includes(
  String(process.env.TELEGRAM_LIVE_DIGEST || "true").toLowerCase(),
);
const liveDigestWindowSec = Number(
  process.env.TELEGRAM_LIVE_DIGEST_WINDOW_SEC || "1200",
); // 20 minutes default
const liveDigestEditDebounceMs = Number(
  process.env.TELEGRAM_LIVE_DIGEST_DEBOUNCE_MS || "3000",
); // 3 second debounce on edits

function delayMs(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function shouldUseCurlPrimary() {
  return (
    TELEGRAM_CURL_FALLBACK &&
    hasCurlBinary() &&
    Date.now() < telegramPreferCurlUntilMs
  );
}

function shouldPinCurlFallback(operation) {
  return String(operation || "") !== "getUpdates";
}

function toErrorCode(err) {
  return String(
    err?.cause?.code || err?.code || err?.cause?.name || err?.name || "",
  ).toUpperCase();
}

function isRetryableCurlFailure(err) {
  const message = String(err?.message || err || "").toLowerCase();
  if (!message.includes("curl")) return false;
  if (/curl:\s*\((6|7|28|35|52|56)\)/.test(message)) return true;
  return [
    "timed out",
    "timeout",
    "failed to connect",
    "couldn't connect",
    "could not resolve",
    "empty reply",
    "network is unreachable",
    "ssl connection timeout",
  ].some((fragment) => message.includes(fragment));
}

function isRetryableNetworkError(err) {
  const code = toErrorCode(err);
  if (
    [
      "ABORTERROR",
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code)
  ) {
    return true;
  }
  return isRetryableCurlFailure(err);
}

function getPollBackoffMs() {
  return Math.min(
    60_000,
    POLL_ERROR_BACKOFF_MS * 2 ** Math.min(5, Math.max(0, pollFailureStreak - 1)),
  );
}

function resetPollFailureStreak() {
  pollFailureStreak = 0;
}

function markPollFailure() {
  pollFailureStreak += 1;
}

function shouldLogPollError(now = Date.now()) {
  if (now - lastPollErrorLogAtMs < 60_000) return false;
  lastPollErrorLogAtMs = now;
  return true;
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

let _hasCurlBinary = null;
function hasCurlBinary() {
  if (_hasCurlBinary !== null) return _hasCurlBinary;
  try {
    const probe = spawnSync("curl", ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    _hasCurlBinary = probe?.status === 0;
  } catch {
    _hasCurlBinary = false;
  }
  return _hasCurlBinary;
}

function createTelegramResponse(status, bodyText) {
  const text = String(bodyText || "");
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: () => null },
    body: {
      cancel: async () => {},
    },
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text || "{}");
    },
  };
}

async function telegramApiFetchViaCurl(url, requestOptions = {}) {
  const {
    method: httpMethod = "POST",
    payload,
    timeoutMs = TELEGRAM_HTTP_TIMEOUT_MS,
    operation = "telegram-api",
  } = requestOptions;

  if (!hasCurlBinary()) {
    throw new Error("curl is not available for Telegram fallback");
  }

  const maxTimeSec = Math.max(5, Math.ceil(timeoutMs / 1000));
  const connectTimeSec = Math.max(
    2,
    Math.min(TELEGRAM_CURL_CONNECT_TIMEOUT_SEC, maxTimeSec - 1),
  );

  const args = [
    "--silent",
    "--show-error",
    "--location",
    "--request",
    String(httpMethod || "POST").toUpperCase(),
    "--connect-timeout",
    String(connectTimeSec),
    "--max-time",
    String(maxTimeSec),
    "--write-out",
    "\n__CODE__:%{http_code}",
    String(url),
  ];

  if (payload !== undefined) {
    args.push("--header", "Content-Type: application/json");
    args.push("--data", JSON.stringify(payload));
  }

  const result = spawnSync("curl", args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 8,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const errText = String(result.stderr || result.stdout || "").trim();
    throw new Error(
      `curl failed for ${operation}: ${errText || `exit ${result.status}`}`,
    );
  }

  const out = String(result.stdout || "");
  const marker = out.lastIndexOf("\n__CODE__:");
  if (marker === -1) {
    throw new Error(`curl response missing HTTP code marker for ${operation}`);
  }
  const body = out.slice(0, marker);
  const statusRaw = out.slice(marker + "\n__CODE__:".length).trim();
  const status = Number(statusRaw);
  if (!Number.isFinite(status)) {
    throw new Error(`invalid curl HTTP status for ${operation}: ${statusRaw}`);
  }
  return createTelegramResponse(status, body);
}

function parseRetryAfterMs(response) {
  const value = response?.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(30_000, seconds * 1000);
  }
  const absolute = Date.parse(value);
  if (!Number.isFinite(absolute)) return null;
  const delta = absolute - Date.now();
  return delta > 0 ? Math.min(30_000, delta) : null;
}

function calcRetryDelayMs(attempt, response) {
  const hinted = parseRetryAfterMs(response);
  if (hinted != null) return hinted;
  const expo = TELEGRAM_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * Math.min(1500, expo * 0.4));
  return Math.min(30_000, expo + jitter);
}

function createTelegramUrl(method, query = null) {
  const url = new URL(
    `/bot${telegramToken}/${method}`,
    `${TELEGRAM_API_BASE}/`,
  );
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function telegramApiFetch(method, requestOptions = {}) {
  refreshTelegramConfigFromEnv();
  const {
    method: httpMethod = "POST",
    payload,
    query,
    signal,
    timeoutMs = TELEGRAM_HTTP_TIMEOUT_MS,
    retries = TELEGRAM_RETRY_ATTEMPTS,
    retryOnStatus = true,
    operation = method,
  } = requestOptions;

  if (!telegramToken) {
    throw new Error("Telegram bot token missing");
  }

  const url = createTelegramUrl(method, query);
  if (shouldPinCurlFallback(operation) && shouldUseCurlPrimary()) {
    try {
      return await telegramApiFetchViaCurl(url, {
        method: httpMethod,
        payload,
        timeoutMs,
        operation,
      });
    } catch (curlErr) {
      if (!isRetryableNetworkError(curlErr)) throw curlErr;
      telegramPreferCurlUntilMs = 0;
    }
  }
  const maxAttempts = Math.max(1, retries);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => {
        try {
          controller.abort(new Error("timeout"));
        } catch {
          controller.abort();
        }
      },
      Math.max(1000, timeoutMs),
    );

    let abortListener = null;
    if (signal) {
      abortListener = () => {
        try {
          controller.abort(signal.reason || new Error("aborted"));
        } catch {
          controller.abort();
        }
      };
      if (signal.aborted) {
        abortListener();
      } else {
        signal.addEventListener("abort", abortListener, { once: true });
      }
    }

    try {
      const response = await fetchWithFallback(url, {
        method: httpMethod,
        headers: { "Content-Type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response || typeof response.ok === "undefined") {
        throw new Error(
          `[telegram-bot] ${operation} invalid response object (response=${!!response}, ok=${response?.ok})`,
        );
      }

      if (
        response.ok ||
        !retryOnStatus ||
        !isRetryableStatus(response.status) ||
        attempt >= maxAttempts
      ) {
        return response;
      }

      try {
        await response.body?.cancel?.();
      } catch {
        /* ignore */
      }

      const waitMs = calcRetryDelayMs(attempt, response);
      if (Date.now() - lastFallbackSwitchLogMs >= 300_000) {
        console.warn(
          `[telegram-bot] ${operation} retry ${attempt}/${maxAttempts} after HTTP ${response.status} (${waitMs}ms)`,
        );
      }
      await delayMs(waitMs);
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      const retryable = isRetryableNetworkError(err);
      if (TELEGRAM_CURL_FALLBACK && hasCurlBinary()) {
        const shouldPinCurl = shouldPinCurlFallback(operation);
        if (shouldPinCurl) {
          telegramPreferCurlUntilMs =
            Date.now() + TELEGRAM_FETCH_FAILURE_COOLDOWN_MS;
        }
        const now = Date.now();
        if (now - lastFallbackSwitchLogMs >= 300_000) {
          lastFallbackSwitchLogMs = now;
          console.warn(
            `[telegram-bot] fetch unavailable, using curl fallback: ${err?.message || err}`,
          );
        }
        try {
          return await telegramApiFetchViaCurl(url, {
            method: httpMethod,
            payload,
            timeoutMs,
            operation,
          });
        } catch (curlErr) {
          telegramPreferCurlUntilMs = 0;
          const curlRetryable = isRetryableNetworkError(curlErr);
          if (!curlRetryable || attempt >= maxAttempts) {
            throw curlErr;
          }
          const waitMs = calcRetryDelayMs(attempt);
          // Curl retry logging suppressed — the overall failure is logged once above
          await delayMs(waitMs);
          continue;
        }
      }
      if (!retryable || attempt >= maxAttempts) {
        throw err;
      }

      const waitMs = calcRetryDelayMs(attempt);
      if (Date.now() - lastFallbackSwitchLogMs >= 300_000) {
        console.warn(
          `[telegram-bot] ${operation} network retry ${attempt}/${maxAttempts}: ${err?.message || err} (${waitMs}ms)`,
        );
      }
      await delayMs(waitMs);
    } finally {
      clearTimeout(timeoutHandle);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  throw new Error(`Telegram request failed: ${operation}`);
}

function canSignalProcess(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireTelegramPollLock(owner) {
  if (telegramPollLockHeld) return true;
  try {
    const payload = JSON.stringify(
      { owner, pid: process.pid, started_at: new Date().toISOString() },
      null,
      2,
    );
    await writeFile(telegramPollLockPath, payload, { flag: "wx" });
    telegramPollLockHeld = true;
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      try {
        const raw = await readFile(telegramPollLockPath, "utf8");
        if (!raw || !raw.trim()) {
          // Empty/corrupt lock file — treat as stale
          await unlink(telegramPollLockPath);
          return await acquireTelegramPollLock(owner);
        }
        const data = JSON.parse(raw);
        const pid = Number(data?.pid);
        if (!canSignalProcess(pid)) {
          await unlink(telegramPollLockPath);
          return await acquireTelegramPollLock(owner);
        }
      } catch {
        // Lock file is corrupt/unparseable — remove and retry
        try {
          await unlink(telegramPollLockPath);
        } catch {
          /* ignore */
        }
        return await acquireTelegramPollLock(owner);
      }
    }
    return false;
  }
}

async function releaseTelegramPollLock() {
  if (!telegramPollLockHeld) return;
  telegramPollLockHeld = false;
  try {
    await unlink(telegramPollLockPath);
  } catch {
    /* best effort */
  }
}

// ── State ────────────────────────────────────────────────────────────────────

let lastUpdateId = 0;
let polling = false;
let pollAbort = null;
let presenceReady = false;
let workspaceRegistryPromise = null;
let localWorkspaceCache = null;
let telegramUiUrl = null;
let telegramWebAppUrl = null;
let telegramWebAppUrlWarned = "";
let lastMenuButtonUrl = null;
let menuButtonRefreshTimer = null;
const UI_TOKEN_TTL_MS = 30 * 60 * 1000;
const UI_INPUT_TTL_MS = 15 * 60 * 1000;
const uiTokenRegistry = new Map();
const uiInputRequests = new Map();

/**
 * Get the browser URL with the session token appended for auto-auth.
 * Falls back to the plain telegramUiUrl if no token is available.
 */
function getBrowserUiUrl() {
  const base = telegramUiUrl;
  if (!base) return null;
  const token = getSessionToken();
  if (!token) return base;
  return appendTokenToUrl(base, token) || base;
}

function syncUiUrlsFromServer() {
  const currentUiUrl = getTelegramUiUrl?.() || null;
  telegramUiUrl = currentUiUrl;
  telegramWebAppUrl = getTelegramWebAppUrl(currentUiUrl);
  return {
    uiUrl: telegramUiUrl,
    webAppUrl: telegramWebAppUrl,
  };
}

// ── Agent session state (for follow-up steering & bottom-pinning) ────────────

let activeAgentSession = null; // { chatId, messageId, taskPreview, abortController, followUpQueue, ... }
let agentMessageId = null; // current agent streaming message ID
let agentChatId = null; // chat where agent is running

// ── Sticky UI menu state (keep /menu accessible at bottom) ─────────────────
const stickyMenuState = new Map();
const stickyMenuTimers = new Map();
const STICKY_MENU_BUMP_MS = 1200;

// ── Queues ──────────────────────────────────────────────────────────────────

let fastCommandQueue = Promise.resolve();
let commandQueue = Promise.resolve();
let agentQueue = Promise.resolve();

function enqueueFastCommand(task) {
  fastCommandQueue = fastCommandQueue.then(task).catch((err) => {
    console.error(`[telegram-bot] fast command error: ${err.message || err}`);
  });
}

function enqueueCommand(task) {
  commandQueue = commandQueue.then(task).catch((err) => {
    console.error(`[telegram-bot] command error: ${err.message || err}`);
  });
}

function enqueueAgentTask(task) {
  agentQueue = agentQueue.then(task).catch((err) => {
    console.error(`[telegram-bot] agent error: ${err.message || err}`);
  });
}

async function getWorkspaceRegistryCached() {
  if (!workspaceRegistryPromise) {
    workspaceRegistryPromise = loadWorkspaceRegistry();
  }
  return workspaceRegistryPromise;
}

async function getLocalWorkspaceContext() {
  if (localWorkspaceCache) return localWorkspaceCache;
  const loaded = await getWorkspaceRegistryCached();
  const registry = loaded.registry || loaded;
  localWorkspaceCache = getLocalWorkspace(
    registry,
    process.env.VE_WORKSPACE_ID || "",
  );
  return localWorkspaceCache;
}

// ── External refs (injected by monitor.mjs) ──────────────────────────────────

let _sendTelegramMessage = null; // injected from monitor.mjs
let _readStatusData = null;
let _readStatusSummary = null;
let _getCurrentChild = null;
let _startProcess = null;
let _getVibeKanbanUrl = null;
let _fetchVk = null;
let _getRepoRoot = null;
let _startFreshSession = null;
let _attemptFreshSessionRetry = null;
let _buildRetryPrompt = null;
let _getActiveAttemptInfo = null;
let _triggerTaskPlanner = null;
let _reconcileTaskStatuses = null;
let _onDigestSealed = null;
let _getAnomalyReport = null;
let _getInternalExecutor = null;
let _getExecutorMode = null;
let _getAgentEndpoint = null;
let _getReviewAgent = null;
let _getReviewAgentEnabled = null;
let _getSyncEngine = null;
let _getErrorDetector = null;
let _getPrCleanupDaemon = null;
let _getWorkspaceMonitor = null;
let _getMonitorMonitorStatus = null;
let _getTaskStoreStats = null;
let _getTasksPendingReview = null;

/**
 * Inject monitor.mjs functions so the bot can send messages and read status.
 * Call this BEFORE startTelegramBot().
 */
export function injectMonitorFunctions({
  sendTelegramMessage,
  readStatusData,
  readStatusSummary,
  getCurrentChild,
  startProcess,
  getVibeKanbanUrl,
  fetchVk,
  getRepoRoot,
  startFreshSession,
  attemptFreshSessionRetry,
  buildRetryPrompt,
  getActiveAttemptInfo,
  triggerTaskPlanner,
  reconcileTaskStatuses,
  onDigestSealed,
  getAnomalyReport,
  getInternalExecutor,
  getExecutorMode,
  getAgentEndpoint,
  getReviewAgent,
  getReviewAgentEnabled,
  getSyncEngine,
  getErrorDetector,
  getPrCleanupDaemon,
  getWorkspaceMonitor,
  getMonitorMonitorStatus,
  getTaskStoreStats,
  getTasksPendingReview,
}) {
  refreshTelegramConfigFromEnv();
  _sendTelegramMessage = sendTelegramMessage;
  _readStatusData = readStatusData;
  _readStatusSummary = readStatusSummary;
  _getCurrentChild = getCurrentChild;
  _startProcess = startProcess;
  _getVibeKanbanUrl = getVibeKanbanUrl;
  _fetchVk = fetchVk;
  _getRepoRoot = getRepoRoot;
  _startFreshSession = startFreshSession;
  _attemptFreshSessionRetry = attemptFreshSessionRetry;
  _buildRetryPrompt = buildRetryPrompt;
  _getActiveAttemptInfo = getActiveAttemptInfo;
  _triggerTaskPlanner = triggerTaskPlanner;
  _reconcileTaskStatuses = reconcileTaskStatuses;
  _onDigestSealed = onDigestSealed || null;
  _getAnomalyReport = getAnomalyReport || null;
  _getInternalExecutor = getInternalExecutor || null;
  _getExecutorMode = getExecutorMode || null;
  _getAgentEndpoint = getAgentEndpoint || null;
  _getReviewAgent = getReviewAgent || null;
  _getReviewAgentEnabled = getReviewAgentEnabled || null;
  _getSyncEngine = getSyncEngine || null;
  _getErrorDetector = getErrorDetector || null;
  _getPrCleanupDaemon = getPrCleanupDaemon || null;
  _getWorkspaceMonitor = getWorkspaceMonitor || null;
  _getMonitorMonitorStatus = getMonitorMonitorStatus || null;
  _getTaskStoreStats = getTaskStoreStats || null;
  _getTasksPendingReview = getTasksPendingReview || null;
}

/**
 * Called by monitor.mjs when a notification is sent while the agent is streaming.
 * Re-sends the agent message so it stays at the bottom of the chat.
 */
export async function bumpAgentMessage() {
  if (!activeAgentSession || activeAgentSession.background) return;
  if (!agentMessageId || !agentChatId) return;
  try {
    // Delete the old message
    await deleteDirect(agentChatId, agentMessageId);
  } catch {
    /* best effort */
  }
  // Re-send at bottom
  const session = activeAgentSession;
  const msg = buildStreamMessage({
    taskPreview: session.taskPreview,
    actionLog: session.actionLog,
    currentThought: session.currentThought,
    totalActions: session.totalActions,
    phase: session.phase,
    finalResponse: null,
  });
  const newId = await sendDirect(agentChatId, msg);
  if (newId) {
    agentMessageId = newId;
    session.messageId = newId;
  }
}

/**
 * Check if agent is active (for external callers like monitor.mjs).
 */
export function isAgentActive() {
  return !!activeAgentSession;
}

function setStickyMenuState(chatId, patch) {
  if (!chatId) return;
  const current = stickyMenuState.get(chatId) || {};
  stickyMenuState.set(chatId, { ...current, ...patch });
}

function isStickyMenuMessage(chatId, messageId) {
  if (!chatId || !messageId) return false;
  const state = stickyMenuState.get(chatId);
  if (!state?.enabled || !state?.messageId) return false;
  return String(state.messageId) === String(messageId);
}

function isStaleStickyMenuMessage(chatId, messageId) {
  if (!chatId || !messageId) return false;
  const state = stickyMenuState.get(chatId);
  if (!state?.enabled || !state?.messageId) return false;
  return String(state.messageId) !== String(messageId);
}

function ensureStickyMenuEnabled(chatId, messageId, screenId, params) {
  const state = stickyMenuState.get(chatId);
  if (state?.enabled) return true;
  if (!messageId) return false;
  setStickyMenuState(chatId, {
    enabled: true,
    messageId,
    screenId: screenId || state?.screenId || "home",
    params: params || state?.params || {},
  });
  return true;
}

function scheduleStickyMenuBump(chatId, lastMessageId) {
  const state = stickyMenuState.get(chatId);
  if (!state?.enabled || !state?.screenId) return;
  if (lastMessageId && state.messageId && lastMessageId === state.messageId)
    return;
  if (stickyMenuTimers.has(chatId)) return;
  const timer = setTimeout(() => {
    stickyMenuTimers.delete(chatId);
    bumpStickyMenu(chatId).catch(() => {});
  }, STICKY_MENU_BUMP_MS);
  stickyMenuTimers.set(chatId, timer);
}

async function bumpStickyMenu(chatId) {
  const state = stickyMenuState.get(chatId);
  if (!state?.enabled || !state?.screenId) return;
  await showUiScreen(chatId, null, state.screenId, state.params || {}, {
    sticky: true,
  });
}

// ── Telegram API Helpers ─────────────────────────────────────────────────────

async function sendReply(chatId, text, options = {}) {
  // If monitor's sendTelegramMessage is available, use it (handles dedup & history)
  if (_sendTelegramMessage) {
    // Bypass dedup for direct replies
    await sendDirect(chatId, text, options);
    return;
  }
  await sendDirect(chatId, text, options);
}

async function sendDirect(chatId, text, options = {}) {
  if (!telegramToken) return null;
  const skipSticky = options.skipSticky;

  // Split long messages
  const chunks = splitMessage(text, MAX_MESSAGE_LEN);
  let lastMessageId = null;
  for (const chunk of chunks) {
    const payload = {
      chat_id: chatId,
      text: chunk,
    };
    if (options.parseMode) {
      payload.parse_mode = options.parseMode;
    }
    if (options.silent) {
      payload.disable_notification = true;
    }
    payload.disable_web_page_preview = true;
    if (options.reply_markup) {
      payload.reply_markup = sanitizeWebAppButtons(options.reply_markup);
    }

    let res;
    try {
      res = await telegramApiFetch("sendMessage", {
        method: "POST",
        payload,
        operation: "sendMessage",
      });
    } catch (err) {
      console.warn(`[telegram-bot] send error: ${err.message}`);
      continue;
    }

    // Safety: validate response object
    if (!res || typeof res.ok === "undefined") {
      console.warn(`[telegram-bot] send error: invalid response object`);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[telegram-bot] send failed: ${res.status} ${body}`);
      // If HTML parse mode fails, retry as plain text
      if (options.parseMode && res.status === 400) {
        return sendDirect(chatId, chunk, {
          ...options,
          parseMode: undefined,
        });
      }
    } else {
      try {
        const data = await res.json();
        if (data.ok && data.result?.message_id) {
          lastMessageId = data.result.message_id;
        }
      } catch (err) {
        console.warn(`[telegram-bot] send JSON parse error: ${err.message}`);
      }
    }
  }
  if (!skipSticky && lastMessageId) {
    scheduleStickyMenuBump(chatId, lastMessageId);
  }
  return lastMessageId;
}

/**
 * Edit an existing Telegram message in-place.
 * Falls back to sending a new message if the edit fails (message too old, etc.).
 */
async function editDirect(chatId, messageId, text, options = {}) {
  if (!telegramToken || !messageId) return messageId;

  // Telegram editMessageText has 4096 char limit — truncate if needed
  const truncated =
    text.length > MAX_MESSAGE_LEN
      ? text.slice(0, MAX_MESSAGE_LEN - 20) + "\n\n…(truncated)"
      : text;

  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: truncated,
    disable_web_page_preview: true,
  };
  if (options.parseMode) {
    payload.parse_mode = options.parseMode;
  }
  if (options.reply_markup) {
    payload.reply_markup = sanitizeWebAppButtons(options.reply_markup);
  }

  let res;
  try {
    res = await telegramApiFetch("editMessageText", {
      method: "POST",
      payload,
      operation: "editMessageText",
    });
  } catch (err) {
    console.warn(`[telegram-bot] edit error: ${err.message}`);
    return messageId;
  }

  // Safety: validate response object
  if (!res || typeof res.ok === "undefined") {
    console.warn(`[telegram-bot] edit error: invalid response object`);
    return messageId;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // "message is not modified" is fine — content didn't change
    if (body.includes("message is not modified")) return messageId;
    // "message can't be edited" — send new message instead
    if (
      body.includes("can't be edited") ||
      body.includes("MESSAGE_ID_INVALID")
    ) {
      console.warn(`[telegram-bot] edit failed, sending new message`);
      return await sendDirect(chatId, truncated, options);
    }
    console.warn(`[telegram-bot] edit failed: ${res.status} ${body}`);
    // For HTML parse errors, retry without parse mode
    if (options.parseMode && res.status === 400) {
      return editDirect(chatId, messageId, truncated, {
        ...options,
        parseMode: undefined,
      });
    }
  }
  return messageId;
}

// ── Action Summarizer ────────────────────────────────────────────────────────

/**
 * Delete a Telegram message. Best-effort, failures are silently ignored.
 */
async function deleteDirect(chatId, messageId) {
  if (!telegramToken || !messageId) return;
  try {
    await telegramApiFetch("deleteMessage", {
      method: "POST",
      payload: { chat_id: chatId, message_id: messageId },
      operation: "deleteMessage",
    });
  } catch {
    /* best effort */
  }
}

/**
 * Answer a Telegram callback query (required to dismiss the "loading" indicator).
 * @param {string} callbackQueryId - The callback_query.id from the update
 * @param {string} [text] - Optional toast notification text
 * @param {boolean} [showAlert] - Show as alert popup instead of toast
 */
async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
  if (!telegramToken || !callbackQueryId) return;
  const payload = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;
  if (showAlert) payload.show_alert = showAlert;
  try {
    await telegramApiFetch("answerCallbackQuery", {
      method: "POST",
      payload,
      operation: "answerCallbackQuery",
    });
  } catch (err) {
    console.warn(`[telegram-bot] answerCallbackQuery error: ${err.message}`);
  }
}

/**
 * Extract a short filename from a path (last 2 segments for context).
 */
function shortPath(p) {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : parts.join("/");
}

/**
 * Extract a file path target from a command string (first path-like argument).
 */
function extractTarget(cmd) {
  if (!cmd) return "";
  // Match file paths (containing / or \ and a file extension, or known directories)
  const m = cmd.match(
    /(?:['"])?([\w.\-/\\]+\.(?:ps1|mjs|js|ts|go|json|yaml|yml|md|log|txt|toml|sh))(?:['"])?/i,
  );
  if (m) return shortPath(m[1]);
  // Match directory paths
  const d = cmd.match(
    /(?:(?:Get-Content|cat|head|tail|type|Select-String)\s+(?:-Path\s+)?['"]?)([\w.\-/\\]+)/i,
  );
  if (d) return shortPath(d[1]);
  return "";
}

function normalizeToolName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function getCopilotToolInfo(event) {
  const data = event?.data || {};
  const toolName =
    data.toolName ||
    data.name ||
    data.tool?.name ||
    event?.toolName ||
    event?.tool ||
    "";
  const input =
    data.input ||
    data.args ||
    data.parameters ||
    data.toolInput ||
    data.payload ||
    null;
  const output = data.output || data.result || data.toolOutput || null;
  const status = data.status || event?.status || "";
  return { toolName: String(toolName || ""), input, output, status };
}

function extractCopilotCommand(input) {
  if (!input) return null;
  if (typeof input === "string") return input;
  const candidates = [
    "command",
    "cmd",
    "shell",
    "script",
    "execute",
    "args",
    "run",
  ];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function extractCopilotPath(input) {
  if (!input) return null;
  if (typeof input === "string") return input;
  const candidates = [
    "path",
    "file",
    "filename",
    "filepath",
    "filePath",
    "fullPath",
    "target",
  ];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function isCopilotReadTool(name) {
  const tool = normalizeToolName(name);
  return /read|open|view|get_file|read_file/.test(tool);
}

function isCopilotWriteTool(name) {
  const tool = normalizeToolName(name);
  return /write|edit|apply|patch|create|update|save/.test(tool);
}

function isCopilotSearchTool(name) {
  const tool = normalizeToolName(name);
  return /search|grep|rg|find|query/.test(tool);
}

function summarizeCopilotTool(toolName, input) {
  const tool = normalizeToolName(toolName);
  const command = extractCopilotCommand(input);
  const target = extractCopilotPath(input);
  if (!toolName) return "running tool";
  if (/command|shell|execute|run/.test(tool)) {
    return command ? `running ${shortSnippet(command, 80)}` : "running command";
  }
  if (isCopilotReadTool(tool)) {
    return target ? `reading ${shortPath(target)}` : "reading file";
  }
  if (isCopilotWriteTool(tool)) {
    return target ? `updating ${shortPath(target)}` : "updating files";
  }
  if (isCopilotSearchTool(tool)) {
    return target ? `searching ${shortPath(target)}` : "searching";
  }
  if (/mcp/.test(tool)) return `MCP tool: ${toolName}`;
  return `tool: ${toolName}`;
}

/**
 * Convert a raw agent event into a concise human-readable action description.
 * Shows which files are being read/written, line counts for changes, and
 * concise command summaries with targets.
 */
function summarizeAction(event) {
  if (!event) return null;

  switch (event.type) {
    case "item.started": {
      const item = event.item;
      switch (item.type) {
        case "command_execution": {
          const desc = summarizeCommand(item.command);
          const target = extractTarget(item.command);
          return {
            icon: "⚡",
            text: target ? `${desc} → ${target}` : desc,
            phase: "running",
          };
        }
        case "mcp_tool_call":
          return {
            icon: "🔌",
            text: `MCP: ${item.server}/${item.tool}`,
            phase: "running",
          };
        case "reasoning":
          return item.text
            ? { icon: "💭", text: item.text.slice(0, 200), phase: "thinking" }
            : null;
        case "web_search":
          return {
            icon: "🔍",
            text: `Searching: ${item.query?.slice(0, 80)}`,
            phase: "searching",
          };
        case "todo_list":
          return item.items?.length
            ? {
                icon: "📋",
                text: `Planning ${item.items.length} steps`,
                phase: "planning",
              }
            : null;
        default:
          return null;
      }
    }

    case "item.completed": {
      const item = event.item;
      switch (item.type) {
        case "command_execution": {
          const ok = item.exit_code === 0;
          const desc = summarizeCommand(item.command);
          const target = extractTarget(item.command);
          const label = target ? `${desc} → ${target}` : desc;
          return {
            icon: ok ? "✅" : "❌",
            text: label + (ok ? "" : ` (exit ${item.exit_code})`),
            phase: "done",
          };
        }
        case "file_change": {
          if (item.changes?.length) {
            const fileDescs = item.changes.map((c) => {
              const name = shortPath(c.path);
              const kind =
                c.kind === "add" ? "➕" : c.kind === "delete" ? "🗑️" : "✏️";
              // Show line counts if available
              const adds = c.additions ?? c.lines_added ?? 0;
              const dels = c.deletions ?? c.lines_deleted ?? 0;
              const stats = adds || dels ? ` (+${adds} -${dels})` : "";
              return `${kind} ${name}${stats}`;
            });
            return {
              icon: "📁",
              text: fileDescs.join(", "),
              phase: "done",
              detail: "file_change",
              files: item.changes.map((c) => ({
                path: c.path,
                kind: c.kind,
                adds: c.additions ?? c.lines_added ?? 0,
                dels: c.deletions ?? c.lines_deleted ?? 0,
              })),
            };
          }
          return null;
        }
        case "mcp_tool_call": {
          const ok = item.status === "completed";
          return {
            icon: ok ? "✅" : "❌",
            text: `MCP ${item.server}/${item.tool}: ${ok ? "done" : "failed"}`,
            phase: "done",
          };
        }
        case "agent_message":
          return null; // final response handled separately
        default:
          return null;
      }
    }

    case "assistant.reasoning":
    case "assistant.reasoning_delta": {
      const text = event.data?.content || event.data?.deltaContent || "";
      return text
        ? { icon: "💭", text: text.slice(0, 200), phase: "thinking" }
        : null;
    }

    case "tool.execution_start": {
      const { toolName, input } = getCopilotToolInfo(event);
      return {
        icon: "🛠️",
        text: summarizeCopilotTool(toolName, input),
        phase: "running",
      };
    }

    case "tool.execution_complete": {
      const { toolName, input, status } = getCopilotToolInfo(event);
      const ok =
        !status ||
        ["ok", "success", "completed", "done"].includes(
          String(status).toLowerCase(),
        );
      return {
        icon: ok ? "✅" : "❌",
        text: summarizeCopilotTool(toolName, input) + (ok ? "" : " (failed)"),
        phase: "done",
      };
    }

    case "session.error":
      return {
        icon: "❌",
        text: `Failed: ${event.data?.message || "unknown"}`,
        phase: "error",
      };

    case "item.updated": {
      const item = event.item;
      if (item.type === "reasoning" && item.text) {
        return { icon: "💭", text: item.text.slice(0, 200), phase: "thinking" };
      }
      if (item.type === "todo_list" && item.items) {
        const done = item.items.filter((t) => t.completed).length;
        return {
          icon: "📋",
          text: `Progress: ${done}/${item.items.length} steps`,
          phase: "planning",
        };
      }
      return null;
    }

    case "turn.failed":
      return {
        icon: "❌",
        text: `Failed: ${event.error?.message || "unknown"}`,
        phase: "error",
      };
    default:
      return null;
  }
}

/**
 * Convert raw command strings into concise human-readable descriptions.
 */
function summarizeCommand(cmd) {
  if (!cmd) return "(unknown command)";
  const c = cmd.trim();
  const cmdLower = c.toLowerCase();
  const clean = c.replace(/\s+/g, " ").trim();

  // Git commands
  if (/^git\s+diff/i.test(c)) return "checking git diff";
  if (/^git\s+log/i.test(c)) return "reading git log";
  if (/^git\s+branch/i.test(c)) return "listing git branches";
  if (/^git\s+status/i.test(c)) return "checking git status";
  if (/^git\s+add/i.test(c)) return "staging files";
  if (/^git\s+commit/i.test(c)) return "committing changes";
  if (/^git\s+push/i.test(c)) return "pushing to remote";
  if (/^git\s+pull/i.test(c)) return "pulling from remote";
  if (/^git\s+checkout/i.test(c)) return "switching branch";
  if (/^git\s+merge/i.test(c)) return "merging branches";
  if (/^git\s+stash/i.test(c)) return "stashing changes";

  // PowerShell / search patterns
  if (/pwsh.*-file/i.test(c)) {
    const target = extractTarget(c);
    return target
      ? `running PowerShell file ${target}`
      : "running PowerShell file";
  }
  if (/pwsh.*Get-Content/i.test(c)) {
    const target = extractTarget(c);
    return target ? `reading ${target}` : "reading file contents";
  }
  if (/pwsh.*Select-String/i.test(c)) {
    const target = extractTarget(c);
    const patternMatch = c.match(/-Pattern\s+["']?([^"']+)["']?/i);
    const pattern = patternMatch ? patternMatch[1].slice(0, 40) : null;
    if (target && pattern) return `searching "${pattern}" in ${target}`;
    return target ? `searching in ${target}` : "searching in files";
  }
  if (/pwsh.*Get-ChildItem.*Select-String/i.test(c))
    return "searching across files";
  if (/pwsh/i.test(c) || /powershell/i.test(c))
    return describePowerShell(clean);

  // Node/npm/pnpm
  if (/^node\s+-[ec]/i.test(c))
    return `running Node.js script: ${shortSnippet(clean, 60)}`;
  if (/^npm\s+/i.test(c)) return `running npm: ${shortSnippet(clean, 60)}`;
  if (/^pnpm\s+/i.test(c)) return `running pnpm: ${shortSnippet(clean, 60)}`;

  // Go
  if (/^go\s+test/i.test(c)) {
    const pkgs = extractGoPackages(c);
    return pkgs ? `running Go tests: ${pkgs}` : "running Go tests";
  }
  if (/^go\s+build/i.test(c)) {
    const pkgs = extractGoPackages(c);
    return pkgs ? `building Go: ${pkgs}` : "building Go project";
  }
  if (/^go\s+vet/i.test(c)) {
    const pkgs = extractGoPackages(c);
    return pkgs ? `vetting Go: ${pkgs}` : "vetting Go code";
  }
  if (/^go\s+/i.test(c)) return `running Go: ${shortSnippet(clean, 60)}`;

  // Make
  if (/^make\s+/i.test(c))
    return `running make ${c.split(/\s+/)[1] || ""}`.trim();

  // gh CLI
  if (/^gh\s+pr/i.test(c)) return "managing GitHub PR";
  if (/^gh\s+issue/i.test(c)) return "managing GitHub issue";
  if (/^gh\s+/i.test(c)) return `running gh: ${shortSnippet(clean, 60)}`;

  // cat/head/tail/grep/find/ls
  if (/^(cat|head|tail|type)\s+/i.test(c)) {
    const target = extractTarget(c);
    return target ? `reading ${target}` : "reading file";
  }
  if (/^(grep|findstr|rg)\s+/i.test(c)) {
    const target = extractTarget(c);
    const pat = c.match(/(['"])(.*?)\1/);
    const pattern = pat ? pat[2].slice(0, 40) : null;
    if (target && pattern) return `searching "${pattern}" in ${target}`;
    return target ? `searching in ${target}` : "searching in files";
  }
  if (/^(find|fd)\s+/i.test(c)) return "finding files";
  if (/^(ls|dir|Get-ChildItem)\s*/i.test(c)) return "listing directory";

  // Docker
  if (/^docker\s+/i.test(c))
    return `running docker: ${shortSnippet(clean, 60)}`;

  // Fallback: first word + truncated
  const firstWord = c.split(/\s+/)[0];
  if (firstWord.length < 20)
    return `running ${firstWord}: ${shortSnippet(clean, 60)}`;
  return shortSnippet(clean, 80);
}

function shortSnippet(text, maxLen = 80) {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

function describePowerShell(command) {
  const cmd = command;
  const cmdMatch = cmd.match(/-Command\s+(.+)/i);
  const fileMatch = cmd.match(/-File\s+([^\s]+)/i);
  if (fileMatch) {
    const target = shortPath(fileMatch[1]);
    return `running PowerShell file ${target}`;
  }
  if (cmdMatch) {
    const inner = cmdMatch[1].replace(/^['"]|['"]$/g, "");
    const target = extractTarget(inner);
    const snippet = shortSnippet(inner, 70);
    return target
      ? `running PowerShell: ${snippet} → ${target}`
      : `running PowerShell: ${snippet}`;
  }
  return "running PowerShell command";
}

function extractGoPackages(command) {
  const parts = command.split(/\s+/).filter(Boolean);
  const pkgs = parts.filter((p) => p.startsWith("./") || p.includes("/"));
  if (!pkgs.length) return "";
  const unique = [...new Set(pkgs)];
  return unique.slice(0, 3).join(" ") + (unique.length > 3 ? " …" : "");
}

/**
 * Strip web_app buttons whose URL is not HTTPS — Telegram rejects non-HTTPS
 * web_app URLs with a 400 error.  Returns the sanitized reply_markup object.
 */
function sanitizeWebAppButtons(markup) {
  if (!markup || !markup.inline_keyboard) return markup;
  const filtered = markup.inline_keyboard
    .map((row) =>
      row.filter((btn) => {
        if (btn.web_app && btn.web_app.url) {
          try {
            const u = new URL(btn.web_app.url);
            if (u.protocol !== "https:") return false;
          } catch {
            return false;
          }
        }
        return true;
      }),
    )
    .filter((row) => row.length > 0);
  return { ...markup, inline_keyboard: filtered };
}

function splitMessage(text, maxLen) {
  if (!text) return ["(empty response)"];
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at newline
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen; // no good newline, hard split
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}

// ── UI Menu Helpers ─────────────────────────────────────────────────────────

function pruneUiTokens() {
  const now = Date.now();
  for (const [token, entry] of uiTokenRegistry.entries()) {
    if (!entry || entry.expiresAt <= now) {
      uiTokenRegistry.delete(token);
    }
  }
}

function issueUiToken(payload, ttlMs = UI_TOKEN_TTL_MS) {
  pruneUiTokens();
  let token = "";
  for (let i = 0; i < 8; i += 1) {
    token = Math.random().toString(36).slice(2, 8);
    if (token && !uiTokenRegistry.has(token)) break;
  }
  uiTokenRegistry.set(token, {
    payload,
    expiresAt: Date.now() + ttlMs,
  });
  return token;
}

function readUiToken(token) {
  const entry = uiTokenRegistry.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    uiTokenRegistry.delete(token);
    return null;
  }
  return entry.payload || null;
}

function setPendingUiInput(chatId, request) {
  if (!chatId || !request) return;
  uiInputRequests.set(String(chatId), {
    ...request,
    expiresAt: Date.now() + UI_INPUT_TTL_MS,
  });
}

function getPendingUiInput(chatId) {
  const key = String(chatId || "");
  const entry = uiInputRequests.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    uiInputRequests.delete(key);
    return null;
  }
  return entry;
}

function clearPendingUiInput(chatId) {
  uiInputRequests.delete(String(chatId || ""));
}

function consumePendingUiInput(chatId) {
  const key = String(chatId || "");
  const entry = getPendingUiInput(key);
  if (entry) uiInputRequests.delete(key);
  return entry;
}

// ── Polling ──────────────────────────────────────────────────────────────────

async function pollUpdates() {
  if (!telegramToken) return [];
  const effectivePollTimeoutS =
    shouldUseCurlPrimary()
      ? Math.min(POLL_TIMEOUT_S, TELEGRAM_CURL_POLL_TIMEOUT_SEC)
      : POLL_TIMEOUT_S;

  pollAbort = new AbortController();
  let res;
  try {
    res = await telegramApiFetch("getUpdates", {
      method: "POST",
      payload: {
        offset: String(lastUpdateId + 1),
        timeout: String(effectivePollTimeoutS),
        allowed_updates: JSON.stringify(["message", "callback_query"]),
      },
      signal: pollAbort.signal,
      timeoutMs: Math.max(
        TELEGRAM_HTTP_TIMEOUT_MS,
        effectivePollTimeoutS * 1000 + 15_000,
      ),
      retries: TELEGRAM_RETRY_ATTEMPTS,
      operation: "getUpdates",
    });
  } catch (err) {
    if (err.name === "AbortError" || !polling) return [];
    markPollFailure();
    const now = Date.now();
    if (shouldLogPollError(now)) {
      console.warn(`[telegram-bot] poll error: ${err.message}`);
    }
    if (polling) await delayMs(getPollBackoffMs());
    return [];
  } finally {
    pollAbort = null;
  }

  // Safety: validate response object
  if (!res || typeof res.ok === "undefined") {
    markPollFailure();
    console.warn(`[telegram-bot] poll error: invalid response object`);
    if (polling) await delayMs(getPollBackoffMs());
    return [];
  }

  if (!res.ok) {
    markPollFailure();
    const body = await res.text().catch(() => "");
    console.warn(`[telegram-bot] getUpdates failed: ${res.status} ${body}`);
    if (res.status === 409) {
      polling = false;
      await releaseTelegramPollLock();
      return [];
    }
    if (polling) await delayMs(getPollBackoffMs());
    return [];
  }
  resetPollFailureStreak();
  if (!telegramApiReachable) {
    telegramApiReachable = true;
    // API came back — register commands that were deferred at startup
    registerBotCommands().catch(() => {});
  }

  try {
    const data = await res.json();
    return data.ok ? data.result || [] : [];
  } catch (err) {
    console.warn(`[telegram-bot] poll JSON parse error: ${err.message}`);
    return [];
  }
}

// ── Update Handling ──────────────────────────────────────────────────────────

/**
 * Handle Telegram inline keyboard button presses (callback_query).
 * Routes callback data to the appropriate command handler.
 */
async function handleCallbackQuery(query) {
  const chatId = String(query.message?.chat?.id || "");
  const fromId = String(query.from?.id || "");
  const data = query.data || "";
  const callbackId = query.id;

  // Security: only accept from configured chat/user allow-list
  if (!isAuthorizedTelegramActor(chatId, fromId)) {
    await answerCallbackQuery(callbackId, "Unauthorized", true);
    return;
  }

  console.log(`[telegram-bot] callback: "${data}" from chat ${chatId}`);

  // Always acknowledge the callback to dismiss loading indicator
  await answerCallbackQuery(callbackId);

  if (data.startsWith("ui:")) {
    await handleUiAction({
      chatId,
      messageId: query.message?.message_id,
      data,
    });
    return;
  }

  // Route callback data as if it were a slash command
  if (data.startsWith("/")) {
    const cmd = data.split(/\s+/)[0].toLowerCase().replace(/@\w+/, "");
    if (FAST_COMMANDS.has(cmd)) {
      enqueueFastCommand(() => handleCommand(data, chatId));
    } else {
      enqueueCommand(() => handleCommand(data, chatId));
    }
    return;
  }

  // Handle special callback prefixes
  if (data === "cb:confirm_pause") {
    enqueueCommand(() => cmdPauseTasks(chatId));
    return;
  }
  if (data === "cb:confirm_resume") {
    enqueueCommand(() => cmdResumeTasks(chatId));
    return;
  }
  if (data === "cb:confirm_restart") {
    await sendReply(
      chatId,
      "⚠️ Restart will stop the orchestrator process and let the monitor respawn it.\nProceed?",
      { reply_markup: buildConfirmKeyboard("cb:do_restart", "Confirm Restart") },
    );
    return;
  }
  if (data === "cb:do_restart") {
    enqueueCommand(() => handleCommand("/restart --confirm", chatId));
    return;
  }
  if (data === "cb:confirm_clear") {
    enqueueCommand(() => handleCommand("/clear --confirm", chatId));
    return;
  }
  if (data === "cb:confirm_cleanup") {
    enqueueCommand(() => handleCommand("/cleanup --confirm", chatId));
    return;
  }
  if (data === "cb:confirm_threads_clear") {
    enqueueCommand(() => handleCommand("/threads clear --confirm", chatId));
    return;
  }
  if (data === "cb:confirm_stop") {
    enqueueCommand(() => handleCommand("/stop --confirm", chatId));
    return;
  }
  if (data === "cb:dismiss") {
    // Delete the message with the buttons
    if (query.message?.message_id) {
      await deleteDirect(chatId, query.message.message_id);
    }
    return;
  }
  if (data.startsWith("cb:confirm_action:")) {
    const token = data.slice("cb:confirm_action:".length);
    const payload = readUiToken(token);
    if (!payload || payload.type !== "confirm_cmd") {
      if (query.message?.message_id) {
        await deleteDirect(chatId, query.message.message_id);
      }
      await sendReply(chatId, "⏳ That action expired. Please try again.");
      return;
    }
    uiTokenRegistry.delete(token);
    if (query.message?.message_id) {
      await deleteDirect(chatId, query.message.message_id);
    }
    await dispatchUiCommand(chatId, payload.command);
    return;
  }

  if (data === "fw:open") {
    const fwState = getFirewallState();
    if (!fwState || !fwState.blocked) {
      await sendReply(chatId, "✅ Port is already open or no firewall detected.");
      return;
    }
    await sendReply(
      chatId,
      `🔧 Attempting to open port via \`${fwState.firewall}\`...\n` +
      `Please enter your admin password on the server if prompted.`,
      { parseMode: "Markdown" },
    );
    const result = await openFirewallPort(
      Number(new URL(getTelegramUiUrl() || "http://localhost:5511").port || 5511),
    );
    if (result.success) {
      await sendReply(chatId, `✅ ${result.message}\nThe Control Center should now be reachable.`);
    } else {
      await sendReply(
        chatId,
        `⚠️ Auto-fix failed.\n\n${result.message}`,
        { parseMode: "Markdown" },
      );
    }
    return;
  }

  // Fallback: treat as command text
  await sendReply(chatId, `Unknown button action: ${data}`);
}

async function handleUpdate(update) {
  // Handle inline keyboard button presses
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  if (!update.message) return;

  const msg = update.message;
  const chatId = String(msg.chat?.id);
  const fromId = String(msg.from?.id || "");
  const text = (msg.text || "").trim();

  const presencePayload = text ? parsePresenceMessage(text) : null;
  if (presencePayload) {
    if (!presenceChatId || chatId !== String(presenceChatId)) {
      console.warn(
        `[telegram-bot] ignored presence from chat ${chatId} (expected ${presenceChatId || "unset"})`,
      );
      return;
    }
    await ensurePresenceReady();
    const receivedAt = Number.isFinite(msg.date)
      ? new Date(msg.date * 1000).toISOString()
      : new Date().toISOString();
    await notePresence(presencePayload, {
      source: "telegram",
      receivedAt,
    });
    return;
  }

  // Security: only accept from configured chat/user allow-list
  if (!isAuthorizedTelegramActor(chatId, fromId)) {
    console.warn(
      `[telegram-bot] rejected message from chat ${chatId} user ${fromId || "unknown"} (allowed: ${Array.from(telegramAllowedChatIds).join(",") || "none"})`,
    );
    return;
  }

  if (msg.web_app_data?.data) {
    await handleWebAppData(msg.web_app_data.data, chatId);
    return;
  }

  if (!text) return;

  console.log(
    `[telegram-bot] received: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}" from chat ${chatId}`,
  );

  const pendingInput = getPendingUiInput(chatId);
  if (pendingInput) {
    const cmdText = text.split(/\s+/)[0].toLowerCase().replace(/@\w+/, "");
    if (cmdText === "/cancel") {
      clearPendingUiInput(chatId);
      await sendReply(chatId, "✅ Input cancelled.");
      return;
    }
    if (!text.startsWith("/")) {
      const request = consumePendingUiInput(chatId);
      if (request) {
        await handleUiInput(chatId, request, text);
        return;
      }
    }
  }

  // Route: slash command or free-text
  if (text.startsWith("/")) {
    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+/, "");
    if (FAST_COMMANDS.has(cmd)) {
      enqueueFastCommand(() => handleCommand(text, chatId));
      return;
    }
    enqueueCommand(() => handleCommand(text, chatId));
    return;
  }

  // Free-text agent task runs in a separate queue so polling isn't blocked.
  // If agent is already busy, handle immediately so follow-ups can be queued.
  if (isPrimaryBusy()) {
    void handleFreeText(text, chatId);
    return;
  }
  enqueueAgentTask(() => handleFreeText(text, chatId));
}

// ── Command Router ────────────────────────────────────────────────────────────

// ── Task Pause / Resume / Repos ──────────────────────────────────────────────

/**
 * /pausetasks — Pause the task executor (running agents continue, no new dispatch)
 */
async function cmdPauseTasks(chatId) {
  const executor = _getInternalExecutor?.();
  if (!executor) {
    return sendDirect(
      chatId,
      "⚠️ Internal executor not enabled — nothing to pause.",
    );
  }
  if (executor.isPaused()) {
    const info = executor.getPauseInfo();
    const dur = info.pauseDuration;
    return sendDirect(
      chatId,
      `⏸ Already paused (${dur >= 60 ? Math.round(dur / 60) + "m" : dur + "s"} ago).\nUse /resumetasks to resume.`,
    );
  }
  executor.pause();
  const status = executor.getStatus();
  const lines = [`⏸ *Task executor paused*`];
  if (status.activeSlots > 0) {
    lines.push(
      `\n${status.activeSlots} running task(s) will continue to completion.`,
    );
    lines.push(`No new tasks will be dispatched until /resumetasks.`);
  } else {
    lines.push(`No tasks running. Use /resumetasks when ready.`);
  }
  const keyboard = {
    inline_keyboard: [
      [
        { text: "▶️ Resume Tasks", callback_data: "cb:confirm_resume" },
        { text: "📊 Status", callback_data: "/status" },
      ],
    ],
  };
  return sendDirect(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

/**
 * /resumetasks — Resume the task executor
 */
async function cmdResumeTasks(chatId) {
  const executor = _getInternalExecutor?.();
  if (!executor) {
    return sendDirect(
      chatId,
      "⚠️ Internal executor not enabled — nothing to resume.",
    );
  }
  if (!executor.isPaused()) {
    return sendDirect(chatId, "▶️ Executor is already running — not paused.");
  }
  const info = executor.getPauseInfo();
  const dur = info.pauseDuration;
  executor.resume();
  const durStr = dur >= 60 ? Math.round(dur / 60) + "m" : dur + "s";
  const keyboard = {
    inline_keyboard: [
      [
        { text: "⏸ Pause Tasks", callback_data: "cb:confirm_pause" },
        { text: "📋 Tasks", callback_data: "/tasks" },
      ],
    ],
  };
  return sendDirect(
    chatId,
    `▶️ *Task executor resumed* (was paused for ${durStr}).\nWill pick up tasks on next poll cycle.`,
    { parse_mode: "Markdown", reply_markup: keyboard },
  );
}

/**
 * /repos — View configured repositories and their status
 */
async function cmdRepos(chatId, _text) {
  try {
    const config = (await import("./config.mjs")).default;
    const repos = config.repositories || [];
    const selected =
      config.selectedRepository || config.repoSlug || "(default)";

    if (repos.length === 0) {
      return sendDirect(
        chatId,
        [
          "📁 *Repositories*",
          "",
          `Active: \`${config.repoSlug || config.repoRoot || "current directory"}\``,
          "",
          "_Single-repo mode. Add repositories in openfleet.config.json:_",
          "\`\`\`json",
          JSON.stringify(
            {
              repositories: [
                {
                  name: "backend",
                  path: "./",
                  slug: "org/backend",
                  primary: true,
                },
                { name: "frontend", path: "../frontend", slug: "org/frontend" },
              ],
            },
            null,
            2,
          ),
          "\`\`\`",
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
    }

    const lines = ["📁 *Repositories*", ""];
    for (const repo of repos) {
      const isCurrent =
        repo.name === selected || repo.slug === selected || repo.primary;
      const icon = isCurrent ? "🟢" : "⚪";
      const primary = repo.primary ? " _(primary)_" : "";
      lines.push(
        `${icon} \`${repo.name}\` — ${repo.slug || repo.path || "?"}${primary}`,
      );
    }
    lines.push("");
    lines.push(`Selected: \`${selected}\``);
    lines.push("Switch: \`/repos set <name>\`");

    return sendDirect(chatId, lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    return sendDirect(chatId, `❌ Failed to read repo config: ${err.message}`);
  }
}

/**
 * /maxparallel — View or set max parallel task slots
 */
async function cmdMaxParallel(chatId, text) {
  const executor = _getInternalExecutor?.();
  if (!executor) {
    return sendDirect(chatId, "⚠️ Internal executor not enabled.");
  }
  const arg = (text || "").replace("/maxparallel", "").trim();
  if (arg) {
    const n = parseInt(arg, 10);
    if (isNaN(n) || n < 0 || n > 20) {
      return sendDirect(chatId, "⚠️ Provide a number between 0 and 20.");
    }
    const old = executor.maxParallel;
    executor.maxParallel = n;
    if (n === 0) {
      executor.pause();
      return sendDirect(
        chatId,
        `⏸ Max parallel set to 0 — executor paused. Use /maxparallel <n> to resume.`,
      );
    }
    if (executor.isPaused() && n > 0) {
      executor.resume();
    }
    return sendDirect(chatId, `✅ Max parallel: ${old} → ${n}`);
  }
  const status = executor.getStatus();
  return sendDirect(
    chatId,
    `📊 Max parallel: ${status.maxParallel} (active: ${status.activeSlots})`,
  );
}

/**
 * /whatsapp — Show WhatsApp channel status
 */
async function cmdWhatsApp(chatId) {
  try {
    const { isWhatsAppEnabled, getWhatsAppStatus } =
      await import("./whatsapp-channel.mjs");
    if (!isWhatsAppEnabled()) {
      return sendDirect(
        chatId,
        "⚪ WhatsApp channel is not enabled.\n\nSet WHATSAPP_ENABLED=1 in your .env to enable.",
      );
    }
    const status = getWhatsAppStatus();
    const lines = [
      "📱 <b>WhatsApp Channel Status</b>",
      "",
      `Status: ${status.connected ? "🟢 Connected" : "🔴 Disconnected"}`,
      `Chat ID: <code>${status.chatId || "not set"}</code>`,
      `Pending messages: ${status.pendingMessages || 0}`,
    ];
    if (status.connectedAt) {
      const ago = Math.round((Date.now() - status.connectedAt) / 60000);
      lines.push(`Connected: ${ago}m ago`);
    }
    return sendDirect(chatId, lines.join("\n"), { parse_mode: "HTML" });
  } catch (err) {
    return sendDirect(chatId, `❌ WhatsApp status error: ${err.message}`);
  }
}

/**
 * /container — Show container runtime status
 */
async function cmdContainer(chatId) {
  try {
    const { isContainerEnabled, getContainerStatus } =
      await import("./container-runner.mjs");
    if (!isContainerEnabled()) {
      return sendDirect(
        chatId,
        "⚪ Container isolation is not enabled.\n\nSet CONTAINER_ENABLED=1 in your .env to enable.",
      );
    }
    const status = getContainerStatus();
    const lines = [
      "📦 <b>Container Runtime Status</b>",
      "",
      `Runtime: ${status.runtime || "detecting..."}`,
      `Active containers: ${status.activeContainers || 0}`,
      `Max concurrent: ${status.maxConcurrent || "unlimited"}`,
    ];
    if (status.image) {
      lines.push(`Image: <code>${status.image}</code>`);
    }
    return sendDirect(chatId, lines.join("\n"), { parse_mode: "HTML" });
  } catch (err) {
    return sendDirect(chatId, `❌ Container status error: ${err.message}`);
  }
}

const COMMANDS = {
  "/menu": { handler: cmdMenu, desc: "Open the control center UI" },
  "/help": { handler: cmdHelp, desc: "Show available commands" },
  "/helpfull": { handler: cmdHelpFull, desc: "Show all commands (text list)" },
  "/app": { handler: cmdApp, desc: "Open the Control Center Mini App" },
  "/miniapp": { handler: cmdApp, desc: "Open the Control Center Mini App" },
  "/webapp": { handler: cmdApp, desc: "Open the Control Center Mini App" },
  "/cancel": { handler: cmdCancel, desc: "Cancel a pending input prompt" },
  "/ask": { handler: cmdAsk, desc: "Send prompt to agent: /ask <prompt>" },
  "/status": { handler: cmdStatus, desc: "Detailed orchestrator status" },
  "/tasks": {
    handler: cmdTasks,
    desc: "Active tasks, workspace metrics & retries",
  },
  "/starttask": {
    handler: cmdStartTask,
    desc: "Manual start of a task: /starttask <taskId>",
  },
  "/agents": {
    handler: cmdAgents,
    desc: "Show all active monitor/task/review/conflict agents",
  },
  "/logs": { handler: cmdLogs, desc: "Recent monitor logs" },
  "/agentlogs": {
    handler: cmdAgentLogs,
    desc: "Agent output for branch: /agentlogs <branch>",
  },
  "/log": { handler: cmdLogs, desc: "Alias for /logs" },
  "/branches": { handler: cmdBranches, desc: "Recent git branches" },
  "/diff": { handler: cmdDiff, desc: "Git diff summary (staged)" },
  "/restart": { handler: cmdRestart, desc: "Restart orchestrator process" },
  "/retry": {
    handler: cmdRetry,
    desc: "Start fresh session for stuck task: /retry [reason]",
  },
  "/plan": {
    handler: cmdPlan,
    desc: "Trigger task planner: /plan [count] (default 5)",
  },
  "/cleanup": {
    handler: cmdCleanupMerged,
    desc: "Reconcile VK tasks with merged PRs/branches",
  },
  "/reconcile": {
    handler: cmdCleanupMerged,
    desc: "Alias for /cleanup",
  },
  "/history": {
    handler: cmdHistory,
    desc: "Primary agent session history",
  },
  "/clear": {
    handler: cmdClear,
    desc: "Clear primary agent session context",
  },
  "/reset_thread": {
    handler: cmdClear,
    desc: "Alias for /clear (reset thread)",
  },
  "/git": { handler: cmdGit, desc: "Run a git command: /git log --oneline -5" },
  "/shell": { handler: cmdShell, desc: "Run a shell command: /shell ls -la" },
  "/background": {
    handler: cmdBackground,
    desc: "Run a task in background or background the active agent",
  },
  "/region": {
    handler: cmdRegion,
    desc: "View/switch Codex region: /region [us|sweden|auto]",
  },
  "/health": {
    handler: cmdHealth,
    desc: "Executor health status & model routing",
  },
  "/anomalies": {
    handler: cmdAnomalies,
    desc: "Agent anomaly detector status & active concerns",
  },
  "/model": {
    handler: cmdModel,
    desc: "Override executor for next task: /model gpt-5.2-codex",
  },
  "/sdk": {
    handler: cmdSdk,
    desc: "View/switch agent pool SDK: /sdk [codex|copilot|claude]",
  },
  "/kanban": {
    handler: cmdKanban,
    desc: "View/switch kanban backend: /kanban [internal|vk|github|jira]",
  },
  "/autobacklog": {
    handler: cmdAutoBacklog,
    desc: "Experimental backlog replenishment controls",
  },
  "/requirements": {
    handler: cmdRequirements,
    desc: "Set project requirements profile",
  },
  "/threads": {
    handler: cmdThreads,
    desc: "View active agent threads: /threads [clear]",
  },
  "/worktrees": {
    handler: cmdWorktrees,
    desc: "View/manage worktrees: /worktrees [prune|release <taskKey>]",
  },
  "/executor": {
    handler: cmdExecutor,
    desc: "View/manage executor mode: /executor [status|mode <vk|internal|hybrid>|slots]",
  },
  "/shared_workspaces": {
    handler: cmdSharedWorkspaces,
    desc: "List shared cloud workspace availability",
  },
  "/claim": {
    handler: cmdSharedWorkspaceClaim,
    desc: "Claim a shared workspace: /claim <id> [--owner <id>] [--ttl <minutes>]",
  },
  "/release": {
    handler: cmdSharedWorkspaceRelease,
    desc: "Release a shared workspace: /release <id> [--owner <id>] [--force]",
  },
  "/agent": {
    handler: cmdAgent,
    desc: "Route a task to a workspace: /agent --workspace <id> <task>",
  },
  "/stop": {
    handler: cmdStop,
    desc: "Stop the running agent and wait for new instructions",
  },
  "/steer": {
    handler: cmdSteer,
    desc: "Steer a running agent: /steer focus on X",
  },
  "/context": {
    handler: cmdSteer,
    desc: "Alias for /steer — update in-flight agent context",
  },
  "/presence": {
    handler: cmdPresence,
    desc: "Show active openfleet instances",
  },
  "/instances": {
    handler: cmdPresence,
    desc: "Alias for /presence",
  },
  "/coordinator": {
    handler: cmdCoordinator,
    desc: "Show current coordinator selection",
  },
  "/pausetasks": {
    handler: cmdPauseTasks,
    desc: "Pause task dispatch (running tasks continue)",
  },
  "/resumetasks": {
    handler: cmdResumeTasks,
    desc: "Resume task dispatch after pause",
  },
  "/pause": {
    handler: cmdPauseTasks,
    desc: "Alias for /pausetasks",
  },
  "/resume": {
    handler: cmdResumeTasks,
    desc: "Alias for /resumetasks",
  },
  "/repos": {
    handler: cmdRepos,
    desc: "View configured repositories",
  },
  "/maxparallel": {
    handler: cmdMaxParallel,
    desc: "View/set max parallel slots: /maxparallel [n]",
  },
  "/whatsapp": {
    handler: cmdWhatsApp,
    desc: "WhatsApp channel status",
  },
  "/container": {
    handler: cmdContainer,
    desc: "Container runtime status",
  },
};

/**
 * Quick connectivity probe — calls getMe with minimal retries.
 * Returns true if Telegram API is reachable, false otherwise.
 */
async function probeTelegramConnectivity() {
  try {
    const res = await telegramApiFetch("getMe", {
      method: "GET",
      retries: 1,
      retryOnStatus: false,
      timeoutMs: 10_000,
      operation: "getMe",
    });
    const ok = res && res.ok;
    telegramApiReachable = !!ok;
    return telegramApiReachable;
  } catch {
    telegramApiReachable = false;
    return false;
  }
}

/**
 * Delete all existing bot commands from every scope to clear stale/old entries.
 * Telegram stores commands per-scope, so we must clear each one explicitly.
 */
async function clearAllBotCommands() {
  const scopes = [
    { scope: { type: "default" } },
    { scope: { type: "all_private_chats" } },
    { scope: { type: "all_group_chats" } },
    { scope: { type: "all_chat_administrators" } },
  ];

  for (const body of scopes) {
    try {
      await telegramApiFetch("deleteMyCommands", {
        method: "POST",
        payload: body,
        retries: 1,
        retryOnStatus: false,
        operation: "deleteMyCommands",
      });
    } catch {
      /* best effort — scope may not have had commands */
    }
  }
}

/**
 * Sync the COMMANDS object to Telegram's bot command menu via setMyCommands.
 * First clears ALL existing commands from every scope to remove stale entries
 * (e.g. leftover commands from a previous project or bot configuration).
 * Then sets the current command list.
 */
async function registerBotCommands() {
  // Step 1: Clear all old commands from every scope
  await clearAllBotCommands();

  // Step 2: Build and register current commands
  const seen = new Set();
  const commands = [];
  for (const [cmd, entry] of Object.entries(COMMANDS)) {
    const command = cmd.replace(/^\//, ""); // strip leading /
    if (seen.has(command)) continue; // skip duplicate keys (e.g. /agent appears twice)
    // Telegram only allows lowercase letters, digits, underscores (1-32 chars)
    if (!/^[a-z0-9_]{1,32}$/.test(command)) {
      console.warn(`[telegram-bot] skipping invalid command name: /${command}`);
      continue;
    }
    seen.add(command);
    // Telegram limits description to 256 chars
    const description = (entry.desc || command).slice(0, 256);
    commands.push({ command, description });
  }

  let res;
  try {
    res = await telegramApiFetch("setMyCommands", {
      method: "POST",
      payload: { commands },
      operation: "setMyCommands",
    });
  } catch (err) {
    // Suppress if we already know the API is unreachable
    if (telegramApiReachable !== false) {
      console.warn(`[telegram-bot] setMyCommands error: ${err.message}`);
    }
    return;
  }

  try {
    const data = await res.json();
    if (data.ok) {
      console.log(
        `[telegram-bot] registered ${commands.length} commands with Telegram`,
      );
    } else {
      console.warn(
        `[telegram-bot] setMyCommands failed: ${data.description || JSON.stringify(data)}`,
      );
    }
  } catch (err) {
    console.warn(
      `[telegram-bot] setMyCommands JSON parse error: ${err.message}`,
    );
  }
}

async function setWebAppMenuButton(url) {
  if (!telegramToken || !url) return false;
  const webAppUrl = getTelegramWebAppUrl(url);
  if (!webAppUrl) return false;
  try {
    const payload = {
      menu_button: {
        type: "web_app",
        text: "Control Center",
        web_app: { url: webAppUrl },
      },
    };
    // Set for the specific chat so it takes effect immediately
    if (telegramChatId) payload.chat_id = telegramChatId;
    const res = await telegramApiFetch("setChatMenuButton", {
      method: "POST",
      payload,
      operation: "setChatMenuButton",
    });
    if (!res || typeof res.ok === "undefined") {
      throw new Error("invalid response object");
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      const details = data?.description || `${res.status} ${res.statusText || ""}`;
      throw new Error(details.trim());
    }
    console.log(`[telegram-bot] chat menu button set to ${webAppUrl}`);
    return true;
  } catch (err) {
    if (telegramApiReachable !== false) {
      console.warn(`[telegram-bot] setChatMenuButton error: ${err.message}`);
    }
    return false;
  }
}

async function clearWebAppMenuButton() {
  if (!telegramToken) return;
  try {
    const payload = { menu_button: { type: "default" } };
    if (telegramChatId) payload.chat_id = telegramChatId;
    await telegramApiFetch("setChatMenuButton", {
      method: "POST",
      payload,
      operation: "clearChatMenuButton",
    });
  } catch {
    /* best effort */
  }
}

const MENU_BUTTON_REFRESH_MS = 60 * 1000; // 1 minute — re-sync after tunnel URL rotates

async function refreshMenuButton() {
  const { uiUrl: currentUiUrl, webAppUrl: currentUrl } = syncUiUrlsFromServer();
  if (currentUrl && currentUrl !== lastMenuButtonUrl) {
    const updated = await setWebAppMenuButton(currentUrl);
    if (updated) {
      lastMenuButtonUrl = currentUrl;
      console.log(`[telegram-bot] menu button URL refreshed: ${currentUrl}`);
    }
  } else if (!currentUrl) {
    await clearWebAppMenuButton();
    lastMenuButtonUrl = null;
    if (currentUiUrl !== telegramUiUrl) {
      telegramUiUrl = currentUiUrl;
    }
  }
}

const FAST_COMMANDS = new Set([
  "/menu",
  "/status",
  "/tasks",
  "/agents",
  "/cancel",
  "/sdk",
  "/kanban",
  "/threads",
  "/worktrees",
  "/executor",
  "/pausetasks",
  "/resumetasks",
  "/pause",
  "/resume",
  "/maxparallel",
  "/repos",
  "/whatsapp",
  "/container",
]);

function getTelegramWebAppUrl(url) {
  // Prefer cloudflared tunnel URL (valid cert, works in Telegram Mini App)
  const tUrl = getTunnelUrl();
  if (tUrl) {
    const normalizedTunnel = String(tUrl || "").trim().replace(/\/+$/, "");
    return appendTokenToUrl(normalizedTunnel, getSessionToken()) || normalizedTunnel;
  }

  const normalized = String(url || "")
    .trim()
    .replace(/\/+$/, "");
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:") {
      if (telegramWebAppUrlWarned !== normalized) {
        telegramWebAppUrlWarned = normalized;
        console.warn(
          `[telegram-bot] mini app URL must be HTTPS for Telegram WebApp buttons; got "${normalized}". Falling back to normal URL buttons only.`,
        );
      }
      return null;
    }
    const normalizedUrl = parsed.toString().replace(/\/+$/, "");
    return appendTokenToUrl(normalizedUrl, getSessionToken()) || normalizedUrl;
  } catch {
    if (telegramWebAppUrlWarned !== normalized) {
      telegramWebAppUrlWarned = normalized;
      console.warn(
        `[telegram-bot] mini app URL is invalid: "${normalized}". Falling back to normal URL buttons only.`,
      );
    }
    return null;
  }
}

function appendTokenToUrl(inputUrl, token) {
  const raw = String(inputUrl || "").trim();
  if (!raw) return null;
  if (!token) return raw;
  try {
    const url = new URL(raw);
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return raw;
  }
}

async function handleCommand(text, chatId) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@\w+/, ""); // strip @botname
  const cmdArgs = parts.slice(1).join(" ");

  const entry = COMMANDS[cmd] || COMMANDS[cmd.replace(/-/g, "_")];
  if (entry) {
    try {
      await entry.handler(chatId, cmdArgs);
    } catch (err) {
      await sendReply(chatId, `❌ Command error: ${err.message}`);
    }
  } else {
    await sendReply(
      chatId,
      `Unknown command: ${cmd}\nType /menu (or /helpfull) for available commands.`,
    );
  }
}

/**
 * Handle a command from the Mini App UI.
 * Runs the Telegram command handler silently (without sending to chat)
 * and returns a summary object.
 */
async function handleUiCommand(text) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@\w+/, "");
  const cmdArgs = parts.slice(1).join(" ");

  const entry = COMMANDS[cmd] || COMMANDS[cmd.replace(/-/g, "_")];
  if (!entry) {
    return { executed: false, error: `Unknown command: ${cmd}` };
  }

  // For the UI, we don't actually need to run the Telegram chat command.
  // The UI already has dedicated API endpoints for data. We just acknowledge
  // and trigger a data refresh via the broadcast in the API handler.
  // For action commands like /restart, /plan, /retry, we run them.
  const ACTION_COMMANDS = new Set([
    "/restart", "/plan", "/retry", "/cleanup", "/prune",
    "/starttask", "/pause", "/resume", "/reconcile",
    "/autobacklog", "/requirements",
  ]);

  if (ACTION_COMMANDS.has(cmd)) {
    try {
      // Use a dummy chatId — the handler sends to Telegram chat, but we
      // also send the command there so the user sees the result.
      if (telegramChatId) {
        await entry.handler(telegramChatId, cmdArgs);
      }
      return { executed: true, command: cmd, args: cmdArgs };
    } catch (err) {
      return { executed: false, error: err.message };
    }
  }

  // For read-only commands (/status, /tasks, /logs, etc.), the UI already
  // has API endpoints — just acknowledge. The UI refreshes data automatically.
  return { executed: true, command: cmd, args: cmdArgs, readOnly: true };
}

// ── UI Menu System ──────────────────────────────────────────────────────────

const UI_INPUT_HANDLERS = {
  ask: {
    prompt: "Send your question for the primary agent.",
    buildCommand: (input) => `/ask ${input}`,
  },
  agentlogs: {
    prompt: "Enter a branch fragment to view logs.",
    buildCommand: (input) => `/agentlogs ${input}`,
  },
  git: {
    prompt: "Enter git arguments (example: log --oneline -5).",
    buildCommand: (input) => `/git ${input}`,
  },
  shell: {
    prompt: "Enter a shell command to run.",
    buildCommand: (input) => `/shell ${input}`,
  },
  plan_count: {
    prompt: "How many tasks should the planner generate?",
    buildCommand: (input) => `/plan ${input}`,
  },
  starttask: {
    prompt:
      "Enter the task ID to start manually.\nNext you'll pick executor → SDK → model.",
    buildCommand: (input) => `/starttask ${input}`,
  },
  starttask_model: {
    prompt: (ctx) =>
      `Model for ${ctx.sdk || "selected"} (${ctx.executor || "executor"}). ` +
      "Type a model name or 'default' to use the standard route.",
    buildCommand: () => null,
  },
  retry_reason: {
    prompt: "Retry reason (any short label).",
    buildCommand: (input) => `/retry ${input}`,
  },
  steer: {
    prompt: "Send steering instructions for the active agent.",
    buildCommand: (input) => `/steer ${input}`,
  },
  background: {
    prompt: "Send the background task description.",
    buildCommand: (input) => `/background ${input}`,
  },
  maxparallel: {
    prompt: "Set max parallel slots (0-20).",
    buildCommand: (input) => `/maxparallel ${input}`,
  },
  logs_lines: {
    prompt: "How many log lines should I show?",
    buildCommand: (input) => `/logs ${input}`,
  },
  threads_kill: {
    prompt: "Task key to invalidate.",
    buildCommand: (input) => `/threads kill ${input}`,
    confirm: true,
    confirmTitle: "Invalidate Thread",
    confirmLabel: "Invalidate",
    confirmBackAction: "go:threads_kill",
    confirmDetails: (input) => [`Task Key: \`${input}\``],
  },
  worktrees_release: {
    prompt: "Task key to release.",
    buildCommand: (input) => `/worktrees release ${input}`,
    confirm: true,
    confirmTitle: "Release Worktree",
    confirmLabel: "Release",
    confirmBackAction: "go:worktrees_release",
    confirmDetails: (input) => [`Task Key: \`${input}\``],
  },
  shared_detail: {
    prompt: "Shared workspace ID to inspect.",
    buildCommand: (input) => `/shared_workspaces ${input}`,
  },
  shared_claim: {
    prompt: 'Claim workspace (id or full args, e.g. "cloud-01 --ttl 120").',
    buildCommand: (input) => `/claim ${input}`,
    confirm: true,
    confirmTitle: "Claim Shared Workspace",
    confirmLabel: "Claim",
    confirmBackAction: "go:shared_claim",
    confirmDetails: (input) => [`Args: \`${shortSnippet(input, 120)}\``],
  },
  shared_release: {
    prompt: 'Release workspace (id or full args, e.g. "cloud-01 --force").',
    buildCommand: (input) => `/release ${input}`,
    confirm: true,
    confirmTitle: "Release Shared Workspace",
    confirmLabel: "Release",
    confirmBackAction: "go:shared_release",
    confirmDetails: (input) => [`Args: \`${shortSnippet(input, 120)}\``],
  },
  agent_custom: {
    prompt:
      'Enter /agent arguments (everything after /agent). Example: "--workspace cloud-01 Update docs"',
    buildCommand: (input) => `/agent ${input}`,
  },
  agent_workspace_task: {
    prompt: (ctx) => `Task for workspace ${ctx.workspaceId}:`,
    buildCommand: (input, ctx) => `${ctx.commandPrefix}${input}`,
  },
  agent_role_task: {
    prompt: (ctx) => `Task for role ${ctx.role}:`,
    buildCommand: (input, ctx) => `${ctx.commandPrefix}${input}`,
  },
};

function uiCallback(action) {
  return `ui:${action}`;
}

function uiGoAction(screenId, page = null) {
  return page === null || page === undefined
    ? `go:${screenId}`
    : `go:${screenId}:${page}`;
}

function uiCmdAction(command) {
  return `cmd:${command}`;
}

function uiInputAction(key) {
  return `input:${key}`;
}

function uiTokenAction(token) {
  return `token:${token}`;
}

function uiButton(text, action) {
  return { text, callback_data: uiCallback(action) };
}

function buildKeyboard(rows) {
  return { inline_keyboard: rows };
}

function buildConfirmKeyboard(confirmId, confirmLabel = "Confirm") {
  return {
    inline_keyboard: [
      [
        { text: `✅ ${confirmLabel}`, callback_data: confirmId },
        { text: "❌ Cancel", callback_data: "cb:dismiss" },
      ],
    ],
  };
}

function buildActionConfirmKeyboard(confirmId, confirmLabel, backAction) {
  const rows = [
    [
      { text: `✅ ${confirmLabel || "Confirm"}`, callback_data: confirmId },
      { text: "❌ Cancel", callback_data: "cb:dismiss" },
    ],
  ];
  if (backAction) {
    rows.push([uiButton("⬅️ Back", backAction)]);
  }
  return { inline_keyboard: rows };
}

function appendRefreshRow(keyboard, screenId, params = {}) {
  if (!keyboard || !keyboard.inline_keyboard) return keyboard;
  const action = uiGoAction(screenId, params.page);
  const rows = keyboard.inline_keyboard || [];
  const hasRefresh = rows.some((row) =>
    row.some((btn) => btn?.text === "🔄 Refresh"),
  );
  if (hasRefresh) return keyboard;
  return {
    ...keyboard,
    inline_keyboard: [...rows, [uiButton("🔄 Refresh", action)]],
  };
}

function chunkButtons(buttons, perRow = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow));
  }
  return rows;
}

function shortenLabel(value, maxLen = 24) {
  const text = String(value || "");
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function parseUiAction(data) {
  const payload = data.startsWith("ui:") ? data.slice(3) : data;
  const [type, ...rest] = payload.split(":");
  return { type, rest, raw: payload };
}

async function dispatchUiCommand(chatId, command) {
  const cmd = command.split(/\s+/)[0].toLowerCase().replace(/@\w+/, "");
  if (FAST_COMMANDS.has(cmd)) {
    enqueueFastCommand(() => handleCommand(command, chatId));
    return;
  }
  enqueueCommand(() => handleCommand(command, chatId));
}

async function promptUiInput(chatId, key, extra = {}) {
  const handler = UI_INPUT_HANDLERS[key];
  if (!handler) {
    await sendReply(chatId, "Unknown input prompt.");
    return;
  }
  const prompt =
    extra.prompt ||
    (typeof handler.prompt === "function"
      ? handler.prompt(extra)
      : handler.prompt);
  setPendingUiInput(chatId, {
    key,
    buildCommand: handler.buildCommand,
    ...extra,
  });
  const keyboard = buildKeyboard([
    [{ text: "❌ Cancel", callback_data: uiCallback("cancel") }],
  ]);
  await sendReply(chatId, `${prompt}\n\nSend /cancel to abort.`, {
    reply_markup: keyboard,
  });
}

async function promptActionConfirm(chatId, token, payload, options = {}) {
  const title = payload.title || "Confirm Action";
  const detailLines = Array.isArray(payload.detailLines)
    ? payload.detailLines.filter(Boolean)
    : [];
  const hint = payload.hint ? String(payload.hint) : "";
  const text = [
    `*${title}*`,
    detailLines.length ? "" : null,
    ...detailLines,
    hint ? "" : null,
    hint,
  ]
    .filter(Boolean)
    .join("\n");
  const confirmId = `cb:confirm_action:${token}`;
  const keyboard = buildActionConfirmKeyboard(
    confirmId,
    payload.confirmLabel || "Confirm",
    payload.backAction,
  );
  await sendReply(chatId, text, {
    parseMode: "Markdown",
    reply_markup: keyboard,
    skipSticky: true,
    ...options,
  });
}

async function handleUiInput(chatId, request, text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    await sendReply(chatId, "⚠️ Input was empty. Prompt cancelled.");
    return;
  }
  if (request.key === "starttask") {
    await showStartTaskExecutorPicker(chatId, trimmed);
    return;
  }
  if (request.key === "starttask_model") {
    const normalizedModel = normalizeStartTaskModelInput(trimmed);
    await promptStartTaskConfirm(chatId, {
      taskId: request.taskId,
      sdk: request.sdk,
      model: normalizedModel,
      executor: request.executor,
    });
    return;
  }
  const buildCommand = request.buildCommand;
  if (typeof buildCommand !== "function") {
    await sendReply(chatId, "⚠️ Unable to process that input.");
    return;
  }
  const command = buildCommand(trimmed, request);
  if (!command) {
    await sendReply(chatId, "⚠️ Could not build a command from that input.");
    return;
  }
  if (request.confirm) {
    const detailLines =
      typeof request.confirmDetails === "function"
        ? request.confirmDetails(trimmed, request, command)
        : [`Command: \`${shortSnippet(command, 120)}\``];
    const payload = {
      type: "confirm_cmd",
      command,
      title: request.confirmTitle || "Confirm Action",
      confirmLabel: request.confirmLabel || "Confirm",
      detailLines,
      backAction: request.confirmBackAction || null,
    };
    const token = issueUiToken(payload);
    await promptActionConfirm(chatId, token, payload);
    return;
  }
  await dispatchUiCommand(chatId, command);
}

function normalizeStartTaskExecutor(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "auto") return "auto";
  if (["internal", "local", "agent", "pool"].includes(raw)) return "internal";
  if (["vk", "vibe", "kanban", "cloud"].includes(raw)) return "vk";
  return "";
}

function normalizeStartTaskModelInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  if (["default", "auto", "none"].includes(lowered)) return "";
  return raw;
}

function resolveStartTaskExecutorMode() {
  const raw =
    (_getExecutorMode?.() || process.env.EXECUTOR_MODE || "internal")
      .toString()
      .trim()
      .toLowerCase();
  if (["internal", "vk", "hybrid"].includes(raw)) return raw;
  return "internal";
}

function getStartTaskExecutorAvailability(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  return {
    internal: normalized === "internal" || normalized === "hybrid",
    vk: normalized === "vk" || normalized === "hybrid",
  };
}

function resolveStartTaskExecutor(requested, mode) {
  const normalized = normalizeStartTaskExecutor(requested);
  const availability = getStartTaskExecutorAvailability(mode);
  if (!normalized || normalized === "auto") {
    if (availability.internal) return "internal";
    if (availability.vk) return "vk";
    return null;
  }
  if (normalized === "internal" && !availability.internal) return null;
  if (normalized === "vk" && !availability.vk) return null;
  return normalized;
}

function buildStartTaskCommand(taskId, sdk, model, executor) {
  const parts = ["/starttask", taskId];
  if (executor) parts.push("--executor", executor);
  if (sdk) parts.push("--sdk", sdk);
  if (model) parts.push("--model", model);
  return parts.join(" ");
}

async function promptStartTaskConfirm(chatId, details = {}) {
  const taskId = String(details.taskId || "").trim();
  if (!taskId) {
    await sendReply(chatId, "⚠️ Task ID missing for manual start.");
    return;
  }
  const executor = normalizeStartTaskExecutor(details.executor);
  const isVk = executor === "vk";
  const sdk = !isVk && details.sdk ? String(details.sdk).trim() : "";
  const model = !isVk && details.model ? String(details.model).trim() : "";
  const command = buildStartTaskCommand(taskId, sdk, model, executor);
  const token = issueUiToken({ type: "cmd", command });
  const executorLabel = executor || "auto";
  const sdkLabel = isVk ? "n/a" : sdk || "auto";
  const modelLabel = isVk ? "n/a" : model || "default";
  const lines = [
    "🚀 *Confirm Manual Start*",
    "",
    "This will enqueue the task immediately.",
    "",
    `Task: \`${taskId}\``,
    `Executor: \`${executorLabel}\``,
    `SDK: \`${sdkLabel}\``,
    `Model: \`${modelLabel}\``,
  ];
  if (isVk) {
    lines.push("Note: VK executor ignores SDK/model overrides.");
  }
  const keyboard = buildKeyboard([
    [
      uiButton("✅ Start", uiTokenAction(token)),
      uiButton("❌ Cancel", "cancel"),
    ],
  ]);
  await sendReply(chatId, lines.join("\n"), {
    parseMode: "Markdown",
    reply_markup: keyboard,
  });
}

async function showStartTaskExecutorPicker(chatId, taskId) {
  const safeId = String(taskId || "").trim();
  if (!safeId) {
    await sendReply(chatId, "⚠️ Task ID missing.");
    return;
  }
  const mode = resolveStartTaskExecutorMode();
  const availability = getStartTaskExecutorAvailability(mode);
  const buttons = [];
  if (availability.internal || availability.vk) {
    buttons.push({
      label: "✨ Auto (recommended)",
      executor: "auto",
    });
  }
  if (availability.internal) {
    buttons.push({
      label: availability.vk ? "🧠 Internal" : "🧠 Internal (only)",
      executor: "internal",
    });
  }
  if (availability.vk) {
    buttons.push({ label: "☁️ VK", executor: "vk" });
  }
  if (!buttons.length) {
    await sendReply(
      chatId,
      "⚠️ No executors available. Check EXECUTOR_MODE configuration.",
    );
    return;
  }
  const rows = [
    ...chunkButtons(
      buttons.map((entry) =>
        uiButton(
          entry.label,
          uiTokenAction(
            issueUiToken({
              type: "starttask_executor",
              taskId: safeId,
              executor: entry.executor,
            }),
          ),
        ),
      ),
      2,
    ),
    [uiButton("❌ Cancel", "cancel")],
  ];
  const lines = [
    "Step 1/3 • Choose executor",
    "",
    `Task: \`${safeId}\``,
    `Mode: \`${mode}\``,
    availability.internal ? "🧠 Internal executor available" : "🧠 Internal executor unavailable",
    availability.vk ? "☁️ VK executor available" : "☁️ VK executor unavailable",
    "",
    "Auto picks internal if available, otherwise VK.",
  ];
  await sendReply(chatId, lines.join("\n"), {
    parseMode: "Markdown",
    reply_markup: buildKeyboard(rows),
  });
}

async function showStartTaskSdkPicker(chatId, taskId, executor) {
  const safeId = String(taskId || "").trim();
  if (!safeId) {
    await sendReply(chatId, "⚠️ Task ID missing.");
    return;
  }
  const safeExecutor = normalizeStartTaskExecutor(executor) || "internal";
  const available = getAvailableSdks();
  const sdkList = available.length > 0 ? available : ["codex", "copilot", "claude"];
  const tokenAuto = issueUiToken({
    type: "starttask_confirm",
    taskId: safeId,
    executor: safeExecutor,
  });
  const tokens = sdkList.map((sdk) => ({
    sdk,
    token: issueUiToken({
      type: "starttask_sdk",
      taskId: safeId,
      sdk,
      executor: safeExecutor,
    }),
  }));
  const tokenBack = issueUiToken({
    type: "starttask_executor_list",
    taskId: safeId,
  });
  const lines = [
    "Step 2/3 • Choose SDK",
    "",
    `Task: \`${safeId}\``,
    `Executor: \`${safeExecutor}\``,
    "Auto uses the current pool SDK.",
  ];
  const rows = [
    [uiButton("🤖 Auto", uiTokenAction(tokenAuto))],
    ...chunkButtons(
      tokens.map((entry) => uiButton(entry.sdk, uiTokenAction(entry.token))),
      2,
    ),
    [uiButton("⬅️ Back", uiTokenAction(tokenBack))],
    [uiButton("❌ Cancel", "cancel")],
  ];
  const keyboard = buildKeyboard(rows);
  await sendReply(chatId, lines.join("\n"), {
    parseMode: "Markdown",
    reply_markup: keyboard,
  });
}

async function showStartTaskModelPicker(chatId, taskId, sdk, executor) {
  const safeId = String(taskId || "").trim();
  const safeSdk = String(sdk || "").trim();
  const safeExecutor = normalizeStartTaskExecutor(executor) || "internal";
  if (!safeId || !safeSdk) {
    await sendReply(chatId, "⚠️ Missing task ID or SDK.");
    return;
  }
  const modelOptions = getDefaultModelPriority()
    .map((entry) => (typeof entry === "string" ? entry : entry?.model || entry?.name || null))
    .filter(Boolean);
  const tokenDefault = issueUiToken({
    type: "starttask_confirm",
    taskId: safeId,
    sdk: safeSdk,
    executor: safeExecutor,
  });
  const tokenCustom = issueUiToken({
    type: "input",
    key: "starttask_model",
    taskId: safeId,
    sdk: safeSdk,
    executor: safeExecutor,
    prompt: `Custom model for ${safeSdk}:`,
  });
  const tokenBack = issueUiToken({
    type: "starttask_sdk_list",
    taskId: safeId,
    executor: safeExecutor,
  });
  const lines = [
    "Step 3/3 • Choose model",
    "",
    `Task: \`${safeId}\``,
    `Executor: \`${safeExecutor}\``,
    `SDK: \`${safeSdk}\``,
    "Default uses the standard routing policy.",
  ];
  const rows = [[uiButton("Default Model", uiTokenAction(tokenDefault))]];
  if (modelOptions.length > 0) {
    rows.push(
      ...chunkButtons(
        modelOptions.slice(0, 6).map((model) =>
          uiButton(
            shortenLabel(model),
            uiTokenAction(
              issueUiToken({
                type: "starttask_confirm",
                taskId: safeId,
                sdk: safeSdk,
                executor: safeExecutor,
                model,
              }),
            ),
          ),
        ),
        2,
      ),
    );
  }
  rows.push([uiButton("Custom Model", uiTokenAction(tokenCustom))]);
  rows.push([uiButton("⬅️ Back", uiTokenAction(tokenBack))]);
  const keyboard = buildKeyboard(rows);
  await sendReply(chatId, lines.join("\n"), {
    parseMode: "Markdown",
    reply_markup: keyboard,
  });
}

function uiNavRow(parent) {
  if (!parent) {
    return [uiButton("🏠 Home", uiGoAction("home"))];
  }
  return [
    uiButton("⬅️ Back", uiGoAction(parent)),
    uiButton("🏠 Home", uiGoAction("home")),
  ];
}

function parsePageParam(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  return formatRuntimeSeconds(Math.floor(ms / 1000));
}

async function buildHomeStatusLine() {
  const data = await readStatusSnapshot();
  if (!data) return "Status: unavailable";
  const counts = data.counts || {};
  const backlog = data.backlog_remaining ?? "?";
  const running = counts.running ?? 0;
  const review = counts.review ?? 0;
  const error = counts.error ?? 0;
  return `Running ${running} • Review ${review} • Error ${error} • Backlog ${backlog}`;
}

async function listWorktreeNames() {
  const worktreeDir = resolve(repoRoot, ".cache", "worktrees");
  let names = [];
  try {
    names = await readdir(worktreeDir);
  } catch {
    return [];
  }
  const entries = await Promise.all(
    names.map(async (name) => {
      const stats = await stat(resolve(worktreeDir, name)).catch(() => null);
      return { name, mtime: stats?.mtimeMs || 0 };
    }),
  );
  return entries.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.name);
}

async function listThreadEntries() {
  try {
    const threads = getActiveThreads();
    return threads
      .map((t) => ({
        taskKey: t.taskKey,
        sdk: t.sdk,
        turnCount: t.turnCount,
        ageMs: t.age,
        threadId: t.threadId,
      }))
      .filter((entry) => entry.taskKey);
  } catch {
    return [];
  }
}

async function listWorktreeEntries() {
  try {
    const worktrees = await listManagedWorktrees();
    return worktrees
      .map((wt) => ({
        taskKey: wt.taskKey,
        branch: wt.branch,
        status: wt.status,
        ageMs: wt.age,
        owner: wt.owner,
        path: wt.path,
      }))
      .filter((entry) => entry.taskKey);
  } catch {
    return [];
  }
}

async function listSharedWorkspaceEntries() {
  try {
    const registry = await loadSharedRegistry();
    const sweep = await sweepSharedLeases({
      registry,
      actor: "telegram:ui",
    });
    return sweep.registry?.workspaces || [];
  } catch {
    return [];
  }
}

function buildSharedWorkspaceDetailLines(workspace) {
  if (!workspace) return [];
  const lines = [
    `Workspace: \`${workspace.id}\``,
    workspace.name && workspace.name !== workspace.id
      ? `Name: ${workspace.name}`
      : null,
    workspace.region ? `Region: ${workspace.region}` : null,
    workspace.provider ? `Provider: ${workspace.provider}` : null,
    `Status: ${workspace.availability}`,
  ];
  const lease = workspace.lease;
  if (lease) {
    lines.push(`Lease Owner: ${lease.owner || "unknown"}`);
    if (lease.claimed_at) {
      const claimedAt = Date.parse(lease.claimed_at);
      lines.push(`Claimed: ${formatAgeFromTimestamp(claimedAt)}`);
    }
    if (lease.lease_expires_at) {
      const expiresAt = Date.parse(lease.lease_expires_at);
      lines.push(`Expires In: ${formatTimeUntil(expiresAt)}`);
    }
    if (lease.notes) {
      lines.push(`Notes: ${shortSnippet(String(lease.notes), 120)}`);
    }
  }
  return lines.filter(Boolean);
}

async function listWorkspaceRegistryEntries() {
  try {
    const { registry } = await loadWorkspaceRegistry();
    return registry?.workspaces || [];
  } catch {
    return [];
  }
}

const UI_SCREENS = {};

Object.assign(UI_SCREENS, {
  home: {
    title: "OpenFleet Control Center",
    parent: null,
    body: async () => {
      const statusLine = await buildHomeStatusLine();
      const executor = _getInternalExecutor?.();
      let executorLine = "";
      if (executor) {
        const status = executor.getStatus();
        const paused = executor.isPaused?.() ? "paused" : "running";
        executorLine = `Executor: ${paused} • Slots ${status.activeSlots}/${status.maxParallel}`;
      } else {
        executorLine = `Executor: ${_getExecutorMode?.() || "internal"}`;
      }
      return [
        "Pick a section below to manage OpenFleet.",
        "",
        statusLine,
        executorLine,
      ].join("\n");
    },
    keyboard: () => {
      syncUiUrlsFromServer();
      const rows = [
        [
          uiButton("📊 Overview", uiGoAction("overview")),
          uiButton("🧭 Tasks", uiGoAction("tasks")),
          uiButton("🤖 Agents", uiGoAction("agents")),
        ],
        [
          uiButton("⚙️ Executor", uiGoAction("executor")),
          uiButton("🌳 Workspaces", uiGoAction("workspaces")),
          uiButton("🛰 Routing", uiGoAction("routing")),
        ],
        [
          uiButton("📁 Logs & Git", uiGoAction("logs")),
          uiButton("🔌 Integrations", uiGoAction("integrations")),
          uiButton("🧠 Session", uiGoAction("session")),
        ],
        [
          uiButton("💬 Ask Agent", uiInputAction("ask")),
          uiButton("📖 All Commands", uiCmdAction("/helpfull")),
        ],
      ];
      if (telegramWebAppUrl) {
        rows.unshift([
          {
            text: "📱 Open Control Center",
            web_app: { url: telegramWebAppUrl },
          },
        ]);
      } else if (telegramUiUrl) {
        rows.unshift([{ text: "🌐 Open Control Center", url: getBrowserUiUrl() || telegramUiUrl }]);
      }
      return buildKeyboard(rows);
    },
  },
  overview: {
    title: "Overview",
    parent: "home",
    body: () => "Live status, health, and presence dashboards.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("📊 Status", uiCmdAction("/status")),
          uiButton("📋 Tasks", uiCmdAction("/tasks")),
          uiButton("🤖 Agents", uiCmdAction("/agents")),
        ],
        [
          uiButton("🏥 Health", uiCmdAction("/health")),
          uiButton("⚠️ Anomalies", uiCmdAction("/anomalies")),
          uiButton("👁 Presence", uiCmdAction("/presence")),
        ],
        [
          uiButton("🎯 Coordinator", uiCmdAction("/coordinator")),
          uiButton("📝 Logs", uiCmdAction("/logs 50")),
        ],
        uiNavRow("home"),
      ]),
  },
  tasks: {
    title: "Task Operations",
    parent: "home",
    body: () =>
      "Pause/resume, plan, retry, cleanup, and guided manual starts.",
    keyboard: () =>
      buildKeyboard([
        [
          { text: "⏸ Pause", callback_data: "cb:confirm_pause" },
          { text: "▶️ Resume", callback_data: "cb:confirm_resume" },
          { text: "🔄 Restart", callback_data: "cb:confirm_restart" },
        ],
        [
          uiButton("📋 Tasks", uiCmdAction("/tasks")),
          uiButton("🧹 Cleanup", uiCmdAction("/cleanup")),
          uiButton("📊 Status", uiCmdAction("/status")),
        ],
        [
          uiButton("🗺️ Planner", uiGoAction("plan")),
          uiButton("🔁 Retry", uiGoAction("retry")),
          uiButton("⚙️ Executor", uiGoAction("executor")),
        ],
        [uiButton("▶️ Start Task (guided)", uiInputAction("starttask"))],
        uiNavRow("home"),
      ]),
  },
  plan: {
    title: "Task Planner",
    parent: "tasks",
    body: () => "Trigger the planner to seed new tasks.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("Plan 3", uiCmdAction("/plan 3")),
          uiButton("Plan 5", uiCmdAction("/plan 5")),
          uiButton("Plan 10", uiCmdAction("/plan 10")),
        ],
        [uiButton("Custom Count", uiInputAction("plan_count"))],
        uiNavRow("tasks"),
      ]),
  },
  retry: {
    title: "Fresh Retry",
    parent: "tasks",
    body: () => "Start a fresh session retry for the active task.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("Manual", uiCmdAction("/retry manual_ui")),
          uiButton("Stuck", uiCmdAction("/retry stuck")),
          uiButton("Rate Limit", uiCmdAction("/retry rate_limit")),
        ],
        [uiButton("Custom Reason", uiInputAction("retry_reason"))],
        uiNavRow("tasks"),
      ]),
  },
  executor: {
    title: "Executor",
    parent: "home",
    body: () => "Executor status, slots, and tuning.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("Status", uiCmdAction("/executor")),
          uiButton("Slots", uiCmdAction("/executor slots")),
          uiButton("Mode", uiCmdAction("/executor mode")),
        ],
        [
          uiButton("Max Parallel", uiGoAction("maxparallel")),
          uiButton("Pause", uiCmdAction("/pausetasks")),
          uiButton("Resume", uiCmdAction("/resumetasks")),
        ],
        uiNavRow("home"),
      ]),
  },
  maxparallel: {
    title: "Max Parallel",
    parent: "executor",
    body: () => "Set the max concurrent task slots.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("0 (Pause)", uiCmdAction("/maxparallel 0")),
          uiButton("1", uiCmdAction("/maxparallel 1")),
          uiButton("2", uiCmdAction("/maxparallel 2")),
        ],
        [
          uiButton("3", uiCmdAction("/maxparallel 3")),
          uiButton("4", uiCmdAction("/maxparallel 4")),
          uiButton("6", uiCmdAction("/maxparallel 6")),
        ],
        [
          uiButton("8", uiCmdAction("/maxparallel 8")),
          uiButton("12", uiCmdAction("/maxparallel 12")),
          uiButton("16", uiCmdAction("/maxparallel 16")),
        ],
        [uiButton("Custom", uiInputAction("maxparallel"))],
        uiNavRow("executor"),
      ]),
  },
  agents: {
    title: "Agents",
    parent: "home",
    body: () => "Monitor and steer running agents.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("🤖 Agents", uiCmdAction("/agents")),
          uiButton("📋 Tasks", uiCmdAction("/tasks")),
          uiButton("📊 Status", uiCmdAction("/status")),
        ],
        [
          uiButton("📂 Agent Logs", uiGoAction("agent_logs")),
          uiButton("🧵 Threads", uiGoAction("threads")),
          uiButton("🧠 History", uiCmdAction("/history")),
        ],
        [
          uiButton("🧭 Steer", uiInputAction("steer")),
          uiButton("🛑 Stop", uiCmdAction("/stop")),
          uiButton("🛰 Background", uiGoAction("background")),
        ],
        uiNavRow("home"),
      ]),
  },
  background: {
    title: "Background Mode",
    parent: "agents",
    body: () => "Run tasks silently or background the active agent.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("Background Active", uiCmdAction("/background")),
          uiButton("New Background Task", uiInputAction("background")),
        ],
        [
          uiButton("🧭 Steer", uiInputAction("steer")),
          uiButton("🛑 Stop", uiCmdAction("/stop")),
        ],
        uiNavRow("agents"),
      ]),
  },
  threads: {
    title: "Threads",
    parent: "agents",
    body: () => "Manage persistent agent threads.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("List Threads", uiCmdAction("/threads")),
          uiButton("Clear Registry", uiCmdAction("/threads clear")),
        ],
        [uiButton("Kill Thread", uiGoAction("threads_kill"))],
        uiNavRow("agents"),
      ]),
  },
});

Object.assign(UI_SCREENS, {
  agent_logs: {
    title: "Agent Logs",
    parent: "agents",
    body: () => "Pick a worktree to view logs, or search by branch fragment.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const names = await listWorktreeNames();
      if (names.length === 0) {
        return buildKeyboard([
          [uiButton("Search", uiInputAction("agentlogs"))],
          uiNavRow("agents"),
        ]);
      }
      const perPage = 8;
      const totalPages = Math.max(1, Math.ceil(names.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const start = safePage * perPage;
      const slice = names.slice(start, start + perPage);
      const rows = chunkButtons(
        slice.map((name) => {
          const token = issueUiToken({
            type: "cmd",
            command: `/agentlogs ${name}`,
          });
          return uiButton(shortenLabel(name), uiTokenAction(token));
        }),
        2,
      );
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton("⬅️ Prev", uiGoAction("agent_logs", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next ➡️", uiGoAction("agent_logs", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push([uiButton("Search", uiInputAction("agentlogs"))]);
      rows.push(uiNavRow("agents"));
      return buildKeyboard(rows);
    },
  },
  threads_kill: {
    title: "Kill Thread",
    parent: "threads",
    body: () => "Select a thread to review details and confirm invalidation.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const threads = await listThreadEntries();
      if (threads.length === 0) {
        return buildKeyboard([
          [uiButton("Custom Task Key", uiInputAction("threads_kill"))],
          uiNavRow("threads"),
        ]);
      }
      const perPage = 8;
      const totalPages = Math.max(1, Math.ceil(threads.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const slice = threads.slice(
        safePage * perPage,
        safePage * perPage + perPage,
      );
      const rows = chunkButtons(
        slice.map((entry) => {
          const age = formatDurationMs(entry.ageMs);
          const detailLines = [
            `Task Key: \`${entry.taskKey}\``,
            entry.sdk ? `SDK: \`${entry.sdk}\`` : null,
            Number.isFinite(entry.turnCount) ? `Turns: ${entry.turnCount}` : null,
            entry.threadId
              ? `Thread: \`${entry.threadId.slice(0, 12)}…\``
              : null,
            `Age: ${age}`,
          ];
          const token = issueUiToken({
            type: "confirm_cmd",
            command: `/threads kill ${entry.taskKey}`,
            title: "Invalidate Thread",
            confirmLabel: "Invalidate",
            detailLines,
            backAction: uiGoAction("threads_kill", safePage),
          });
          return uiButton(shortenLabel(entry.taskKey), uiTokenAction(token));
        }),
        2,
      );
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton("⬅️ Prev", uiGoAction("threads_kill", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next ➡️", uiGoAction("threads_kill", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push([uiButton("Custom Task Key", uiInputAction("threads_kill"))]);
      rows.push(uiNavRow("threads"));
      return buildKeyboard(rows);
    },
  },
});

Object.assign(UI_SCREENS, {
  routing: {
    title: "Routing & Models",
    parent: "home",
    body: () => "Control model routing, SDKs, and workspace routing.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("🤖 Model", uiGoAction("model")),
          uiButton("📦 SDK", uiGoAction("sdk")),
          uiButton("📋 Kanban", uiGoAction("kanban")),
        ],
        [
          uiButton("🌍 Region", uiGoAction("region")),
          uiButton("♻️ Auto Backlog", uiGoAction("autobacklog")),
          uiButton("📐 Requirements", uiGoAction("requirements")),
        ],
        [
          uiButton("🎯 Route Task", uiGoAction("route_task")),
          uiButton("🏥 Health", uiCmdAction("/health")),
        ],
        uiNavRow("home"),
      ]),
  },
  model: {
    title: "Model Override",
    parent: "routing",
    body: () => "Override the executor model for the next few tasks.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("gpt-5.2-codex", uiCmdAction("/model gpt-5.2-codex")),
          uiButton("gpt-5.1-max", uiCmdAction("/model gpt-5.1-codex-max")),
        ],
        [
          uiButton("gpt-5.1-mini", uiCmdAction("/model gpt-5.1-codex-mini")),
          uiButton("claude-opus-4.6", uiCmdAction("/model claude-opus-4.6")),
        ],
        [
          uiButton("claude-code", uiCmdAction("/model claude-code")),
          uiButton("Auto", uiCmdAction("/model auto")),
        ],
        uiNavRow("routing"),
      ]),
  },
  sdk: {
    title: "Agent SDK",
    parent: "routing",
    body: () => "Switch the agent pool SDK.",
    keyboard: () => {
      const available = getAvailableSdks();
      const rows = [];
      const buttons = ["codex", "copilot", "claude"].map((sdk) =>
        uiButton(sdk, uiCmdAction(`/sdk ${sdk}`)),
      );
      rows.push(...chunkButtons(buttons, 2));
      rows.push([uiButton("Auto", uiCmdAction("/sdk auto"))]);
      if (available.length > 0) {
        rows.unshift([
          uiButton(`Available: ${available.join(", ")}`, uiCmdAction("/sdk")),
        ]);
      }
      rows.push(uiNavRow("routing"));
      return buildKeyboard(rows);
    },
  },
  kanban: {
    title: "Kanban Backend",
    parent: "routing",
    body: () => "Switch the Kanban backend.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("Internal", uiCmdAction("/kanban internal")),
          uiButton("VK", uiCmdAction("/kanban vk")),
          uiButton("GitHub", uiCmdAction("/kanban github")),
        ],
        [uiButton("Jira", uiCmdAction("/kanban jira"))],
        [uiButton("Status", uiCmdAction("/kanban"))],
        uiNavRow("routing"),
      ]),
  },
  autobacklog: {
    title: "Auto Backlog",
    parent: "routing",
    body: () => "Experimental autonomous backlog replenishment controls.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("Enable", uiCmdAction("/autobacklog on")),
          uiButton("Disable", uiCmdAction("/autobacklog off")),
          uiButton("Status", uiCmdAction("/autobacklog")),
        ],
        [
          uiButton("Min 1", uiCmdAction("/autobacklog min 1")),
          uiButton("Min 2", uiCmdAction("/autobacklog min 2")),
        ],
        [
          uiButton("Max 1", uiCmdAction("/autobacklog max 1")),
          uiButton("Max 2", uiCmdAction("/autobacklog max 2")),
          uiButton("Max 3", uiCmdAction("/autobacklog max 3")),
        ],
        uiNavRow("routing"),
      ]),
  },
  requirements: {
    title: "Requirements Profile",
    parent: "routing",
    body: () => "Tune project-scope requirements for planning and backlog quality.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("Simple", uiCmdAction("/requirements simple-feature")),
          uiButton("Feature", uiCmdAction("/requirements feature")),
          uiButton("Large", uiCmdAction("/requirements large-feature")),
        ],
        [
          uiButton("System", uiCmdAction("/requirements system")),
          uiButton("Multi-System", uiCmdAction("/requirements multi-system")),
        ],
        [uiButton("Status", uiCmdAction("/requirements"))],
        uiNavRow("routing"),
      ]),
  },
  region: {
    title: "Codex Region",
    parent: "routing",
    body: () => "Switch Codex region routing.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("US", uiCmdAction("/region us")),
          uiButton("Sweden", uiCmdAction("/region sweden")),
          uiButton("Auto", uiCmdAction("/region auto")),
        ],
        [uiButton("Status", uiCmdAction("/region"))],
        uiNavRow("routing"),
      ]),
  },
  route_task: {
    title: "Route Task",
    parent: "routing",
    body: () => "Send tasks to a specific workspace or role.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("By Workspace", uiGoAction("route_workspace")),
          uiButton("By Role", uiGoAction("route_role")),
        ],
        [uiButton("Custom /agent", uiInputAction("agent_custom"))],
        uiNavRow("routing"),
      ]),
  },
  route_workspace: {
    title: "Route by Workspace",
    parent: "route_task",
    body: () => "Select a workspace to send a task.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const workspaces = await listWorkspaceRegistryEntries();
      if (!workspaces.length) {
        return buildKeyboard([
          [uiButton("Custom /agent", uiInputAction("agent_custom"))],
          uiNavRow("route_task"),
        ]);
      }
      const perPage = 8;
      const totalPages = Math.max(1, Math.ceil(workspaces.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const slice = workspaces.slice(
        safePage * perPage,
        safePage * perPage + perPage,
      );
      const rows = chunkButtons(
        slice.map((ws) => {
          const token = issueUiToken({
            type: "input",
            key: "agent_workspace_task",
            workspaceId: ws.id,
            commandPrefix: `/agent --workspace ${ws.id} `,
            prompt: `Task for workspace ${ws.id}:`,
          });
          const label = `${shortenLabel(ws.id)}${
            ws.role ? ` (${ws.role})` : ""
          }`;
          return uiButton(label, uiTokenAction(token));
        }),
        1,
      );
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton("⬅️ Prev", uiGoAction("route_workspace", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next ➡️", uiGoAction("route_workspace", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push([uiButton("Custom /agent", uiInputAction("agent_custom"))]);
      rows.push(uiNavRow("route_task"));
      return buildKeyboard(rows);
    },
  },
  route_role: {
    title: "Route by Role",
    parent: "route_task",
    body: () => "Select a role to route tasks.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const workspaces = await listWorkspaceRegistryEntries();
      const roles = Array.from(
        new Set(workspaces.map((ws) => ws.role).filter(Boolean)),
      );
      if (!roles.length) {
        return buildKeyboard([
          [uiButton("Custom /agent", uiInputAction("agent_custom"))],
          uiNavRow("route_task"),
        ]);
      }
      const perPage = 8;
      const totalPages = Math.max(1, Math.ceil(roles.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const slice = roles.slice(
        safePage * perPage,
        safePage * perPage + perPage,
      );
      const rows = chunkButtons(
        slice.map((role) => {
          const token = issueUiToken({
            type: "input",
            key: "agent_role_task",
            role,
            commandPrefix: `/agent --role ${role} `,
            prompt: `Task for role ${role}:`,
          });
          return uiButton(shortenLabel(role, 28), uiTokenAction(token));
        }),
        2,
      );
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton("⬅️ Prev", uiGoAction("route_role", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next ➡️", uiGoAction("route_role", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push([uiButton("Custom /agent", uiInputAction("agent_custom"))]);
      rows.push(uiNavRow("route_task"));
      return buildKeyboard(rows);
    },
  },
});

Object.assign(UI_SCREENS, {
  workspaces: {
    title: "Workspaces",
    parent: "home",
    body: () => "Worktree and shared workspace controls.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("🌳 Worktrees", uiCmdAction("/worktrees")),
          uiButton("📊 Stats", uiCmdAction("/worktrees stats")),
          uiButton("🧹 Prune", uiCmdAction("/worktrees prune")),
        ],
        [
          uiButton("🔓 Release", uiGoAction("worktrees_release")),
          uiButton("📁 Repos", uiCmdAction("/repos")),
          uiButton("👁 Presence", uiCmdAction("/presence")),
        ],
        [
          uiButton("📋 Shared", uiCmdAction("/shared_workspaces")),
          uiButton("✅ Claim", uiGoAction("shared_claim")),
          uiButton("🚪 Release", uiGoAction("shared_release")),
        ],
        [
          uiButton("🎯 Coordinator", uiCmdAction("/coordinator")),
          uiButton("📍 Worktree List", uiCmdAction("/worktrees")),
        ],
        uiNavRow("home"),
      ]),
  },
  worktrees_release: {
    title: "Release Worktree",
    parent: "workspaces",
    body: () => "Select a task key to review details and confirm release.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const entries = await listWorktreeEntries();
      if (entries.length === 0) {
        return buildKeyboard([
          [uiButton("Custom Task Key", uiInputAction("worktrees_release"))],
          uiNavRow("workspaces"),
        ]);
      }
      const perPage = 8;
      const totalPages = Math.max(1, Math.ceil(entries.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const slice = entries.slice(
        safePage * perPage,
        safePage * perPage + perPage,
      );
      const rows = chunkButtons(
        slice.map((entry) => {
          const age = formatDurationMs(entry.ageMs);
          const detailLines = [
            `Task Key: \`${entry.taskKey}\``,
            entry.branch ? `Branch: \`${entry.branch}\`` : null,
            entry.status ? `Status: ${entry.status}` : null,
            entry.owner ? `Owner: ${entry.owner}` : null,
            `Age: ${age}`,
            entry.path ? `Path: \`${shortPath(entry.path)}\`` : null,
          ];
          const token = issueUiToken({
            type: "confirm_cmd",
            command: `/worktrees release ${entry.taskKey}`,
            title: "Release Worktree",
            confirmLabel: "Release",
            detailLines,
            backAction: uiGoAction("worktrees_release", safePage),
          });
          return uiButton(shortenLabel(entry.taskKey), uiTokenAction(token));
        }),
        2,
      );
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton("⬅️ Prev", uiGoAction("worktrees_release", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next ➡️", uiGoAction("worktrees_release", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push([
        uiButton("Custom Task Key", uiInputAction("worktrees_release")),
      ]);
      rows.push(uiNavRow("workspaces"));
      return buildKeyboard(rows);
    },
  },
  shared_claim: {
    title: "Claim Shared Workspace",
    parent: "workspaces",
    body: () => "Select a workspace to review details and confirm claim.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const entries = await listSharedWorkspaceEntries();
      if (!entries.length) {
        return buildKeyboard([
          [uiButton("Custom Claim", uiInputAction("shared_claim"))],
          uiNavRow("workspaces"),
        ]);
      }
      const available = entries.filter((ws) => ws.availability === "available");
      const pool = available.length ? available : entries;
      const perPage = 8;
      const totalPages = Math.max(1, Math.ceil(pool.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const slice = pool.slice(
        safePage * perPage,
        safePage * perPage + perPage,
      );
      const rows = chunkButtons(
        slice.map((ws) => {
          const detailLines = buildSharedWorkspaceDetailLines(ws);
          if (ws.availability !== "available") {
            detailLines.push("Note: Workspace is not marked available.");
          }
          const token = issueUiToken({
            type: "confirm_cmd",
            command: `/claim ${ws.id}`,
            title: "Claim Shared Workspace",
            confirmLabel: ws.availability === "available" ? "Claim" : "Claim Anyway",
            detailLines,
            backAction: uiGoAction("shared_claim", safePage),
          });
          const emoji = ws.availability === "available" ? "✅" : "🔒";
          return uiButton(
            `${emoji} ${shortenLabel(ws.id)}`,
            uiTokenAction(token),
          );
        }),
        2,
      );
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton("⬅️ Prev", uiGoAction("shared_claim", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next ➡️", uiGoAction("shared_claim", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push([uiButton("Custom Claim", uiInputAction("shared_claim"))]);
      rows.push(uiNavRow("workspaces"));
      return buildKeyboard(rows);
    },
  },
  shared_release: {
    title: "Release Shared Workspace",
    parent: "workspaces",
    body: () => "Select a workspace to review details and confirm release.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const entries = await listSharedWorkspaceEntries();
      if (!entries.length) {
        return buildKeyboard([
          [uiButton("Custom Release", uiInputAction("shared_release"))],
          uiNavRow("workspaces"),
        ]);
      }
      const perPage = 8;
      const totalPages = Math.max(1, Math.ceil(entries.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const slice = entries.slice(
        safePage * perPage,
        safePage * perPage + perPage,
      );
      const rows = chunkButtons(
        slice.map((ws) => {
          const detailLines = buildSharedWorkspaceDetailLines(ws);
          if (ws.availability !== "leased") {
            detailLines.push("Note: Workspace is not currently leased.");
          }
          const token = issueUiToken({
            type: "confirm_cmd",
            command: `/release ${ws.id}`,
            title: "Release Shared Workspace",
            confirmLabel: "Release",
            detailLines,
            backAction: uiGoAction("shared_release", safePage),
          });
          const emoji = ws.availability === "leased" ? "🔓" : "ℹ️";
          return uiButton(
            `${emoji} ${shortenLabel(ws.id)}`,
            uiTokenAction(token),
          );
        }),
        2,
      );
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton("⬅️ Prev", uiGoAction("shared_release", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next ➡️", uiGoAction("shared_release", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push([uiButton("Custom Release", uiInputAction("shared_release"))]);
      rows.push(uiNavRow("workspaces"));
      return buildKeyboard(rows);
    },
  },
});

Object.assign(UI_SCREENS, {
  logs: {
    title: "Logs & Git",
    parent: "home",
    body: () => "Logs, branches, diffs, and utilities.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("📝 Logs", uiGoAction("logs_tail")),
          uiButton("🌿 Branches", uiCmdAction("/branches")),
          uiButton("💡 Diff", uiCmdAction("/diff")),
        ],
        [
          uiButton("🔎 Git", uiGoAction("git")),
          uiButton("🖥 Shell", uiGoAction("shell")),
          uiButton("📂 Agent Logs", uiGoAction("agent_logs")),
        ],
        uiNavRow("home"),
      ]),
  },
  logs_tail: {
    title: "Tail Logs",
    parent: "logs",
    body: () => "Choose how many log lines to show.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("30 lines", uiCmdAction("/logs 30")),
          uiButton("100 lines", uiCmdAction("/logs 100")),
          uiButton("300 lines", uiCmdAction("/logs 300")),
        ],
        [
          uiButton("600 lines", uiCmdAction("/logs 600")),
          uiButton("Custom", uiInputAction("logs_lines")),
        ],
        uiNavRow("logs"),
      ]),
  },
  git: {
    title: "Git",
    parent: "logs",
    body: () => "Quick git utilities.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("Status", uiCmdAction("/git status")),
          uiButton("Log -5", uiCmdAction("/git log --oneline -5")),
        ],
        [
          uiButton(
            "Branches",
            uiCmdAction("/git branch -a --sort=-committerdate"),
          ),
          uiButton("Diff Stat", uiCmdAction("/git diff --stat")),
        ],
        [uiButton("Custom Git", uiInputAction("git"))],
        uiNavRow("logs"),
      ]),
  },
  shell: {
    title: "Shell",
    parent: "logs",
    body: () => "Run safe shell commands.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("dir", uiCmdAction("/shell dir")),
          uiButton("cd", uiCmdAction("/shell cd")),
        ],
        [
          uiButton("whoami", uiCmdAction("/shell whoami")),
          uiButton("ver", uiCmdAction("/shell ver")),
        ],
        [uiButton("Custom Shell", uiInputAction("shell"))],
        uiNavRow("logs"),
      ]),
  },
  integrations: {
    title: "Integrations",
    parent: "home",
    body: () => "WhatsApp and container runtime status.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("📱 WhatsApp", uiCmdAction("/whatsapp")),
          uiButton("📦 Container", uiCmdAction("/container")),
        ],
        uiNavRow("home"),
      ]),
  },
  session: {
    title: "Session",
    parent: "home",
    body: () => "Primary agent session controls.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("🧠 History", uiCmdAction("/history")),
          uiButton("💬 Ask", uiInputAction("ask")),
        ],
        [
          uiButton("🧹 Clear", "confirm_clear"),
          uiButton("🧭 Steer", uiInputAction("steer")),
        ],
        [
          uiButton("🛰 Background", uiGoAction("background")),
          uiButton("🛑 Stop", uiCmdAction("/stop")),
        ],
        uiNavRow("home"),
      ]),
  },
});

async function showUiScreen(chatId, messageId, screenId, params = {}, opts = {}) {
  const screen = UI_SCREENS[screenId];
  if (!screen) {
    await sendReply(chatId, "Unknown menu.");
    return;
  }
  const sticky = Boolean(opts.sticky);
  const stickyActive = sticky || stickyMenuState.get(chatId)?.enabled;
  const isCurrentSticky = isStickyMenuMessage(chatId, messageId);
  const isStaleSticky =
    !!messageId && stickyActive && !isCurrentSticky && isStaleStickyMenuMessage(chatId, messageId);
  let resolvedMessageId = messageId;
  if (isStaleSticky) {
    await deleteDirect(chatId, messageId);
    resolvedMessageId = null;
  }
  const ctx = { chatId, params };
  const body =
    typeof screen.body === "function"
      ? await screen.body(ctx)
      : screen.body || "";
  const title = screen.title ? `*${screen.title}*` : "";
  const text = [title, body].filter(Boolean).join("\n\n");
  const keyboard =
    typeof screen.keyboard === "function"
      ? await screen.keyboard(ctx)
      : screen.keyboard;
  const finalKeyboard = appendRefreshRow(keyboard, screenId, params);
  const sendOpts = {
    parseMode: "Markdown",
    reply_markup: finalKeyboard,
  };
  if (resolvedMessageId) {
    await editDirect(chatId, resolvedMessageId, text, sendOpts);
    if (stickyActive) {
      setStickyMenuState(chatId, {
        enabled: true,
        screenId,
        params,
        messageId: resolvedMessageId,
      });
    }
  } else if (stickyActive) {
    const prev = stickyMenuState.get(chatId);
    if (prev?.messageId) {
      try {
        await deleteDirect(chatId, prev.messageId);
      } catch {
        /* best effort */
      }
    }
    const newId = await sendDirect(chatId, text, {
      ...sendOpts,
      skipSticky: true,
    });
    setStickyMenuState(chatId, {
      enabled: true,
      messageId: newId,
      screenId,
      params,
    });
  } else {
    await sendDirect(chatId, text, sendOpts);
  }
}

async function handleUiAction({ chatId, messageId, data }) {
  const { type, rest, raw } = parseUiAction(data);
  const stickyEnabled = ensureStickyMenuEnabled(chatId, messageId);
  const staleSticky = stickyEnabled && isStaleStickyMenuMessage(chatId, messageId);
  if (type === "cancel") {
    clearPendingUiInput(chatId);
    if (messageId) {
      await deleteDirect(chatId, messageId);
    }
    await sendReply(chatId, "✅ Input cancelled.");
    return;
  }
  if (type === "confirm_clear") {
    enqueueCommand(() => handleCommand("/clear", chatId));
    return;
  }
  if (type === "go") {
    const screenId = rest[0];
    const page = rest[1] ? parsePageParam(rest[1]) : 0;
    const resolvedMessageId =
      staleSticky ? null : messageId || null;
    await showUiScreen(chatId, resolvedMessageId, screenId, { page }, {
      sticky: stickyEnabled,
    });
    return;
  }
  if (type === "cmd") {
    if (staleSticky && messageId) {
      await deleteDirect(chatId, messageId);
    }
    const command = raw.slice(4);
    await dispatchUiCommand(chatId, command);
    return;
  }
  if (type === "input") {
    if (staleSticky && messageId) {
      await deleteDirect(chatId, messageId);
    }
    const key = rest[0];
    await promptUiInput(chatId, key);
    return;
  }
  if (type === "token") {
    const token = rest[0];
    const payload = readUiToken(token);
    if (!payload) {
      if (messageId && !isStickyMenuMessage(chatId, messageId)) {
        await deleteDirect(chatId, messageId);
      }
      if (messageId && isStickyMenuMessage(chatId, messageId)) {
        const state = stickyMenuState.get(chatId);
        if (state?.screenId) {
          await showUiScreen(chatId, messageId, state.screenId, state.params || {}, {
            sticky: true,
          });
        }
      }
      await sendReply(
        chatId,
        "⏳ That option expired. Please reopen the menu.",
      );
      return;
    }
    if (payload.type === "confirm_cmd") {
      if (staleSticky && messageId) {
        await deleteDirect(chatId, messageId);
      }
      await promptActionConfirm(chatId, token, payload);
      return;
    }
    if (payload.type === "cmd") {
      if (staleSticky && messageId) {
        await deleteDirect(chatId, messageId);
      }
      await dispatchUiCommand(chatId, payload.command);
      return;
    }
    if (payload.type === "input") {
      if (staleSticky && messageId) {
        await deleteDirect(chatId, messageId);
      }
      await promptUiInput(chatId, payload.key, payload);
      return;
    }
    if (payload.type === "go") {
      const resolvedMessageId =
        staleSticky || !isStickyMenuMessage(chatId, messageId)
          ? null
          : messageId;
      await showUiScreen(chatId, resolvedMessageId, payload.screenId, payload.params, {
        sticky: stickyEnabled,
      });
      return;
    }
    if (payload.type === "starttask_confirm") {
      await promptStartTaskConfirm(chatId, payload);
      return;
    }
    if (payload.type === "starttask_executor") {
      const mode = resolveStartTaskExecutorMode();
      const executor = resolveStartTaskExecutor(payload.executor, mode);
      if (!executor) {
        await sendReply(
          chatId,
          `⚠️ Executor "${payload.executor || "auto"}" not available (mode: ${mode}).`,
        );
        await showStartTaskExecutorPicker(chatId, payload.taskId);
        return;
      }
      if (executor === "vk") {
        await promptStartTaskConfirm(chatId, {
          taskId: payload.taskId,
          executor,
        });
        return;
      }
      await showStartTaskSdkPicker(chatId, payload.taskId, executor || "internal");
      return;
    }
    if (payload.type === "starttask_sdk") {
      await showStartTaskModelPicker(
        chatId,
        payload.taskId,
        payload.sdk,
        payload.executor,
      );
      return;
    }
    if (payload.type === "starttask_sdk_list") {
      await showStartTaskSdkPicker(
        chatId,
        payload.taskId,
        payload.executor,
      );
      return;
    }
    if (payload.type === "starttask_executor_list") {
      await showStartTaskExecutorPicker(chatId, payload.taskId);
      return;
    }
  }
  await sendReply(chatId, `Unknown UI action: ${data}`);
}

async function handleWebAppData(raw, chatId) {
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { type: "command", command: String(raw || "").trim() };
  }

  if (!payload || typeof payload !== "object") {
    await sendReply(chatId, "⚠️ Web app sent an invalid payload.");
    return;
  }

  if (payload.type === "command" && payload.command) {
    await dispatchUiCommand(chatId, payload.command);
    return;
  }

  if (payload.type === "menu" && payload.screen) {
    await showUiScreen(chatId, null, payload.screen, payload.params || {}, {
      sticky: stickyMenuState.get(chatId)?.enabled,
    });
    return;
  }

  if (payload.type === "prompt" && payload.key) {
    await promptUiInput(chatId, payload.key, payload);
    return;
  }

  await sendReply(chatId, "⚠️ Web app request not recognized.");
}

// ── Built-in Command Handlers ────────────────────────────────────────────────

function splitArgs(input) {
  if (!input) return [];
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function stripLeadingConfirmFlag(rawArgs) {
  const trimmed = String(rawArgs || "").trim();
  if (!trimmed) return { confirmed: false, args: "" };
  const match = trimmed.match(/^--confirm\b\s*/i);
  if (!match) return { confirmed: false, args: trimmed };
  return { confirmed: true, args: trimmed.slice(match[0].length).trim() };
}

function matchesAnyPattern(value, patterns) {
  const lower = String(value || "").toLowerCase();
  return patterns.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(lower) : lower.includes(pattern),
  );
}

function parseSharedWorkspaceArgs(args) {
  const tokens = splitArgs(args);
  const parsed = {
    workspaceId: null,
    owner: null,
    ttlMinutes: null,
    note: "",
    reason: "",
    force: false,
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--owner") {
      parsed.owner = tokens[i + 1];
      i++;
      continue;
    }
    if (token === "--ttl") {
      parsed.ttlMinutes = Number(tokens[i + 1]);
      i++;
      continue;
    }
    if (token === "--note") {
      parsed.note = tokens.slice(i + 1).join(" ");
      break;
    }
    if (token === "--reason") {
      parsed.reason = tokens.slice(i + 1).join(" ");
      break;
    }
    if (token === "--force") {
      parsed.force = true;
      continue;
    }
    if (!parsed.workspaceId) {
      parsed.workspaceId = token;
    }
  }
  return parsed;
}

function parseAgentArgs(args) {
  const tokens = splitArgs(args);
  let workspaceId = null;
  let role = null;
  let model = null;
  let queue = false;
  let newSession = false;
  let dryRun = false;
  let taskTokens = [];
  const remaining = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--workspace" || token === "-w") {
      workspaceId = tokens[i + 1] || null;
      i++;
      continue;
    }
    if (token.startsWith("--workspace=")) {
      workspaceId = token.slice("--workspace=".length) || null;
      continue;
    }
    if (token === "--role" || token === "-r") {
      role = tokens[i + 1] || null;
      i++;
      continue;
    }
    if (token.startsWith("--role=")) {
      role = token.slice("--role=".length) || null;
      continue;
    }
    if (token === "--model" || token === "-m") {
      model = tokens[i + 1] || null;
      i++;
      continue;
    }
    if (token.startsWith("--model=")) {
      model = token.slice("--model=".length) || null;
      continue;
    }
    if (token === "--queue") {
      queue = true;
      continue;
    }
    if (token === "--new-session") {
      newSession = true;
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--task" || token === "-t") {
      taskTokens = tokens.slice(i + 1);
      break;
    }
    if (token.startsWith("--task=")) {
      taskTokens = [token.slice("--task=".length)];
      break;
    }
    remaining.push(token);
  }

  if (taskTokens.length === 0) {
    taskTokens = remaining;
  }

  return {
    workspaceId: workspaceId ? workspaceId.trim() : null,
    role: role ? role.trim() : null,
    model: model ? model.trim() : null,
    queue,
    newSession,
    dryRun,
    message: taskTokens.join(" ").trim(),
  };
}

function isPathLike(value) {
  return /[\\/]|^[A-Za-z]:/.test(value);
}

function findRepoPath(basePath) {
  if (!basePath) return null;
  const resolved = resolve(basePath);
  if (existsSync(resolve(resolved, "go.mod"))) {
    return resolved;
  }
  return null;
}

async function listWorkspaceIds(worktreesRoot) {
  const entries = await readdir(worktreesRoot, { withFileTypes: true }).catch(
    () => [],
  );
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoPath = findRepoPath(resolve(worktreesRoot, entry.name));
    if (repoPath) ids.push(entry.name);
  }
  return ids;
}

async function resolveWorkspaceRepo(workspaceId) {
  const trimmed = (workspaceId || "").trim();
  if (!trimmed) {
    return {
      repoPath: repoRoot,
      label: "primary coordinator",
      isPrimary: true,
    };
  }

  const lower = trimmed.toLowerCase();
  if (["primary", "coordinator", "default"].includes(lower)) {
    return {
      repoPath: repoRoot,
      label: "primary coordinator",
      isPrimary: true,
    };
  }

  const worktreesRoot = resolve(repoRoot, "..", "..");
  const candidates = [];

  if (isPathLike(trimmed)) {
    candidates.push(trimmed);
    candidates.push(resolve(worktreesRoot, trimmed));
  } else {
    candidates.push(resolve(worktreesRoot, trimmed));
  }

  for (const candidate of candidates) {
    const repoPath = findRepoPath(candidate);
    if (repoPath) {
      return {
        repoPath,
        label: trimmed,
        isPrimary: repoPath === repoRoot,
      };
    }
  }

  const suggestions = await listWorkspaceIds(worktreesRoot);
  return {
    error: `Workspace "${trimmed}" not found.`,
    suggestions,
    worktreesRoot,
  };
}

async function loadWorkspaceStatusData(workspacePath) {
  try {
    const workspaceStatusPath = resolve(
      workspacePath,
      ".cache",
      "ve-orchestrator-status.json",
    );
    const raw = await readFile(workspaceStatusPath, "utf8").catch(() => null);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function cmdApp(chatId) {
  const { uiUrl, webAppUrl } = syncUiUrlsFromServer();
  if (!uiUrl) {
    await sendReply(
      chatId,
      "⚠️ Mini App not configured. Set TELEGRAM_UI_PORT and TELEGRAM_MINIAPP_ENABLED=true in your environment.",
    );
    return;
  }
  const rows = [[{ text: "🌐 Open in Browser", url: getBrowserUiUrl() || uiUrl }]];
  if (webAppUrl) {
    rows.unshift([{ text: "📱 Open Control Center", web_app: { url: webAppUrl } }]);
  }
  const keyboard = { inline_keyboard: rows };

  await sendDirect(
    chatId,
    "🚀 *OpenFleet Control Center*\n\nOpen the Mini App or access via browser:",
    {
      parseMode: "Markdown",
      reply_markup: keyboard,
    },
  );
}

async function cmdMenu(chatId) {
  syncUiUrlsFromServer();
  if (telegramApiReachable !== false) {
    void refreshMenuButton();
  }
  clearPendingUiInput(chatId);
  await showUiScreen(chatId, null, "home", {}, { sticky: true });
}

async function cmdCancel(chatId) {
  const pending = getPendingUiInput(chatId);
  if (!pending) {
    await sendReply(chatId, "No pending input to cancel.");
    return;
  }
  clearPendingUiInput(chatId);
  await sendReply(chatId, "✅ Input cancelled.");
}

async function cmdHelp(chatId) {
  await cmdMenu(chatId);
}

async function cmdHelpFull(chatId) {
  const lines = ["🤖 OpenFleet Primary Agent — All Commands:\n"];
  for (const [cmd, { desc }] of Object.entries(COMMANDS)) {
    lines.push(`${cmd} — ${desc}`);
  }
  lines.push(
    "",
    "Any other text → sent to the primary agent (full repo + MCP access)",
    "Use /menu for the full button-driven control center.",
  );
  await sendReply(chatId, lines.join("\n"));
}

async function cmdAsk(chatId, args) {
  const prompt = String(args || "").trim();
  if (!prompt) {
    await sendReply(chatId, "Usage: /ask <prompt>");
    return;
  }
  enqueueAgentTask(() => handleFreeText(prompt, chatId));
}

async function cmdStatus(chatId) {
  await sendReply(chatId, "⏳ Reading orchestrator status...");

  let statusText = "Status unavailable";

  // Try the formatted summary first
  if (_readStatusSummary) {
    try {
      const summary = await _readStatusSummary();
      if (summary?.text) {
        await sendReply(chatId, summary.text, {
          parseMode: summary.parseMode || undefined,
        });
        return;
      }
    } catch {
      /* fallback to raw */
    }
  }

  // Fallback: read raw status file
  try {
    const raw = await readFile(statusPath, "utf8");
    const data = JSON.parse(raw);

    const counts = data.counts || {};
    const sm = data.success_metrics || {};
    const backlog = data.backlog_remaining ?? "?";
    const submitted = Array.isArray(data.submitted_tasks)
      ? data.submitted_tasks.length
      : 0;
    const completed = Array.isArray(data.completed_tasks)
      ? data.completed_tasks.length
      : 0;
    const errors = Array.isArray(data.error_tasks) ? data.error_tasks : [];
    const reviews = Array.isArray(data.review_tasks) ? data.review_tasks : [];
    const manualReviews = Array.isArray(data.manual_review_tasks)
      ? data.manual_review_tasks
      : [];

    const lines = [
      "📊 OpenFleet Orchestrator Status",
      "",
      `Running: ${counts.running ?? 0}`,
      `Review: ${counts.review ?? 0}`,
      `Error: ${counts.error ?? 0}`,
      `Manual Review: ${counts.manual_review ?? 0}`,
      `Backlog: ${backlog}`,
      "",
      `Submitted: ${submitted} | Completed: ${completed}`,
      `First-shot: ${sm.first_shot_rate ?? 0}% (${sm.first_shot_success ?? 0}/${(sm.first_shot_success ?? 0) + (sm.needed_fix ?? 0) + (sm.failed ?? 0)})`,
      `Needed fix: ${sm.needed_fix ?? 0} | Failed: ${sm.failed ?? 0}`,
    ];

    if (errors.length > 0) {
      lines.push(
        "",
        "⚠️ Error tasks:",
        ...errors.slice(0, 5).map((t) => `  - ${t}`),
      );
    }
    if (manualReviews.length > 0) {
      lines.push(
        "",
        "👀 Manual review:",
        ...manualReviews.slice(0, 5).map((t) => `  - ${t}`),
      );
    }

    statusText = lines.join("\n");
  } catch (err) {
    statusText = `Status file error: ${err.message}`;
  }

  await sendReply(chatId, statusText);
}

async function cmdAnomalies(chatId) {
  if (!_getAnomalyReport) {
    await sendReply(chatId, "Anomaly detector not initialized.");
    return;
  }
  try {
    const report = _getAnomalyReport();
    await sendReply(chatId, report, { parseMode: "HTML" });
  } catch (err) {
    await sendReply(chatId, `Error getting anomaly report: ${err.message}`);
  }
}

function formatRuntimeSeconds(seconds) {
  const safeSeconds =
    Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const mins = Math.floor(safeSeconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  return `${hours}h${remMin}m`;
}

function formatAgeFromTimestamp(timestampMs) {
  const ts = Number(timestampMs || 0);
  if (!Number.isFinite(ts) || ts <= 0) return "n/a";
  const ageSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  const hours = Math.floor(ageSec / 3600);
  const remMin = Math.floor((ageSec % 3600) / 60);
  return remMin > 0 ? `${hours}h ${remMin}m ago` : `${hours}h ago`;
}

function formatTimeUntil(timestampMs) {
  const ts = Number(timestampMs || 0);
  if (!Number.isFinite(ts) || ts <= 0) return "n/a";
  const deltaSec = Math.floor((ts - Date.now()) / 1000);
  if (deltaSec <= 0) return "expired";
  if (deltaSec < 60) return `${deltaSec}s`;
  const mins = Math.floor(deltaSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

async function cmdTasks(chatId) {
  try {
    // ── Prefer live executor slots over stale status file ──
    const executor = _getInternalExecutor?.();
    const executorStatus = executor?.getStatus?.();

    if (executorStatus) {
      let statusSnapshot = null;
      if (_readStatusData) {
        try {
          statusSnapshot = await _readStatusData();
        } catch {
          /* best effort */
        }
      }
      const reviewTaskIds = (() => {
        try {
          const pending = _getTasksPendingReview?.() || [];
          if (Array.isArray(pending) && pending.length > 0) {
            return pending.map((task) => task?.id).filter(Boolean);
          }
        } catch {
          /* best effort */
        }
        return Array.isArray(statusSnapshot?.review_tasks)
          ? statusSnapshot.review_tasks
          : [];
      })();
      const lines = [];

      // Show pause state prominently at top
      if (executorStatus.paused) {
        const dur = executorStatus.pauseDuration || 0;
        const durStr =
          dur >= 3600
            ? Math.round(dur / 3600) + "h"
            : dur >= 60
              ? Math.round(dur / 60) + "m"
              : dur + "s";
        lines.push(`⏸ PAUSED (for ${durStr}) — /resumetasks to resume`);
        lines.push("");
      }

      if (executorStatus.slots.length > 0) {
        lines.push(
          `📋 Active Agents (${executorStatus.activeSlots}/${executorStatus.maxParallel} slots)\n`,
        );

        for (const slot of executorStatus.slots) {
          const emoji =
            slot.status === "running"
              ? "🟢"
              : slot.status === "error"
                ? "❌"
                : "🔵";
          const runStr = formatRuntimeSeconds(slot.runningFor);
          const agentId =
            Number.isFinite(slot.agentInstanceId) && slot.agentInstanceId > 0
              ? `#${slot.agentInstanceId}`
              : "n/a";

          // Branch is still the best debug key for logs/worktrees.
          const branch = slot.branch || slot.taskId.substring(0, 8);
          const shortBranch = branch.replace(/^ve\//, "");
          lines.push(`${emoji} Agent ${agentId} • ${shortBranch}`);
          lines.push(`   ${slot.taskTitle}`);
          lines.push(
            `   SDK: ${slot.sdk} | ⏱️ ${runStr} | Attempt #${slot.attempt} | Task ${slot.taskId.substring(0, 8)}`,
          );

          // Git diff stats
          if (slot.branch) {
            try {
              const diffStat = execSync(
                `git diff --shortstat main...${slot.branch} 2>nul || echo ""`,
                { cwd: repoRoot, encoding: "utf8", timeout: 8000 },
              ).trim();
              if (diffStat) {
                const insMatch = diffStat.match(/(\d+) insertion/);
                const delMatch = diffStat.match(/(\d+) deletion/);
                const filesMatch = diffStat.match(/(\d+) file/);
                lines.push(
                  `   📊 ${filesMatch?.[1] || 0} files | +${insMatch?.[1] || 0} -${delMatch?.[1] || 0}`,
                );
              }
            } catch {
              /* branch not pushed yet */
            }
          }
          lines.push(""); // spacing
        }

        const reviewAgent = _getReviewAgent?.();
        const reviewStatus =
          reviewAgent && typeof reviewAgent.getStatus === "function"
            ? reviewAgent.getStatus()
            : null;
        const reviewQueued =
          Number(reviewStatus?.queuedReviews || 0) +
          Number(reviewStatus?.activeReviews || 0);
        const taskStoreStats = _getTaskStoreStats?.() || null;
        const reviewCount = Math.max(
          Number(taskStoreStats?.inreview || 0),
          reviewQueued,
        );
        if (reviewCount > 0) {
          lines.push(`👀 In review: ${reviewCount} task(s)`);
          if (reviewStatus) {
            lines.push(
              `   Review agent queue: active=${reviewStatus.activeReviews || 0}, queued=${reviewStatus.queuedReviews || 0}, completed=${reviewStatus.completedReviews || 0}`,
            );
          }
          if (reviewTaskIds.length > 0) {
            for (const taskId of reviewTaskIds.slice(0, 5)) {
              lines.push(`   - ${taskId}`);
            }
          }
          lines.push("");
        }

        lines.push("────────────────────────────");
        lines.push(`Use /agentlogs <branch> for agent output`);

        await sendReply(chatId, lines.join("\n"));
        return;
      } else {
        // No active slots — show status summary
        lines.push(
          `📋 No active agents (0/${executorStatus.maxParallel} slots)`,
        );
        const reviewAgent = _getReviewAgent?.();
        const reviewStatus =
          reviewAgent && typeof reviewAgent.getStatus === "function"
            ? reviewAgent.getStatus()
            : null;
        const taskStoreStats = _getTaskStoreStats?.() || null;
        const reviewCount = Math.max(
          Number(taskStoreStats?.inreview || 0),
          Number(reviewStatus?.activeReviews || 0) +
            Number(reviewStatus?.queuedReviews || 0),
        );
        if (reviewCount > 0) {
          lines.push(`👀 In review: ${reviewCount} task(s)`);
          if (reviewTaskIds.length > 0) {
            for (const taskId of reviewTaskIds.slice(0, 5)) {
              lines.push(`   - ${taskId}`);
            }
          }
        }
        if (executorStatus.blockedTasks?.length > 0) {
          lines.push(
            `\n⛔ ${executorStatus.blockedTasks.length} task(s) blocked (exceeded retry limit)`,
          );
        }
        lines.push("");
        lines.push(
          executorStatus.paused
            ? `Use /resumetasks to start accepting tasks`
            : `Waiting for todo tasks in kanban...`,
        );
      }

      await sendReply(chatId, lines.join("\n"));
      return;
    }

    // ── Fallback: read status file (legacy/VK mode) ──
    const raw = await readFile(statusPath, "utf8");
    const data = JSON.parse(raw);
    const attempts = data.attempts || {};

    if (Object.keys(attempts).length === 0) {
      await sendReply(chatId, "No active task attempts tracked.");
      return;
    }

    const lines = ["📋 Active Task Attempts\n"];

    for (const [id, attempt] of Object.entries(attempts)) {
      if (!attempt) continue;
      const status = attempt.status || "unknown";
      const emoji =
        status === "running"
          ? "🟢"
          : status === "review"
            ? "👀"
            : status === "error"
              ? "❌"
              : status === "completed"
                ? "✅"
                : "⏸️";
      const branch = attempt.branch || "";
      const pr = attempt.pr_number ? ` PR#${attempt.pr_number}` : "";
      const title = attempt.task_title || attempt.task_id || id;
      const shortBranch = branch ? branch.replace(/^ve\//, "") : title;
      const agentIdRaw = Number(attempt.agent_instance_id);
      const agentId =
        Number.isFinite(agentIdRaw) && agentIdRaw > 0 ? `#${agentIdRaw}` : null;

      lines.push(
        `${emoji} ${agentId ? `Agent ${agentId} • ` : ""}${shortBranch}${pr}`,
      );
      lines.push(`   ${title}`);
      lines.push(`   Status: ${status} | Agent: ${attempt.executor || "?"}`);

      const started =
        attempt.started_at || attempt.created_at || attempt.updated_at;
      if (started) {
        const dur = Date.now() - Date.parse(started);
        const mins = Math.floor(dur / 60000);
        const hrs = Math.floor(mins / 60);
        const remMin = mins % 60;
        const durStr = hrs > 0 ? `${hrs}h ${remMin}m` : `${mins}m`;
        lines.push(`   ⏱️ Active: ${durStr}`);
      }

      if (branch) {
        try {
          const diffStat = execSync(
            `git diff --shortstat main...${branch} 2>nul || echo ""`,
            { cwd: repoRoot, encoding: "utf8", timeout: 8000 },
          ).trim();
          if (diffStat) {
            const insMatch = diffStat.match(/(\d+) insertion/);
            const delMatch = diffStat.match(/(\d+) deletion/);
            const filesMatch = diffStat.match(/(\d+) file/);
            lines.push(
              `   📊 ${filesMatch?.[1] || 0} files | +${insMatch?.[1] || 0} -${delMatch?.[1] || 0}`,
            );
          }
        } catch {
          /* git diff not available */
        }
      }
      lines.push("");
    }

    const running = Object.values(attempts).filter(
      (a) => a?.status === "running",
    ).length;
    const errors = Object.values(attempts).filter(
      (a) => a?.status === "error",
    ).length;
    const reviews = Object.values(attempts).filter(
      (a) => a?.status === "review" || a?.status === "manual_review",
    ).length;
    lines.push("────────────────────────────");
    lines.push(
      `Total: ${Object.keys(attempts).length} | Running: ${running} | Review: ${reviews} | Error: ${errors}`,
    );

    await sendReply(chatId, lines.join("\n"));
  } catch (err) {
    await sendReply(chatId, `Error reading tasks: ${err.message}`);
  }
}

async function cmdStartTask(chatId, args) {
  const rawArgs = String(args || "").trim();
  const tokens = rawArgs ? rawArgs.split(/\s+/) : [];
  const taskId = String(tokens.shift() || "").trim();
  if (!taskId) {
    await sendReply(
      chatId,
      "Usage: /starttask <taskId> [--executor internal|vk] [--sdk <sdk>] [--model <model>]",
    );
    return;
  }
  let sdk = "";
  let model = "";
  let executorArg = "";
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--sdk" && tokens[i + 1]) {
      sdk = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith("--sdk=")) {
      sdk = token.slice("--sdk=".length);
      continue;
    }
    if (token === "--model" && tokens[i + 1]) {
      model = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith("--model=")) {
      model = token.slice("--model=".length);
      continue;
    }
    if (token === "--executor" && tokens[i + 1]) {
      executorArg = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith("--executor=")) {
      executorArg = token.slice("--executor=".length);
      continue;
    }
  }
  const executorMode = resolveStartTaskExecutorMode();
  const normalizedExecutor = executorArg ? normalizeStartTaskExecutor(executorArg) : "";
  if (executorArg && !normalizedExecutor) {
    await sendReply(
      chatId,
      `⚠️ Unknown executor "${executorArg}". Use internal or vk.`,
    );
    return;
  }
  const selectedExecutor = resolveStartTaskExecutor(
    normalizedExecutor,
    executorMode,
  );
  if (!selectedExecutor) {
    const availability = getStartTaskExecutorAvailability(executorMode);
    const options = [
      availability.internal ? "internal" : null,
      availability.vk ? "vk" : null,
    ]
      .filter(Boolean)
      .join(" | ");
    await sendReply(
      chatId,
      `⚠️ Executor "${normalizedExecutor || "auto"}" not available (mode: ${executorMode}). Available: ${options || "none"}`,
    );
    return;
  }
  try {
    const adapter = getKanbanAdapter();
    const task = await adapter.getTask(taskId);
    if (!task) {
      await sendReply(chatId, `Task "${taskId}" not found.`);
      return;
    }
    if (selectedExecutor === "vk") {
      if (typeof adapter.submitTaskAttempt !== "function") {
        await sendReply(
          chatId,
          `⚠️ VK executor not available for current backend (${getKanbanBackendName()}).`,
        );
        return;
      }
      const attempt = await adapter.submitTaskAttempt(taskId);
      try {
        if (typeof adapter.updateTaskStatus === "function") {
          await adapter.updateTaskStatus(taskId, "inprogress");
        } else if (typeof adapter.updateTask === "function") {
          await adapter.updateTask(taskId, { status: "inprogress" });
        }
      } catch (err) {
        console.warn(
          `[openfleet] manual start failed to mark task ${taskId} inprogress: ${err.message}`,
        );
      }
      const detailLines = [
        `✅ VK executor submitted for ${task.title || task.id}.`,
        attempt?.id ? `Attempt: ${attempt.id}` : null,
        attempt?.branch ? `Branch: ${attempt.branch}` : null,
      ].filter(Boolean);
      if (sdk || model) {
        detailLines.push("Note: SDK/model overrides are ignored for VK.");
      }
      await sendReply(chatId, detailLines.join("\n"));
      return;
    }

    const executor = _getInternalExecutor?.();
    if (!executor) {
      await sendReply(
        chatId,
        "⚠️ Manual start requires internal executor. Set EXECUTOR_MODE=internal or hybrid and restart the monitor.",
      );
      return;
    }
    void executor.executeTask(task, {
      sdk: sdk || undefined,
      model: model || undefined,
    });
    await sendReply(
      chatId,
      `✅ Manual start queued for ${task.title || task.id}.` +
        `\nExecutor: ${selectedExecutor}` +
        (sdk ? `\nSDK: ${sdk}` : "") +
        (model ? `\nModel: ${model}` : ""),
    );
  } catch (err) {
    await sendReply(chatId, `❌ Manual start failed: ${err.message}`);
  }
}

async function cmdAgents(chatId) {
  try {
    const lines = ["🤖 Agent Fleet", ""];
    let statusSnapshot = null;
    if (_readStatusData) {
      try {
        statusSnapshot = await _readStatusData();
      } catch {
        /* best effort */
      }
    }

    const executor = _getInternalExecutor?.();
    const executorStatus = executor?.getStatus?.();
    if (executorStatus) {
      lines.push(
        `Task Executor: ${executorStatus.running ? "running" : "stopped"} | mode=${executorStatus.mode} | slots=${executorStatus.activeSlots}/${executorStatus.maxParallel} | sdk=${executorStatus.sdk}`,
      );
      if (executorStatus.slots.length > 0) {
        for (const slot of executorStatus.slots) {
          const agentId =
            Number.isFinite(slot.agentInstanceId) && slot.agentInstanceId > 0
              ? `#${slot.agentInstanceId}`
              : "n/a";
          lines.push(
            `  Agent ${agentId}: ${slot.taskTitle} | status=${slot.status} | run=${formatRuntimeSeconds(slot.runningFor)} | branch=${slot.branch || "-"}`,
          );
        }
      }
    } else {
      lines.push("Task Executor: unavailable");
    }

    const threads = getActiveThreads();
    lines.push(`Thread Registry: ${threads.length} active thread(s)`);
    for (const entry of threads.slice(0, 5)) {
      lines.push(
        `  ${entry.taskKey}: ${entry.sdk} turn=${entry.turnCount} age=${Math.round(entry.age / 60_000)}m`,
      );
    }

    const reviewEnabled = _getReviewAgentEnabled
      ? !!_getReviewAgentEnabled()
      : !!_getReviewAgent?.();
    const reviewAgent = _getReviewAgent?.();
    const reviewStatus =
      reviewAgent && typeof reviewAgent.getStatus === "function"
        ? reviewAgent.getStatus()
        : null;
    if (!reviewEnabled) {
      lines.push("Review Agent: disabled");
    } else if (reviewStatus) {
      lines.push(
        `Review Agent: running | active=${reviewStatus.activeReviews || 0} queued=${reviewStatus.queuedReviews || 0} completed=${reviewStatus.completedReviews || 0}`,
      );
    } else {
      lines.push("Review Agent: enabled, not running");
    }

    const endpoint = _getAgentEndpoint?.();
    const endpointStatus =
      endpoint && typeof endpoint.getStatus === "function"
        ? endpoint.getStatus()
        : null;
    if (endpointStatus) {
      lines.push(
        `Agent Endpoint: ${endpointStatus.running ? "listening" : "stopped"} | port=${endpointStatus.port} | uptime=${formatRuntimeSeconds(Math.floor((endpointStatus.uptimeMs || 0) / 1000))}`,
      );
    }

    const prCleanup = _getPrCleanupDaemon?.();
    const prStatus =
      prCleanup && typeof prCleanup.getStatus === "function"
        ? prCleanup.getStatus()
        : null;
    if (prStatus) {
      lines.push(
        `PR Cleanup Daemon: ${prStatus.running ? "running" : "stopped"} | active=${prStatus.activeCleanups} queued=${prStatus.queuedCleanups} | processed=${prStatus.stats?.prsProcessed || 0} resolved=${prStatus.stats?.conflictsResolved || 0}`,
      );
    }

    const monitorMonitor = _getMonitorMonitorStatus?.();
    if (monitorMonitor) {
      lines.push(
        `Monitor-Monitor: ${monitorMonitor.enabled ? (monitorMonitor.running ? "running" : "idle") : "disabled"} | sdk=${monitorMonitor.currentSdk || "n/a"} | failures=${monitorMonitor.consecutiveFailures || 0} | last=${formatAgeFromTimestamp(monitorMonitor.lastRunAt)}`,
      );
    }

    const workspaceMonitor = _getWorkspaceMonitor?.();
    if (
      workspaceMonitor &&
      typeof workspaceMonitor.getAllStates === "function"
    ) {
      const states = workspaceMonitor.getAllStates();
      lines.push(`Workspace Monitor: tracking ${states.length} workspace(s)`);
    }

    const syncEngine = _getSyncEngine?.();
    const syncStatus =
      syncEngine && typeof syncEngine.getStatus === "function"
        ? syncEngine.getStatus()
        : null;
    if (syncStatus) {
      lines.push(
        `Sync Engine: ${syncStatus.running ? "running" : "stopped"} | syncs=${syncStatus.syncsCompleted || 0} | failures=${syncStatus.consecutiveFailures || 0}`,
      );
    }

    const storeStats = _getTaskStoreStats?.();
    if (storeStats) {
      lines.push(
        `Task Store: todo=${storeStats.todo || 0} inprogress=${storeStats.inprogress || 0} inreview=${storeStats.inreview || 0} done=${storeStats.done || 0} blocked=${storeStats.blocked || 0}`,
      );
    }

    const conflictResolvingCount = Number(
      statusSnapshot?.counts?.conflict_resolving ||
        statusSnapshot?.counts?.conflictResolving ||
        0,
    );
    if (conflictResolvingCount > 0) {
      lines.push(
        `SDK Conflict Resolution Agents: active=${conflictResolvingCount}`,
      );
    }

    await sendReply(chatId, lines.join("\n"));
  } catch (err) {
    await sendReply(
      chatId,
      `❌ Failed to read agent fleet status: ${err.message}`,
    );
  }
}

/**
 * /agentlogs {branch} — Show agent output for a specific branch/worktree.
 * The branch can be partial (e.g. "hpc-topology" matches "ve/73ea9114-xl-p1-feat-hpc-topology-aware-scheduling").
 * Shows: last git log, last commit diff stat, worktree status.
 */
async function cmdAgentLogs(chatId, args) {
  const query = (args || "").trim();
  if (!query) {
    await sendReply(
      chatId,
      "Usage: /agentlogs <branch-fragment>\n\nExample: /agentlogs hpc-topology",
    );
    return;
  }

  try {
    // Find matching worktree
    const worktreeDir = resolve(repoRoot, ".cache", "worktrees");
    let dirs;
    try {
      dirs = await readdir(worktreeDir);
    } catch {
      await sendReply(chatId, "No worktrees directory found.");
      return;
    }

    const matches = dirs.filter((d) =>
      d.toLowerCase().includes(query.toLowerCase()),
    );
    if (matches.length === 0) {
      await sendReply(
        chatId,
        `No worktree matching "${query}".\n\nAvailable:\n${dirs.slice(0, 15).join("\n")}`,
      );
      return;
    }

    const wtName = matches[0]; // Best match
    const wtPath = resolve(worktreeDir, wtName);
    const lines = [`📂 Agent: ${wtName}\n`];

    // Git log (last 5 commits)
    try {
      const gitLog = execSync(`git log --oneline -5 2>&1`, {
        cwd: wtPath,
        encoding: "utf8",
        timeout: 10000,
      }).trim();
      if (gitLog) {
        lines.push("📝 Recent commits:");
        lines.push(gitLog);
      } else {
        lines.push("📝 No commits yet");
      }
    } catch {
      lines.push("📝 Git log unavailable");
    }

    lines.push("");

    // Git status
    try {
      const gitStatus = execSync(`git status --short 2>&1`, {
        cwd: wtPath,
        encoding: "utf8",
        timeout: 10000,
      }).trim();
      if (gitStatus) {
        const statusLines = gitStatus.split("\n");
        lines.push(`📄 Working tree: ${statusLines.length} changed files`);
        lines.push(statusLines.slice(0, 15).join("\n"));
        if (statusLines.length > 15)
          lines.push(`... +${statusLines.length - 15} more`);
      } else {
        lines.push("📄 Working tree: clean");
      }
    } catch {
      lines.push("📄 Git status unavailable");
    }

    lines.push("");

    // Diff stat vs main
    try {
      const branchName = execSync(`git branch --show-current 2>&1`, {
        cwd: wtPath,
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      const diffStat = execSync(`git diff --stat main...${branchName} 2>&1`, {
        cwd: wtPath,
        encoding: "utf8",
        timeout: 10000,
      }).trim();
      if (diffStat) {
        const statLines = diffStat.split("\n");
        lines.push("📊 Diff vs main:");
        // Show only summary line (last line)
        lines.push(statLines[statLines.length - 1] || "(none)");
      }
    } catch {
      /* no diff available */
    }

    lines.push("");

    // Check for active executor slot matching this branch
    const executor = _getInternalExecutor?.();
    if (executor) {
      const executorStatus = executor.getStatus?.();
      const slot = executorStatus?.slots?.find(
        (s) =>
          s.branch &&
          wtName.includes(s.branch.replace("ve/", "").replace(/\//g, "-")),
      );
      if (slot) {
        const runMin = Math.round(slot.runningFor / 60);
        const runStr =
          runMin >= 60
            ? `${Math.floor(runMin / 60)}h${runMin % 60}m`
            : `${runMin}m`;
        lines.push(
          `🤖 Active agent: ${slot.sdk} | Running: ${runStr} | Attempt #${slot.attempt}`,
        );
      } else {
        lines.push("🤖 No active agent on this branch");
      }
    }

    await sendReply(chatId, lines.join("\n"));
  } catch (err) {
    await sendReply(chatId, `Error: ${err.message}`);
  }
}

async function cmdLogs(chatId, _args) {
  const numLines = parseInt(_args, 10) || 30;
  try {
    const logFiles = await readdir(resolve(__dirname, "logs")).catch(() => []);
    const logFile = logFiles
      .filter((f) => f.endsWith(".log"))
      .sort()
      .pop(); // most recent

    if (!logFile) {
      await sendReply(chatId, "No log files found.");
      return;
    }

    const logPath = resolve(__dirname, "logs", logFile);
    const content = await readFile(logPath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const tail = lines.slice(-numLines).join("\n");

    await sendReply(
      chatId,
      `📄 Last ${numLines} lines of ${logFile}:\n\n${tail || "(empty)"}`,
    );
  } catch (err) {
    await sendReply(chatId, `Error reading logs: ${err.message}`);
  }
}

async function cmdBranches(chatId, _args) {
  try {
    const result = execSync("git branch -a --sort=-committerdate", {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10000,
    });
    const lines = result.split("\n").filter(Boolean).slice(0, 20);
    await sendReply(
      chatId,
      `🌿 Recent branches (top 20):\n\n${lines.join("\n")}`,
    );
  } catch (err) {
    await sendReply(chatId, `Error listing branches: ${err.message}`);
  }
}

async function cmdDiff(chatId, _args) {
  try {
    const diffStat = execSync("git diff --stat HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10000,
    });
    if (!diffStat.trim()) {
      await sendReply(chatId, "No uncommitted changes.");
      return;
    }
    await sendReply(
      chatId,
      `📝 Working tree changes:\n\n${diffStat.slice(0, 3500)}`,
    );
  } catch (err) {
    await sendReply(chatId, `Error reading diff: ${err.message}`);
  }
}

async function cmdRestart(chatId, args) {
  const confirmFlag = /--confirm\b/i.test(String(args || ""));
  if (!confirmFlag) {
    await sendReply(
      chatId,
      "⚠️ Restart will stop the orchestrator process and let the monitor respawn it.\nProceed?",
      { reply_markup: buildConfirmKeyboard("cb:do_restart", "Confirm Restart") },
    );
    return;
  }
  await sendReply(chatId, "🔄 Restarting orchestrator process...");
  try {
    if (_getCurrentChild) {
      const child = _getCurrentChild();
      if (child && child.pid) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* best effort */
        }
      }
    }
    // The monitor's handleExit will auto-restart the process
    await sendReply(
      chatId,
      "✅ Restart signal sent. Monitor will auto-restart the orchestrator.",
    );
  } catch (err) {
    await sendReply(chatId, `❌ Restart failed: ${err.message}`);
  }
}

async function cmdRetry(chatId, args) {
  if (!_attemptFreshSessionRetry) {
    await sendReply(
      chatId,
      "❌ Fresh session retry not available (not injected from monitor).",
    );
    return;
  }

  const reason = args?.trim() || "manual_retry_via_telegram";
  await sendReply(chatId, `🔄 Attempting fresh session retry (${reason})...`);

  try {
    const started = await _attemptFreshSessionRetry(reason);
    if (started) {
      await sendReply(
        chatId,
        "✅ Fresh session started. New agent will pick up the task.",
      );
    } else {
      await sendReply(
        chatId,
        "⚠️ Fresh session retry failed. Check logs for details (rate limit, no active attempt, or VK endpoint unavailable).",
      );
    }
  } catch (err) {
    await sendReply(chatId, `❌ Retry error: ${err.message || err}`);
  }
}

async function cmdPlan(chatId, args) {
  if (!_triggerTaskPlanner) {
    await sendReply(
      chatId,
      "❌ Task planner not available (not injected from monitor).",
    );
    return;
  }

  // Parse optional task count: /plan 5 or /plan 10
  const parsed = parseInt(args?.trim(), 10);
  const taskCount = Number.isFinite(parsed) && parsed > 0 ? parsed : 5;

  await sendReply(chatId, `📋 Triggering task planner (${taskCount} tasks)...`);

  try {
    const result = await _triggerTaskPlanner(
      "manual-telegram",
      { source: "telegram /plan command" },
      {
        taskCount,
        notify: false,
        preferredMode: "codex-sdk",
        allowCodexWhenDisabled: true,
      },
    );
    if (result?.status === "skipped") {
      if (result.reason === "planner_disabled") {
        await sendReply(
          chatId,
          "⚠️ Task planner disabled. Set TASK_PLANNER_MODE=kanban or codex-sdk.",
        );
        return;
      }
      if (result.reason === "planner_busy") {
        await sendReply(
          chatId,
          "⚠️ Task planner already running. Try again in a moment.",
        );
        return;
      }
      const lines = [
        "⚠️ Task planner skipped — a planning task already exists.",
      ];
      if (result.taskTitle) {
        lines.push(`Title: ${result.taskTitle}`);
      }
      if (result.taskId) {
        lines.push(`Task ID: ${result.taskId}`);
      }
      if (result.taskUrl) {
        lines.push(result.taskUrl);
      }
      await sendReply(chatId, lines.join("\n"));
      return;
    }
    if (result?.status === "created") {
      const lines = [
        "✅ Task planner task created.",
        result.taskTitle ? `Title: ${result.taskTitle}` : null,
        result.taskId ? `Task ID: ${result.taskId}` : null,
        result.taskUrl || null,
      ].filter(Boolean);
      await sendReply(chatId, lines.join("\n"));
      return;
    }
    if (result?.status === "completed") {
      const createdInfo =
        Number.isFinite(result.createdTaskCount) &&
        Number.isFinite(result.parsedTaskCount)
          ? `Created ${result.createdTaskCount}/${result.parsedTaskCount} tasks.\n`
          : "";
      const artifactInfo = result.artifactPath
        ? `\nArtifact: ${result.artifactPath}`
        : "";
      await sendReply(
        chatId,
        `✅ Task planner completed.\n${createdInfo}Output: ${result.outputPath}${artifactInfo}`,
      );
      return;
    }
    await sendReply(
      chatId,
      `✅ Task planner triggered for ${taskCount} tasks. Check backlog shortly.`,
    );
  } catch (err) {
    await sendReply(chatId, `❌ Task planner error: ${err.message || err}`);
  }
}

async function cmdCleanupMerged(chatId, args) {
  const confirmFlag = /--confirm\b/i.test(String(args || ""));
  if (!_reconcileTaskStatuses) {
    await sendReply(
      chatId,
      "❌ Cleanup not available (not injected from monitor).",
    );
    return;
  }
  if (!confirmFlag) {
    await sendReply(
      chatId,
      "⚠️ Cleanup will reconcile VK task statuses with PR/branch state.\nProceed?",
      { reply_markup: buildConfirmKeyboard("cb:confirm_cleanup", "Confirm Cleanup") },
    );
    return;
  }
  await sendReply(
    chatId,
    "🧹 Reconciling VK task statuses with PR/branch state…",
  );
  try {
    const result = await _reconcileTaskStatuses("manual-telegram");
    const lines = [
      "✅ Cleanup complete.",
      `Checked: ${result?.checked ?? 0}`,
      `Moved to done: ${result?.movedDone ?? 0}`,
      `Moved to inreview: ${result?.movedReview ?? 0}`,
    ];
    await sendReply(chatId, lines.join("\n"));
  } catch (err) {
    await sendReply(chatId, `❌ Cleanup error: ${err.message || err}`);
  }
}

async function cmdHistory(chatId) {
  const info = getPrimaryAgentInfo();
  const sessionLabel = info.sessionId || info.threadId || "(none)";
  const agentLabel = info.adapter || info.provider || getPrimaryAgentName();
  const lines = [
    `🧠 Primary Agent (${agentLabel})`,
    "",
    `Session: ${sessionLabel}`,
    `Turns: ${info.turnCount}`,
    `Active: ${info.isActive ? "yes" : "no"}`,
    `Busy: ${info.isBusy ? "yes" : "no"}`,
    info.workspacePath ? `Workspace: ${info.workspacePath}` : "",
    info.fallbackReason ? `Fallback: ${info.fallbackReason}` : "",
    "",
    "The session persists across messages.",
    "Use /clear to start a fresh session.",
  ];
  await sendReply(chatId, lines.filter(Boolean).join("\n"));
}

async function cmdClear(chatId, args) {
  const confirmFlag = /--confirm\b/i.test(String(args || ""));
  if (!confirmFlag) {
    const info = getPrimaryAgentInfo();
    const sessionLabel = info.sessionId || info.threadId || "(none)";
    const agentLabel = info.adapter || info.provider || getPrimaryAgentName();
    const lines = [
      "⚠️ This will clear the primary agent session and reset context.",
      "",
      `Agent: ${agentLabel}`,
      `Session: ${sessionLabel}`,
      `Turns: ${info.turnCount}`,
      `Busy: ${info.isBusy ? "yes" : "no"}`,
      "",
      "Proceed?",
    ];
    await sendReply(chatId, lines.join("\n"), {
      reply_markup: buildConfirmKeyboard("cb:confirm_clear", "Confirm Clear"),
    });
    return;
  }
  await resetPrimaryAgent();
  await sendReply(
    chatId,
    "🧹 Agent session reset. Next message starts a fresh conversation.",
  );
}

async function cmdGit(chatId, gitArgs) {
  if (!gitArgs) {
    await sendReply(
      chatId,
      "Usage: /git <command>\nExample: /git log --oneline -10",
    );
    return;
  }

  const { confirmed, args } = stripLeadingConfirmFlag(gitArgs);
  if (!args) {
    await sendReply(
      chatId,
      "Usage: /git <command>\nExample: /git log --oneline -10",
    );
    return;
  }
  const destructiveGit = [
    /^push\b/i,
    /^reset\b.*--hard\b/i,
    /^clean\b.*-f\b/i,
    /^checkout\b.*-f\b/i,
  ];
  if (!confirmed && matchesAnyPattern(args, destructiveGit)) {
    const token = issueUiToken({
      type: "confirm_cmd",
      command: `/git --confirm ${args}`,
      title: "Run Destructive Git Command",
      confirmLabel: "Run Git",
      detailLines: [`Command: \`git ${shortSnippet(args, 120)}\``],
      hint: "This may rewrite history or delete files.",
    });
    await promptActionConfirm(chatId, token, {
      type: "confirm_cmd",
      title: "Run Destructive Git Command",
      confirmLabel: "Run Git",
      detailLines: [`Command: \`git ${shortSnippet(args, 120)}\``],
      hint: "This may rewrite history or delete files.",
    });
    return;
  }

  try {
    const result = execSync(`git ${args}`, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15000,
    });
    await sendReply(
      chatId,
      `$ git ${args}\n\n${result.slice(0, 3800) || "(no output)"}`,
    );
  } catch (err) {
    await sendReply(
      chatId,
      `$ git ${args}\n\n❌ ${err.message?.slice(0, 1500) || err}`,
    );
  }
}

async function cmdShell(chatId, shellArgs) {
  if (!shellArgs) {
    await sendReply(
      chatId,
      "Usage: /shell <command>\nExample: /shell ls -la scripts/",
    );
    return;
  }

  const { confirmed, args } = stripLeadingConfirmFlag(shellArgs);
  if (!args) {
    await sendReply(
      chatId,
      "Usage: /shell <command>\nExample: /shell ls -la scripts/",
    );
    return;
  }

  const blockedShell = [/rm\s+-rf\s+\/(\s|$)/i];
  if (matchesAnyPattern(args, blockedShell)) {
    await sendReply(chatId, `⛔ Blocked: '${args}' is too destructive.`);
    return;
  }

  const confirmShell = [
    /rm\s+-rf\b/i,
    /rm\s+-r\b/i,
    "format",
    "del /f /s",
    "shutdown",
    "reboot",
  ];
  if (!confirmed && matchesAnyPattern(args, confirmShell)) {
    const token = issueUiToken({
      type: "confirm_cmd",
      command: `/shell --confirm ${args}`,
      title: "Run Destructive Shell Command",
      confirmLabel: "Run Shell",
      detailLines: [`Command: \`${shortSnippet(args, 120)}\``],
      hint: "This may delete data or stop services.",
    });
    await promptActionConfirm(chatId, token, {
      type: "confirm_cmd",
      title: "Run Destructive Shell Command",
      confirmLabel: "Run Shell",
      detailLines: [`Command: \`${shortSnippet(args, 120)}\``],
      hint: "This may delete data or stop services.",
    });
    return;
  }

  try {
    const isWin = process.platform === "win32";
    const result = execSync(args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30000,
      shell: isWin ? "cmd.exe" : "/bin/sh",
    });
    await sendReply(
      chatId,
      `$ ${args}\n\n${result.slice(0, 3800) || "(no output)"}`,
    );
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().slice(0, 1000) : "";
    const stdout = err.stdout ? err.stdout.toString().slice(0, 1000) : "";
    await sendReply(
      chatId,
      `$ ${args}\n\n❌ ${stderr || stdout || err.message}`,
    );
  }
}

// ── Region / Health / Model Override Commands ─────────────────────────────────

function runPwsh(psScript, timeoutMs = 15000) {
  const isWin = process.platform === "win32";
  const pwsh = isWin ? "powershell.exe" : "pwsh";
  const script = `& { ${psScript} }`;
  const result = spawnSync(pwsh, ["-NoProfile", "-Command", script], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "").trim() ||
        `powershell command failed (exit ${result.status})`,
    );
  }
  return result.stdout;
}

async function readStatusSnapshot() {
  try {
    const raw = await readFile(statusPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildExecutorKey(executor, variant) {
  const exec = (executor || "unknown").toString().trim().toUpperCase();
  const varNorm = variant ? String(variant).trim().toUpperCase() : "";
  return varNorm ? `${exec}:${varNorm}` : exec;
}

function buildExecutorHealthFromStatus(statusData) {
  const metrics = new Map();
  const attempts = statusData?.attempts ?? {};
  for (const info of Object.values(attempts)) {
    if (!info) continue;
    const key = buildExecutorKey(info.executor, info.executor_variant);
    const entry = metrics.get(key) || {
      active: 0,
      failures: 0,
      successes: 0,
      timeouts: 0,
      rate_limits: 0,
    };

    const processStatus = String(
      info.last_process_status || info.status || "",
    ).toLowerCase();
    const trackedStatus = String(info.status || "").toLowerCase();

    if (
      ["running", "queued", "in_progress", "active"].includes(processStatus) ||
      trackedStatus === "running"
    ) {
      entry.active += 1;
    } else if (
      ["failed", "error", "killed", "aborted"].includes(processStatus) ||
      trackedStatus === "error"
    ) {
      entry.failures += 1;
    } else if (
      ["completed", "success", "review", "done"].includes(processStatus) ||
      ["review", "completed", "done"].includes(trackedStatus)
    ) {
      entry.successes += 1;
    }

    if (processStatus.includes("timeout")) entry.timeouts += 1;
    if (processStatus.includes("rate") || processStatus.includes("limit")) {
      entry.rate_limits += 1;
    }

    metrics.set(key, entry);
  }
  return metrics;
}

function deriveExecutorStatus(stats) {
  if (!stats) return "unknown";
  if ((stats.rate_limits ?? 0) > 0) return "cooldown";
  if ((stats.failures ?? 0) > 0 || (stats.timeouts ?? 0) > 0) {
    return "degraded";
  }
  if ((stats.active ?? 0) > 0 || (stats.successes ?? 0) > 0) {
    return "healthy";
  }
  return "unknown";
}

function buildExecutorHealthEntries(executorConfig, metrics) {
  const entries = [];
  const usedKeys = new Set();
  const executors = executorConfig?.executors ?? [];

  for (const exec of executors) {
    const key = buildExecutorKey(exec.executor, exec.variant);
    const stats =
      metrics.get(key) ||
      metrics.get(buildExecutorKey(exec.executor, null)) ||
      null;
    usedKeys.add(key);
    entries.push({
      label:
        exec.executor && exec.variant
          ? `${exec.executor}/${exec.variant}`
          : exec.executor || exec.name || key,
      tier: exec.tier || exec.role || "default",
      region: exec.region || exec.variant || "default",
      status: deriveExecutorStatus(stats),
      stats: stats || {
        active: 0,
        failures: 0,
        successes: 0,
        timeouts: 0,
        rate_limits: 0,
      },
    });
  }

  for (const [key, stats] of metrics.entries()) {
    if (usedKeys.has(key)) continue;
    entries.push({
      label: key.replace(":", "/"),
      tier: "default",
      region: "default",
      status: deriveExecutorStatus(stats),
      stats,
    });
  }

  return entries;
}

async function cmdRegion(chatId, regionArg) {
  if (!regionArg || regionArg.trim() === "") {
    // Show current region status
    try {
      const result = runPwsh(
        `. '${resolveVeKanbanPs1Path()}'; Initialize-CodexRegionTracking; Get-RegionStatus | ConvertTo-Json -Depth 3`,
      );
      const status = JSON.parse(result);
      const lines = [
        "🌍 Codex Region Status",
        "",
        `Active: ${status.active_region?.toUpperCase() || "unknown"}`,
        `Override: ${status.override || "auto"}`,
        `Sweden available: ${status.sweden_available ? "✅" : "❌"}`,
        `Cooldown: ${status.cooldown_min}min`,
      ];
      if (status.switched_ago_min !== null) {
        lines.push(`Switched: ${status.switched_ago_min}min ago`);
      }
      if (status.active_region === "sweden") {
        lines.push(
          `Auto-restore to US: ${status.cooldown_expired ? "ready" : `in ${Math.round(status.cooldown_min - (status.switched_ago_min || 0))}min`}`,
        );
      }
      lines.push("", "Usage: /region us | /region sweden | /region auto");
      await sendReply(chatId, lines.join("\n"));
    } catch (err) {
      await sendReply(chatId, `Error reading region: ${err.message}`);
    }
    return;
  }

  const target = regionArg.trim().toLowerCase();
  if (!["us", "sweden", "auto"].includes(target)) {
    await sendReply(
      chatId,
      "Usage: /region us | /region sweden | /region auto",
    );
    return;
  }

  try {
    const psCmd =
      target === "auto"
        ? `. '${resolveVeKanbanPs1Path()}'; Set-RegionOverride -Region $null | ConvertTo-Json`
        : `. '${resolveVeKanbanPs1Path()}'; Set-RegionOverride -Region '${target}' | ConvertTo-Json`;
    const result = runPwsh(psCmd);
    const info = JSON.parse(result);
    const icon = info.changed ? "✅" : "ℹ️";
    await sendReply(
      chatId,
      `${icon} Region: ${info.region?.toUpperCase()}\nReason: ${info.reason}`,
    );
  } catch (err) {
    await sendReply(chatId, `❌ Region switch failed: ${err.message}`);
  }
}

async function cmdHealth(chatId) {
  try {
    const statusData = await readStatusSnapshot();
    let executorConfig = null;
    try {
      executorConfig = loadExecutorConfig(__dirname, null);
    } catch {
      executorConfig = null;
    }
    const metrics = buildExecutorHealthFromStatus(statusData);
    const arr = buildExecutorHealthEntries(executorConfig, metrics);

    const iconMap = {
      healthy: "✅",
      degraded: "⚠️",
      cooldown: "⏸️",
      disabled: "❌",
    };
    const lines = ["🏥 Executor Health Dashboard\n"];

    if (!arr.length) {
      lines.push("No executor data available.");
    }

    for (const e of arr) {
      const icon = iconMap[e.status] || "❓";
      lines.push(
        `${icon} ${e.label} (${e.tier}/${e.region})\n` +
          `   Status: ${e.status} | Active: ${e.stats.active}\n` +
          `   ✓${e.stats.successes} ✗${e.stats.failures} ⏱${e.stats.timeouts} 🚫${e.stats.rate_limits}`,
      );
    }

    // Add region info
    try {
      const regionScript = [
        `. '${resolveVeKanbanPs1Path()}';`,
        "Initialize-CodexRegionTracking;",
        "Get-RegionStatus | ConvertTo-Json",
      ].join(" ");
      const regionResult = runPwsh(regionScript, 10000);
      const region = JSON.parse(regionResult);
      lines.push(
        "",
        `🌍 Region: ${region.active_region?.toUpperCase()} ${region.override ? `(override: ${region.override})` : "(auto)"}`,
        `Sweden backup: ${region.sweden_available ? "available" : "not configured"}`,
      );
    } catch {
      lines.push("", "🌍 Region: unavailable");
    }

    await sendReply(chatId, lines.join("\n"));
  } catch (err) {
    await sendReply(chatId, `Error reading health: ${err.message}`);
  }
}

async function cmdPresence(chatId) {
  await ensurePresenceReady();
  const child = _getCurrentChild ? _getCurrentChild() : null;
  const payload = buildLocalPresence({
    orchestrator_running: !!child,
    orchestrator_pid: child?.pid ?? null,
    vk_url: _getVibeKanbanUrl ? _getVibeKanbanUrl() : null,
  });
  await notePresence(payload, {
    source: "local",
    receivedAt: payload.updated_at,
  });
  const nowMs = Date.now();
  const summary = formatPresenceSummary({ nowMs, ttlMs: presenceTtlMs });
  await sendReply(chatId, summary);
}

async function cmdCoordinator(chatId) {
  await ensurePresenceReady();
  const nowMs = Date.now();
  const summary = formatCoordinatorSummary({ nowMs, ttlMs: presenceTtlMs });
  await sendReply(chatId, summary);
}

/** State for model override — write a file that orchestrator reads */
const modelOverridePath = resolve(repoRoot, ".cache", "executor-override.json");

async function cmdModel(chatId, modelArg) {
  if (!modelArg || modelArg.trim() === "") {
    // Show current model routing info
    try {
      const exists = existsSync(modelOverridePath);
      let overrideText = "none (auto routing)";
      if (exists) {
        const raw = await readFile(modelOverridePath, "utf8");
        const data = JSON.parse(raw);
        if (
          data.model &&
          (!data.expires_at || new Date(data.expires_at) > new Date())
        ) {
          overrideText = `${data.model} (until ${data.expires_at || "cleared"})`;
        }
      }
      const lines = [
        "🤖 Model Routing",
        "",
        `Override: ${overrideText}`,
        "",
        "Available models:",
        "  gpt-5.2-codex      — Primary, best speed/quality",
        "  gpt-5.1-codex-max  — Large tasks, extra capacity",
        "  gpt-5.1-codex-mini — Small tasks, subagent-optimized",
        "  claude-opus-4.6    — Supreme quality, complex refactors",
        "  claude-code        — Claude Code CLI fallback",
        "",
        "Usage:",
        "  /model gpt-5.2-codex     Set override for next 3 tasks",
        "  /model auto              Clear override (smart routing)",
      ];
      await sendReply(chatId, lines.join("\n"));
    } catch (err) {
      await sendReply(chatId, `Error: ${err.message}`);
    }
    return;
  }

  const target = modelArg.trim().toLowerCase();

  if (target === "auto" || target === "clear") {
    try {
      if (existsSync(modelOverridePath)) {
        await unlink(modelOverridePath);
      }
      await sendReply(
        chatId,
        "✅ Model override cleared. Smart routing active.",
      );
    } catch (err) {
      await sendReply(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  const validModels = [
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "claude-opus-4.6",
    "claude-code",
  ];
  if (!validModels.includes(target)) {
    await sendReply(
      chatId,
      `Unknown model: ${target}\nValid: ${validModels.join(", ")}`,
    );
    return;
  }

  try {
    const override = {
      model: target,
      remaining_tasks: 3,
      set_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
    };
    await writeFile(
      modelOverridePath,
      JSON.stringify(override, null, 2),
      "utf8",
    );
    await sendReply(
      chatId,
      `✅ Model override set: ${target}\nApplies to next 3 tasks (or 1 hour)`,
    );
  } catch (err) {
    await sendReply(chatId, `❌ Error: ${err.message}`);
  }
}

async function cmdKanban(chatId, backendArg) {
  if (!backendArg || backendArg.trim() === "") {
    const current = getKanbanBackendName();
    const available = getAvailableBackends();
    const syncPolicy = String(
      process.env.KANBAN_SYNC_POLICY || "internal-primary",
    ).toLowerCase();
    const lines = [
      "📋 Kanban Backend Status",
      "",
      `Active: ${current}`,
      `Sync Policy: ${syncPolicy}`,
      `Available: ${available.join(", ")}`,
      "",
      "Switch backend:",
      "  /kanban internal  Internal task-store (primary)",
      "  /kanban vk        Vibe-Kanban (secondary)",
      "  /kanban github     GitHub Issues",
      "  /kanban jira       Jira (stub)",
    ];
    await sendReply(chatId, lines.join("\n"));
    return;
  }

  const target = backendArg.trim().toLowerCase();
  const validBackends = getAvailableBackends();

  if (!validBackends.includes(target)) {
    await sendReply(
      chatId,
      `Unknown backend: ${target}\nValid: ${validBackends.join(", ")}`,
    );
    return;
  }

  try {
    setKanbanBackend(target);
    await sendReply(
      chatId,
      `✅ Kanban backend switched to: ${target}\nActive: ${getKanbanBackendName()}`,
    );
  } catch (err) {
    await sendReply(chatId, `❌ Error switching backend: ${err.message}`);
  }
}

async function cmdAutoBacklog(chatId, args) {
  const executor = _getInternalExecutor?.();
  if (!executor) {
    await sendReply(chatId, "⚠️ Internal executor is not available.");
    return;
  }

  const parts = String(args || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0 || parts[0] === "status") {
    const cfg = executor.getBacklogReplenishmentConfig?.() || {};
    await sendReply(
      chatId,
      [
        "♻️ Experimental Auto-Backlog",
        "",
        `Enabled: ${cfg.enabled ? "yes" : "no"}`,
        `Min new tasks: ${cfg.minNewTasks ?? 1}`,
        `Max new tasks: ${cfg.maxNewTasks ?? 2}`,
        `Require priority: ${cfg.requirePriority !== false ? "yes" : "no"}`,
        `Requirements profile: ${cfg.projectRequirements?.profile || "feature"}`,
        "",
        "Usage:",
        "  /autobacklog on|off",
        "  /autobacklog min <1|2>",
        "  /autobacklog max <1|2|3>",
      ].join("\n"),
    );
    return;
  }

  const op = parts[0];
  if (op === "on" || op === "off") {
    const cfg = executor.setBacklogReplenishmentConfig?.({
      enabled: op === "on",
    });
    await sendReply(
      chatId,
      `✅ Auto-backlog ${op === "on" ? "enabled" : "disabled"}. Min=${cfg?.minNewTasks ?? 1}, Max=${cfg?.maxNewTasks ?? 2}`,
    );
    return;
  }

  if ((op === "min" || op === "max") && parts[1]) {
    const value = Number(parts[1]);
    if (!Number.isFinite(value)) {
      await sendReply(chatId, `❌ Invalid ${op} value: ${parts[1]}`);
      return;
    }
    const patch = op === "min" ? { minNewTasks: value } : { maxNewTasks: value };
    const cfg = executor.setBacklogReplenishmentConfig?.(patch);
    await sendReply(
      chatId,
      `✅ Auto-backlog updated. Enabled=${cfg?.enabled ? "yes" : "no"}, Min=${cfg?.minNewTasks ?? 1}, Max=${cfg?.maxNewTasks ?? 2}`,
    );
    return;
  }

  await sendReply(chatId, "Usage: /autobacklog [status|on|off|min <n>|max <n>]");
}

async function cmdRequirements(chatId, args) {
  const executor = _getInternalExecutor?.();
  if (!executor) {
    await sendReply(chatId, "⚠️ Internal executor is not available.");
    return;
  }
  const profiles = [
    "simple-feature",
    "feature",
    "large-feature",
    "system",
    "multi-system",
  ];
  const input = String(args || "").trim();
  if (!input) {
    const req = executor.getProjectRequirements?.() || {
      profile: "feature",
      notes: "",
    };
    await sendReply(
      chatId,
      [
        "📐 Project Requirements",
        "",
        `Profile: ${req.profile || "feature"}`,
        `Notes: ${req.notes || "(none)"}`,
        "",
        "Usage:",
        "  /requirements <simple-feature|feature|large-feature|system|multi-system>",
      ].join("\n"),
    );
    return;
  }

  const profile = input.toLowerCase();
  if (!profiles.includes(profile)) {
    await sendReply(
      chatId,
      `❌ Unknown requirements profile: ${input}\nValid: ${profiles.join(", ")}`,
    );
    return;
  }

  const req = executor.setProjectRequirements?.({ profile });
  await sendReply(
    chatId,
    `✅ Project requirements profile set to ${req?.profile || profile}`,
  );
}

async function cmdThreads(chatId, subArg) {
  if (subArg) {
    const parts = subArg.trim().split(/\s+/);
    const sub = parts[0]?.toLowerCase();
    if (sub === "clear") {
      const confirmed = parts.slice(1).some((p) => p === "--confirm");
      if (!confirmed) {
        await sendReply(
          chatId,
          "⚠️ This will clear all thread records. Proceed?",
          {
            reply_markup: buildConfirmKeyboard(
              "cb:confirm_threads_clear",
              "Confirm Clear",
            ),
          },
        );
        return;
      }
      clearThreadRegistry();
      await sendReply(chatId, "✅ Thread registry cleared.");
      return;
    }
  }

  if (subArg && subArg.trim().toLowerCase().startsWith("kill ")) {
    const tokens = subArg.trim().split(/\s+/);
    const taskKey = tokens.slice(1).find((t) => !t.startsWith("--")) || "";
    const confirmed = tokens.includes("--confirm");
    if (!taskKey) {
      await sendReply(chatId, "Usage: /threads kill <taskKey>");
      return;
    }
    if (!confirmed) {
      const token = issueUiToken({
        type: "confirm_cmd",
        command: `/threads kill ${taskKey} --confirm`,
        title: "Invalidate Thread",
        confirmLabel: "Invalidate",
        detailLines: [`Task Key: \`${taskKey}\``],
        backAction: uiGoAction("threads_kill"),
      });
      await promptActionConfirm(chatId, token, {
        type: "confirm_cmd",
        title: "Invalidate Thread",
        confirmLabel: "Invalidate",
        detailLines: [`Task Key: \`${taskKey}\``],
        backAction: uiGoAction("threads_kill"),
      });
      return;
    }
    invalidateThread(taskKey);
    await sendReply(chatId, `✅ Thread for "${taskKey}" invalidated.`);
    return;
  }

  const threads = getActiveThreads();
  if (threads.length === 0) {
    await sendReply(
      chatId,
      "🧵 No active agent threads.\n\nThreads are created when tasks run via the agent pool with thread persistence.",
    );
    return;
  }

  const lines = [`🧵 Active Agent Threads (${threads.length})`, ""];

  for (const t of threads) {
    const ageMin = Math.round(t.age / 60_000);
    lines.push(
      `• ${t.taskKey}`,
      `  SDK: ${t.sdk} | Turns: ${t.turnCount} | Age: ${ageMin}m`,
      `  Thread: ${t.threadId ? t.threadId.slice(0, 12) + "…" : "(none)"}`,
      "",
    );
  }

  lines.push(
    "Commands:",
    "  /threads clear          Clear all thread records",
    "  /threads kill <taskKey>  Invalidate a specific thread",
  );

  await sendReply(chatId, lines.join("\n"));
}

/**
 * /worktrees — View and manage git worktrees.
 *
 * Subcommands:
 *   /worktrees           — Show all active worktrees with branch, task, age
 *   /worktrees stats     — Show aggregate statistics
 *   /worktrees prune     — Prune stale/orphaned worktrees
 *   /worktrees release <taskKey> — Release a specific worktree by task key
 */
async function cmdWorktrees(chatId, args) {
  const parts = args ? args.trim().split(/\s+/) : [];
  const sub = parts[0]?.toLowerCase();

  if (sub === "prune") {
    const confirmed = parts.slice(1).some((p) => p === "--confirm");
    if (!confirmed) {
      const token = issueUiToken({
        type: "confirm_cmd",
        command: "/worktrees prune --confirm",
        title: "Prune Worktrees",
        confirmLabel: "Prune",
        detailLines: ["This removes stale/orphaned worktrees from disk."],
        backAction: uiGoAction("worktrees"),
      });
      await promptActionConfirm(chatId, token, {
        type: "confirm_cmd",
        title: "Prune Worktrees",
        confirmLabel: "Prune",
        detailLines: ["This removes stale/orphaned worktrees from disk."],
        backAction: uiGoAction("worktrees"),
      });
      return;
    }
    // Prune stale worktrees
    try {
      const result = await pruneStaleWorktrees();
      const lines = [`🧹 Worktree prune complete:`];
      lines.push(`  Pruned: ${result.pruned}`);
      lines.push(`  Registry evicted: ${result.evicted}`);
      await sendReply(chatId, lines.join("\n"));
    } catch (err) {
      await sendReply(chatId, `❌ Prune failed: ${err.message}`);
    }
    return;
  }

  if (sub === "release") {
    const taskKey = parts[1];
    if (!taskKey) {
      await sendReply(chatId, "Usage: /worktrees release <taskKey>");
      return;
    }
    const confirmed = parts.slice(2).some((p) => p === "--confirm");
    if (!confirmed) {
      const token = issueUiToken({
        type: "confirm_cmd",
        command: `/worktrees release ${taskKey} --confirm`,
        title: "Release Worktree",
        confirmLabel: "Release",
        detailLines: [`Task Key: \`${taskKey}\``],
        backAction: uiGoAction("worktrees_release"),
      });
      await promptActionConfirm(chatId, token, {
        type: "confirm_cmd",
        title: "Release Worktree",
        confirmLabel: "Release",
        detailLines: [`Task Key: \`${taskKey}\``],
        backAction: uiGoAction("worktrees_release"),
      });
      return;
    }
    try {
      const wm = getWorktreeManager();
      const result = wm.releaseWorktree(taskKey);
      if (result.success) {
        await sendReply(
          chatId,
          `✅ Released worktree for "${taskKey}": ${result.path}`,
        );
      } else {
        await sendReply(
          chatId,
          `⚠️ No worktree found for task key "${taskKey}"`,
        );
      }
    } catch (err) {
      await sendReply(chatId, `❌ Release failed: ${err.message}`);
    }
    return;
  }

  if (sub === "stats") {
    try {
      const stats = getWorktreeStats();
      const lines = [`📊 Worktree Stats:`];
      lines.push(`  Total tracked: ${stats.total}`);
      lines.push(`  Active: ${stats.active}`);
      lines.push(`  Stale: ${stats.stale}`);
      if (Object.keys(stats.byOwner).length > 0) {
        lines.push(`  By owner:`);
        for (const [owner, count] of Object.entries(stats.byOwner)) {
          lines.push(`    ${owner}: ${count}`);
        }
      }
      await sendReply(chatId, lines.join("\n"));
    } catch (err) {
      await sendReply(chatId, `❌ Stats failed: ${err.message}`);
    }
    return;
  }

  // Default: list all active worktrees
  try {
    const worktrees = listManagedWorktrees();
    if (!worktrees || worktrees.length === 0) {
      await sendReply(chatId, "🌳 No active worktrees tracked.");
      return;
    }

    const lines = [`🌳 Active Worktrees (${worktrees.length}):\n`];
    for (const wt of worktrees) {
      const ageMin = Math.round((wt.age || 0) / 60000);
      const ageStr =
        ageMin >= 60 ? `${Math.round(ageMin / 60)}h` : `${ageMin}m`;
      const branch = wt.branch || "(detached)";
      const taskKey = wt.taskKey ? ` [${wt.taskKey}]` : "";
      const owner = wt.owner ? ` (${wt.owner})` : "";
      const status = wt.status || "active";
      lines.push(`• ${branch}${taskKey}${owner}`);
      lines.push(`  Status: ${status} | Age: ${ageStr}`);
      lines.push(`  Path: ${wt.path}`);
    }

    lines.push(
      `\nCommands: /worktrees prune | /worktrees release <key> | /worktrees stats`,
    );
    await sendReply(chatId, lines.join("\n"));
  } catch (err) {
    await sendReply(chatId, `❌ Worktree list failed: ${err.message}`);
  }
}

/**
 * /executor — View and manage the internal task executor.
 *
 * Subcommands:
 *   /executor           — Show status (mode, active slots, SDK, etc.)
 *   /executor status    — Same as above
 *   /executor slots     — Show active task slots with details
 *   /executor mode <vk|internal|hybrid> — Show current mode (runtime switch not supported)
 */
async function cmdExecutor(chatId, args) {
  const parts = args ? args.trim().split(/\s+/) : [];
  const sub = parts[0]?.toLowerCase();

  // Get monitor functions for executor access
  const executor = _getInternalExecutor?.();
  const mode = _getExecutorMode?.() || "internal";

  if (sub === "slots") {
    if (!executor) {
      await sendReply(
        chatId,
        `⚙️ Internal executor not active (mode: ${mode})`,
      );
      return;
    }
    const status = executor.getStatus();
    if (status.slots.length === 0) {
      await sendReply(
        chatId,
        `⚙️ No active task slots (${status.activeSlots}/${status.maxParallel} used)`,
      );
      return;
    }
    const lines = [
      `⚙️ Active Task Slots (${status.activeSlots}/${status.maxParallel}):\n`,
    ];
    for (const slot of status.slots) {
      const runStr = formatRuntimeSeconds(slot.runningFor);
      const agentId =
        Number.isFinite(slot.agentInstanceId) && slot.agentInstanceId > 0
          ? `#${slot.agentInstanceId}`
          : "n/a";
      lines.push(`• ${slot.taskTitle}`);
      lines.push(
        `  ID: ${slot.taskId.substring(0, 8)} | Agent: ${agentId} | SDK: ${slot.sdk}`,
      );
      lines.push(`  Branch: ${slot.branch}`);
      lines.push(
        `  Running: ${runStr} | Attempt: ${slot.attempt} | Status: ${slot.status}`,
      );
    }
    await sendReply(chatId, lines.join("\n"));
    return;
  }

  if (sub === "mode") {
    const target = parts[1]?.toLowerCase();
    if (target && ["vk", "internal", "hybrid"].includes(target)) {
      await sendReply(
        chatId,
        `⚙️ Current mode: ${mode}\n` +
          `ℹ️ Mode can be changed via EXECUTOR_MODE env var or config.\n` +
          `Restart the monitor after changing to apply.`,
      );
    } else {
      await sendReply(
        chatId,
        `⚙️ Current executor mode: ${mode}\n\nValid modes: vk, internal, hybrid`,
      );
    }
    return;
  }

  // Default: show status
  const lines = [`⚙️ Executor Status\n`];
  lines.push(`Mode: ${mode}`);

  if (executor) {
    const status = executor.getStatus();
    lines.push(`Running: ${status.running ? "✅ Yes" : "❌ No"}`);
    lines.push(`SDK: ${status.sdk}`);
    lines.push(`Active Slots: ${status.activeSlots}/${status.maxParallel}`);
    lines.push(`Poll Interval: ${status.pollIntervalMs / 1000}s`);
    lines.push(`Task Timeout: ${Math.round(status.taskTimeoutMs / 60000)}min`);
    lines.push(`Max Retries: ${status.maxRetries}`);
    lines.push(`Cooldowns: ${status.cooldowns}`);
    if (status.projectId) {
      lines.push(`Project ID: ${status.projectId.substring(0, 8)}...`);
    }
  } else {
    lines.push(`Internal executor: not active`);
    if (mode === "vk") {
      lines.push(
        `\nℹ️ Using VK executor only. Set EXECUTOR_MODE=internal or hybrid to enable.`,
      );
    }
  }

  lines.push(`\nCommands: /executor slots | /executor mode`);
  await sendReply(chatId, lines.join("\n"));
}

async function cmdSdk(chatId, sdkArg) {
  if (!sdkArg || sdkArg.trim() === "") {
    // Show current SDK info
    const poolSdk = getPoolSdkName();
    const primaryAgent = getPrimaryAgentName();
    const available = getAvailableSdks();
    const lines = [
      "🔌 Agent SDK Status",
      "",
      `Pool SDK: ${poolSdk}`,
      `Primary Agent: ${primaryAgent}`,
      `Available: ${available.join(", ") || "(none)"}`,
      "",
      "Switch SDK:",
      "  /sdk copilot    Use Copilot SDK",
      "  /sdk codex      Use Codex SDK",
      "  /sdk claude     Use Claude SDK",
      "  /sdk auto       Reset to config default",
    ];
    await sendReply(chatId, lines.join("\n"));
    return;
  }

  const target = sdkArg.trim().toLowerCase().replace(/-sdk$/, "");

  if (target === "auto" || target === "reset") {
    resetPoolSdkCache();
    await sendReply(
      chatId,
      "✅ Agent pool SDK reset to config default.\nCurrent: " +
        getPoolSdkName(),
    );
    return;
  }

  const validSdks = ["codex", "copilot", "claude"];
  if (!validSdks.includes(target)) {
    await sendReply(
      chatId,
      `Unknown SDK: ${target}\nValid: ${validSdks.join(", ")}, auto`,
    );
    return;
  }

  try {
    // Switch pool SDK
    setPoolSdk(target);

    // Also switch primary agent to match
    const switchResult = await switchPrimaryAgent(`${target}-sdk`);
    const primaryStatus = switchResult.ok
      ? `Primary agent: ${switchResult.name}`
      : `Primary agent switch failed: ${switchResult.reason}`;

    await sendReply(
      chatId,
      `✅ SDK switched to: ${target}\nPool SDK: ${getPoolSdkName()}\n${primaryStatus}`,
    );
  } catch (err) {
    await sendReply(chatId, `❌ Error switching SDK: ${err.message}`);
  }
}

async function cmdSharedWorkspaces(chatId, rawArgs) {
  const registry = await loadSharedRegistry();
  const sweep = await sweepSharedLeases({
    registry,
    actor: `telegram:${chatId}`,
  });
  const tokens = splitArgs(rawArgs);
  if (tokens.length > 0) {
    const workspace = resolveSharedWorkspace(sweep.registry, tokens[0]);
    if (!workspace) {
      await sendReply(chatId, `Unknown shared workspace '${tokens[0]}'.`);
      return;
    }
    await sendReply(chatId, formatSharedWorkspaceDetail(workspace));
    return;
  }
  await sendReply(chatId, formatSharedWorkspaceSummary(sweep.registry));
}

async function cmdSharedWorkspaceClaim(chatId, rawArgs) {
  const parsed = parseSharedWorkspaceArgs(rawArgs);
  if (!parsed.workspaceId) {
    await sendReply(
      chatId,
      "Usage: /claim <id> [--owner <id>] [--ttl <minutes>] [--note <text>]",
    );
    return;
  }
  const actor = `telegram:${chatId}`;
  const owner = parsed.owner || actor;
  const result = await claimSharedWorkspace({
    workspaceId: parsed.workspaceId,
    owner,
    ttlMinutes: parsed.ttlMinutes,
    note: parsed.note,
    force: parsed.force,
    actor,
  });
  if (result.error) {
    await sendReply(chatId, `❌ ${result.error}`);
    return;
  }
  await sendReply(
    chatId,
    `✅ Claimed ${result.workspace.id} for ${result.lease.owner} (expires ${result.lease.lease_expires_at})`,
  );
}

async function cmdSharedWorkspaceRelease(chatId, rawArgs) {
  const parsed = parseSharedWorkspaceArgs(rawArgs);
  if (!parsed.workspaceId) {
    await sendReply(
      chatId,
      "Usage: /release <id> [--owner <id>] [--reason <text>] [--force]",
    );
    return;
  }
  if (!parsed.force) {
    const token = issueUiToken({
      type: "confirm_cmd",
      command: `/release ${parsed.workspaceId} --force`,
      title: "Release Shared Workspace",
      confirmLabel: "Release",
      detailLines: [
        `Workspace: \`${parsed.workspaceId}\``,
        parsed.owner ? `Owner: \`${parsed.owner}\`` : null,
      ].filter(Boolean),
      backAction: uiGoAction("shared_release"),
    });
    await promptActionConfirm(chatId, token, {
      type: "confirm_cmd",
      title: "Release Shared Workspace",
      confirmLabel: "Release",
      detailLines: [
        `Workspace: \`${parsed.workspaceId}\``,
        parsed.owner ? `Owner: \`${parsed.owner}\`` : null,
      ].filter(Boolean),
      backAction: uiGoAction("shared_release"),
    });
    return;
  }
  const actor = `telegram:${chatId}`;
  const result = await releaseSharedWorkspace({
    workspaceId: parsed.workspaceId,
    owner: parsed.owner,
    reason: parsed.reason,
    force: parsed.force,
    actor,
  });
  if (result.error) {
    await sendReply(chatId, `❌ ${result.error}`);
    return;
  }
  await sendReply(chatId, `✅ Released ${result.workspace.id}`);
}

// ── /agent — route to workspace registry ────────────────────────────────────

const MODEL_PROFILE_MAP = {
  "gpt-5.2-codex": {
    executor: "CODEX",
    variant: "DEFAULT",
    model: "gpt-5.2-codex",
  },
  "gpt-5.1-codex-max": {
    executor: "CODEX",
    variant: "DEFAULT",
    model: "gpt-5.1-codex-max",
  },
  "gpt-5.1-codex-mini": {
    executor: "CODEX",
    variant: "DEFAULT",
    model: "gpt-5.1-codex-mini",
  },
  "claude-opus-4.6": {
    executor: "COPILOT",
    variant: "CLAUDE_OPUS_4_6",
    model: "claude-opus-4.6",
  },
  "claude-code": {
    executor: "COPILOT",
    variant: "CLAUDE_CODE",
    model: "claude-code",
  },
};

function normalizeHost(host) {
  if (!host) return null;
  const trimmed = String(host).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function buildExecutorProfile(model, customProfile) {
  if (customProfile && typeof customProfile === "object") {
    const profile = { ...customProfile };
    if (model && !profile.model) profile.model = model;
    return profile;
  }
  if (!model) return null;
  return MODEL_PROFILE_MAP[model] || { model };
}

function resolveModelSelection(workspace, preferredModel) {
  const priorities = Array.isArray(workspace.model_priority)
    ? workspace.model_priority
    : getDefaultModelPriority();
  const candidates = [];
  if (preferredModel) candidates.push(preferredModel);
  candidates.push(...priorities);

  for (const entry of candidates) {
    if (!entry) continue;
    if (typeof entry === "string") {
      const model = entry.trim();
      if (!model) continue;
      return { model, profile: buildExecutorProfile(model) };
    }
    if (typeof entry === "object") {
      const model = entry.model || entry.name || null;
      const profile = buildExecutorProfile(model, entry);
      if (profile) {
        return { model: model || profile.model || null, profile };
      }
    }
  }
  return { model: null, profile: null };
}

async function vkRequest(host, path, options = {}) {
  const { method = "GET", body, timeoutMs = 15000 } = options;
  const base = normalizeHost(host);
  if (!base) {
    throw new Error("Workspace host missing");
  }
  const url = new URL(path, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  let res;
  try {
    res = await fetch(url.toString(), {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`VK fetch error: ${err.message}`);
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `VK ${res.status}: ${text.slice(0, 200) || res.statusText}`,
    );
  }

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(`VK response parse error: ${err.message}`);
    }
  }
  if (data && data.success === false) {
    throw new Error(data.message || "VK API error");
  }
  return data?.data ?? data;
}

async function getWorkspaceSummaries(host) {
  const data = await vkRequest(host, "/api/task-attempts/summary", {
    method: "POST",
    body: { archived: false },
  });
  if (!data) return [];
  if (Array.isArray(data.summaries)) return data.summaries;
  return Array.isArray(data) ? data : [data];
}

function scoreWorkspace(summary) {
  const status = String(
    summary?.latest_process_status ?? summary?.status ?? summary?.state ?? "",
  ).toLowerCase();
  const busy = ["running", "queued", "in_progress", "active"];
  const idle = ["completed", "idle", "success", "done"];
  const failed = ["failed", "error", "crashed", "killed", "aborted"];
  if (busy.includes(status)) {
    return { available: false, score: 0, status: "busy" };
  }
  if (idle.includes(status)) {
    return { available: true, score: 3, status: "healthy" };
  }
  if (failed.includes(status)) {
    return { available: true, score: 1, status: "degraded" };
  }
  return { available: true, score: 2, status: status || "unknown" };
}

async function getWorkspaceHealth(workspaces) {
  const health = new Map();
  const hostMap = new Map();
  for (const ws of workspaces) {
    const host = normalizeHost(ws.host);
    if (!host) {
      health.set(ws.id, { available: true, score: 1, status: "unknown" });
      continue;
    }
    if (!hostMap.has(host)) hostMap.set(host, []);
    hostMap.get(host).push(ws);
  }

  for (const [host, wsList] of hostMap.entries()) {
    let summaries = [];
    try {
      summaries = await getWorkspaceSummaries(host);
    } catch {
      for (const ws of wsList) {
        health.set(ws.id, { available: true, score: 1, status: "unknown" });
      }
      continue;
    }

    const summaryMap = new Map();
    for (const summary of summaries) {
      if (summary?.workspace_id) {
        summaryMap.set(summary.workspace_id, summary);
      }
    }
    for (const ws of wsList) {
      const summary = summaryMap.get(ws.id);
      if (summary) {
        const scored = scoreWorkspace(summary);
        const last = Date.parse(
          summary.latest_process_completed_at ||
            summary.latest_process_started_at ||
            summary.updated_at ||
            "",
        );
        health.set(ws.id, {
          ...scored,
          lastCompletedAt: Number.isFinite(last) ? last : null,
        });
      } else {
        health.set(ws.id, { available: true, score: 1, status: "unknown" });
      }
    }
  }

  return health;
}

function selectWorkspace(candidates, healthMap, options = {}) {
  const { preferredId } = options;
  const scored = candidates.map((ws) => {
    const h = healthMap.get(ws.id) || {
      available: true,
      score: 1,
      status: "unknown",
    };
    return { ws, health: h };
  });

  const sortFn = (a, b) => {
    const scoreDiff = (b.health.score ?? 0) - (a.health.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    const lastA = a.health.lastCompletedAt || 0;
    const lastB = b.health.lastCompletedAt || 0;
    return lastB - lastA;
  };

  if (preferredId) {
    const target = scored.find((item) => item.ws.id === preferredId);
    if (target && target.health.available) {
      return { workspace: target.ws, health: target.health };
    }
    const fallback = scored.sort(sortFn)[0];
    return {
      workspace: fallback?.ws || null,
      health: fallback?.health || null,
      fallbackFrom: target?.ws || null,
    };
  }

  const best = scored.sort(sortFn)[0];
  return { workspace: best?.ws || null, health: best?.health || null };
}

function rankWorkspaceCandidates(candidates, healthMap, options = {}) {
  const { preferredId } = options;
  const scored = candidates.map((ws) => {
    const h = healthMap.get(ws.id) || {
      available: true,
      score: 1,
      status: "unknown",
    };
    return { ws, health: h };
  });

  const sortFn = (a, b) => {
    const scoreDiff = (b.health.score ?? 0) - (a.health.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    const lastA = a.health.lastCompletedAt || 0;
    const lastB = b.health.lastCompletedAt || 0;
    return lastB - lastA;
  };

  const sorted = scored.sort(sortFn).map((item) => item.ws);
  if (!preferredId) return sorted;
  const preferred = scored.find((item) => item.ws.id === preferredId);
  if (!preferred) return sorted;
  return [
    preferred.ws,
    ...sorted.filter((candidate) => candidate.id !== preferred.ws.id),
  ];
}

function pickLatestSession(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  return [...sessions].sort((a, b) => {
    const ta = Date.parse(a.updated_at || a.created_at || 0) || 0;
    const tb = Date.parse(b.updated_at || b.created_at || 0) || 0;
    return tb - ta;
  })[0];
}

async function dispatchAgentMessage(workspace, message, options = {}) {
  const host = normalizeHost(workspace.host);
  const executorProfile = options.executorProfile || null;
  const sessions = await vkRequest(
    host,
    `/api/sessions?workspace_id=${encodeURIComponent(workspace.id)}`,
  );
  let session = pickLatestSession(sessions);
  let created = false;

  if (!session || options.newSession) {
    session = await vkRequest(host, "/api/sessions", {
      method: "POST",
      body: { workspace_id: workspace.id },
    });
    created = true;
  }
  if (!session?.id) {
    throw new Error("Failed to acquire workspace session.");
  }

  if (options.queue) {
    await vkRequest(host, `/api/sessions/${session.id}/queue`, {
      method: "POST",
      body: {
        message,
        executor_profile_id: executorProfile || undefined,
      },
    });
    return { sessionId: session.id, created, action: "queued" };
  }

  await vkRequest(host, `/api/sessions/${session.id}/follow-up`, {
    method: "POST",
    body: {
      prompt: message,
      executor_profile_id: executorProfile || undefined,
    },
  });
  return { sessionId: session.id, created, action: "follow-up" };
}

async function cmdAgent(chatId, rawArgs) {
  const parsed = parseAgentArgs(rawArgs || "");
  const { message, workspaceId, role, model, queue, newSession, dryRun } =
    parsed;

  const { registry, errors, warnings } = await loadWorkspaceRegistry();
  const diagnostics = formatRegistryDiagnostics(errors, warnings);
  if (diagnostics) {
    await sendReply(chatId, diagnostics);
  }

  if (!message) {
    const list = registry.workspaces
      .map((ws) => `  - ${ws.id} (${ws.role})`)
      .join("\n");
    const usage = [
      "Usage: /agent --workspace <id> <task>",
      "       /agent --role <role> <task>",
      "Options: --model <name> --queue --new-session --dry-run",
      "",
      "Available workspaces:",
      list || "  (none)",
    ];
    await sendReply(chatId, usage.join("\n"));
    return;
  }

  if (!registry.workspaces.length) {
    await sendReply(chatId, "No workspaces available to route.");
    return;
  }

  let candidates = registry.workspaces;
  let preferredId = null;

  if (workspaceId) {
    const match = registry.workspaces.find(
      (ws) => ws.id.toLowerCase() === workspaceId.toLowerCase(),
    );
    if (!match) {
      const ids = registry.workspaces.map((ws) => ws.id).join(", ");
      await sendReply(
        chatId,
        `Unknown workspace: ${workspaceId}\nAvailable: ${ids}`,
      );
      return;
    }
    candidates = [match];
    preferredId = match.id;
  } else if (role) {
    const roleLower = role.toLowerCase();
    candidates = registry.workspaces.filter(
      (ws) => ws.role && ws.role.toLowerCase() === roleLower,
    );
    if (candidates.length === 0) {
      await sendReply(chatId, `No workspaces found with role: ${role}`);
      return;
    }
  } else {
    const primary = registry.workspaces.filter(
      (ws) => (ws.role || "").toLowerCase() === "primary",
    );
    if (primary.length > 0) {
      candidates = primary;
    }
  }

  const leaseOwner =
    process.env.VE_WORKSPACE_OWNER ||
    process.env.USER ||
    process.env.USERNAME ||
    `telegram:${chatId}`;
  const leaseTtlSecRaw = Number(process.env.VE_WORKSPACE_LEASE_TTL_SEC || "");
  const leaseTtlMinRaw = Number(process.env.VE_WORKSPACE_LEASE_TTL_MIN || "");
  const leaseTtlMinutes = Number.isFinite(leaseTtlMinRaw)
    ? leaseTtlMinRaw
    : Number.isFinite(leaseTtlSecRaw)
      ? Math.ceil(leaseTtlSecRaw / 60)
      : null;

  let availabilityMap = new Map();
  try {
    const registry = await loadSharedRegistry();
    const sweep = await sweepSharedLeases({ registry, actor: leaseOwner });
    availabilityMap = getSharedAvailabilityMap(sweep.registry);
  } catch {
    availabilityMap = new Map();
  }

  if (availabilityMap.size > 0) {
    const filtered = candidates.filter((ws) => {
      const entry = availabilityMap.get(ws.id);
      if (!entry) return true;
      const state = String(entry.state || "available").toLowerCase();
      return state === "available";
    });
    if (filtered.length === 0) {
      await sendReply(
        chatId,
        "No available workspaces found (all leased or unavailable).",
      );
      return;
    }
    candidates = filtered;
  }

  const healthMap = await getWorkspaceHealth(candidates);
  const ranked = rankWorkspaceCandidates(candidates, healthMap, {
    preferredId,
  });
  const preferredMatch = preferredId
    ? candidates.find((ws) => ws.id === preferredId)
    : null;

  let selectedWorkspace = null;
  let selectedHealth = null;
  let leaseError = null;

  for (const candidate of ranked) {
    if (dryRun) {
      selectedWorkspace = candidate;
      selectedHealth = healthMap.get(candidate.id) || null;
      break;
    }
    try {
      const claimResult = await claimSharedWorkspace({
        workspaceId: candidate.id,
        owner: leaseOwner,
        ttlMinutes: leaseTtlMinutes,
        note: `telegram:${chatId}`,
        actor: leaseOwner,
      });
      if (claimResult?.error) {
        throw new Error(claimResult.error);
      }
      selectedWorkspace = candidate;
      selectedHealth = healthMap.get(candidate.id) || null;
      break;
    } catch (err) {
      leaseError = err;
    }
  }

  if (!selectedWorkspace) {
    await sendReply(
      chatId,
      leaseError?.message || "No available workspace found for routing.",
    );
    return;
  }

  const selection = {
    workspace: selectedWorkspace,
    health: selectedHealth,
    fallbackFrom:
      preferredMatch && preferredMatch.id !== selectedWorkspace.id
        ? preferredMatch
        : null,
  };

  const modelSelection = resolveModelSelection(selection.workspace, model);
  const selectedModel = modelSelection.model || model || "auto";

  const infoLines = [
    `Routing → ${selection.workspace.name} (${selection.workspace.id})`,
    `Role: ${selection.workspace.role || "n/a"}`,
    `Host: ${normalizeHost(selection.workspace.host) || "n/a"}`,
    `Model: ${selectedModel}`,
  ];
  if (selection.fallbackFrom) {
    infoLines.push(`Fallback: ${selection.fallbackFrom.id} unavailable`);
  }

  if (dryRun) {
    infoLines.push("Dry-run only. No message sent.");
    await sendReply(chatId, infoLines.join("\\n"));
    return;
  }

  try {
    const result = await dispatchAgentMessage(selection.workspace, message, {
      executorProfile: modelSelection.profile,
      queue,
      newSession,
    });
    infoLines.push(`Action: ${result.action}`);
    infoLines.push(
      `Session: ${result.sessionId}${result.created ? " (new)" : ""}`,
    );
    await sendReply(chatId, infoLines.join("\\n"));
  } catch (err) {
    await sendReply(
      chatId,
      `❌ /agent failed: ${err.message || err}\n${infoLines.join("\\n")}`,
    );
  }
}

// ── /background — run task silently or background active agent ────────────────

async function cmdBackground(chatId, args) {
  const task = (args || "").trim();
  if (task) {
    await sendReply(
      chatId,
      `🛰️ Background task queued: "${task.slice(0, 80)}${task.length > 80 ? "…" : ""}"`,
    );
    await handleFreeText(task, chatId, { background: true });
    return;
  }

  if (!activeAgentSession) {
    await sendReply(
      chatId,
      "No active agent. Usage:\n/background <task>\n(background current agent with /background)",
    );
    return;
  }

  activeAgentSession.background = true;
  activeAgentSession.suppressEdits = true;

  if (agentMessageId && agentChatId) {
    try {
      await deleteDirect(agentChatId, agentMessageId);
    } catch {
      /* best effort */
    }
  }
  agentMessageId = null;
  if (activeAgentSession) {
    activeAgentSession.messageId = null;
  }

  await sendReply(
    chatId,
    "🛰️ Background mode enabled for the active agent. I will post a final summary when it completes. Use /stop to cancel or /steer to adjust context.",
  );
}

// ── /stop — Stop Running Agent ───────────────────────────────────────────────

async function cmdStop(chatId, args) {
  const confirmFlag = /--confirm\b/i.test(String(args || ""));
  if (!confirmFlag) {
    await sendReply(
      chatId,
      "⚠️ Stop will halt the active agent session. Proceed?",
      { reply_markup: buildConfirmKeyboard("cb:confirm_stop", "Confirm Stop") },
    );
    return;
  }
  if (!activeAgentSession) {
    await sendReply(chatId, "No agent is currently running.");
    return;
  }
  activeAgentSession.aborted = true;
  if (activeAgentSession.abortController) {
    try {
      activeAgentSession.abortController.abort("user_stop");
    } catch {
      /* best effort */
    }
  }
  if (activeAgentSession.actionLog) {
    activeAgentSession.actionLog.push({
      icon: "🛑",
      text: "Stop requested by user (will halt after current step)",
    });
    if (activeAgentSession.scheduleEdit) {
      activeAgentSession.scheduleEdit();
    }
  }
  await sendReply(chatId, "🛑 Stop signal sent. Agent will halt and wait.");
}

// ── /steer — Steering update for running agent ───────────────────────────────

async function cmdSteer(chatId, steerArgs) {
  if (!steerArgs || !steerArgs.trim()) {
    await sendReply(chatId, "Usage: /steer <update or correction>");
    return;
  }
  const message = steerArgs.trim();

  if (!activeAgentSession || !isPrimaryBusy()) {
    await sendReply(chatId, "No active agent. Sending as a new task.");
    await handleFreeText(message, chatId);
    return;
  }

  const result = await steerPrimaryPrompt(message);
  if (result.ok) {
    if (activeAgentSession.actionLog) {
      activeAgentSession.actionLog.push({
        icon: "🧭",
        text: `Steering update delivered (${result.mode})`,
      });
      if (activeAgentSession.scheduleEdit) {
        activeAgentSession.scheduleEdit();
      }
    }
    await sendReply(chatId, `🧭 Steering sent (${result.mode}).`);
    return;
  }

  if (!activeAgentSession.followUpQueue) {
    activeAgentSession.followUpQueue = [];
  }
  activeAgentSession.followUpQueue.push(message);
  const qLen = activeAgentSession.followUpQueue.length;
  if (activeAgentSession.actionLog) {
    const steerStatus = result.reason || "failed";
    activeAgentSession.actionLog.push({
      icon: "🧭",
      text: `Steering queued (#${qLen}; steer failed: ${steerStatus})`,
      kind: "followup_queued",
      steerStatus,
    });
    if (activeAgentSession.scheduleEdit) {
      activeAgentSession.scheduleEdit();
    }
  }
  await sendReply(chatId, `🧭 Steering queued (#${qLen}).`);
}

// ── Free-text → Primary Agent Dispatch ───────────────────────────────────────

/**
 * Build the rolling summary message text from accumulated action log.
 * This is the single message that gets continuously edited in Telegram.
 */
function suppressSteerFailedLines(actionLog) {
  if (!Array.isArray(actionLog)) return;
  for (let i = actionLog.length - 1; i >= 0; i -= 1) {
    const entry = actionLog[i];
    if (!entry || entry.kind !== "followup_queued") continue;
    if (entry.steerStatus && entry.steerStatus !== "ok") {
      actionLog.splice(i, 1);
    }
  }
}

function buildStreamMessage({
  taskPreview,
  actionLog,
  currentThought,
  totalActions,
  phase,
  finalResponse,
  filesRead,
  filesWritten,
  searchesDone,
  statusIcon,
}) {
  const header = `🔧 Agent: ${taskPreview}`;
  const counter = `📊 Actions: ${totalActions} | ${phase}`;
  const separator = "────────────────────────────";

  // Show last N actions (keep message compact)
  const MAX_VISIBLE_ACTIONS = 20;
  const visibleActions = actionLog.slice(-MAX_VISIBLE_ACTIONS);
  const hiddenCount = actionLog.length - visibleActions.length;

  const lines = [header, counter, separator];

  if (hiddenCount > 0) {
    lines.push(`… ${hiddenCount} earlier action${hiddenCount > 1 ? "s" : ""}`);
  }

  for (const action of visibleActions) {
    lines.push(`${action.icon} ${action.text}`);
  }

  if (currentThought) {
    lines.push("", `💭 ${currentThought}`);
  }

  if (!finalResponse) {
    if (filesWritten?.size) {
      lines.push("", "✍️ Files modified so far:");
      const recent = Array.from(filesWritten.entries()).slice(-6);
      for (const [fpath, info] of recent) {
        const name = shortPath(fpath);
        if (info.adds || info.dels) {
          lines.push(`  ✏️ ${name} (+${info.adds} -${info.dels})`);
        } else {
          lines.push(`  ✏️ ${name}`);
        }
      }
    }
    if (filesRead?.size) {
      lines.push("", "📖 Files read so far:");
      const recent = Array.from(filesRead.values()).slice(-6);
      for (const fpath of recent) {
        lines.push(`  📄 ${shortPath(fpath)}`);
      }
    }
    if (searchesDone) {
      lines.push("", `🔎 Searches: ${searchesDone}`);
    }
  }

  if (finalResponse) {
    // ── Final summary block ──────────────────────────────────────
    const icon = statusIcon || "✅";
    lines.push("", separator);
    lines.push(`${icon} ${phase}`);
    lines.push("");

    // Stats line
    const stats = [];
    if (filesRead?.size) stats.push(`${filesRead.size} files read`);
    if (filesWritten?.size) stats.push(`${filesWritten.size} files modified`);
    if (searchesDone) stats.push(`${searchesDone} searches`);
    if (stats.length) {
      lines.push(`📈 ${stats.join(" · ")}`);
    }

    // Files modified detail
    if (filesWritten?.size) {
      lines.push("");
      lines.push("📁 Files modified:");
      for (const [fpath, info] of filesWritten) {
        const name = shortPath(fpath);
        if (info.adds || info.dels) {
          lines.push(`  ✏️ ${name} (+${info.adds} -${info.dels})`);
        } else {
          const kindIcon =
            info.kind === "add" ? "➕" : info.kind === "delete" ? "🗑️" : "✏️";
          lines.push(`  ${kindIcon} ${name}`);
        }
      }
    }

    lines.push("");
    lines.push(finalResponse.slice(0, 1200));
  }

  return lines.join("\n");
}

async function handleFreeText(text, chatId, options = {}) {
  const backgroundMode = !!options.background;
  // ── Follow-up steering: if agent is busy, queue message as follow-up ──
  if (isPrimaryBusy() && activeAgentSession) {
    if (!activeAgentSession.followUpQueue) {
      activeAgentSession.followUpQueue = [];
    }
    activeAgentSession.followUpQueue.push(text);
    const qLen = activeAgentSession.followUpQueue.length;

    // Try immediate steering so the in-flight run can adapt ASAP.
    const steerResult = await steerPrimaryPrompt(text);
    const steerStatus = steerResult.ok ? "ok" : steerResult.reason || "failed";
    const steerNote = steerResult.ok
      ? `Steer ${steerResult.mode}.`
      : `Steer failed (${steerStatus}).`;

    // Acknowledge the follow-up in both the user's chat and update the agent message
    await sendDirect(
      chatId,
      `📌 Follow-up queued (#${qLen}). Agent will process it after current action. ${steerNote}`,
    );

    // Add follow-up indicator to the streaming message
    if (activeAgentSession.actionLog) {
      activeAgentSession.actionLog.push({
        icon: "📌",
        text: `Follow-up: "${text.length > 60 ? text.slice(0, 60) + "…" : text}" (${steerNote})`,
        kind: "followup_queued",
        steerStatus,
      });
      // Trigger an edit to show the follow-up in the streaming message
      if (activeAgentSession.scheduleEdit) {
        activeAgentSession.scheduleEdit();
      }
    }
    return;
  }

  // ── Block if agent is busy but no session (shouldn't happen normally) ──
  if (isPrimaryBusy()) {
    await sendReply(
      chatId,
      "⏳ Agent is executing a task. Please wait for it to finish...",
    );
    return;
  }

  const taskPreview = text.length > 60 ? text.slice(0, 60) + "…" : text;

  // Send the initial message and capture its ID for editing (unless background)
  let messageId = null;
  if (!backgroundMode) {
    messageId = await sendDirect(
      chatId,
      buildStreamMessage({
        taskPreview,
        actionLog: [],
        currentThought: null,
        totalActions: 0,
        phase: "starting…",
        finalResponse: null,
      }),
    );
  }

  // Load current status for context
  let statusData = null;
  try {
    if (_readStatusData) {
      statusData = await _readStatusData();
    } else {
      const raw = await readFile(statusPath, "utf8").catch(() => null);
      statusData = raw ? JSON.parse(raw) : null;
    }
  } catch {
    /* best effort */
  }

  // ── Single-message streaming state ──────────────────────────────────
  const actionLog = []; // { icon, text } entries
  let currentThought = null;
  let totalActions = 0;
  let phase = "working…";
  let lastEditAt = 0;
  const EDIT_THROTTLE_MS = 2000; // edit at most every 2s (Telegram rate limit)
  let editPending = false;
  let editTimer = null;

  // ── Tracking for final summary ──────────────────────────────────────
  const filesRead = new Set(); // file paths read
  const filesWritten = new Map(); // path → { kind, adds, dels }
  let searchCount = 0;
  let hadError = false;

  const doEdit = async () => {
    if (backgroundMode || activeAgentSession?.background) return;
    editPending = false;
    const msg = buildStreamMessage({
      taskPreview,
      actionLog,
      currentThought,
      totalActions,
      phase,
      finalResponse: null,
      filesRead,
      filesWritten,
      searchesDone: searchCount,
    });
    if (messageId) {
      messageId = await editDirect(chatId, messageId, msg);
      agentMessageId = messageId;
    }
    lastEditAt = Date.now();
  };

  const scheduleEdit = () => {
    if (backgroundMode || activeAgentSession?.background) return;
    if (editPending) return;
    const now = Date.now();
    const elapsed = now - lastEditAt;
    if (elapsed >= EDIT_THROTTLE_MS) {
      editPending = true;
      void doEdit();
    } else {
      editPending = true;
      if (editTimer) clearTimeout(editTimer);
      editTimer = setTimeout(() => void doEdit(), EDIT_THROTTLE_MS - elapsed);
    }
  };

  // ── Set up agent session (enables follow-up steering & bottom-pinning) ──
  const abortController = new AbortController();
  activeAgentSession = {
    chatId,
    messageId,
    taskPreview,
    actionLog,
    currentThought: null,
    totalActions: 0,
    phase: "working…",
    followUpQueue: [],
    scheduleEdit,
    aborted: false,
    abortController,
    background: backgroundMode,
    suppressEdits: backgroundMode,
  };
  agentMessageId = messageId;
  agentChatId = chatId;

  const onEvent = async (_formatted, rawEvent) => {
    const action = rawEvent ? summarizeAction(rawEvent) : null;
    if (!action) return;

    // ── Track files read & written for final summary ──────────────
    if (rawEvent.type === "item.completed") {
      const item = rawEvent.item;
      if (item.type === "command_execution" && item.command) {
        const target = extractTarget(item.command);
        if (target) {
          // Determine if this is a read or search command
          if (
            /^(cat|head|tail|type|Get-Content)/i.test(item.command.trim()) ||
            /pwsh.*Get-Content/i.test(item.command)
          ) {
            filesRead.add(target);
          }
          if (
            /^(grep|findstr|rg|Select-String)/i.test(item.command.trim()) ||
            /pwsh.*Select-String/i.test(item.command)
          ) {
            searchCount++;
          }
        }
      }
      if (item.type === "file_change" && item.changes?.length) {
        for (const c of item.changes) {
          filesWritten.set(c.path, {
            kind: c.kind || "modify",
            adds: c.additions ?? c.lines_added ?? 0,
            dels: c.deletions ?? c.lines_deleted ?? 0,
          });
        }
      }
    }

    if (
      rawEvent.type === "tool.execution_start" ||
      rawEvent.type === "tool.execution_complete"
    ) {
      const { toolName, input } = getCopilotToolInfo(rawEvent);
      const command = extractCopilotCommand(input);
      const target = extractCopilotPath(input);

      if (command) {
        const cmdTarget = extractTarget(command);
        if (
          cmdTarget &&
          (/^(cat|head|tail|type|Get-Content)/i.test(command.trim()) ||
            /pwsh.*Get-Content/i.test(command))
        ) {
          filesRead.add(cmdTarget);
        }
        if (
          /^(grep|findstr|rg|Select-String)/i.test(command.trim()) ||
          /pwsh.*Select-String/i.test(command)
        ) {
          searchCount++;
        }
      }

      if (isCopilotReadTool(toolName) && target) {
        filesRead.add(target);
      }
      if (isCopilotSearchTool(toolName)) {
        searchCount++;
      }
      if (isCopilotWriteTool(toolName) && target) {
        filesWritten.set(target, {
          kind: "modify",
          adds: 0,
          dels: 0,
        });
      }
    }

    // ── Track file changes from action detail ─────────────────────
    if (action.detail === "file_change" && action.files) {
      for (const f of action.files) {
        filesWritten.set(f.path, {
          kind: f.kind || "modify",
          adds: f.adds || 0,
          dels: f.dels || 0,
        });
      }
    }

    if (action.phase === "thinking") {
      currentThought = action.text;
      if (activeAgentSession) activeAgentSession.currentThought = action.text;
    } else {
      if (action.phase === "done" || action.phase === "running") {
        totalActions++;
        if (activeAgentSession) activeAgentSession.totalActions = totalActions;
      }
      actionLog.push(action);
      // Keep thought visible while actions proceed (only clear on new non-thinking action)
      if (action.phase !== "thinking") {
        currentThought = null;
        if (activeAgentSession) activeAgentSession.currentThought = null;
      }
    }

    if (action.phase === "error") {
      phase = "error";
      hadError = true;
    } else if (action.phase === "planning") {
      phase = "planning…";
    } else {
      phase = "working…";
    }
    if (activeAgentSession) activeAgentSession.phase = phase;

    scheduleEdit();
  };

  try {
    const result = await execPrimaryPrompt(text, {
      statusData,
      timeoutMs: AGENT_TIMEOUT_MS,
      onEvent,
      sendRawEvents: true, // request raw events alongside formatted ones
      abortController,
    });

    if (editTimer) clearTimeout(editTimer);

    // ── Process follow-up queue ───────────────────────────────────
    // If user sent follow-up messages while agent was working, process them now
    const followUps = activeAgentSession?.followUpQueue || [];
    if (followUps.length > 0 && !activeAgentSession?.aborted) {
      for (const followUp of followUps) {
        actionLog.push({
          icon: "📌",
          text: `Processing follow-up: "${followUp.slice(0, 60)}"`,
        });
        phase = "processing follow-up…";
        scheduleEdit();

        try {
          const followUpResult = await execPrimaryPrompt(followUp, {
            statusData,
            timeoutMs: AGENT_TIMEOUT_MS,
            onEvent,
            sendRawEvents: true,
          });

          // Merge follow-up results
          if (followUpResult.finalResponse) {
            result.finalResponse =
              (result.finalResponse || "") +
              `\n\n📌 Follow-up result:\n${followUpResult.finalResponse}`;
            suppressSteerFailedLines(actionLog);
          }
        } catch (err) {
          actionLog.push({
            icon: "❌",
            text: `Follow-up error: ${err.message}`,
          });
        }
      }
    }

    // Final edit with the complete summary
    const itemSummary = result.items.filter(
      (i) =>
        i.type === "command_execution" ||
        i.type === "file_change" ||
        i.type === "mcp_tool_call",
    ).length;

    totalActions = Math.max(totalActions, itemSummary);

    // Determine final status icon
    const hasChanges = filesWritten.size > 0;
    let statusIcon;
    if (hadError) {
      statusIcon = "❌";
      phase = "Failed — needs manual review";
    } else if (hasChanges) {
      statusIcon = "✅";
      phase = "Completed successfully";
    } else {
      // No files changed — might be informational or might need user input
      statusIcon = "❓";
      phase = "Completed — no files changed";
    }

    const finalMsg = buildStreamMessage({
      taskPreview,
      actionLog,
      currentThought: null,
      totalActions,
      phase,
      finalResponse: result.finalResponse || null,
      filesRead,
      filesWritten,
      searchesDone: searchCount,
      statusIcon,
    });
    if (backgroundMode || activeAgentSession?.background) {
      await sendReply(chatId, finalMsg);
    } else {
      const finalMessageId = await editDirect(chatId, messageId, finalMsg);
      if (finalMessageId) {
        scheduleStickyMenuBump(chatId, finalMessageId);
      }
    }
  } catch (err) {
    if (editTimer) clearTimeout(editTimer);
    const finalMsg = buildStreamMessage({
      taskPreview,
      actionLog,
      currentThought: null,
      totalActions,
      phase: "Failed — error during execution",
      finalResponse: `Error: ${err.message}`,
      filesRead,
      filesWritten,
      searchesDone: searchCount,
      statusIcon: "❌",
    });
    if (backgroundMode || activeAgentSession?.background) {
      await sendReply(chatId, finalMsg);
    } else {
      const finalMessageId = await editDirect(chatId, messageId, finalMsg);
      if (finalMessageId) {
        scheduleStickyMenuBump(chatId, finalMessageId);
      }
    }
  } finally {
    // ── Clean up agent session ────────────────────────────────────
    activeAgentSession = null;
    agentMessageId = null;
    agentChatId = null;
  }
}

// ── Main Polling Loop ────────────────────────────────────────────────────────

async function pollLoop() {
  while (polling) {
    try {
      const updates = await pollUpdates();
      for (const update of updates) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id);
        try {
          await handleUpdate(update);
        } catch (err) {
          console.error(
            `[telegram-bot] error handling update ${update.update_id}: ${err.message}`,
          );
        }
      }
    } catch (err) {
      console.error(`[telegram-bot] poll loop error: ${err.message}`);
      // Backoff before retrying
      await new Promise((r) => setTimeout(r, POLL_ERROR_BACKOFF_MS));
    }
  }
}

async function ensurePresenceReady() {
  if (presenceReady) return;
  const localWorkspace = await getLocalWorkspaceContext();
  await initPresence({
    repoRoot: _getRepoRoot ? _getRepoRoot() : repoRoot,
    localWorkspace,
  });
  presenceReady = true;
}

function startPresenceLoop() {
  if (presenceDisabled) return;
  if (!telegramToken || !presenceChatId) return;
  if (!Number.isFinite(presenceIntervalSec) || presenceIntervalSec <= 0) {
    return;
  }
  const intervalMs = presenceIntervalSec * 1000;
  let lastSentPayload = null;

  const sendPresence = async () => {
    try {
      await ensurePresenceReady();
      const child = _getCurrentChild ? _getCurrentChild() : null;
      const payload = buildLocalPresence({
        orchestrator_running: !!child,
        orchestrator_pid: child?.pid ?? null,
        vk_url: _getVibeKanbanUrl ? _getVibeKanbanUrl() : null,
      });

      // Check if state changed significantly (ignore updated_at for comparison)
      const shouldSend =
        !presenceOnlyOnChange ||
        !lastSentPayload ||
        hasPresenceChanged(lastSentPayload, payload);

      // Always update local registry
      await notePresence(payload, {
        source: "local",
        receivedAt: payload.updated_at,
      });

      // Only send to Telegram if state changed or not configured to only-on-change
      if (shouldSend) {
        await sendDirect(presenceChatId, formatPresenceMessage(payload), {
          silent: presenceSilent,
        });
        lastSentPayload = payload;
      }
    } catch (err) {
      console.warn(
        `[telegram-bot] presence heartbeat error: ${err.message || err}`,
      );
    }
  };
  setTimeout(() => void sendPresence(), intervalMs);
  setInterval(() => void sendPresence(), intervalMs);
}

function hasPresenceChanged(prev, curr) {
  if (!prev || !curr) return true;
  // Compare meaningful fields (ignore timestamps)
  const significantFields = [
    "instance_id",
    "workspace_id",
    "workspace_role",
    "orchestrator_running",
    "orchestrator_pid",
    "git_branch",
    "git_sha",
    "coordinator_priority",
    "coordinator_eligible",
  ];
  for (const field of significantFields) {
    if (prev[field] !== curr[field]) {
      return true;
    }
  }
  return false;
}

// ── Notification Batching System ─────────────────────────────────────────────

const messageQueue = {
  critical: [], // priority 1 - immediate
  errors: [], // priority 2
  warnings: [], // priority 3
  info: [], // priority 4
  debug: [], // priority 5
};

let batchFlushTimer = null;

// ── Live Digest State ───────────────────────────────────────────────────────
// A single Telegram message that gets continuously edited as events happen.
// When the digest window expires, the message is sealed and the next event
// starts a fresh one.
let liveDigest = {
  messageId: null, // Telegram message_id of the current live digest
  chatId: null, // chat_id it was sent to
  startedAt: 0, // timestamp when this digest window started
  entries: [], // { emoji, text, time } — events in this digest window
  sealTimer: null, // timer to seal the digest after the window expires
  editTimer: null, // debounce timer for edits
  editPending: false, // whether an edit is pending
  sealed: false, // true once the window has expired and message is finalized
};

const PRIORITY_EMOJI = {
  1: "🔴",
  2: "❌",
  3: "⚠️",
  4: "ℹ️",
  5: "🔹",
};

/**
 * Build the live digest message text from accumulated entries.
 */
function buildLiveDigestText() {
  const d = liveDigest;
  const startTime = new Date(d.startedAt).toISOString().slice(11, 19);
  const now = new Date().toISOString().slice(11, 19);

  // Count by severity
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const e of d.entries) {
    counts[e.priority] = (counts[e.priority] || 0) + 1;
  }

  const countParts = [];
  if (counts[1] > 0) countParts.push(`🔴 ${counts[1]}`);
  if (counts[2] > 0) countParts.push(`❌ ${counts[2]}`);
  if (counts[3] > 0) countParts.push(`⚠️ ${counts[3]}`);
  if (counts[4] > 0) countParts.push(`ℹ️ ${counts[4]}`);

  const statusLine = d.sealed
    ? `📊 Digest (${startTime} → ${now}) — sealed`
    : `📊 Live Digest (since ${startTime}) — updating...`;
  const headerLine =
    countParts.length > 0
      ? `${statusLine}\n${countParts.join(" • ")}`
      : statusLine;

  // Build event lines (most recent at bottom, like a log)
  // Telegram 4096 char limit — keep recent events, trim old ones
  const MAX_LEN = 3800; // leave room for header
  const lines = [];
  let totalLen = headerLine.length + 2; // +2 for \n\n separator

  // Add entries from newest to oldest, then reverse for chronological order
  for (let i = d.entries.length - 1; i >= 0; i--) {
    const e = d.entries[i];
    const line = `${e.time} ${e.emoji} ${e.text}`;
    if (totalLen + line.length + 1 > MAX_LEN) {
      const trimmed = d.entries.length - lines.length;
      if (trimmed > 0) {
        lines.push(`  …${trimmed} earlier event(s) trimmed`);
      }
      break;
    }
    lines.push(line);
    totalLen += line.length + 1;
  }

  lines.reverse(); // chronological order

  return [headerLine, "", ...lines].join("\n");
}

/**
 * Schedule a debounced edit of the live digest message.
 */
function scheduleLiveDigestEdit() {
  const d = liveDigest;
  if (d.editTimer) {
    clearTimeout(d.editTimer);
  }
  d.editPending = true;
  d.editTimer = setTimeout(async () => {
    d.editPending = false;
    d.editTimer = null;
    if (!d.messageId || !d.chatId) return;
    const text = buildLiveDigestText();
    try {
      const newId = await editDirect(d.chatId, d.messageId, text);
      if (newId && newId !== d.messageId) {
        d.messageId = newId; // editDirect fell back to sendDirect
      }
    } catch (err) {
      console.warn(`[telegram-bot] live digest edit failed: ${err.message}`);
    }
  }, liveDigestEditDebounceMs);
}

/**
 * Seal the current live digest window — mark final, clear state for next window.
 */
function sealLiveDigest() {
  const d = liveDigest;
  if (d.entries.length === 0) {
    // Nothing happened in this window — just reset
    resetLiveDigest();
    return;
  }

  // Snapshot entries before sealing (for devmode auto code fix callback)
  const sealedEntries = [...d.entries];
  const sealedText = buildLiveDigestText();

  d.sealed = true;
  // Flush one last edit to mark it sealed
  if (d.editTimer) clearTimeout(d.editTimer);
  const text = buildLiveDigestText();
  if (d.messageId && d.chatId) {
    editDirect(d.chatId, d.messageId, text).catch(() => {});
  }

  // Fire digest sealed callback (used by devmode auto code fix)
  if (_onDigestSealed) {
    try {
      _onDigestSealed({ entries: sealedEntries, text: sealedText });
    } catch (err) {
      console.warn(
        `[telegram-bot] onDigestSealed callback error: ${err.message}`,
      );
    }
  }

  // Reset for next window
  resetLiveDigest();
}

/**
 * Reset live digest state for a new window.
 */
function resetLiveDigest() {
  if (liveDigest.sealTimer) clearTimeout(liveDigest.sealTimer);
  if (liveDigest.editTimer) clearTimeout(liveDigest.editTimer);
  liveDigest = {
    messageId: null,
    chatId: null,
    startedAt: 0,
    entries: [],
    sealTimer: null,
    editTimer: null,
    editPending: false,
    sealed: false,
  };
  // Clear persisted state
  writeFile(liveDigestStatePath, "{}").catch(() => {});
}

/**
 * Persist live digest state to disk so restarts can resume the same message.
 */
function persistLiveDigest() {
  const d = liveDigest;
  if (!d.messageId) return;
  const state = {
    messageId: d.messageId,
    chatId: d.chatId,
    startedAt: d.startedAt,
    entries: d.entries,
  };
  writeFile(liveDigestStatePath, JSON.stringify(state)).catch(() => {});
}

/**
 * Restore live digest state from disk after a restart.
 * Returns true if a valid digest was restored (still within window).
 */
export async function restoreLiveDigest() {
  // Already restored or active — skip
  if (liveDigest.messageId) return true;
  try {
    const raw = await readFile(liveDigestStatePath, "utf8");
    const state = JSON.parse(raw);
    if (!state.messageId || !state.startedAt) return false;
    const now = Date.now();
    const windowMs = liveDigestWindowSec * 1000;
    // Only restore if the window hasn't expired
    if (now - state.startedAt >= windowMs) {
      await writeFile(liveDigestStatePath, "{}").catch(() => {});
      return false;
    }
    liveDigest.messageId = state.messageId;
    liveDigest.chatId = state.chatId || telegramChatId;
    liveDigest.startedAt = state.startedAt;
    liveDigest.entries = state.entries || [];
    liveDigest.sealed = false;
    // Re-schedule the seal timer for remaining window time
    const remaining = windowMs - (now - state.startedAt);
    liveDigest.sealTimer = setTimeout(() => sealLiveDigest(), remaining);
    console.log(
      `[telegram-bot] restored live digest (${liveDigest.entries.length} entries, ${Math.round(remaining / 1000)}s remaining)`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Add an event to the live digest. Creates the message on first event,
 * then edits it for subsequent events in the same window.
 */
async function addToLiveDigest(text, priority, category) {
  const d = liveDigest;
  const now = Date.now();
  const timeStr = new Date(now).toISOString().slice(11, 19);
  const emoji = PRIORITY_EMOJI[priority] || "ℹ️";

  // Check if we need a new digest window
  const windowMs = liveDigestWindowSec * 1000;
  const windowExpired = d.startedAt > 0 && now - d.startedAt >= windowMs;

  if (windowExpired || !d.startedAt) {
    // Seal old digest if it had entries
    if (d.entries.length > 0) {
      sealLiveDigest();
    } else {
      resetLiveDigest();
    }
  }

  // Add entry
  liveDigest.entries.push({ emoji, text, time: timeStr, priority, category });

  if (!liveDigest.startedAt) {
    // First event — create the digest message
    liveDigest.startedAt = now;
    liveDigest.chatId = telegramChatId;

    const messageText = buildLiveDigestText();
    const msgId = await sendDirect(telegramChatId, messageText, {
      silent: true,
    });
    if (msgId) {
      liveDigest.messageId = msgId;
    }
    persistLiveDigest();

    // Schedule seal
    liveDigest.sealTimer = setTimeout(() => sealLiveDigest(), windowMs);
  } else {
    // Subsequent event — debounced edit
    scheduleLiveDigestEdit();
    persistLiveDigest();
  }
}

/**
 * Queue a notification for batched delivery.
 * Routes through Live Digest when enabled, falls back to batch queues.
 * @param {string} text - Message text
 * @param {number} priority - 1=critical(immediate), 2=error, 3=warning, 4=info, 5=debug
 * @param {object} options - { category, data, silent }
 */
function queueNotification(text, priority = 4, options = {}) {
  // Critical messages always go immediately
  if (priority <= immediateThreshold) {
    return sendDirect(telegramChatId, text, { silent: options.silent });
  }

  // Live Digest mode: append to the continuously-edited message
  if (liveDigestEnabled && batchingEnabled) {
    return addToLiveDigest(text, priority, options.category || "general");
  }

  // Legacy batch mode fallback
  if (!batchingEnabled) {
    return sendDirect(telegramChatId, text, { silent: options.silent });
  }

  const category = options.category || "info";
  const entry = {
    text,
    priority,
    category,
    timestamp: new Date().toISOString(),
    data: options.data || {},
  };

  // Route to appropriate queue
  if (priority === 1) {
    messageQueue.critical.push(entry);
  } else if (priority === 2) {
    messageQueue.errors.push(entry);
  } else if (priority === 3) {
    messageQueue.warnings.push(entry);
  } else if (priority === 5) {
    messageQueue.debug.push(entry);
  } else {
    messageQueue.info.push(entry);
  }

  // Flush if queue is getting too large
  const totalSize =
    messageQueue.critical.length +
    messageQueue.errors.length +
    messageQueue.warnings.length +
    messageQueue.info.length +
    messageQueue.debug.length;

  if (totalSize >= batchMaxSize) {
    flushNotificationQueue();
  }
}

/**
 * Format and send batched notifications as a summary (legacy fallback).
 */
async function flushNotificationQueue() {
  const sections = [];
  const counts = {
    critical: messageQueue.critical.length,
    errors: messageQueue.errors.length,
    warnings: messageQueue.warnings.length,
    info: messageQueue.info.length,
    debug: messageQueue.debug.length,
  };

  const totalMessages =
    counts.critical +
    counts.errors +
    counts.warnings +
    counts.info +
    counts.debug;

  if (totalMessages === 0) return; // Nothing to send

  // Build summary header
  const timestamp = new Date().toISOString().slice(11, 19);
  let header = `📊 Update Summary (${timestamp})`;
  if (totalMessages > 0) {
    const parts = [];
    if (counts.critical > 0) parts.push(`🔴 ${counts.critical}`);
    if (counts.errors > 0) parts.push(`❌ ${counts.errors}`);
    if (counts.warnings > 0) parts.push(`⚠️ ${counts.warnings}`);
    if (counts.info > 0) parts.push(`ℹ️ ${counts.info}`);
    header += `\n${parts.join(" • ")}`;
  }

  // Critical messages (show all)
  if (counts.critical > 0) {
    sections.push(
      `🔴 Critical:\n${messageQueue.critical.map((m) => `  • ${m.text}`).join("\n")}`,
    );
  }

  // Errors (show up to 5, then summarize)
  if (counts.errors > 0) {
    const errorTexts = messageQueue.errors
      .slice(0, 5)
      .map((m) => `  • ${m.text}`);
    if (counts.errors > 5) {
      errorTexts.push(`  • ... and ${counts.errors - 5} more errors`);
    }
    sections.push(`❌ Errors:\n${errorTexts.join("\n")}`);
  }

  // Warnings (show up to 3, then summarize)
  if (counts.warnings > 0) {
    const warnTexts = messageQueue.warnings
      .slice(0, 3)
      .map((m) => `  • ${m.text}`);
    if (counts.warnings > 3) {
      warnTexts.push(`  • ... and ${counts.warnings - 3} more warnings`);
    }
    sections.push(`⚠️ Warnings:\n${warnTexts.join("\n")}`);
  }

  // Info messages (aggregate by category)
  if (counts.info > 0) {
    const categories = {};
    for (const msg of messageQueue.info) {
      const cat = msg.category || "general";
      categories[cat] = (categories[cat] || 0) + 1;
    }
    const summary = Object.entries(categories)
      .map(([cat, count]) => `  • ${cat}: ${count}`)
      .join("\n");
    sections.push(`ℹ️ Info:\n${summary}`);
  }

  // Build final message
  const message = [header, ...sections].join("\n\n");

  // Send the summary
  await sendDirect(telegramChatId, message, { silent: true });

  // Clear queues
  messageQueue.critical.length = 0;
  messageQueue.errors.length = 0;
  messageQueue.warnings.length = 0;
  messageQueue.info.length = 0;
  messageQueue.debug.length = 0;
}

/**
 * Start periodic flushing of the notification queue.
 * In live-digest mode, the flush loop is only used as a fallback seal timer.
 */
async function startBatchFlushLoop() {
  if (!batchingEnabled || batchFlushTimer) return;
  // In live digest mode, restore persisted state (if not already restored) and skip flush loop
  if (liveDigestEnabled) {
    if (!liveDigest.messageId) await restoreLiveDigest();
    return;
  }
  const intervalMs = batchIntervalSec * 1000;
  batchFlushTimer = setInterval(() => {
    flushNotificationQueue().catch((err) =>
      console.warn(`[telegram-bot] batch flush error: ${err.message}`),
    );
  }, intervalMs);
}

/**
 * Stop the batch flush loop and seal any active live digest.
 */
function stopBatchFlushLoop() {
  if (batchFlushTimer) {
    clearInterval(batchFlushTimer);
    batchFlushTimer = null;
  }
  // Seal any active live digest
  if (liveDigest.entries.length > 0) {
    sealLiveDigest();
  } else {
    resetLiveDigest();
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the two-way Telegram bot.
 * Call injectMonitorFunctions() first if you want full integration.
 */
export async function startTelegramBot() {
  refreshTelegramConfigFromEnv();
  if (!telegramToken || !telegramChatId) {
    console.warn(
      "[telegram-bot] disabled (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)",
    );
    return;
  }

  const lockOk = await acquireTelegramPollLock("telegram-bot");
  if (!lockOk) {
    console.warn(
      "[telegram-bot] polling disabled (another getUpdates poller is active)",
    );
    return;
  }

  // Initialize the primary agent context
  await initPrimaryAgent();

  // Probe Telegram API connectivity before startup registration
  const reachable = await probeTelegramConnectivity();
  if (reachable) {
    await registerBotCommands();
  } else {
    console.warn(
      "[telegram-bot] Telegram API unreachable at startup — command registration deferred",
    );
  }

  // Start Telegram UI server (Mini App) when configured
  const miniAppEnabled = ["1", "true", "yes"].includes(
    String(process.env.TELEGRAM_MINIAPP_ENABLED || "").toLowerCase(),
  );
  const miniAppPort = Number(process.env.TELEGRAM_UI_PORT || "0");

  if (miniAppEnabled || miniAppPort > 0) {
    try {
      await startTelegramUiServer({
        dependencies: {
          getInternalExecutor: _getInternalExecutor,
          getExecutorMode: _getExecutorMode,
          handleUiCommand: handleUiCommand,
          getSyncEngine: _getSyncEngine,
          onProjectSyncAlert: async (alert) => {
            if (!_sendTelegramMessage) return;
            const text = String(alert?.message || "Project sync alert");
            await _sendTelegramMessage(`⚠️ ${text}`);
          },
        },
      });
      syncUiUrlsFromServer();
      if (reachable && telegramWebAppUrl) {
        const updated = await setWebAppMenuButton(telegramWebAppUrl);
        if (updated) {
          lastMenuButtonUrl = telegramWebAppUrl;
        }
      } else if (reachable) {
        await clearWebAppMenuButton();
        lastMenuButtonUrl = null;
      }

      // Periodically refresh the menu button URL in case the tunnel changes
      if (reachable && !menuButtonRefreshTimer) {
        menuButtonRefreshTimer = setInterval(() => void refreshMenuButton(), MENU_BUTTON_REFRESH_MS);
      }

      // Notify about firewall issues if detected (24h cooldown)
      // Skip the alarm if the cloudflared tunnel is active — Telegram Mini App
      // traffic goes through the tunnel (internet → Cloudflare → localhost),
      // so the LAN firewall doesn't matter for Telegram. Only direct LAN
      // browser access is affected.
      if (reachable) {
        const fwState = getFirewallState();
        const tUrl = getTunnelUrl();
        if (fwState && fwState.blocked && !tUrl) {
          let skipCooldown = false;
          try {
            if (existsSync(fwCooldownPath)) {
              const data = JSON.parse(readFileSync(fwCooldownPath, "utf8"));
              if (Date.now() - (data.lastNotified || 0) < FW_COOLDOWN_MS) {
                skipCooldown = true;
              }
            }
          } catch { /* ignore corrupt file */ }
          if (!skipCooldown) {
            const port = new URL(telegramUiUrl || "http://localhost:5511").port || "5511";
            await sendDirect(
              telegramChatId,
              `🔥 *Firewall Alert*\n\n` +
              `Port ${port}/tcp appears blocked by \`${fwState.firewall}\`.\n` +
              `The Control Center may not be reachable from your phone or LAN browser.\n\n` +
              `To fix, run on the server:\n\`\`\`\n${fwState.allowCmd}\n\`\`\``,
              {
                parseMode: "Markdown",
                reply_markup: {
                  inline_keyboard: [[
                    { text: "🔓 Open Port (requires admin password on server)", callback_data: "fw:open" },
                  ]],
                },
              },
            );
            try {
              mkdirSync(resolve(repoRoot, ".cache"), { recursive: true });
              writeFileSync(fwCooldownPath, JSON.stringify({ lastNotified: Date.now() }));
            } catch { /* best effort */ }
          }
        } else if (fwState && fwState.blocked && tUrl) {
          console.log(
            `[telegram-bot] firewall blocks port but tunnel active — suppressing Telegram firewall alert`,
          );
        }
      }
    } catch (err) {
      console.warn(`[telegram-bot] UI server start failed: ${err.message}`);
      if (reachable) {
        await clearWebAppMenuButton();
        lastMenuButtonUrl = null;
      }
    }
  } else if (reachable) {
    await clearWebAppMenuButton();
  }

  // Start presence announcements for multi-workstation discovery
  startPresenceLoop();

  // Start batched notification / live digest system
  await startBatchFlushLoop();

  // Clear any pending updates that arrived while we were offline
  try {
    const stale = await pollUpdates();
    for (const u of stale) {
      lastUpdateId = Math.max(lastUpdateId, u.update_id);
    }
    if (stale.length > 0) {
      console.log(`[telegram-bot] skipped ${stale.length} stale updates`);
    }
  } catch {
    /* best effort */
  }

  polling = true;

  // Only send "online" notification on truly fresh starts, not code-change restarts.
  // Check the self-restart marker file first, then fall back to rapid-restart heuristic.
  const botStartPath = resolve(repoRoot, ".cache", "ve-last-bot-start.txt");
  const selfRestartPath = resolve(repoRoot, ".cache", "ve-self-restart.marker");
  let suppressOnline = false;
  try {
    if (existsSync(selfRestartPath)) {
      const ts = Number(readFileSync(selfRestartPath, "utf8"));
      if (Date.now() - ts < 30_000) suppressOnline = true;
    }
  } catch {
    /* best effort */
  }
  if (!suppressOnline) {
    try {
      const prev = await readFile(botStartPath, "utf8");
      const elapsed = Date.now() - Number(prev);
      if (elapsed < 60_000) suppressOnline = true;
    } catch {
      /* first start or missing file */
    }
  }
  await writeFile(botStartPath, String(Date.now())).catch(() => {});

  if (suppressOnline) {
    console.log(
      "[telegram-bot] restarted (suppressed online notification — rapid restart)",
    );
  } else {
    await sendDirect(
      telegramChatId,
      `🤖 OpenFleet primary agent online (${getPrimaryAgentName()}).\n\nType /menu for the control center or send any message to chat with the agent.`,
    );
  }

  console.log("[telegram-bot] started — listening for messages");

  // Start the polling loop (non-blocking)
  pollLoop().catch((err) => {
    console.error(`[telegram-bot] fatal poll loop error: ${err.message}`);
    polling = false;
  });
}

/**
 * Stop the Telegram bot polling.
 */
export function stopTelegramBot(options = {}) {
  polling = false;
  if (pollAbort) {
    try {
      pollAbort.abort();
    } catch {
      /* best effort */
    }
  }
  if (options.preserveDigest) {
    // Self-restart: persist live digest state for the next process to resume.
    // Don't seal or reset — the new process will pick up where we left off.
    persistLiveDigest();
    if (liveDigest.sealTimer) clearTimeout(liveDigest.sealTimer);
    if (liveDigest.editTimer) clearTimeout(liveDigest.editTimer);
    if (batchFlushTimer) {
      clearInterval(batchFlushTimer);
      batchFlushTimer = null;
    }
  } else {
    // Normal shutdown: seal any active live digest and flush legacy queues
    if (liveDigestEnabled && liveDigest.entries.length > 0) {
      sealLiveDigest();
    } else {
      flushNotificationQueue().catch(() => {});
    }
    stopBatchFlushLoop();
  }
  void releaseTelegramPollLock();
  stopTelegramUiServer();
  if (menuButtonRefreshTimer) {
    clearInterval(menuButtonRefreshTimer);
    menuButtonRefreshTimer = null;
  }
  console.log("[telegram-bot] stopped");
}

/**
 * Queue a notification for batched delivery (exported for monitor.mjs).
 * @param {string} text - Message text
 * @param {number} priority - 1=critical(immediate), 2=error, 3=warning, 4=info, 5=debug
 * @param {object} options - { category, data, silent }
 */
export function notify(text, priority = 4, options = {}) {
  return queueNotification(text, priority, options);
}

/**
 * Get a snapshot of the current live digest entries.
 * Useful for external consumers that need to read digest state.
 */
export function getDigestSnapshot() {
  return {
    entries: [...liveDigest.entries],
    startedAt: liveDigest.startedAt,
    sealed: liveDigest.sealed,
  };
}

// ── Periodic status file writer ─────────────────────────────────
// Called by monitor to keep the status file in sync with live executor state
let _statusWriterTimer = null;

export function startStatusFileWriter(intervalMs = 30000) {
  if (_statusWriterTimer) return;
  const statusDir = dirname(statusPath);
  _statusWriterTimer = setInterval(async () => {
    try {
      const executor = _getInternalExecutor?.();
      if (!executor) return;
      const status = executor.getStatus?.();
      if (!status) return;
      await mkdir(statusDir, { recursive: true });

      let data = {};
      try {
        const raw = await readFile(statusPath, "utf8");
        data = JSON.parse(raw);
      } catch {
        /* fresh file */
      }

      // Convert executor slots to the attempts format
      const attempts = {};
      for (const slot of status.slots) {
        attempts[slot.taskId] = {
          task_id: slot.taskId,
          task_title: slot.taskTitle,
          branch: slot.branch,
          status: slot.status,
          executor: slot.sdk,
          started_at: new Date(
            Number(slot.startedAt || Date.now()),
          ).toISOString(),
          updated_at: new Date().toISOString(),
          attempt: slot.attempt,
          agent_instance_id:
            Number.isFinite(slot.agentInstanceId) && slot.agentInstanceId > 0
              ? Number(slot.agentInstanceId)
              : null,
        };
      }

      let storeStats = null;
      try {
        storeStats = _getTaskStoreStats?.() || null;
      } catch {
        storeStats = null;
      }

      let reviewTasks = [];
      try {
        reviewTasks = (_getTasksPendingReview?.() || [])
          .map((task) => task?.id)
          .filter(Boolean);
      } catch {
        reviewTasks = [];
      }

      data.attempts = attempts;
      data.last_executor_sync = new Date().toISOString();
      data.executor_mode = status.mode || "unknown";
      data.active_slots = `${status.activeSlots}/${status.maxParallel}`;
      data.review_tasks = reviewTasks;
      data.manual_review_tasks = [];
      if (!data.counts || typeof data.counts !== "object") data.counts = {};
      data.counts.running = Number(status.activeSlots || 0);
      data.counts.review = Number(storeStats?.inreview || reviewTasks.length);
      data.counts.error = Number(storeStats?.blocked || 0);
      data.counts.manual_review = 0;

      const { writeFile } = await import("node:fs/promises");
      await writeFile(statusPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn("[telegram-bot] Status file write error:", err.message);
    }
  }, intervalMs);

  if (_statusWriterTimer.unref) _statusWriterTimer.unref();
}

export function stopStatusFileWriter() {
  if (_statusWriterTimer) {
    clearInterval(_statusWriterTimer);
    _statusWriterTimer = null;
  }
}
