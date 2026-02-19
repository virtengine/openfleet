import { execSync, spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, chmodSync, createWriteStream, writeFileSync, watchFile, unwatchFile } from "node:fs";
import { open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { get as httpsGet } from "node:https";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { connect as netConnect } from "node:net";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { arch as osArch, platform as osPlatform } from "node:os";
import Ajv2020 from "ajv/dist/2020.js";

function getLocalLanIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "localhost";
}
import { WebSocketServer } from "ws";
import { getKanbanAdapter } from "./kanban-adapter.mjs";
import { getActiveThreads } from "./agent-pool.mjs";
import {
  listActiveWorktrees,
  getWorktreeStats,
  pruneStaleWorktrees,
  releaseWorktree,
  releaseWorktreeByBranch,
} from "./worktree-manager.mjs";
import {
  loadSharedWorkspaceRegistry,
  sweepExpiredLeases,
  getSharedAvailabilityMap,
  claimSharedWorkspace,
  releaseSharedWorkspace,
  renewSharedWorkspaceLease,
} from "./shared-workspace-registry.mjs";
import {
  initPresence,
  listActiveInstances,
  selectCoordinator,
} from "./presence.mjs";
import {
  loadWorkspaceRegistry,
  getLocalWorkspace,
} from "./workspace-registry.mjs";
import {
  getSessionTracker,
} from "./session-tracker.mjs";
import {
  collectDiffStats,
  getCompactDiffSummary,
  getRecentCommits,
} from "./diff-stats.mjs";
import { resolveRepoRoot } from "./repo-root.mjs";
import {
  SETTINGS_SCHEMA,
  validateSetting,
} from "./ui/modules/settings-schema.js";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolveRepoRoot();
const uiRoot = resolve(__dirname, "ui");
const statusPath = resolve(repoRoot, ".cache", "ve-orchestrator-status.json");
const logsDir = resolve(__dirname, "logs");
const agentLogsDir = resolve(repoRoot, ".cache", "agent-logs");
const CONFIG_SCHEMA_PATH = resolve(__dirname, "openfleet.schema.json");
let _configSchema = null;
let _configValidator = null;

function resolveConfigPath() {
  return process.env.OPENFLEET_CONFIG_PATH
    ? resolve(process.env.OPENFLEET_CONFIG_PATH)
    : resolve(__dirname, "openfleet.config.json");
}

function getConfigSchema() {
  if (_configSchema) return _configSchema;
  try {
    const raw = readFileSync(CONFIG_SCHEMA_PATH, "utf8");
    _configSchema = JSON.parse(raw);
  } catch {
    _configSchema = null;
  }
  return _configSchema;
}

function getConfigValidator() {
  if (_configValidator) return _configValidator;
  const schema = getConfigSchema();
  if (!schema) return null;
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
    _configValidator = ajv.compile(schema);
  } catch {
    _configValidator = null;
  }
  return _configValidator;
}

function isUnsetValue(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return false;
  return typeof value === "string" && value === "";
}

function toCamelCaseFromEnv(key) {
  const parts = String(key || "").toLowerCase().split("_").filter(Boolean);
  return parts
    .map((part, idx) => (idx === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

function parseExecutorsValue(value) {
  if (Array.isArray(value)) return value;
  const raw = String(value || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : value;
    } catch {
      return value;
    }
  }
  const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  const roles = ["primary", "backup", "tertiary"];
  const executors = [];
  for (let i = 0; i < entries.length; i += 1) {
    const parts = entries[i].split(":").map((part) => part.trim());
    if (parts.length < 2) continue;
    const weight = parts[2] ? Number(parts[2]) : Math.floor(100 / entries.length);
    executors.push({
      name: `${parts[0].toLowerCase()}-${parts[1].toLowerCase()}`,
      executor: parts[0].toUpperCase(),
      variant: parts[1],
      weight: Number.isFinite(weight) ? weight : 0,
      role: roles[i] || `executor-${i + 1}`,
      enabled: true,
    });
  }
  return executors.length ? executors : value;
}

function coerceSettingValue(def, value, propSchema) {
  if (value == null) return value;
  const types = [];
  if (propSchema?.type) {
    if (Array.isArray(propSchema.type)) types.push(...propSchema.type);
    else types.push(propSchema.type);
  }

  if (types.includes("array")) {
    if (def?.key === "EXECUTORS") {
      return parseExecutorsValue(value);
    }
    if (Array.isArray(value)) return value;
    let parts = String(value)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (def?.key === "OPENFLEET_HOOK_TARGETS") {
      parts = parts.map((part) => part.toLowerCase());
      if (parts.includes("all")) {
        const allowed = Array.isArray(propSchema?.items?.enum)
          ? propSchema.items.enum
          : ["codex", "claude", "copilot"];
        parts = [...allowed];
      }
    }
    return parts;
  }

  if (types.includes("boolean")) {
    if (typeof value === "boolean") return value;
    const normalized = String(value).toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }

  if (types.includes("number") || types.includes("integer")) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  if (def?.type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (def?.type === "boolean") {
    if (typeof value === "boolean") return value;
    const normalized = String(value).toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return value;
}

function getSchemaProperty(schema, pathParts) {
  let current = schema;
  for (const part of pathParts) {
    if (!current || !current.properties) return null;
    current = current.properties[part];
  }
  return current || null;
}

const ROOT_SKIP_ENV_KEYS = new Set([]);
const ROOT_OVERRIDE_MAP = {
  OPENFLEET_MODE: "mode",
  TASK_PLANNER_MODE: "plannerMode",
  EXECUTOR_DISTRIBUTION: "distribution",
};
const INTERNAL_EXECUTOR_MAP = {
  PARALLEL: ["internalExecutor", "maxParallel"],
  SDK: ["internalExecutor", "sdk"],
  TIMEOUT_MS: ["internalExecutor", "taskTimeoutMs"],
  MAX_RETRIES: ["internalExecutor", "maxRetries"],
  POLL_MS: ["internalExecutor", "pollIntervalMs"],
  REVIEW_AGENT_ENABLED: ["internalExecutor", "reviewAgentEnabled"],
  REPLENISH_ENABLED: ["internalExecutor", "backlogReplenishment", "enabled"],
};
const CONFIG_PATH_OVERRIDES = {
  EXECUTOR_MODE: ["internalExecutor", "mode"],
  PROJECT_REQUIREMENTS_PROFILE: ["projectRequirements", "profile"],
  TASK_PLANNER_DEDUP_HOURS: ["plannerDedupHours"],
};
const ROOT_PREFIX_ALLOWLIST = [
  "TELEGRAM_",
  "FLEET_",
  "VE_",
];

const AUTH_ENV_PREFIX_MAP = {
  CODEX: "codex",
  CLAUDE: "claude",
  COPILOT: "copilot",
};

function buildConfigPath(pathParts, allowUnknownSchema = false) {
  return { pathParts, allowUnknownSchema };
}

function mapEnvKeyToConfigPath(key, schema) {
  if (!schema?.properties) return null;
  const envKey = String(key || "").toUpperCase();

  if (ROOT_SKIP_ENV_KEYS.has(envKey)) return null;

  const overridePath = CONFIG_PATH_OVERRIDES[envKey];
  if (overridePath) {
    return buildConfigPath(overridePath, true);
  }

  if (envKey.startsWith("INTERNAL_EXECUTOR_")) {
    const rest = envKey.slice("INTERNAL_EXECUTOR_".length);
    const internalPath = INTERNAL_EXECUTOR_MAP[rest];
    if (internalPath) {
      return buildConfigPath(internalPath, true);
    }
  }

  if (ROOT_OVERRIDE_MAP[envKey] && schema.properties[ROOT_OVERRIDE_MAP[envKey]]) {
    return buildConfigPath([ROOT_OVERRIDE_MAP[envKey]]);
  }
  if (envKey.startsWith("FAILOVER_") && schema.properties.failover?.properties) {
    const rest = envKey.slice("FAILOVER_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (schema.properties.failover.properties[sub]) return buildConfigPath(["failover", sub]);
  }
  if (envKey.startsWith("OPENFLEET_PROMPT_") && schema.properties.agentPrompts?.properties) {
    const rest = envKey.slice("OPENFLEET_PROMPT_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (schema.properties.agentPrompts.properties[sub]) {
      return buildConfigPath(["agentPrompts", sub]);
    }
  }
  if (envKey.endsWith("_AUTH_SOURCES") || envKey.endsWith("_AUTH_FALLBACK_INTERACTIVE")) {
    const match = envKey.match(/^(CODEX|CLAUDE|COPILOT)_AUTH_(SOURCES|FALLBACK_INTERACTIVE)$/);
    if (match && schema.properties.auth?.properties) {
      const provider = AUTH_ENV_PREFIX_MAP[match[1]];
      const sub = match[2] === "SOURCES" ? "sources" : "fallbackToInteractive";
      const propSchema = schema.properties.auth?.properties?.[provider]?.properties;
      if (propSchema?.[sub]) {
        return buildConfigPath(["auth", provider, sub]);
      }
    }
  }
  const hookProfileMap = {
    OPENFLEET_HOOK_PROFILE: ["hookProfiles", "profile"],
    OPENFLEET_HOOK_TARGETS: ["hookProfiles", "targets"],
    OPENFLEET_HOOKS_ENABLED: ["hookProfiles", "enabled"],
    OPENFLEET_HOOKS_OVERWRITE: ["hookProfiles", "overwriteExisting"],
  };
  if (hookProfileMap[envKey]) {
    const pathParts = hookProfileMap[envKey];
    const propSchema = getSchemaProperty(schema, pathParts);
    if (propSchema) return buildConfigPath(pathParts);
  }
  const rootKey = toCamelCaseFromEnv(envKey);
  if (schema.properties[rootKey]) return buildConfigPath([rootKey]);
  if (ROOT_PREFIX_ALLOWLIST.some((prefix) => envKey.startsWith(prefix))) {
    return buildConfigPath([rootKey], true);
  }
  if (envKey.startsWith("KANBAN_") && schema.properties.kanban?.properties) {
    const rest = envKey.slice("KANBAN_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (schema.properties.kanban.properties[sub]) return buildConfigPath(["kanban", sub]);
  }
  if (envKey.startsWith("JIRA_STATUS_")) {
    const jiraSchema = schema.properties.kanban?.properties?.jira?.properties?.statusMapping?.properties;
    const rest = envKey.slice("JIRA_STATUS_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (jiraSchema?.[sub]) return buildConfigPath(["kanban", "jira", "statusMapping", sub]);
  }
  if (envKey.startsWith("JIRA_LABEL_")) {
    const jiraSchema = schema.properties.kanban?.properties?.jira?.properties?.labels?.properties;
    const rest = envKey.slice("JIRA_LABEL_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (jiraSchema?.[sub]) return buildConfigPath(["kanban", "jira", "labels", sub]);
  }
  if (envKey.startsWith("JIRA_")) {
    const jiraSchema = schema.properties.kanban?.properties?.jira?.properties;
    const rest = envKey.slice("JIRA_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (jiraSchema?.[sub]) return buildConfigPath(["kanban", "jira", sub]);
  }
  if (envKey.startsWith("GITHUB_PROJECT_")) {
    const projectSchema = schema.properties.kanban?.properties?.github?.properties?.project?.properties;
    const rest = envKey.slice("GITHUB_PROJECT_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (projectSchema?.[sub]) return buildConfigPath(["kanban", "github", "project", sub]);
  }
  if (envKey.startsWith("GITHUB_PROJECT_WEBHOOK_")) {
    const webhookSchema = schema.properties.kanban?.properties?.github?.properties?.project?.properties?.webhook?.properties;
    const rest = envKey.slice("GITHUB_PROJECT_WEBHOOK_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (webhookSchema?.[sub]) return buildConfigPath(["kanban", "github", "project", "webhook", sub]);
  }
  if (envKey.startsWith("GITHUB_PROJECT_SYNC_")) {
    const syncSchema = schema.properties.kanban?.properties?.github?.properties?.project?.properties?.syncMonitoring?.properties;
    const rest = envKey.slice("GITHUB_PROJECT_SYNC_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (syncSchema?.[sub]) return buildConfigPath(["kanban", "github", "project", "syncMonitoring", sub]);
  }
  return null;
}

function setConfigPathValue(obj, pathParts, value) {
  let cursor = obj;
  for (let i = 0; i < pathParts.length; i += 1) {
    const part = pathParts[i];
    if (i === pathParts.length - 1) {
      cursor[part] = value;
      return;
    }
    if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
    cursor = cursor[part];
  }
}

function unsetConfigPathValue(obj, pathParts) {
  let cursor = obj;
  const stack = [];
  for (let i = 0; i < pathParts.length; i += 1) {
    const part = pathParts[i];
    if (!cursor || typeof cursor !== "object") return;
    if (i === pathParts.length - 1) {
      delete cursor[part];
      break;
    }
    stack.push({ parent: cursor, key: part });
    cursor = cursor[part];
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const { parent, key } = stack[i];
    if (
      parent[key] &&
      typeof parent[key] === "object" &&
      Object.keys(parent[key]).length === 0
    ) {
      delete parent[key];
    } else {
      break;
    }
  }
}

// Read port lazily — .env may not be loaded at module import time
function getDefaultPort() {
  return Number(process.env.TELEGRAM_UI_PORT || "0") || 0;
}
const DEFAULT_HOST = process.env.TELEGRAM_UI_HOST || "0.0.0.0";
// Lazy evaluation — .env may not be loaded yet when this module is first imported
function isAllowUnsafe() {
  return ["1", "true", "yes"].includes(
    String(process.env.TELEGRAM_UI_ALLOW_UNSAFE || "").toLowerCase(),
  );
}
const AUTH_MAX_AGE_SEC = Number(
  process.env.TELEGRAM_UI_AUTH_MAX_AGE_SEC || "86400",
);
const PRESENCE_TTL_MS =
  Number(process.env.TELEGRAM_PRESENCE_TTL_SEC || "180") * 1000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

let uiServer = null;
let uiServerUrl = null;
let uiServerTls = false;
let wsServer = null;
const wsClients = new Set();
/** @type {ReturnType<typeof setInterval>|null} */
let wsHeartbeatTimer = null;

/* ─── Log Streaming State ─── */
/** Map<string, { sockets: Set<WebSocket>, offset: number, pollTimer }> keyed by filePath */
const logStreamers = new Map();
let uiDeps = {};
const projectSyncWebhookMetrics = {
  received: 0,
  processed: 0,
  ignored: 0,
  failed: 0,
  invalidSignature: 0,
  syncTriggered: 0,
  syncSuccess: 0,
  syncFailure: 0,
  rateLimitObserved: 0,
  alertsTriggered: 0,
  consecutiveFailures: 0,
  lastEventAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
};

// ── Settings API: Known env keys from settings schema ──
const SETTINGS_KNOWN_KEYS = [
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_ALLOWED_CHAT_IDS",
  "TELEGRAM_INTERVAL_MIN", "TELEGRAM_COMMAND_POLL_TIMEOUT_SEC", "TELEGRAM_AGENT_TIMEOUT_MIN",
  "TELEGRAM_COMMAND_CONCURRENCY", "TELEGRAM_VERBOSITY", "TELEGRAM_BATCH_NOTIFICATIONS",
  "TELEGRAM_BATCH_INTERVAL_SEC", "TELEGRAM_BATCH_MAX_SIZE", "TELEGRAM_IMMEDIATE_PRIORITY",
  "TELEGRAM_API_BASE_URL", "TELEGRAM_HTTP_TIMEOUT_MS", "TELEGRAM_RETRY_ATTEMPTS",
  "PROJECT_NAME", "TELEGRAM_MINIAPP_ENABLED", "TELEGRAM_UI_PORT", "TELEGRAM_UI_HOST",
  "TELEGRAM_UI_PUBLIC_HOST", "TELEGRAM_UI_BASE_URL", "TELEGRAM_UI_ALLOW_UNSAFE",
  "TELEGRAM_UI_AUTH_MAX_AGE_SEC", "TELEGRAM_UI_TUNNEL",
  "EXECUTOR_MODE", "INTERNAL_EXECUTOR_PARALLEL", "INTERNAL_EXECUTOR_SDK",
  "INTERNAL_EXECUTOR_TIMEOUT_MS", "INTERNAL_EXECUTOR_MAX_RETRIES", "INTERNAL_EXECUTOR_POLL_MS",
  "INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED", "INTERNAL_EXECUTOR_REPLENISH_ENABLED",
  "PRIMARY_AGENT", "EXECUTORS", "EXECUTOR_DISTRIBUTION", "FAILOVER_STRATEGY",
  "COMPLEXITY_ROUTING_ENABLED", "PROJECT_REQUIREMENTS_PROFILE",
  "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "CODEX_MODEL",
  "CODEX_MODEL_PROFILE", "CODEX_MODEL_PROFILE_SUBAGENT",
  "CODEX_MODEL_PROFILE_XL_PROVIDER", "CODEX_MODEL_PROFILE_XL_MODEL", "CODEX_MODEL_PROFILE_XL_BASE_URL", "CODEX_MODEL_PROFILE_XL_API_KEY",
  "CODEX_MODEL_PROFILE_M_PROVIDER", "CODEX_MODEL_PROFILE_M_MODEL", "CODEX_MODEL_PROFILE_M_BASE_URL", "CODEX_MODEL_PROFILE_M_API_KEY",
  "CODEX_SUBAGENT_MODEL", "ANTHROPIC_API_KEY", "CLAUDE_MODEL",
  "COPILOT_MODEL", "COPILOT_CLI_TOKEN",
  "KANBAN_BACKEND", "KANBAN_SYNC_POLICY", "OPENFLEET_TASK_LABEL",
  "OPENFLEET_ENFORCE_TASK_LABEL", "STALE_TASK_AGE_HOURS",
  "TASK_PLANNER_MODE", "TASK_PLANNER_DEDUP_HOURS",
  "OPENFLEET_PROMPT_PLANNER",
  "GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_PROJECT_MODE",
  "GITHUB_PROJECT_NUMBER", "GITHUB_DEFAULT_ASSIGNEE", "GITHUB_AUTO_ASSIGN_CREATOR",
  "GITHUB_PROJECT_WEBHOOK_PATH", "GITHUB_PROJECT_WEBHOOK_SECRET", "GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE",
  "GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD", "GITHUB_PROJECT_SYNC_RATE_LIMIT_ALERT_THRESHOLD",
  "VK_TARGET_BRANCH", "CODEX_ANALYZE_MERGE_STRATEGY", "DEPENDABOT_AUTO_MERGE",
  "GH_RECONCILE_ENABLED",
  "CLOUDFLARE_TUNNEL_NAME", "CLOUDFLARE_TUNNEL_CREDENTIALS",
  "TELEGRAM_PRESENCE_INTERVAL_SEC", "TELEGRAM_PRESENCE_DISABLED",
  "VE_INSTANCE_LABEL", "VE_COORDINATOR_ELIGIBLE", "VE_COORDINATOR_PRIORITY",
  "FLEET_ENABLED", "FLEET_BUFFER_MULTIPLIER", "FLEET_SYNC_INTERVAL_MS",
  "FLEET_PRESENCE_TTL_MS", "FLEET_KNOWLEDGE_ENABLED", "FLEET_KNOWLEDGE_FILE",
  "CODEX_SANDBOX", "CODEX_FEATURES_BWRAP", "CODEX_SANDBOX_PERMISSIONS", "CODEX_SANDBOX_WRITABLE_ROOTS",
  "CONTAINER_ENABLED", "CONTAINER_RUNTIME", "CONTAINER_IMAGE",
  "CONTAINER_TIMEOUT_MS", "MAX_CONCURRENT_CONTAINERS", "CONTAINER_MEMORY_LIMIT", "CONTAINER_CPU_LIMIT",
  "OPENFLEET_SENTINEL_AUTO_START", "SENTINEL_AUTO_RESTART_MONITOR",
  "SENTINEL_CRASH_LOOP_THRESHOLD", "SENTINEL_CRASH_LOOP_WINDOW_MIN",
  "SENTINEL_REPAIR_AGENT_ENABLED", "SENTINEL_REPAIR_TIMEOUT_MIN",
  "OPENFLEET_HOOK_PROFILE", "OPENFLEET_HOOK_TARGETS",
  "OPENFLEET_HOOKS_ENABLED", "OPENFLEET_HOOKS_OVERWRITE",
  "OPENFLEET_HOOKS_BUILTINS_MODE",
  "AGENT_WORK_LOGGING_ENABLED", "AGENT_WORK_ANALYZER_ENABLED",
  "AGENT_SESSION_LOG_RETENTION", "AGENT_ERROR_LOOP_THRESHOLD",
  "AGENT_STUCK_THRESHOLD_MS", "LOG_MAX_SIZE_MB",
  "DEVMODE", "SELF_RESTART_WATCH_ENABLED", "MAX_PARALLEL",
  "RESTART_DELAY_MS", "SHARED_STATE_ENABLED", "SHARED_STATE_STALE_THRESHOLD_MS",
  "VE_CI_SWEEP_EVERY",
];

const SETTINGS_SENSITIVE_KEYS = new Set([
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "GITHUB_TOKEN",
  "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "CODEX_MODEL_PROFILE_XL_API_KEY", "CODEX_MODEL_PROFILE_M_API_KEY",
  "ANTHROPIC_API_KEY", "COPILOT_CLI_TOKEN", "GITHUB_PROJECT_WEBHOOK_SECRET",
  "CLOUDFLARE_TUNNEL_CREDENTIALS",
]);

const SETTINGS_KNOWN_SET = new Set(SETTINGS_KNOWN_KEYS);
let _settingsLastUpdateTime = 0;

function updateEnvFile(changes) {
  const envPath = resolve(__dirname, '.env');
  let content = '';
  try { content = readFileSync(envPath, 'utf8'); } catch { content = ''; }

  const lines = content.split('\n');
  const updated = new Set();

  for (const [key, value] of Object.entries(changes)) {
    const pattern = new RegExp(`^(#\\s*)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        lines[i] = `${key}=${value}`;
        found = true;
        updated.add(key);
        break;
      }
    }
    if (!found) {
      lines.push(`${key}=${value}`);
      updated.add(key);
    }
  }

  writeFileSync(envPath, lines.join('\n'), 'utf8');
  return Array.from(updated);
}

function updateConfigFile(changes) {
  const schema = getConfigSchema();
  const configPath = resolveConfigPath();
  if (!schema) return { updated: [], path: configPath };
  let configData = { $schema: "./openfleet.schema.json" };
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf8");
      configData = JSON.parse(raw);
    } catch {
      configData = { $schema: "./openfleet.schema.json" };
    }
  }

  const updated = new Set();
  for (const [key, value] of Object.entries(changes)) {
    const pathInfo = mapEnvKeyToConfigPath(key, schema);
    if (!pathInfo) continue;
    const { pathParts, allowUnknownSchema } = pathInfo;
    const propSchema = getSchemaProperty(schema, pathParts);
    if (!propSchema && !allowUnknownSchema) continue;
    if (isUnsetValue(value)) {
      unsetConfigPathValue(configData, pathParts);
      updated.add(key);
      continue;
    }
    const def = SETTINGS_SCHEMA.find((s) => s.key === key);
    const coerced = coerceSettingValue(def, value, propSchema);
    setConfigPathValue(configData, pathParts, coerced);
    updated.add(key);
  }

  if (updated.size === 0) {
    return { updated: [], path: configPath };
  }

  if (!configData.$schema) {
    configData.$schema = "./openfleet.schema.json";
  }
  writeFileSync(configPath, JSON.stringify(configData, null, 2) + "\n", "utf8");
  return { updated: Array.from(updated), path: configPath };
}

function validateConfigSchemaChanges(changes) {
  try {
    const schema = getConfigSchema();
    const validator = getConfigValidator();
    if (!schema || !validator) return {};

    const configPath = resolveConfigPath();
    let configData = {};
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, "utf8");
        configData = JSON.parse(raw);
      } catch {
        configData = {};
      }
    }

    const candidate = JSON.parse(JSON.stringify(configData || {}));
    const pathMap = new Map();
    for (const [key, value] of Object.entries(changes)) {
      const pathInfo = mapEnvKeyToConfigPath(key, schema);
      if (!pathInfo) continue;
      const { pathParts, allowUnknownSchema } = pathInfo;
      const propSchema = getSchemaProperty(schema, pathParts);
      if (!propSchema && !allowUnknownSchema) continue;
      if (isUnsetValue(value)) {
        unsetConfigPathValue(candidate, pathParts);
        pathMap.set(pathParts.join("."), key);
        continue;
      }
      const def = SETTINGS_SCHEMA.find((s) => s.key === key);
      const coerced = coerceSettingValue(def, value, propSchema);
      setConfigPathValue(candidate, pathParts, coerced);
      pathMap.set(pathParts.join("."), key);
    }

    if (pathMap.size === 0) return {};
    const valid = validator(candidate);
    if (valid) return {};

    const fieldErrors = {};
    const errors = validator.errors || [];
    for (const err of errors) {
      let path = String(err.instancePath || "").replace(/^\//, "");
      if (!path && err.params?.missingProperty) {
        const missing = String(err.params.missingProperty);
        path = path ? `${path}/${missing}` : missing;
      }
      if (!path && err.params?.additionalProperty) {
        const extra = String(err.params.additionalProperty);
        path = path ? `${path}/${extra}` : extra;
      }
      if (!path) continue;
      const parts = path.split("/").filter(Boolean);
      let envKey = pathMap.get(parts.join("."));
      if (!envKey) {
        for (let i = parts.length; i > 0; i -= 1) {
          const candidatePath = parts.slice(0, i).join(".");
          if (pathMap.has(candidatePath)) {
            envKey = pathMap.get(candidatePath);
            break;
          }
        }
      }
      if (envKey && !fieldErrors[envKey]) {
        fieldErrors[envKey] = err.message || "Invalid value";
      }
    }
    if (Object.keys(fieldErrors).length === 0) {
      for (const envKey of pathMap.values()) {
        fieldErrors[envKey] = "Invalid value (config schema)";
      }
    }
    return fieldErrors;
  } catch {
    return {};
  }
}

// ── Simple rate limiter for mutation endpoints ──
const _rateLimitMap = new Map();
function checkRateLimit(req, maxPerMin = 30) {
  const key = req.headers["x-telegram-initdata"] || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  let bucket = _rateLimitMap.get(key);
  if (!bucket || now - bucket.windowStart > 60000) {
    bucket = { windowStart: now, count: 0 };
    _rateLimitMap.set(key, bucket);
  }
  bucket.count++;
  if (bucket.count > maxPerMin) return false;
  return true;
}
// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateLimitMap) {
    if (now - v.windowStart > 120000) _rateLimitMap.delete(k);
  }
}, 300000).unref();

// ── Session token (auto-generated per startup for browser access) ────
let sessionToken = "";

/** Return the current session token (for logging the browser URL). */
export function getSessionToken() {
  return sessionToken;
}

// ── Auto-TLS self-signed certificate generation ──────────────────────
const TLS_CACHE_DIR = resolve(__dirname, ".cache", "tls");
const TLS_CERT_PATH = resolve(TLS_CACHE_DIR, "server.crt");
const TLS_KEY_PATH = resolve(TLS_CACHE_DIR, "server.key");
function isTlsDisabled() {
  return ["1", "true", "yes"].includes(
    String(process.env.TELEGRAM_UI_TLS_DISABLE || "").toLowerCase(),
  );
}

/**
 * Ensures a self-signed TLS certificate exists in .cache/tls/.
 * Generates one via openssl if missing or expired (valid for 825 days).
 * Returns { key, cert } buffers or null if generation fails.
 */
function ensureSelfSignedCert() {
  try {
    if (!existsSync(TLS_CACHE_DIR)) {
      mkdirSync(TLS_CACHE_DIR, { recursive: true });
    }

    // Reuse existing cert if still valid
    if (existsSync(TLS_CERT_PATH) && existsSync(TLS_KEY_PATH)) {
      try {
        const certPem = readFileSync(TLS_CERT_PATH, "utf8");
        const cert = new X509Certificate(certPem);
        const notAfter = new Date(cert.validTo);
        if (notAfter > new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)) {
          return {
            key: readFileSync(TLS_KEY_PATH),
            cert: readFileSync(TLS_CERT_PATH),
          };
        }
      } catch {
        // Cert parse failed or expired — regenerate
      }
    }

    // Generate self-signed cert via openssl
    const lanIp = getLocalLanIp();
    const subjectAltName = `DNS:localhost,IP:127.0.0.1,IP:${lanIp}`;
    execSync(
      `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
        `-keyout "${TLS_KEY_PATH}" -out "${TLS_CERT_PATH}" ` +
        `-days 825 -nodes -batch ` +
        `-subj "/CN=openfleet" ` +
        `-addext "subjectAltName=${subjectAltName}"`,
      { stdio: "pipe", timeout: 10_000 },
    );

    console.log(
      `[telegram-ui] auto-generated self-signed TLS cert (SAN: ${subjectAltName})`,
    );
    return {
      key: readFileSync(TLS_KEY_PATH),
      cert: readFileSync(TLS_CERT_PATH),
    };
  } catch (err) {
    console.warn(
      `[telegram-ui] TLS cert generation failed, falling back to HTTP: ${err.message}`,
    );
    return null;
  }
}

// ── Firewall detection and management ────────────────────────────────

/** Detected firewall state — populated by checkFirewall() */
let firewallState = null;

/** Return the last firewall check result (or null). */
export function getFirewallState() {
  return firewallState;
}

/**
 * Detect the active firewall and check if a given TCP port is allowed.
 * Uses a TCP self-connect probe as the ground truth, then identifies the
 * firewall for the fix command.
 * Returns { firewall, blocked, allowCmd, status } or null if no firewall.
 */
async function checkFirewall(port) {
  const lanIp = getLocalLanIp();
  if (!lanIp) return null;

  // Ground truth: try connecting to ourselves on the LAN IP
  const reachable = await new Promise((resolve) => {
    const sock = netConnect({ host: lanIp, port, timeout: 3000 });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => { sock.destroy(); resolve(false); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
  });

  // Detect which firewall is active (for the fix command)
  const fwInfo = detectFirewallType(port);

  if (reachable) {
    return fwInfo
      ? { ...fwInfo, blocked: false, status: "allowed" }
      : null;
  }

  // Port is not reachable — report as blocked
  return fwInfo
    ? { ...fwInfo, blocked: true, status: "blocked" }
    : { firewall: "unknown", blocked: true, allowCmd: `# Check your firewall settings for port ${port}/tcp`, status: "blocked" };
}

/**
 * Identify the active firewall and build the fix command (without needing root).
 */
function detectFirewallType(port) {
  const platform = process.platform;
  try {
    if (platform === "linux") {
      // Check ufw
      try {
        const active = execSync("systemctl is-active ufw 2>/dev/null", { encoding: "utf8", timeout: 3000 }).trim();
        if (active === "active") {
          return {
            firewall: "ufw",
            allowCmd: `sudo ufw allow ${port}/tcp comment "openfleet UI"`,
          };
        }
      } catch { /* not active */ }

      // Check firewalld
      try {
        const active = execSync("systemctl is-active firewalld 2>/dev/null", { encoding: "utf8", timeout: 3000 }).trim();
        if (active === "active") {
          return {
            firewall: "firewalld",
            allowCmd: `sudo firewall-cmd --add-port=${port}/tcp --permanent && sudo firewall-cmd --reload`,
          };
        }
      } catch { /* not active */ }

      // Fallback: iptables
      return {
        firewall: "iptables",
        allowCmd: `sudo iptables -I INPUT -p tcp --dport ${port} -j ACCEPT`,
      };
    }

    if (platform === "win32") {
      return {
        firewall: "windows",
        allowCmd: `netsh advfirewall firewall add rule name="openfleet UI" dir=in action=allow protocol=tcp localport=${port}`,
      };
    }

    if (platform === "darwin") {
      return {
        firewall: "pf",
        allowCmd: `echo 'pass in proto tcp from any to any port ${port}' | sudo pfctl -ef -`,
      };
    }
  } catch { /* detection failed */ }
  return null;
}

/**
 * Attempt to open a firewall port. Uses pkexec for GUI prompt, falls back to sudo.
 * Returns { success, message }.
 */
export async function openFirewallPort(port) {
  const state = firewallState || await checkFirewall(port);
  if (!state || !state.blocked) {
    return { success: true, message: "Port already allowed or no firewall detected." };
  }

  const { firewall, allowCmd } = state;

  // Try pkexec first (GUI sudo prompt — works on Linux desktop)
  if (process.platform === "linux") {
    // Build the actual command for pkexec (it doesn't support shell pipelines)
    let pkexecCmd;
    if (firewall === "ufw") {
      pkexecCmd = `pkexec ufw allow ${port}/tcp comment "openfleet UI"`;
    } else if (firewall === "firewalld") {
      pkexecCmd = `pkexec bash -c 'firewall-cmd --add-port=${port}/tcp --permanent && firewall-cmd --reload'`;
    } else {
      pkexecCmd = `pkexec iptables -I INPUT -p tcp --dport ${port} -j ACCEPT`;
    }

    try {
      execSync(pkexecCmd, { encoding: "utf8", timeout: 60000, stdio: "pipe" });
      // Re-check after opening
      firewallState = await checkFirewall(port);
      return { success: true, message: `Firewall rule added via ${firewall}.` };
    } catch (err) {
      // pkexec failed (user dismissed, not available, etc.)
      return {
        success: false,
        message: `Could not auto-open port. Run manually:\n\`${allowCmd}\``,
      };
    }
  }

  if (process.platform === "win32") {
    try {
      execSync(allowCmd, { encoding: "utf8", timeout: 30000, stdio: "pipe" });
      firewallState = await checkFirewall(port);
      return { success: true, message: "Windows firewall rule added." };
    } catch {
      return {
        success: false,
        message: `Could not auto-open port. Run as admin:\n\`${allowCmd}\``,
      };
    }
  }

  return {
    success: false,
    message: `Run manually:\n\`${allowCmd}\``,
  };
}

// ── Cloudflared tunnel for trusted TLS ──────────────────────────────

let tunnelUrl = null;
let tunnelProcess = null;

/** Return the tunnel URL (e.g. https://xxx.trycloudflare.com) or null. */
export function getTunnelUrl() {
  return tunnelUrl;
}

// ── Cloudflared binary auto-download ─────────────────────────────────

const CF_CACHE_DIR = resolve(__dirname, ".cache", "bin");
const CF_BIN_NAME = osPlatform() === "win32" ? "cloudflared.exe" : "cloudflared";
const CF_CACHED_PATH = resolve(CF_CACHE_DIR, CF_BIN_NAME);

/**
 * Get the cloudflared download URL for the current platform+arch.
 * Uses GitHub releases (no account needed).
 */
function getCloudflaredDownloadUrl() {
  const plat = osPlatform();
  const ar = osArch();
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download";
  if (plat === "linux") {
    if (ar === "arm64" || ar === "aarch64") return `${base}/cloudflared-linux-arm64`;
    return `${base}/cloudflared-linux-amd64`;
  }
  if (plat === "win32") {
    return `${base}/cloudflared-windows-amd64.exe`;
  }
  if (plat === "darwin") {
    if (ar === "arm64") return `${base}/cloudflared-darwin-arm64.tgz`;
    return `${base}/cloudflared-darwin-amd64.tgz`;
  }
  return null;
}

/**
 * Download a file from URL, following redirects (GitHub releases use 302).
 * Returns a promise that resolves when the file is fully written and closed.
 */
function downloadFile(url, destPath, maxRedirects = 5) {
  return new Promise((res, rej) => {
    if (maxRedirects <= 0) return rej(new Error("Too many redirects"));
    httpsGet(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return downloadFile(response.headers.location, destPath, maxRedirects - 1).then(res, rej);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return rej(new Error(`HTTP ${response.statusCode}`));
      }
      const stream = createWriteStream(destPath);
      response.pipe(stream);
      // Wait for 'close' not 'finish' — ensures file descriptor is fully released
      stream.on("close", () => res());
      stream.on("error", (err) => {
        stream.close();
        rej(err);
      });
    }).on("error", rej);
  });
}

/**
 * Find cloudflared binary — checks system PATH first, then cached download.
 * If not found anywhere and mode=auto, auto-downloads to .cache/bin/.
 */
async function findCloudflared() {
  // 1. Check system PATH
  try {
    const cmd = osPlatform() === "win32"
      ? "where cloudflared 2>nul"
      : "which cloudflared 2>/dev/null";
    const found = execSync(cmd, { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (found) return found.split(/\r?\n/)[0]; // `where` may return multiple lines
  } catch { /* not on PATH */ }

  // 2. Check cached binary
  if (existsSync(CF_CACHED_PATH)) {
    return CF_CACHED_PATH;
  }

  // 3. Auto-download
  const dlUrl = getCloudflaredDownloadUrl();
  if (!dlUrl) {
    console.warn("[telegram-ui] cloudflared: unsupported platform/arch for auto-download");
    return null;
  }

  console.log("[telegram-ui] cloudflared not found — auto-downloading...");
  try {
    mkdirSync(CF_CACHE_DIR, { recursive: true });
    await downloadFile(dlUrl, CF_CACHED_PATH);
    if (osPlatform() !== "win32") {
      chmodSync(CF_CACHED_PATH, 0o755);
      // Small delay to ensure OS fully releases file locks after chmod
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(`[telegram-ui] cloudflared downloaded to ${CF_CACHED_PATH}`);
    return CF_CACHED_PATH;
  } catch (err) {
    console.warn(`[telegram-ui] cloudflared auto-download failed: ${err.message}`);
    return null;
  }
}

/**
 * Start a cloudflared tunnel for the given local URL.
 *
 * Two modes:
 * 1. **Quick tunnel** (default): Free, no account, random *.trycloudflare.com domain.
 *    Pros: Zero setup. Cons: URL changes on each restart.
 * 2. **Named tunnel**: Persistent custom domain (e.g., myapp.example.com).
 *    Pros: Stable URL, custom domain. Cons: Requires cloudflare account + tunnel setup.
 *
 * Named tunnel setup:
 *   1. Create a tunnel: `cloudflared tunnel create <name>`
 *   2. Create DNS record: `cloudflared tunnel route dns <name> <subdomain.yourdomain.com>`
 *   3. Set env vars:
 *      - CLOUDFLARE_TUNNEL_NAME=<name>
 *      - CLOUDFLARE_TUNNEL_CREDENTIALS=/path/to/<tunnel-id>.json
 *
 * Returns the assigned public URL or null on failure.
 */
async function startTunnel(localPort) {
  const tunnelMode = (process.env.TELEGRAM_UI_TUNNEL || "auto").toLowerCase();
  if (tunnelMode === "disabled" || tunnelMode === "off" || tunnelMode === "0") {
    console.log("[telegram-ui] tunnel disabled via TELEGRAM_UI_TUNNEL=disabled");
    return null;
  }

  const cfBin = await findCloudflared();
  if (!cfBin) {
    if (tunnelMode === "auto") {
      console.log(
        "[telegram-ui] cloudflared unavailable — Telegram Mini App will use self-signed cert (may be rejected by Telegram webview).",
      );
      return null;
    }
    console.warn("[telegram-ui] cloudflared not found but TELEGRAM_UI_TUNNEL=cloudflared requested");
    return null;
  }

  // Check for named tunnel configuration (persistent URL)
  const namedTunnel = process.env.CLOUDFLARE_TUNNEL_NAME || process.env.CF_TUNNEL_NAME;
  const tunnelCreds = process.env.CLOUDFLARE_TUNNEL_CREDENTIALS || process.env.CF_TUNNEL_CREDENTIALS;

  if (namedTunnel && tunnelCreds) {
    return startNamedTunnel(cfBin, namedTunnel, tunnelCreds, localPort);
  }

  // Fall back to quick tunnel (random URL, no persistence)
  return startQuickTunnel(cfBin, localPort);
}

/**
 * Spawn cloudflared with ETXTBSY retry (race condition after fresh download).
 * Returns the child process or throws after max retries.
 */
function spawnCloudflared(cfBin, args, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return spawn(cfBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });
    } catch (err) {
      if (err.code === "ETXTBSY" && attempt < maxRetries) {
        // File still locked from download — wait and retry
        const delayMs = attempt * 100;
        console.warn(`[telegram-ui] spawn ETXTBSY (attempt ${attempt}/${maxRetries}) — retrying in ${delayMs}ms`);
        // Sync sleep (rare case, acceptable here)
        execSync(`sleep 0.${delayMs / 100}`, { stdio: "ignore" });
        continue;
      }
      throw err;
    }
  }
  throw new Error("spawn failed after retries");
}

/**
 * Start a cloudflared **named tunnel** with persistent URL.
 * Requires: cloudflared tunnel create + DNS setup.
 */
async function startNamedTunnel(cfBin, tunnelName, credentialsPath, localPort) {
  if (!existsSync(credentialsPath)) {
    console.warn(`[telegram-ui] named tunnel credentials not found: ${credentialsPath}`);
    console.warn("[telegram-ui] falling back to quick tunnel (random URL)");
    return startQuickTunnel(cfBin, localPort);
  }

  // Named tunnels require config file with ingress rules.
  // We'll create a temporary config on the fly.
  const configPath = resolve(__dirname, ".cache", "cloudflared-config.yml");
  mkdirSync(dirname(configPath), { recursive: true });

  const configYaml = `
tunnel: ${tunnelName}
credentials-file: ${credentialsPath}

ingress:
  - hostname: "*"
    service: https://localhost:${localPort}
    originRequest:
      noTLSVerify: true
  - service: http_status:404
`.trim();

  writeFileSync(configPath, configYaml, "utf8");

  // Read the tunnel ID from credentials to construct the public URL
  let publicUrl = null;
  try {
    const creds = JSON.parse(readFileSync(credentialsPath, "utf8"));
    const tunnelId = creds.TunnelID || creds.tunnel_id;
    if (tunnelId) {
      publicUrl = `https://${tunnelId}.cfargotunnel.com`;
    }
  } catch (err) {
    console.warn(`[telegram-ui] failed to parse tunnel credentials: ${err.message}`);
  }

  return new Promise((resolvePromise) => {
    const args = ["tunnel", "--config", configPath, "run"];
    console.log(`[telegram-ui] starting named tunnel: ${tunnelName} → https://localhost:${localPort}`);

    let child;
    try {
      child = spawnCloudflared(cfBin, args);
    } catch (err) {
      console.warn(`[telegram-ui] named tunnel spawn failed: ${err.message}`);
      return resolvePromise(null);
    }

    let resolved = false;
    let output = "";
    // Named tunnels emit "Connection <UUID> registered" when ready
    const readyPattern = /Connection [a-f0-9-]+ registered/;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.warn("[telegram-ui] named tunnel timed out after 60s");
        resolvePromise(null);
      }
    }, 60_000);

    function parseOutput(chunk) {
      output += chunk;
      if (readyPattern.test(output) && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        tunnelUrl = publicUrl;
        tunnelProcess = child;
        console.log(`[telegram-ui] named tunnel active: ${publicUrl || tunnelName}`);
        resolvePromise(publicUrl);
      }
    }

    child.stdout.on("data", (d) => parseOutput(d.toString()));
    child.stderr.on("data", (d) => parseOutput(d.toString()));

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.warn(`[telegram-ui] named tunnel failed: ${err.message}`);
        resolvePromise(null);
      }
    });

    child.on("exit", (code) => {
      tunnelProcess = null;
      tunnelUrl = null;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.warn(`[telegram-ui] named tunnel exited with code ${code}`);
        resolvePromise(null);
      } else if (code !== 0 && code !== null) {
        console.warn(`[telegram-ui] named tunnel exited (code ${code})`);
      }
    });
  });
}

/**
 * Start a cloudflared **quick tunnel** (random *.trycloudflare.com URL).
 * Quick tunnels are free, require no account, but the URL changes on each restart.
 */
async function startQuickTunnel(cfBin, localPort) {
  return new Promise((resolvePromise) => {
    const localUrl = `https://localhost:${localPort}`;
    const args = ["tunnel", "--url", localUrl, "--no-autoupdate", "--no-tls-verify"];
    console.log(`[telegram-ui] starting quick tunnel → ${localUrl}`);

    let child;
    try {
      child = spawnCloudflared(cfBin, args);
    } catch (err) {
      console.warn(`[telegram-ui] quick tunnel spawn failed: ${err.message}`);
      return resolvePromise(null);
    }

    let resolved = false;
    let output = "";
    const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.warn("[telegram-ui] quick tunnel timed out after 30s");
        resolvePromise(null);
      }
    }, 30_000);

    function parseOutput(chunk) {
      output += chunk;
      const match = output.match(urlPattern);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        tunnelUrl = match[0];
        tunnelProcess = child;
        console.log(`[telegram-ui] quick tunnel active: ${tunnelUrl}`);
        resolvePromise(tunnelUrl);
      }
    }

    child.stdout.on("data", (d) => parseOutput(d.toString()));
    child.stderr.on("data", (d) => parseOutput(d.toString()));

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.warn(`[telegram-ui] quick tunnel failed: ${err.message}`);
        resolvePromise(null);
      }
    });

    child.on("exit", (code) => {
      tunnelProcess = null;
      tunnelUrl = null;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.warn(`[telegram-ui] quick tunnel exited with code ${code}`);
        resolvePromise(null);
      } else if (code !== 0 && code !== null) {
        console.warn(`[telegram-ui] quick tunnel exited (code ${code})`);
      }
    });
  });
}

/** Stop the tunnel if running. */
export function stopTunnel() {
  if (tunnelProcess) {
    try {
      tunnelProcess.kill("SIGTERM");
    } catch { /* ignore */ }
    tunnelProcess = null;
    tunnelUrl = null;
  }
}

export function injectUiDependencies(deps = {}) {
  uiDeps = { ...uiDeps, ...deps };
}

export function getTelegramUiUrl() {
  const explicit =
    process.env.TELEGRAM_UI_BASE_URL || process.env.TELEGRAM_WEBAPP_URL;
  if (explicit) {
    // Auto-upgrade explicit HTTP URL to HTTPS when the server is running TLS
    if (uiServerTls && explicit.startsWith("http://")) {
      let upgraded = explicit.replace(/^http:\/\//, "https://");
      // Ensure the port is present (the explicit URL may omit it)
      try {
        const parsed = new URL(upgraded);
        if (!parsed.port && uiServer) {
          const actualPort = uiServer.address()?.port;
          if (actualPort) parsed.port = String(actualPort);
          upgraded = parsed.href;
        }
      } catch {
        // URL parse failed — use as-is
      }
      return upgraded.replace(/\/+$/, "");
    }
    return explicit.replace(/\/+$/, "");
  }
  return uiServerUrl;
}

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function textResponse(res, statusCode, body, contentType = "text/plain") {
  res.writeHead(statusCode, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const data = {};
  for (const [key, value] of params.entries()) {
    data[key] = value;
  }
  return data;
}

function validateInitData(initData, botToken) {
  if (!initData || !botToken) return false;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return false;
  params.delete("hash");
  const entries = Array.from(params.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const signature = createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");
  if (signature !== hash) return false;
  const authDate = Number(params.get("auth_date") || 0);
  if (Number.isFinite(authDate) && authDate > 0 && AUTH_MAX_AGE_SEC > 0) {
    const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - authDate);
    if (ageSec > AUTH_MAX_AGE_SEC) return false;
  }
  return true;
}

function parseCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.split("=");
    if (k.trim() === name) return rest.join("=").trim();
  }
  return "";
}

function checkSessionToken(req) {
  if (!sessionToken) return false;
  // Bearer header
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    const provided = Buffer.from(authHeader.slice(7));
    const expected = Buffer.from(sessionToken);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return true;
    }
  }
  // Cookie
  const cookieVal = parseCookie(req, "ve_session");
  if (cookieVal) {
    const provided = Buffer.from(cookieVal);
    const expected = Buffer.from(sessionToken);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true;
  }
  return false;
}

function requireAuth(req) {
  if (isAllowUnsafe()) return true;
  // Session token (browser access)
  if (checkSessionToken(req)) return true;
  // Telegram initData HMAC
  const initData =
    req.headers["x-telegram-initdata"] ||
    req.headers["x-telegram-init-data"] ||
    req.headers["x-telegram-init"] ||
    req.headers["x-telegram-webapp"] ||
    req.headers["x-telegram-webapp-data"] ||
    "";
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!initData) return false;
  return validateInitData(String(initData), token);
}

function requireWsAuth(req, url) {
  if (isAllowUnsafe()) return true;
  // Session token (query param or cookie)
  if (checkSessionToken(req)) return true;
  if (sessionToken) {
    const qTokenVal = url.searchParams.get("token") || "";
    if (qTokenVal) {
      const provided = Buffer.from(qTokenVal);
      const expected = Buffer.from(sessionToken);
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true;
    }
  }
  // Telegram initData HMAC
  const initData =
    req.headers["x-telegram-initdata"] ||
    req.headers["x-telegram-init-data"] ||
    req.headers["x-telegram-init"] ||
    url.searchParams.get("initData") ||
    "";
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!initData) return false;
  return validateInitData(String(initData), token);
}

function sendWsMessage(socket, payload) {
  try {
    if (socket?.readyState === 1) {
      socket.send(JSON.stringify(payload));
    }
  } catch {
    // best effort
  }
}

function broadcastUiEvent(channels, type, payload = {}) {
  const required = new Set(Array.isArray(channels) ? channels : [channels]);
  const message = {
    type,
    channels: Array.from(required),
    payload,
    ts: Date.now(),
  };
  for (const socket of wsClients) {
    const subscribed = socket.__channels || new Set(["*"]);
    const shouldSend =
      subscribed.has("*") ||
      Array.from(required).some((channel) => subscribed.has(channel));
    if (shouldSend) {
      sendWsMessage(socket, message);
    }
  }
}

/* ─── Log Streaming Helpers ─── */

/**
 * Resolve the log file path for a given logType and optional query.
 * Returns null if no matching file found.
 */
async function resolveLogPath(logType, query) {
  if (logType === "system") {
    const files = await readdir(logsDir).catch(() => []);
    const logFile = files.filter((f) => f.endsWith(".log")).sort().pop();
    return logFile ? resolve(logsDir, logFile) : null;
  }
  if (logType === "agent") {
    const files = await readdir(agentLogsDir).catch(() => []);
    let candidates = files.filter((f) => f.endsWith(".log")).sort().reverse();
    if (query) {
      const q = query.toLowerCase();
      const filtered = candidates.filter((f) => f.toLowerCase().includes(q));
      if (filtered.length) candidates = filtered;
    }
    return candidates.length ? resolve(agentLogsDir, candidates[0]) : null;
  }
  return null;
}

/**
 * Start streaming a log file to a socket. Uses polling (every 2s) to detect
 * new content. Handles file rotation and missing files gracefully.
 */
function startLogStream(socket, logType, query) {
  // Clean up any previous stream for this socket
  stopLogStream(socket);

  const streamState = { logType, query, filePath: null, offset: 0, pollTimer: null, active: true };
  socket.__logStream = streamState;

  async function poll() {
    if (!streamState.active) return;
    try {
      const filePath = await resolveLogPath(logType, query);
      if (!filePath || !existsSync(filePath)) return;

      // Detect file rotation (path changed or file shrank)
      const info = await stat(filePath).catch(() => null);
      if (!info) return;
      const size = info.size || 0;

      if (filePath !== streamState.filePath) {
        // New file or first poll — start from end to avoid dumping history
        streamState.filePath = filePath;
        streamState.offset = size;
        return;
      }

      if (size < streamState.offset) {
        // File was truncated/rotated — reset
        streamState.offset = 0;
      }

      if (size <= streamState.offset) return;

      // Read only new bytes
      const readLen = Math.min(size - streamState.offset, 512_000);
      const handle = await open(filePath, "r");
      try {
        const buffer = Buffer.alloc(readLen);
        await handle.read(buffer, 0, readLen, streamState.offset);
        streamState.offset += readLen;
        const text = buffer.toString("utf8");
        const lines = text.split("\n").filter(Boolean);
        if (lines.length > 0) {
          sendWsMessage(socket, { type: "log-lines", lines });
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Ignore transient errors — next poll will retry
    }
  }

  // First poll immediately, then every 2 seconds
  poll();
  streamState.pollTimer = setInterval(poll, 2000);
}

/**
 * Stop streaming logs for a given socket.
 */
function stopLogStream(socket) {
  const stream = socket.__logStream;
  if (stream) {
    stream.active = false;
    if (stream.pollTimer) clearInterval(stream.pollTimer);
    socket.__logStream = null;
  }
}

/* ─── Server-side Heartbeat ─── */

function startWsHeartbeat() {
  if (wsHeartbeatTimer) clearInterval(wsHeartbeatTimer);
  wsHeartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const socket of wsClients) {
      // Check for missed pongs (2 consecutive pings = 60s)
      if (socket.__lastPing && !socket.__lastPong) {
        socket.__missedPongs = (socket.__missedPongs || 0) + 1;
      } else if (socket.__lastPing && socket.__lastPong && socket.__lastPong < socket.__lastPing) {
        socket.__missedPongs = (socket.__missedPongs || 0) + 1;
      } else {
        socket.__missedPongs = 0;
      }

      if ((socket.__missedPongs || 0) >= 2) {
        try { socket.close(); } catch { /* noop */ }
        wsClients.delete(socket);
        stopLogStream(socket);
        continue;
      }

      // Send ping
      socket.__lastPing = now;
      sendWsMessage(socket, { type: "ping", ts: now });
    }
  }, 30_000);
}

function stopWsHeartbeat() {
  if (wsHeartbeatTimer) {
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
  }
}

function parseBooleanEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function getGitHubWebhookPath() {
  return (
    process.env.GITHUB_PROJECT_WEBHOOK_PATH ||
    "/api/webhooks/github/project-sync"
  );
}

function getGitHubWebhookSecret() {
  return (
    process.env.GITHUB_PROJECT_WEBHOOK_SECRET ||
    process.env.GITHUB_WEBHOOK_SECRET ||
    ""
  );
}

function shouldRequireGitHubWebhookSignature() {
  const secret = getGitHubWebhookSecret();
  return parseBooleanEnv(
    process.env.GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE,
    Boolean(secret),
  );
}

function getWebhookFailureAlertThreshold() {
  return Math.max(
    1,
    Number(process.env.GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD || 3),
  );
}

async function emitProjectSyncAlert(message, context = {}) {
  projectSyncWebhookMetrics.alertsTriggered++;
  console.warn(
    `[project-sync-webhook] alert: ${message} ${JSON.stringify(context)}`,
  );
  if (typeof uiDeps.onProjectSyncAlert === "function") {
    try {
      await uiDeps.onProjectSyncAlert({
        message,
        context,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // best effort
    }
  }
}

function verifyGitHubWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret) return false;
  const expectedDigest = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const providedRaw = String(signatureHeader || "");
  if (!providedRaw.startsWith("sha256=")) return false;
  const providedDigest = providedRaw.slice("sha256=".length).trim();
  if (!providedDigest || providedDigest.length !== expectedDigest.length) {
    return false;
  }
  const expected = Buffer.from(expectedDigest, "utf8");
  const provided = Buffer.from(providedDigest, "utf8");
  return timingSafeEqual(expected, provided);
}

function extractIssueNumberFromWebhook(payload) {
  const item = payload?.projects_v2_item || {};
  const content = item.content || payload?.content || {};
  const candidates = [
    item.content_number,
    item.issue_number,
    content.number,
    content.issue?.number,
    payload?.issue?.number,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isInteger(numeric) && numeric > 0) {
      return String(numeric);
    }
  }
  const urlCandidates = [
    item.content_url,
    item.url,
    content.url,
    payload?.issue?.html_url,
    payload?.issue?.url,
  ];
  for (const value of urlCandidates) {
    const match = String(value || "").match(/\/issues\/(\d+)(?:$|[/?#])/);
    if (match) return match[1];
  }
  return null;
}

export function getProjectSyncWebhookMetrics() {
  return { ...projectSyncWebhookMetrics };
}

export function resetProjectSyncWebhookMetrics() {
  for (const key of Object.keys(projectSyncWebhookMetrics)) {
    if (
      key === "lastEventAt" ||
      key === "lastSuccessAt" ||
      key === "lastFailureAt" ||
      key === "lastError"
    ) {
      projectSyncWebhookMetrics[key] = null;
      continue;
    }
    projectSyncWebhookMetrics[key] = 0;
  }
}

async function readRawBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      size += buf.length;
      if (size > 1_000_000) {
        rejectBody(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", rejectBody);
  });
}

async function handleGitHubProjectWebhook(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type,X-GitHub-Event,X-Hub-Signature-256,X-GitHub-Delivery",
    });
    res.end();
    return;
  }
  if (req.method !== "POST") {
    jsonResponse(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  projectSyncWebhookMetrics.received++;
  projectSyncWebhookMetrics.lastEventAt = new Date().toISOString();

  const deliveryId = String(req.headers["x-github-delivery"] || "");
  const eventType = String(req.headers["x-github-event"] || "").toLowerCase();
  const secret = getGitHubWebhookSecret();
  const requireSignature = shouldRequireGitHubWebhookSignature();

  try {
    const rawBody = await readRawBody(req);
    if (requireSignature) {
      const signature = req.headers["x-hub-signature-256"];
      if (
        !verifyGitHubWebhookSignature(rawBody, signature, secret)
      ) {
        projectSyncWebhookMetrics.invalidSignature++;
        projectSyncWebhookMetrics.failed++;
        projectSyncWebhookMetrics.consecutiveFailures++;
        projectSyncWebhookMetrics.lastFailureAt = new Date().toISOString();
        projectSyncWebhookMetrics.lastError = "invalid webhook signature";
        const threshold = getWebhookFailureAlertThreshold();
        if (
          projectSyncWebhookMetrics.consecutiveFailures % threshold ===
          0
        ) {
          await emitProjectSyncAlert(
            `GitHub project webhook signature failures: ${projectSyncWebhookMetrics.consecutiveFailures}`,
            { deliveryId, eventType },
          );
        }
        jsonResponse(res, 401, { ok: false, error: "Invalid webhook signature" });
        return;
      }
    }

    let payload = {};
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      projectSyncWebhookMetrics.failed++;
      projectSyncWebhookMetrics.consecutiveFailures++;
      projectSyncWebhookMetrics.lastFailureAt = new Date().toISOString();
      projectSyncWebhookMetrics.lastError = "invalid JSON payload";
      jsonResponse(res, 400, { ok: false, error: "Invalid JSON payload" });
      return;
    }

    if (eventType !== "projects_v2_item") {
      projectSyncWebhookMetrics.ignored++;
      projectSyncWebhookMetrics.processed++;
      jsonResponse(res, 202, {
        ok: true,
        ignored: true,
        reason: `Unsupported event: ${eventType || "unknown"}`,
      });
      return;
    }

    const syncEngine = uiDeps.getSyncEngine?.() || null;
    if (!syncEngine) {
      projectSyncWebhookMetrics.failed++;
      projectSyncWebhookMetrics.consecutiveFailures++;
      projectSyncWebhookMetrics.lastFailureAt = new Date().toISOString();
      projectSyncWebhookMetrics.lastError = "sync engine unavailable";
      const threshold = getWebhookFailureAlertThreshold();
      if (
        projectSyncWebhookMetrics.consecutiveFailures % threshold ===
        0
      ) {
        await emitProjectSyncAlert(
          `GitHub project webhook sync failures: ${projectSyncWebhookMetrics.consecutiveFailures}`,
          { deliveryId, reason: "sync engine unavailable" },
        );
      }
      jsonResponse(res, 503, { ok: false, error: "Sync engine unavailable" });
      return;
    }

    const beforeRateLimitEvents =
      Number(syncEngine.getStatus?.()?.metrics?.rateLimitEvents || 0);
    const issueNumber = extractIssueNumberFromWebhook(payload);
    const action = String(payload?.action || "");

    projectSyncWebhookMetrics.syncTriggered++;
    if (issueNumber && typeof syncEngine.syncTask === "function") {
      await syncEngine.syncTask(issueNumber);
      console.log(
        `[project-sync-webhook] delivery=${deliveryId} action=${action} task=${issueNumber} synced`,
      );
    } else if (typeof syncEngine.fullSync === "function") {
      await syncEngine.fullSync();
      console.log(
        `[project-sync-webhook] delivery=${deliveryId} action=${action} full-sync triggered`,
      );
    } else {
      throw new Error("sync engine does not expose syncTask/fullSync");
    }

    const afterRateLimitEvents =
      Number(syncEngine.getStatus?.()?.metrics?.rateLimitEvents || 0);
    if (afterRateLimitEvents > beforeRateLimitEvents) {
      projectSyncWebhookMetrics.rateLimitObserved +=
        afterRateLimitEvents - beforeRateLimitEvents;
    }
    projectSyncWebhookMetrics.processed++;
    projectSyncWebhookMetrics.syncSuccess++;
    projectSyncWebhookMetrics.consecutiveFailures = 0;
    projectSyncWebhookMetrics.lastSuccessAt = new Date().toISOString();
    projectSyncWebhookMetrics.lastError = null;
    jsonResponse(res, 202, {
      ok: true,
      deliveryId,
      eventType,
      action,
      issueNumber,
      synced: true,
    });
  } catch (err) {
    projectSyncWebhookMetrics.failed++;
    projectSyncWebhookMetrics.syncFailure++;
    projectSyncWebhookMetrics.consecutiveFailures++;
    projectSyncWebhookMetrics.lastFailureAt = new Date().toISOString();
    projectSyncWebhookMetrics.lastError = err.message;
    const threshold = getWebhookFailureAlertThreshold();
    if (
      projectSyncWebhookMetrics.consecutiveFailures % threshold === 0
    ) {
      await emitProjectSyncAlert(
        `GitHub project webhook sync failures: ${projectSyncWebhookMetrics.consecutiveFailures}`,
        { deliveryId, eventType, error: err.message },
      );
    }
    console.warn(
      `[project-sync-webhook] delivery=${deliveryId} failed: ${err.message}`,
    );
    jsonResponse(res, 500, { ok: false, error: err.message });
  }
}

async function readStatusSnapshot() {
  try {
    const raw = await readFile(statusPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function runGit(args, timeoutMs = 10000) {
  return execSync(`git ${args}`, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
  }).trim();
}

async function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        rejectBody(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolveBody(null);
      try {
        resolveBody(JSON.parse(data));
      } catch (err) {
        rejectBody(err);
      }
    });
  });
}

function normalizeTagsInput(input) {
  if (!input) return [];
  const values = Array.isArray(input)
    ? input
    : String(input || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
  const seen = new Set();
  const tags = [];
  for (const value of values) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

function normalizeBranchInput(input) {
  const trimmed = String(input ?? "").trim();
  return trimmed ? trimmed : null;
}

async function getLatestLogTail(lineCount) {
  const files = await readdir(logsDir).catch(() => []);
  const logFile = files
    .filter((f) => f.endsWith(".log"))
    .sort()
    .pop();
  if (!logFile) return { file: null, lines: [] };
  const logPath = resolve(logsDir, logFile);
  const content = await readFile(logPath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  const tail = lines.slice(-lineCount);
  return { file: logFile, lines: tail };
}

async function tailFile(filePath, lineCount, maxBytes = 1_000_000) {
  const info = await stat(filePath);
  const size = info.size || 0;
  const start = Math.max(0, size - maxBytes);
  const length = Math.max(0, size - start);
  const handle = await open(filePath, "r");
  const buffer = Buffer.alloc(length);
  try {
    if (length > 0) {
      await handle.read(buffer, 0, length, start);
    }
  } finally {
    await handle.close();
  }
  const text = buffer.toString("utf8");
  const lines = text.split("\n").filter(Boolean);
  const tail = lines.slice(-lineCount);
  return {
    file: filePath,
    lines: tail,
    size,
    truncated: size > maxBytes,
  };
}

async function listAgentLogFiles(query = "", limit = 60) {
  const entries = [];
  const files = await readdir(agentLogsDir).catch(() => []);
  for (const name of files) {
    if (!name.endsWith(".log")) continue;
    if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
    try {
      const info = await stat(resolve(agentLogsDir, name));
      entries.push({
        name,
        size: info.size,
        mtime:
          info.mtime?.toISOString?.() || new Date(info.mtime).toISOString(),
        mtimeMs: info.mtimeMs,
      });
    } catch {
      // ignore
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.slice(0, limit);
}

async function ensurePresenceLoaded() {
  const loaded = await loadWorkspaceRegistry().catch(() => null);
  const registry = loaded?.registry || loaded || null;
  const localWorkspace = registry
    ? getLocalWorkspace(registry, process.env.VE_WORKSPACE_ID || "")
    : null;
  await initPresence({ repoRoot, localWorkspace });
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Telegram-InitData",
    });
    res.end();
    return;
  }

  if (!requireAuth(req)) {
    jsonResponse(res, 401, {
      ok: false,
      error: "Unauthorized. Telegram init data missing or invalid.",
    });
    return;
  }

  if (req.method === "POST" && !checkRateLimit(req, 30)) {
    jsonResponse(res, 429, { ok: false, error: "Rate limit exceeded. Try again later." });
    return;
  }

  const path = url.pathname;
  if (path === "/api/status") {
    const data = await readStatusSnapshot();
    jsonResponse(res, 200, { ok: true, data });
    return;
  }

  if (path === "/api/executor") {
    const executor = uiDeps.getInternalExecutor?.();
    const mode = uiDeps.getExecutorMode?.() || "internal";
    jsonResponse(res, 200, {
      ok: true,
      data: executor?.getStatus?.() || null,
      mode,
      paused: executor?.isPaused?.() || false,
    });
    return;
  }

  if (path === "/api/executor/pause") {
    const executor = uiDeps.getInternalExecutor?.();
    if (!executor) {
      jsonResponse(res, 400, {
        ok: false,
        error: "Internal executor not enabled.",
      });
      return;
    }
    executor.pause();
    jsonResponse(res, 200, { ok: true, paused: true });
    broadcastUiEvent(["executor", "overview", "agents"], "invalidate", {
      reason: "executor-paused",
    });
    return;
  }

  if (path === "/api/executor/resume") {
    const executor = uiDeps.getInternalExecutor?.();
    if (!executor) {
      jsonResponse(res, 400, {
        ok: false,
        error: "Internal executor not enabled.",
      });
      return;
    }
    executor.resume();
    jsonResponse(res, 200, { ok: true, paused: false });
    broadcastUiEvent(["executor", "overview", "agents"], "invalidate", {
      reason: "executor-resumed",
    });
    return;
  }

  if (path === "/api/executor/maxparallel") {
    try {
      const executor = uiDeps.getInternalExecutor?.();
      if (!executor) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Internal executor not enabled.",
        });
        return;
      }
      const body = await readJsonBody(req);
      const value = Number(body?.value ?? body?.maxParallel);
      if (!Number.isFinite(value) || value < 0 || value > 20) {
        jsonResponse(res, 400, {
          ok: false,
          error: "value must be between 0 and 20",
        });
        return;
      }
      executor.maxParallel = value;
      if (value === 0) {
        executor.pause();
      } else if (executor.isPaused?.()) {
        executor.resume();
      }
      jsonResponse(res, 200, { ok: true, maxParallel: executor.maxParallel });
      broadcastUiEvent(["executor", "overview", "agents"], "invalidate", {
        reason: "executor-maxparallel",
        maxParallel: executor.maxParallel,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/projects") {
    try {
      const adapter = getKanbanAdapter();
      const projects = await adapter.listProjects();
      jsonResponse(res, 200, { ok: true, data: projects });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks") {
    const status = url.searchParams.get("status") || "";
    const projectId = url.searchParams.get("project") || "";
    const page = Math.max(0, Number(url.searchParams.get("page") || "0"));
    const pageSize = Math.min(
      50,
      Math.max(5, Number(url.searchParams.get("pageSize") || "15")),
    );
    try {
      const adapter = getKanbanAdapter();
      const projects = await adapter.listProjects();
      const activeProject =
        projectId || projects[0]?.id || projects[0]?.project_id || "";
      if (!activeProject) {
        jsonResponse(res, 200, {
          ok: true,
          data: [],
          page,
          pageSize,
          total: 0,
        });
        return;
      }
      const tasks = await adapter.listTasks(
        activeProject,
        status ? { status } : {},
      );
      const search = (url.searchParams.get("search") || "").trim().toLowerCase();
      const filtered = search
        ? tasks.filter((t) => {
            const hay = `${t.title || ""} ${t.description || ""} ${t.id || ""}`.toLowerCase();
            return hay.includes(search);
          })
        : tasks;
      const total = filtered.length;
      const start = page * pageSize;
      const slice = filtered.slice(start, start + pageSize);
      jsonResponse(res, 200, {
        ok: true,
        data: slice,
        page,
        pageSize,
        total,
        projectId: activeProject,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/detail") {
    try {
      const taskId =
        url.searchParams.get("taskId") || url.searchParams.get("id") || "";
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId required" });
        return;
      }
      const adapter = getKanbanAdapter();
      const task = await adapter.getTask(taskId);
      jsonResponse(res, 200, { ok: true, data: task || null });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/start") {
    try {
      const body = await readJsonBody(req);
      const taskId = body?.taskId || body?.id;
      const sdk = typeof body?.sdk === "string" ? body.sdk.trim() : "";
      const model = typeof body?.model === "string" ? body.model.trim() : "";
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId is required" });
        return;
      }
      const executor = uiDeps.getInternalExecutor?.();
      if (!executor) {
        jsonResponse(res, 400, {
          ok: false,
          error:
            "Internal executor not enabled. Set EXECUTOR_MODE=internal or hybrid.",
        });
        return;
      }
      const adapter = getKanbanAdapter();
      const task = await adapter.getTask(taskId);
      if (!task) {
        jsonResponse(res, 404, { ok: false, error: "Task not found." });
        return;
      }
      try {
        if (typeof adapter.updateTaskStatus === "function") {
          await adapter.updateTaskStatus(taskId, "inprogress");
        } else if (typeof adapter.updateTask === "function") {
          await adapter.updateTask(taskId, { status: "inprogress" });
        }
      } catch (err) {
        console.warn(
          `[telegram-ui] failed to mark task ${taskId} inprogress: ${err.message}`,
        );
      }
      executor.executeTask(task, {
        ...(sdk ? { sdk } : {}),
        ...(model ? { model } : {}),
      }).catch((error) => {
        console.warn(
          `[telegram-ui] failed to execute task ${taskId}: ${error.message}`,
        );
      });
      jsonResponse(res, 200, { ok: true, taskId });
      broadcastUiEvent(
        ["tasks", "overview", "executor", "agents"],
        "invalidate",
        {
          reason: "task-started",
          taskId,
        },
      );
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/update") {
    try {
      const body = await readJsonBody(req);
      const taskId = body?.taskId || body?.id;
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId required" });
        return;
      }
      const adapter = getKanbanAdapter();
      const tagsProvided = body && Object.prototype.hasOwnProperty.call(body, "tags");
      const tags = tagsProvided ? normalizeTagsInput(body?.tags) : undefined;
      const draftProvided = body && Object.prototype.hasOwnProperty.call(body, "draft");
      const baseBranchProvided =
        body &&
        (Object.prototype.hasOwnProperty.call(body, "baseBranch") ||
          Object.prototype.hasOwnProperty.call(body, "base_branch"));
      const baseBranch = baseBranchProvided
        ? normalizeBranchInput(body?.baseBranch ?? body?.base_branch)
        : undefined;
      const patch = {
        status: body?.status,
        title: body?.title,
        description: body?.description,
        priority: body?.priority,
        ...(tagsProvided ? { tags } : {}),
        ...(draftProvided ? { draft: Boolean(body?.draft) } : {}),
        ...(baseBranchProvided ? { baseBranch } : {}),
      };
      const hasPatch = Object.values(patch).some(
        (value) => typeof value === "string" && value.trim(),
      );
      const hasTags = Array.isArray(patch.tags);
      const hasDraft = typeof patch.draft === "boolean";
      const hasBaseBranch = baseBranchProvided;
      if (!hasPatch && !hasTags && !hasDraft && !hasBaseBranch) {
        jsonResponse(res, 400, {
          ok: false,
          error: "No update fields provided",
        });
        return;
      }
      const updated =
        typeof adapter.updateTask === "function"
          ? await adapter.updateTask(taskId, patch)
          : await adapter.updateTaskStatus(taskId, patch.status);
      jsonResponse(res, 200, { ok: true, data: updated });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "task-updated",
        taskId,
        status: updated?.status || patch.status || null,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/edit") {
    try {
      const body = await readJsonBody(req);
      const taskId = body?.taskId || body?.id;
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId required" });
        return;
      }
      const adapter = getKanbanAdapter();
      const tagsProvided = body && Object.prototype.hasOwnProperty.call(body, "tags");
      const tags = tagsProvided ? normalizeTagsInput(body?.tags) : undefined;
      const draftProvided = body && Object.prototype.hasOwnProperty.call(body, "draft");
      const baseBranchProvided =
        body &&
        (Object.prototype.hasOwnProperty.call(body, "baseBranch") ||
          Object.prototype.hasOwnProperty.call(body, "base_branch"));
      const baseBranch = baseBranchProvided
        ? normalizeBranchInput(body?.baseBranch ?? body?.base_branch)
        : undefined;
      const patch = {
        title: body?.title,
        description: body?.description,
        priority: body?.priority,
        status: body?.status,
        ...(tagsProvided ? { tags } : {}),
        ...(draftProvided ? { draft: Boolean(body?.draft) } : {}),
        ...(baseBranchProvided ? { baseBranch } : {}),
      };
      const hasPatch = Object.values(patch).some(
        (value) => typeof value === "string" && value.trim(),
      );
      const hasTags = Array.isArray(patch.tags);
      const hasDraft = typeof patch.draft === "boolean";
      const hasBaseBranch = baseBranchProvided;
      if (!hasPatch && !hasTags && !hasDraft && !hasBaseBranch) {
        jsonResponse(res, 400, {
          ok: false,
          error: "No edit fields provided",
        });
        return;
      }
      const updated =
        typeof adapter.updateTask === "function"
          ? await adapter.updateTask(taskId, patch)
          : await adapter.updateTaskStatus(taskId, patch.status);
      jsonResponse(res, 200, { ok: true, data: updated });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "task-edited",
        taskId,
        status: updated?.status || patch.status || null,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/create") {
    try {
      const body = await readJsonBody(req);
      const title = body?.title;
      if (!title || !String(title).trim()) {
        jsonResponse(res, 400, { ok: false, error: "title is required" });
        return;
      }
      const projectId = body?.project || "";
      const adapter = getKanbanAdapter();
      const tags = normalizeTagsInput(body?.tags);
      const wantsDraft = Boolean(body?.draft) || body?.status === "draft";
      const baseBranch = normalizeBranchInput(body?.baseBranch ?? body?.base_branch);
      const taskData = {
        title: String(title).trim(),
        description: body?.description || "",
        status: body?.status || (wantsDraft ? "draft" : "todo"),
        priority: body?.priority || undefined,
        ...(tags.length ? { tags } : {}),
        ...(tags.length ? { labels: tags } : {}),
        ...(baseBranch ? { baseBranch } : {}),
        meta: {
          ...(tags.length ? { tags } : {}),
          ...(wantsDraft ? { draft: true } : {}),
          ...(baseBranch ? { base_branch: baseBranch, baseBranch } : {}),
        },
      };
      const created = await adapter.createTask(projectId, taskData);
      jsonResponse(res, 200, { ok: true, data: created });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "task-created",
        taskId: created?.id || null,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/logs") {
    const lines = Math.min(
      1000,
      Math.max(10, Number(url.searchParams.get("lines") || "200")),
    );
    try {
      const tail = await getLatestLogTail(lines);
      jsonResponse(res, 200, { ok: true, data: tail });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/threads") {
    try {
      const threads = getActiveThreads();
      jsonResponse(res, 200, { ok: true, data: threads });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/worktrees") {
    try {
      const worktrees = listActiveWorktrees();
      const stats = await getWorktreeStats();
      jsonResponse(res, 200, { ok: true, data: worktrees, stats });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/worktrees/prune") {
    try {
      const result = await pruneStaleWorktrees({ actor: "telegram-ui" });
      jsonResponse(res, 200, { ok: true, data: result });
      broadcastUiEvent(["worktrees"], "invalidate", {
        reason: "worktrees-pruned",
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/worktrees/release") {
    try {
      const body = await readJsonBody(req);
      const taskKey = body?.taskKey || body?.key;
      const branch = body?.branch;
      let released = null;
      if (taskKey) {
        released = await releaseWorktree(taskKey);
      } else if (branch) {
        released = await releaseWorktreeByBranch(branch);
      } else {
        jsonResponse(res, 400, {
          ok: false,
          error: "taskKey or branch required",
        });
        return;
      }
      jsonResponse(res, 200, { ok: true, data: released });
      broadcastUiEvent(["worktrees"], "invalidate", {
        reason: "worktree-released",
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/presence") {
    try {
      await ensurePresenceLoaded();
      const instances = listActiveInstances({ ttlMs: PRESENCE_TTL_MS });
      const coordinator = selectCoordinator({ ttlMs: PRESENCE_TTL_MS });
      jsonResponse(res, 200, { ok: true, data: { instances, coordinator } });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/shared-workspaces") {
    try {
      const registry = await loadSharedWorkspaceRegistry();
      const sweep = await sweepExpiredLeases({
        registry,
        actor: "telegram-ui",
      });
      const availability = getSharedAvailabilityMap(sweep.registry);
      jsonResponse(res, 200, {
        ok: true,
        data: sweep.registry,
        availability,
        expired: sweep.expired || [],
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/shared-workspaces/claim") {
    try {
      const body = await readJsonBody(req);
      const workspaceId = body?.workspaceId || body?.id;
      if (!workspaceId) {
        jsonResponse(res, 400, { ok: false, error: "workspaceId required" });
        return;
      }
      const result = await claimSharedWorkspace({
        workspaceId,
        owner: body?.owner,
        ttlMinutes: body?.ttlMinutes,
        note: body?.note,
        actor: "telegram-ui",
      });
      if (result.error) {
        jsonResponse(res, 400, { ok: false, error: result.error });
        return;
      }
      jsonResponse(res, 200, {
        ok: true,
        data: result.workspace,
        lease: result.lease,
      });
      broadcastUiEvent(["workspaces"], "invalidate", {
        reason: "workspace-claimed",
        workspaceId,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/shared-workspaces/release") {
    try {
      const body = await readJsonBody(req);
      const workspaceId = body?.workspaceId || body?.id;
      if (!workspaceId) {
        jsonResponse(res, 400, { ok: false, error: "workspaceId required" });
        return;
      }
      const result = await releaseSharedWorkspace({
        workspaceId,
        owner: body?.owner,
        force: body?.force,
        reason: body?.reason,
        actor: "telegram-ui",
      });
      if (result.error) {
        jsonResponse(res, 400, { ok: false, error: result.error });
        return;
      }
      jsonResponse(res, 200, { ok: true, data: result.workspace });
      broadcastUiEvent(["workspaces"], "invalidate", {
        reason: "workspace-released",
        workspaceId,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/shared-workspaces/renew") {
    try {
      const body = await readJsonBody(req);
      const workspaceId = body?.workspaceId || body?.id;
      if (!workspaceId) {
        jsonResponse(res, 400, { ok: false, error: "workspaceId required" });
        return;
      }
      const result = await renewSharedWorkspaceLease({
        workspaceId,
        owner: body?.owner,
        ttlMinutes: body?.ttlMinutes,
        actor: "telegram-ui",
      });
      if (result.error) {
        jsonResponse(res, 400, { ok: false, error: result.error });
        return;
      }
      jsonResponse(res, 200, {
        ok: true,
        data: result.workspace,
        lease: result.lease,
      });
      broadcastUiEvent(["workspaces"], "invalidate", {
        reason: "workspace-renewed",
        workspaceId,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/agent-logs") {
    try {
      const file = url.searchParams.get("file");
      const query = url.searchParams.get("query") || "";
      const lines = Math.min(
        1000,
        Math.max(20, Number(url.searchParams.get("lines") || "200")),
      );
      if (!file) {
        const files = await listAgentLogFiles(query);
        jsonResponse(res, 200, { ok: true, data: files });
        return;
      }
      const filePath = resolve(agentLogsDir, file);
      if (!filePath.startsWith(agentLogsDir)) {
        jsonResponse(res, 403, { ok: false, error: "Forbidden" });
        return;
      }
      if (!existsSync(filePath)) {
        jsonResponse(res, 404, { ok: false, error: "Log not found" });
        return;
      }
      const tail = await tailFile(filePath, lines);
      jsonResponse(res, 200, { ok: true, data: tail });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/agent-logs/context") {
    try {
      const query = url.searchParams.get("query") || "";
      if (!query) {
        jsonResponse(res, 400, { ok: false, error: "query required" });
        return;
      }
      const worktreeDir = resolve(repoRoot, ".cache", "worktrees");
      const dirs = await readdir(worktreeDir).catch(() => []);
      const matches = dirs.filter((d) =>
        d.toLowerCase().includes(query.toLowerCase()),
      );
      if (matches.length === 0) {
        jsonResponse(res, 200, { ok: true, data: { matches: [] } });
        return;
      }
      const wtName = matches[0];
      const wtPath = resolve(worktreeDir, wtName);
      let gitLog = "";
      let gitStatus = "";
      let diffStat = "";
      try {
        gitLog = execSync("git log --oneline -5 2>&1", {
          cwd: wtPath,
          encoding: "utf8",
          timeout: 10000,
        }).trim();
      } catch {
        gitLog = "";
      }
      try {
        gitStatus = execSync("git status --short 2>&1", {
          cwd: wtPath,
          encoding: "utf8",
          timeout: 10000,
        }).trim();
      } catch {
        gitStatus = "";
      }
      try {
        const branch = execSync("git branch --show-current 2>&1", {
          cwd: wtPath,
          encoding: "utf8",
          timeout: 5000,
        }).trim();
        diffStat = execSync(`git diff --stat main...${branch} 2>&1`, {
          cwd: wtPath,
          encoding: "utf8",
          timeout: 10000,
        }).trim();
      } catch {
        diffStat = "";
      }
      jsonResponse(res, 200, {
        ok: true,
        data: {
          name: wtName,
          path: wtPath,
          gitLog,
          gitStatus,
          diffStat,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/agents") {
    try {
      const executor = uiDeps.getInternalExecutor?.();
      const agents = [];
      if (executor) {
        const status = executor.getStatus();
        for (const slot of status.slots || []) {
          if (slot.taskId) {
            agents.push({
              id: slot.taskId,
              status: slot.status || "busy",
              taskTitle: slot.taskTitle || slot.taskId,
              branch: slot.branch || null,
              startedAt: slot.startedAt || null,
              completedCount: slot.completedCount || 0,
            });
          }
        }
      }
      jsonResponse(res, 200, { ok: true, data: agents });
    } catch (err) {
      jsonResponse(res, 200, { ok: true, data: [] });
    }
    return;
  }

  if (path === "/api/infra") {
    try {
      const executor = uiDeps.getInternalExecutor?.();
      const status = executor?.getStatus?.() || {};
      const data = {
        executor: {
          mode: uiDeps.getExecutorMode?.() || "internal",
          maxParallel: status.maxParallel || 0,
          activeSlots: status.activeSlots || 0,
          paused: executor?.isPaused?.() || false,
        },
        system: {
          uptime: process.uptime(),
          memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
          nodeVersion: process.version,
          platform: process.platform,
        },
      };
      jsonResponse(res, 200, { ok: true, data });
    } catch (err) {
      jsonResponse(res, 200, { ok: true, data: null });
    }
    return;
  }

  if (path === "/api/agent-logs/tail") {
    try {
      const query = url.searchParams.get("query") || "";
      const lines = Math.min(
        1000,
        Math.max(20, Number(url.searchParams.get("lines") || "100")),
      );
      const files = await listAgentLogFiles(query);
      if (!files.length) {
        jsonResponse(res, 200, { ok: true, data: null });
        return;
      }
      const latest = files[0];
      const filePath = resolve(agentLogsDir, latest.name || latest);
      if (!filePath.startsWith(agentLogsDir) || !existsSync(filePath)) {
        jsonResponse(res, 200, { ok: true, data: null });
        return;
      }
      const tail = await tailFile(filePath, lines);
      jsonResponse(res, 200, { ok: true, data: { file: latest.name || latest, content: tail } });
    } catch (err) {
      jsonResponse(res, 200, { ok: true, data: null });
    }
    return;
  }

  if (path === "/api/agent-context") {
    try {
      const query = url.searchParams.get("query") || "";
      if (!query) {
        jsonResponse(res, 200, { ok: true, data: null });
        return;
      }
      const queryLower = query.toLowerCase();
      const worktreeDir = resolve(repoRoot, ".cache", "worktrees");

      const worktreeMatches = [];
      let matchedWorktree = null;
      try {
        const active = await listActiveWorktrees();
        for (const wt of active || []) {
          const branch = String(wt.branch || "").toLowerCase();
          const taskKey = String(wt.taskKey || "").toLowerCase();
          const name = String(wt.name || wt.branch || "").toLowerCase();
          if (
            branch.includes(queryLower) ||
            taskKey === queryLower ||
            taskKey.includes(queryLower) ||
            name.includes(queryLower)
          ) {
            matchedWorktree = wt;
            worktreeMatches.push(wt.branch || wt.taskKey || wt.path || wt.name || "");
            break;
          }
        }
      } catch {
        /* best effort */
      }

      let wtName = matchedWorktree?.name || "";
      let wtPath = matchedWorktree?.path || "";

      if (!wtPath) {
        const dirs = await readdir(worktreeDir).catch(() => []);
        const directMatches = dirs.filter((d) => d.toLowerCase().includes(queryLower));
        const shortQuery = queryLower.length > 8 ? queryLower.slice(0, 8) : "";
        const shortMatches = shortQuery
          ? dirs.filter((d) => d.toLowerCase().includes(shortQuery))
          : [];
        const matches = directMatches.length ? directMatches : shortMatches;
        if (!matches.length) {
          jsonResponse(res, 200, { ok: true, data: { matches: [], context: null } });
          return;
        }
        wtName = matches[0];
        wtPath = resolve(worktreeDir, wtName);
        worktreeMatches.push(...matches);
      }
      const runWtGit = (args) => {
        try {
          return execSync(`git ${args}`, { cwd: wtPath, encoding: "utf8", timeout: 5000 }).trim();
        } catch { return ""; }
      };
      const gitLog = runWtGit("log --oneline -10");
      const gitLogDetailed = runWtGit("log --format=%h||%s||%cr -10");
      const gitStatus = runWtGit("status --porcelain");
      const gitBranch = runWtGit("rev-parse --abbrev-ref HEAD");
      const gitDiffStat = runWtGit("diff --stat");
      const gitAheadBehind = runWtGit("rev-list --left-right --count HEAD...@{upstream} 2>/dev/null");
      const changedFiles = gitStatus
        ? gitStatus
            .split("\n")
            .filter(Boolean)
            .map((line) => ({
              code: line.substring(0, 2).trim() || "?",
              file: line.substring(3).trim(),
            }))
        : [];
      const commitRows = gitLogDetailed
        ? gitLogDetailed.split("\n").filter(Boolean).map((line) => {
            const [hash, message, time] = line.split("||");
            return { hash, message, time };
          })
        : [];
      const sessionTracker = getSessionTracker();
      const sessions = sessionTracker?.listAllSessions?.() || [];
      let session =
        sessions.find((s) => String(s.id || "").toLowerCase() === queryLower) ||
        sessions.find((s) => String(s.taskId || "").toLowerCase() === queryLower);
      if (!session && matchedWorktree?.taskKey) {
        const taskKey = String(matchedWorktree.taskKey || "").toLowerCase();
        session =
          sessions.find((s) => String(s.id || "").toLowerCase() === taskKey) ||
          sessions.find((s) => String(s.taskId || "").toLowerCase() === taskKey);
      }
      if (!session && queryLower.length > 8) {
        const short = queryLower.slice(0, 8);
        session = sessions.find(
          (s) =>
            String(s.id || "").toLowerCase().includes(short) ||
            String(s.taskId || "").toLowerCase().includes(short),
        );
      }
      const fullSession =
        session && typeof sessionTracker?.getSessionMessages === "function"
          ? sessionTracker.getSessionMessages(session.id || session.taskId)
          : null;
      const actionHistory = [];
      const fileAccessMap = new Map();
      const fileAccessCounts = { read: 0, write: 0, other: 0 };
      const filePattern = /([a-zA-Z0-9_./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|mdx|css|scss|less|html|yml|yaml|toml|env|lock|go|rs|py|sh|ps1|psm1|txt|sql))/g;
      const classifyActionKind = (toolName, detail) => {
        const toolLower = String(toolName || "").toLowerCase();
        const cmdLower = String(detail || "").toLowerCase();
        if (toolLower.includes("apply_patch") || toolLower.includes("write")) return "write";
        if (/\b(rg|cat|sed|ls|stat|head|tail|grep|find)\b/.test(cmdLower)) return "read";
        return "other";
      };
      const addFileAccess = (path, kind) => {
        if (!path) return;
        const entry = fileAccessMap.get(path) || { path, kinds: new Set() };
        if (!entry.kinds.has(kind)) {
          entry.kinds.add(kind);
          if (fileAccessCounts[kind] != null) fileAccessCounts[kind] += 1;
          else fileAccessCounts.other += 1;
        }
        fileAccessMap.set(path, entry);
      };

      const messages = fullSession?.messages || [];
      const recentMessages = messages.slice(-50);
      for (const msg of recentMessages) {
        if (!msg || !msg.type) continue;
        if (msg.type === "tool_call" || msg.type === "tool_result" || msg.type === "error") {
          actionHistory.push({
            type: msg.type,
            tool: msg.meta?.toolName || (msg.type === "tool_result" ? "RESULT" : "TOOL"),
            detail: msg.content || "",
            content: msg.content || "",
            timestamp: msg.timestamp || null,
          });
        }
        if (msg.type === "tool_call" && msg.content) {
          const kind = classifyActionKind(msg.meta?.toolName, msg.content);
          const matches = msg.content.matchAll(filePattern);
          for (const match of matches) {
            const file = match?.[1];
            if (file) addFileAccess(file, kind);
          }
        }
      }
      for (const file of changedFiles) {
        if (file?.file) addFileAccess(file.file, "write");
      }
      const fileAccessSummary = fileAccessMap.size
        ? {
            files: Array.from(fileAccessMap.values()).map((entry) => ({
              path: entry.path,
              kinds: Array.from(entry.kinds),
            })),
            counts: fileAccessCounts,
          }
        : null;
      jsonResponse(res, 200, {
        ok: true,
        data: {
          matches: worktreeMatches,
          session: session || null,
          actionHistory,
          fileAccessSummary,
          context: {
            name: wtName,
            path: wtPath,
            gitLog,
            gitLogDetailed,
            gitStatus,
            gitBranch,
            gitDiffStat,
            gitAheadBehind,
            changedFiles,
            diffSummary: gitDiffStat,
            recentCommits: commitRows,
          },
        },
      });
    } catch (err) {
      jsonResponse(res, 200, { ok: true, data: null });
    }
    return;
  }

  if (path === "/api/git/branches") {
    try {
      const raw = runGit("branch -a --sort=-committerdate", 15000);
      const lines = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      jsonResponse(res, 200, { ok: true, data: lines.slice(0, 40) });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/git/branch-detail") {
    try {
      const rawBranch = url.searchParams.get("branch") || "";
      const cleaned = rawBranch.replace(/^\*\s*/, "").trim();
      const safe = cleaned.replace(/^remotes\//, "").replace(/[^\w./-]/g, "");
      if (!safe) {
        jsonResponse(res, 400, { ok: false, error: "branch is required" });
        return;
      }
      const hasRef = (ref) => {
        try {
          execSync(`git show-ref --verify --quiet ${ref}`, {
            cwd: repoRoot,
            timeout: 5000,
            stdio: "ignore",
          });
          return true;
        } catch {
          return false;
        }
      };
      const baseRef =
        (hasRef("refs/heads/main") && "main") ||
        (hasRef("refs/remotes/origin/main") && "origin/main") ||
        (hasRef("refs/heads/master") && "master") ||
        (hasRef("refs/remotes/origin/master") && "origin/master") ||
        null;
      const diffRange = baseRef ? `${baseRef}...${safe}` : `${safe}~1..${safe}`;
      const commitsRaw = runGit(`log ${safe} --format=%h||%s||%cr -20`, 15000);
      const commits = commitsRaw
        ? commitsRaw.split("\n").filter(Boolean).map((line) => {
            const [hash, message, time] = line.split("||");
            return { hash, message, time };
          })
        : [];
      const commitListRaw = runGit(
        `log ${safe} --format=%H||%h||%an||%ae||%ad||%s --date=iso-strict -20`,
        15000,
      );
      const commitList = commitListRaw
        ? commitListRaw.split("\n").filter(Boolean).map((line) => {
            const [hash, short, authorName, authorEmail, authorDate, subject] = line.split("||");
            return {
              hash,
              short,
              authorName,
              authorEmail,
              authorDate,
              subject,
            };
          })
        : [];
      const diffStat = runGit(`diff --stat ${diffRange}`, 15000);
      const filesRaw = runGit(`diff --name-only ${diffRange}`, 15000);
      const files = filesRaw ? filesRaw.split("\n").filter(Boolean) : [];
      const numstatRaw = runGit(`diff --numstat ${diffRange}`, 15000);
      const parseNumstat = (raw) => {
        if (!raw) return [];
        const entries = [];
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          const parts = line.split("\t");
          if (parts.length < 3) continue;
          const [addRaw, delRaw, ...fileParts] = parts;
          const file = fileParts.join("\t");
          if (!file) continue;
          if (addRaw === "-" && delRaw === "-") {
            entries.push({ file, additions: 0, deletions: 0, binary: true });
          } else {
            entries.push({
              file,
              additions: parseInt(addRaw, 10) || 0,
              deletions: parseInt(delRaw, 10) || 0,
              binary: false,
            });
          }
        }
        return entries;
      };
      const filesChanged = parseNumstat(numstatRaw);
      const diffSummary = filesChanged.length
        ? {
            totalFiles: filesChanged.length,
            totalAdditions: filesChanged.reduce((sum, f) => sum + (f.additions || 0), 0),
            totalDeletions: filesChanged.reduce((sum, f) => sum + (f.deletions || 0), 0),
            binaryFiles: filesChanged.reduce((sum, f) => sum + (f.binary ? 1 : 0), 0),
          }
        : null;

      let worktree = null;
      try {
        const active = await listActiveWorktrees();
        const match = (active || []).find((wt) => {
          const branch = String(wt.branch || "").replace(/^refs\/heads\//, "");
          return branch === safe || branch === cleaned || branch.endsWith(`/${safe}`);
        });
        if (match) {
          worktree = {
            path: match.path,
            taskKey: match.taskKey || null,
            branch: match.branch || safe,
            status: match.status || null,
          };
        }
      } catch {
        /* best effort */
      }

      let activeSlot = null;
      const executor = uiDeps.getInternalExecutor?.();
      if (executor?.getStatus) {
        const status = executor.getStatus();
        const slotMatch = (status?.slots || []).find((s) => {
          const slotBranch = String(s.branch || "").replace(/^refs\/heads\//, "");
          return slotBranch === safe || slotBranch === cleaned || slotBranch.endsWith(`/${safe}`);
        });
        if (slotMatch) {
          activeSlot = slotMatch;
        }
      }
      const workspaceTarget =
        activeSlot || worktree
          ? {
              taskId: activeSlot?.taskId || worktree?.taskKey || null,
              taskTitle: activeSlot?.taskTitle || worktree?.taskKey || safe,
              branch: worktree?.branch || safe,
              workspacePath: worktree?.path || null,
            }
          : null;
      const workspaceLink = workspaceTarget
        ? {
            label: workspaceTarget.taskTitle || workspaceTarget.branch || safe,
            taskTitle: workspaceTarget.taskTitle,
            branch: workspaceTarget.branch,
            workspacePath: workspaceTarget.workspacePath,
            target: workspaceTarget,
          }
        : null;

      jsonResponse(res, 200, {
        ok: true,
        data: {
          branch: safe,
          base: baseRef,
          commits,
          commitList,
          diffStat,
          files,
          filesChanged,
          filesDetailed: filesChanged,
          diffSummary,
          worktree,
          activeSlot,
          workspaceTarget,
          workspaceLink,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/git/diff") {
    try {
      const diff = runGit("diff --stat HEAD", 15000);
      jsonResponse(res, 200, { ok: true, data: diff });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/health") {
    jsonResponse(res, 200, {
      ok: true,
      uptime: process.uptime(),
      wsClients: wsClients.size,
      lanIp: getLocalLanIp(),
      url: getTelegramUiUrl(),
    });
    return;
  }

  if (path === "/api/config") {
    const regionEnv = (process.env.EXECUTOR_REGIONS || "").trim();
    const regions = regionEnv ? regionEnv.split(",").map((r) => r.trim()).filter(Boolean) : ["auto"];
    jsonResponse(res, 200, {
      ok: true,
      miniAppEnabled:
        !!process.env.TELEGRAM_MINIAPP_ENABLED ||
        !!process.env.TELEGRAM_UI_PORT,
      uiUrl: getTelegramUiUrl(),
      lanIp: getLocalLanIp(),
      wsEnabled: true,
      authRequired: !isAllowUnsafe(),
      sdk: process.env.EXECUTOR_SDK || "auto",
      kanbanBackend: process.env.KANBAN_BACKEND || "github",
      regions,
    });
    return;
  }

  if (path === "/api/config/update") {
    try {
      const body = await readJsonBody(req);
      const { key, value } = body || {};
      if (!key || !value) {
        jsonResponse(res, 400, { ok: false, error: "key and value are required" });
        return;
      }
      const envMap = { sdk: "EXECUTOR_SDK", kanban: "KANBAN_BACKEND", region: "EXECUTOR_REGIONS" };
      const envKey = envMap[key];
      if (!envKey) {
        jsonResponse(res, 400, { ok: false, error: `Unknown config key: ${key}` });
        return;
      }
      process.env[envKey] = value;
      // Also send chat command for backward compat
      const cmdMap = { sdk: `/sdk ${value}`, kanban: `/kanban ${value}`, region: `/region ${value}` };
      const handler = uiDeps.handleUiCommand;
      if (typeof handler === "function") {
        try { await handler(cmdMap[key]); } catch { /* best-effort */ }
      }
      broadcastUiEvent(["executor", "overview"], "invalidate", { reason: "config-updated", key, value });
      jsonResponse(res, 200, { ok: true, key, value });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/settings") {
    try {
      const data = {};
      for (const key of SETTINGS_KNOWN_KEYS) {
        const val = process.env[key];
        if (SETTINGS_SENSITIVE_KEYS.has(key)) {
          data[key] = val ? "••••••" : "";
        } else {
          data[key] = val || "";
        }
      }
      const envPath = resolve(__dirname, ".env");
      const configPath = resolveConfigPath();
      const configExists = existsSync(configPath);
      const configSchema = getConfigSchema();
      jsonResponse(res, 200, {
        ok: true,
        data,
        meta: {
          envPath,
          configPath,
          configDir: dirname(configPath),
          configExists,
          configSchemaPath: CONFIG_SCHEMA_PATH,
          configSchemaLoaded: Boolean(configSchema),
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/settings/update") {
    try {
      const body = await readJsonBody(req);
      const changes = body?.changes;
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
        jsonResponse(res, 400, { ok: false, error: "changes object is required" });
        return;
      }
      // Rate limit: 2 seconds between settings updates
      const now = Date.now();
      if (now - _settingsLastUpdateTime < 2000) {
        jsonResponse(res, 429, { ok: false, error: "Settings update rate limited. Wait 2 seconds." });
        return;
      }
      const unknownKeys = Object.keys(changes).filter(k => !SETTINGS_KNOWN_SET.has(k));
      if (unknownKeys.length > 0) {
        jsonResponse(res, 400, { ok: false, error: `Unknown keys: ${unknownKeys.join(", ")}` });
        return;
      }
      const fieldErrors = {};
      for (const [key, value] of Object.entries(changes)) {
        const def = SETTINGS_SCHEMA.find((s) => s.key === key);
        if (!def) continue;
        const result = validateSetting(def, String(value ?? ""));
        if (!result.valid) {
          fieldErrors[key] = result.error || "Invalid value";
        }
      }
      const schemaFieldErrors = validateConfigSchemaChanges(changes);
      for (const [key, error] of Object.entries(schemaFieldErrors)) {
        if (!fieldErrors[key]) fieldErrors[key] = error;
      }
      if (Object.keys(fieldErrors).length > 0) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Validation failed",
          fieldErrors,
        });
        return;
      }
      for (const [key, value] of Object.entries(changes)) {
        const strVal = String(value);
        if (strVal.length > 2000) {
          jsonResponse(res, 400, { ok: false, error: `Value for ${key} exceeds 2000 chars` });
          return;
        }
        if (strVal.includes('\0') || strVal.includes('\n') || strVal.includes('\r')) {
          jsonResponse(res, 400, { ok: false, error: `Value for ${key} contains illegal characters (null bytes or newlines)` });
          return;
        }
      }
      // Apply to process.env
      const strChanges = {};
      for (const [key, value] of Object.entries(changes)) {
        const strVal = String(value);
        process.env[key] = strVal;
        strChanges[key] = strVal;
      }
      // Write to .env file
      const updated = updateEnvFile(strChanges);
      const configUpdate = updateConfigFile(changes);
      const configDir = configUpdate.path ? dirname(configUpdate.path) : null;
      _settingsLastUpdateTime = now;
      broadcastUiEvent(["settings", "overview"], "invalidate", { reason: "settings-updated", keys: updated });
      jsonResponse(res, 200, {
        ok: true,
        updated,
        updatedConfig: configUpdate.updated || [],
        configPath: configUpdate.path || null,
        configDir,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/project-summary") {
    try {
      const adapter = getKanbanAdapter();
      const projects = await adapter.listProjects();
      const project = projects?.[0] || null;
      if (project) {
        const tasks = await adapter.listTasks(project.id || project.name).catch(() => []);
        const completedCount = tasks.filter(
          (t) => t.status === "done" || t.status === "closed" || t.status === "completed",
        ).length;
        jsonResponse(res, 200, {
          ok: true,
          data: {
            id: project.id || project.name,
            name: project.name || project.title || project.id,
            description: project.description || project.body || null,
            taskCount: tasks.length,
            completedCount,
          },
        });
      } else {
        jsonResponse(res, 200, { ok: true, data: null });
      }
    } catch (err) {
      jsonResponse(res, 200, { ok: true, data: null });
    }
    return;
  }

  if (path === "/api/project-sync/metrics") {
    try {
      const syncEngine = uiDeps.getSyncEngine?.() || null;
      jsonResponse(res, 200, {
        ok: true,
        data: {
          webhook: getProjectSyncWebhookMetrics(),
          syncEngine: syncEngine?.getStatus?.()?.metrics || null,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/command") {
    try {
      const body = await readJsonBody(req);
      const command = (body?.command || "").trim();
      if (!command) {
        jsonResponse(res, 400, { ok: false, error: "command is required" });
        return;
      }
      const ALLOWED_CMD_PREFIXES = [
        "/status",
        "/health",
        "/plan",
        "/logs",
        "/menu",
        "/tasks",
        "/start",
        "/stop",
        "/pause",
        "/resume",
        "/sdk",
        "/kanban",
        "/region",
        "/deploy",
        "/help",
        "/starttask",
        "/stoptask",
        "/retrytask",
        "/parallelism",
        "/sentinel",
        "/hooks",
        "/version",
      ];
      const cmdBase = command.split(/\s/)[0].toLowerCase();
      if (!ALLOWED_CMD_PREFIXES.some(p => cmdBase === p || cmdBase.startsWith(p + " "))) {
        jsonResponse(res, 400, { ok: false, error: `Command not allowed: ${cmdBase}` });
        return;
      }
      const handler = uiDeps.handleUiCommand;
      if (typeof handler === "function") {
        const result = await handler(command);
        jsonResponse(res, 200, { ok: true, data: result || null, command });
      } else {
        // No command handler wired — acknowledge and broadcast refresh
        jsonResponse(res, 200, {
          ok: true,
          data: null,
          command,
          message: "Command queued. Check status for results.",
        });
      }
      broadcastUiEvent(["overview", "executor", "tasks"], "invalidate", {
        reason: "command-executed",
        command,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/retry") {
    try {
      const body = await readJsonBody(req);
      const taskId = body?.taskId || body?.id;
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId is required" });
        return;
      }
      const executor = uiDeps.getInternalExecutor?.();
      if (!executor) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Internal executor not enabled.",
        });
        return;
      }
      const adapter = getKanbanAdapter();
      const task = await adapter.getTask(taskId);
      if (!task) {
        jsonResponse(res, 404, { ok: false, error: "Task not found." });
        return;
      }
      if (typeof adapter.updateTask === "function") {
        await adapter.updateTask(taskId, { status: "todo" });
      } else if (typeof adapter.updateTaskStatus === "function") {
        await adapter.updateTaskStatus(taskId, "todo");
      }
      executor.executeTask(task).catch((error) => {
        console.warn(
          `[telegram-ui] failed to retry task ${taskId}: ${error.message}`,
        );
      });
      jsonResponse(res, 200, { ok: true, taskId });
      broadcastUiEvent(
        ["tasks", "overview", "executor", "agents"],
        "invalidate",
        { reason: "task-retried", taskId },
      );
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/executor/dispatch") {
    try {
      const executor = uiDeps.getInternalExecutor?.();
      if (!executor) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Internal executor not enabled.",
        });
        return;
      }
      const body = await readJsonBody(req);
      const taskId = (body?.taskId || "").trim();
      const prompt = (body?.prompt || "").trim();
      if (!taskId && !prompt) {
        jsonResponse(res, 400, {
          ok: false,
          error: "taskId or prompt is required",
        });
        return;
      }
      const status = executor.getStatus?.() || {};
      const freeSlots =
        (status.maxParallel || 0) - (status.activeSlots || 0);
      if (freeSlots <= 0) {
        jsonResponse(res, 409, { ok: false, error: "No free slots" });
        return;
      }
      if (taskId) {
        const adapter = getKanbanAdapter();
        const task = await adapter.getTask(taskId);
        if (!task) {
          jsonResponse(res, 404, { ok: false, error: "Task not found." });
          return;
        }
        executor.executeTask(task).catch((error) => {
          console.warn(
            `[telegram-ui] dispatch failed for ${taskId}: ${error.message}`,
          );
        });
        jsonResponse(res, 200, {
          ok: true,
          slotIndex: status.activeSlots || 0,
          taskId,
        });
      } else {
        // Ad-hoc prompt dispatch via command handler
        const handler = uiDeps.handleUiCommand;
        if (typeof handler === "function") {
          const result = await handler(`/prompt ${prompt}`);
          jsonResponse(res, 200, {
            ok: true,
            slotIndex: status.activeSlots || 0,
            data: result || null,
          });
        } else {
          jsonResponse(res, 400, {
            ok: false,
            error: "Prompt dispatch not available — no command handler.",
          });
          return;
        }
      }
      broadcastUiEvent(
        ["executor", "overview", "agents", "tasks"],
        "invalidate",
        { reason: "task-dispatched", taskId: taskId || "(ad-hoc)" },
      );
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/executor/stop-slot") {
    try {
      const executor = uiDeps.getInternalExecutor?.();
      if (!executor) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Internal executor not enabled.",
        });
        return;
      }
      const body = await readJsonBody(req);
      const slot = Number(body?.slot ?? -1);
      if (typeof executor.stopSlot === "function") {
        await executor.stopSlot(slot);
      } else if (typeof executor.cancelSlot === "function") {
        await executor.cancelSlot(slot);
      } else {
        jsonResponse(res, 400, {
          ok: false,
          error: "Executor does not support stop-slot.",
        });
        return;
      }
      jsonResponse(res, 200, { ok: true, slot });
      broadcastUiEvent(["executor", "overview", "agents"], "invalidate", {
        reason: "slot-stopped",
        slot,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── Session API endpoints ──────────────────────────────────────────────

  if (path === "/api/sessions" && req.method === "GET") {
    try {
      const tracker = getSessionTracker();
      let sessions = tracker.listAllSessions();
      const typeFilter = url.searchParams.get("type");
      const statusFilter = url.searchParams.get("status");
      if (typeFilter) sessions = sessions.filter((s) => s.type === typeFilter);
      if (statusFilter) sessions = sessions.filter((s) => s.status === statusFilter);
      jsonResponse(res, 200, { ok: true, sessions });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/sessions/create" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const type = body?.type || "manual";
      const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tracker = getSessionTracker();
      const session = tracker.createSession({
        id,
        type,
        metadata: { prompt: body?.prompt },
      });
      jsonResponse(res, 200, { ok: true, session: { id: session.id, type: session.type, status: session.status } });
      broadcastUiEvent(["sessions"], "invalidate", { reason: "session-created", sessionId: id });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // Parameterized session routes: /api/sessions/:id[/action]
  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.+))?$/);
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const action = sessionMatch[2] || null;

    if (!action && req.method === "GET") {
      try {
        const tracker = getSessionTracker();
        const session = tracker.getSessionMessages(sessionId);
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        jsonResponse(res, 200, { ok: true, session });
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "message" && req.method === "POST") {
      try {
        const tracker = getSessionTracker();
        const session = tracker.getSessionById(sessionId);
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        if (session.status === "paused" || session.status === "archived") {
          jsonResponse(res, 400, { ok: false, error: `Session is ${session.status}` });
          return;
        }
        const body = await readJsonBody(req);
        const content = body?.content;
        if (!content) {
          jsonResponse(res, 400, { ok: false, error: "content is required" });
          return;
        }
        const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        tracker.recordEvent(sessionId, { role: "user", content, timestamp: new Date().toISOString() });

        // Forward to primary agent if applicable
        if (session.type === "primary") {
          const exec = uiDeps.execPrimaryPrompt;
          if (exec) {
            try {
              const result = await exec(content);
              if (result) {
                tracker.recordEvent(sessionId, {
                  role: "assistant",
                  content: typeof result === "string" ? result : JSON.stringify(result),
                  timestamp: new Date().toISOString(),
                });
              }
            } catch { /* best-effort forwarding */ }
          }
        }

        jsonResponse(res, 200, { ok: true, messageId });
        broadcastUiEvent(["sessions"], "invalidate", { reason: "session-message", sessionId });
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "archive" && req.method === "POST") {
      try {
        const tracker = getSessionTracker();
        const session = tracker.getSessionById(sessionId);
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        tracker.updateSessionStatus(sessionId, "archived");
        jsonResponse(res, 200, { ok: true });
        broadcastUiEvent(["sessions"], "invalidate", {
          reason: "session-archived",
          sessionId,
        });
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "resume" && req.method === "POST") {
      try {
        const tracker = getSessionTracker();
        const session = tracker.getSessionById(sessionId);
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        tracker.updateSessionStatus(sessionId, "active");
        jsonResponse(res, 200, { ok: true });
        broadcastUiEvent(["sessions"], "invalidate", { reason: "session-resumed", sessionId });
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "diff" && req.method === "GET") {
      try {
        const tracker = getSessionTracker();
        const session = tracker.getSessionById(sessionId);
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        const worktreePath = session.metadata?.worktreePath;
        if (!worktreePath || !existsSync(worktreePath)) {
          jsonResponse(res, 200, { ok: true, diff: { files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0, formatted: "(no worktree)" }, summary: "(no worktree)", commits: [] });
          return;
        }
        const stats = collectDiffStats(worktreePath);
        const summary = getCompactDiffSummary(worktreePath);
        const commits = getRecentCommits(worktreePath);
        jsonResponse(res, 200, { ok: true, diff: stats, summary, commits });
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }
  }

  jsonResponse(res, 404, { ok: false, error: "Unknown API endpoint" });
}

async function handleStatic(req, res, url) {
  if (!requireAuth(req)) {
    textResponse(res, 401, "Unauthorized");
    return;
  }

  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolve(uiRoot, `.${pathname}`);

  if (!filePath.startsWith(uiRoot)) {
    textResponse(res, 403, "Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    textResponse(res, 404, "Not Found");
    return;
  }

  try {
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch (err) {
    textResponse(res, 500, `Failed to load ${pathname}: ${err.message}`);
  }
}

export async function startTelegramUiServer(options = {}) {
  if (uiServer) return uiServer;

  const port = Number(options.port || getDefaultPort());
  if (!port) return null;

  injectUiDependencies(options.dependencies || {});

  // Auto-TLS: generate a self-signed cert for HTTPS unless explicitly disabled
  let tlsOpts = null;
  if (!isTlsDisabled()) {
    tlsOpts = ensureSelfSignedCert();
  }

  const requestHandler = async (req, res) => {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    const webhookPath = getGitHubWebhookPath();

    // Token exchange: ?token=<hex> → set session cookie and redirect to clean URL
    const qToken = url.searchParams.get("token");
    if (qToken && sessionToken) {
      const provided = Buffer.from(qToken);
      const expected = Buffer.from(sessionToken);
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
        const secure = uiServerTls ? "; Secure" : "";
        res.writeHead(302, {
          "Set-Cookie": `ve_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`,
          Location: url.pathname || "/",
        });
        res.end();
        return;
      }
    }

    if (url.pathname === webhookPath) {
      await handleGitHubProjectWebhook(req, res);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    // Telegram initData exchange: ?tgWebAppData=... or ?initData=... → set session cookie and redirect
    const initDataQuery =
      url.searchParams.get("tgWebAppData") ||
      url.searchParams.get("initData") ||
      "";
    if (
      initDataQuery &&
      sessionToken &&
      req.method === "GET"
    ) {
      const token = process.env.TELEGRAM_BOT_TOKEN || "";
      if (validateInitData(String(initDataQuery), token)) {
        const secure = uiServerTls ? "; Secure" : "";
        const cleanUrl = new URL(url.toString());
        cleanUrl.searchParams.delete("tgWebAppData");
        cleanUrl.searchParams.delete("initData");
        const redirectPath =
          cleanUrl.pathname + (cleanUrl.searchParams.toString() ? `?${cleanUrl.searchParams.toString()}` : "");
        res.writeHead(302, {
          "Set-Cookie": `ve_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`,
          Location: redirectPath || "/",
        });
        res.end();
        return;
      }
    }
    await handleStatic(req, res, url);
  };

  if (tlsOpts) {
    uiServer = createHttpsServer(tlsOpts, requestHandler);
    uiServerTls = true;
  } else {
    uiServer = createServer(requestHandler);
    uiServerTls = false;
  }

  wsServer = new WebSocketServer({ noServer: true });
  wsServer.on("connection", (socket) => {
    socket.__channels = new Set(["*"]);
    socket.__lastPong = Date.now();
    socket.__lastPing = null;
    socket.__missedPongs = 0;
    wsClients.add(socket);
    sendWsMessage(socket, {
      type: "hello",
      channels: ["*"],
      payload: { connected: true },
      ts: Date.now(),
    });

    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw || "{}"));
        if (message?.type === "subscribe" && Array.isArray(message.channels)) {
          const channels = message.channels
            .filter((item) => typeof item === "string" && item.trim())
            .map((item) => item.trim());
          socket.__channels = new Set(channels.length ? channels : ["*"]);
          sendWsMessage(socket, {
            type: "subscribed",
            channels: Array.from(socket.__channels),
            payload: { ok: true },
            ts: Date.now(),
          });
        } else if (message?.type === "ping" && typeof message.ts === "number") {
          // Client ping → echo back as pong
          sendWsMessage(socket, { type: "pong", ts: message.ts });
        } else if (message?.type === "pong" && typeof message.ts === "number") {
          // Client pong in response to server ping
          socket.__lastPong = Date.now();
          socket.__missedPongs = 0;
        } else if (message?.type === "subscribe-logs") {
          const logType = message.logType === "agent" ? "agent" : "system";
          const query = typeof message.query === "string" ? message.query : "";
          startLogStream(socket, logType, query);
        } else if (message?.type === "unsubscribe-logs") {
          stopLogStream(socket);
        }
      } catch {
        // Ignore malformed websocket payloads
      }
    });

    socket.on("close", () => {
      stopLogStream(socket);
      wsClients.delete(socket);
    });

    socket.on("error", () => {
      stopLogStream(socket);
      wsClients.delete(socket);
    });
  });

  startWsHeartbeat();

  uiServer.on("upgrade", (req, socket, head) => {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (!requireWsAuth(req, url)) {
      try {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      } catch {
        // no-op
      }
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      wsServer.emit("connection", ws, req);
    });
  });

  // Generate a session token for browser-based access (no config needed)
  sessionToken = randomBytes(32).toString("hex");

  await new Promise((resolveReady, rejectReady) => {
    uiServer.once("error", rejectReady);
    uiServer.listen(port, options.host || DEFAULT_HOST, () => {
      resolveReady();
    });
  });

  const publicHost = options.publicHost || process.env.TELEGRAM_UI_PUBLIC_HOST;
  const lanIp = getLocalLanIp();
  const host = publicHost || lanIp;
  const actualPort = uiServer.address().port;
  const protocol = uiServerTls
    ? "https"
    : publicHost &&
        !publicHost.startsWith("192.") &&
        !publicHost.startsWith("10.") &&
        !publicHost.startsWith("172.")
      ? "https"
      : "http";
  uiServerUrl = `${protocol}://${host}:${actualPort}`;
  console.log(`[telegram-ui] server listening on ${uiServerUrl}`);
  if (uiServerTls) {
    console.log(`[telegram-ui] TLS enabled (self-signed) — Telegram WebApp buttons will use HTTPS`);
  }
  console.log(`[telegram-ui] LAN access: ${protocol}://${lanIp}:${actualPort}`);
  console.log(`[telegram-ui] Browser access: ${protocol}://${lanIp}:${actualPort}/?token=${sessionToken}`);

  // Check firewall rules for the UI port
  firewallState = await checkFirewall(actualPort);
  if (firewallState) {
    if (firewallState.blocked) {
      console.warn(
        `[telegram-ui] ⚠️  Port ${actualPort}/tcp appears BLOCKED by ${firewallState.firewall} for LAN access.`,
      );
      console.warn(
        `[telegram-ui] To fix, run: ${firewallState.allowCmd}`,
      );
    } else {
      console.log(`[telegram-ui] Firewall (${firewallState.firewall}): port ${actualPort}/tcp is allowed`);
    }
  }

  // Start cloudflared tunnel for trusted TLS (Telegram Mini App requires valid cert)
  if (uiServerTls) {
    const tUrl = await startTunnel(actualPort);
    if (tUrl) {
      console.log(`[telegram-ui] Telegram Mini App URL: ${tUrl}`);
      if (firewallState?.blocked) {
        console.log(
          `[telegram-ui] ℹ️  Tunnel active — Telegram Mini App works regardless of firewall. ` +
          `LAN browser access still requires port ${actualPort}/tcp to be open.`,
        );
      }
    }
  }

  return uiServer;
}

export function stopTelegramUiServer() {
  if (!uiServer) return;
  stopTunnel();
  stopWsHeartbeat();
  for (const socket of wsClients) {
    try {
      stopLogStream(socket);
      socket.close();
    } catch {
      // best effort
    }
  }
  wsClients.clear();
  // Clean up any remaining log stream poll timers
  for (const [, streamer] of logStreamers) {
    if (streamer.pollTimer) clearInterval(streamer.pollTimer);
  }
  logStreamers.clear();
  if (wsServer) {
    try {
      wsServer.close();
    } catch {
      // best effort
    }
  }
  wsServer = null;
  try {
    uiServer.close();
  } catch {
    /* best effort */
  }
  uiServer = null;
  uiServerTls = false;
  sessionToken = "";
  resetProjectSyncWebhookMetrics();
}

export { getLocalLanIp };
