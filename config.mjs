#!/usr/bin/env node

/**
 * bosun — Configuration System
 *
 * Loads configuration from (in priority order):
 *   1. CLI flags (--key value)
 *   2. Environment variables
 *   3. .env file
 *   4. bosun.config.json (project config)
 *   5. Built-in defaults
 *
 * Executor configuration supports N executors with weights and failover.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename, relative, isAbsolute } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { resolveAgentSdkConfig } from "./agent-sdk.mjs";
import {
  ensureAgentPromptWorkspace,
  getAgentPromptDefinitions,
  resolveAgentPrompts,
} from "./agent-prompts.mjs";
import { resolveAgentRepoRoot } from "./repo-root.mjs";
import { applyAllCompatibility } from "./compat.mjs";
import {
  normalizeExecutorKey,
  getModelsForExecutor,
  MODEL_ALIASES,
} from "./task-complexity.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_FILES = [
  "bosun.config.json",
  ".bosun.json",
  "bosun.json",
];

function hasSetupMarkers(dir) {
  const markers = [".env", ...CONFIG_FILES];
  return markers.some((name) => existsSync(resolve(dir, name)));
}

function hasConfigFiles(dir) {
  return CONFIG_FILES.some((name) => existsSync(resolve(dir, name)));
}

function isPathInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Returns true if the given directory appears to be the root of the bosun npm module
 * (i.e. contains a package.json with `"name": "bosun"` or the bosun main entry point).
 * @param {string} dirPath
 * @returns {boolean}
 */
function isBosunModuleRoot(dirPath) {
  if (!dirPath) return false;
  const pkgPath = resolve(dirPath, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.name === "bosun" || pkg.name === "@virtengine/bosun";
  } catch {
    return false;
  }
}

/**
 * Detect the bosun module root starting from the current file's directory,
 * walking up until a package.json with name "bosun" (or "@virtengine/bosun") is found.
 * Returns the module root path or __dirname as fallback.
 * @returns {string}
 */
function detectBosunModuleRoot() {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (isBosunModuleRoot(dir)) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return __dirname;
}

/**
 * Resolve the watch path with smart fallback logic.
 *
 * Priority:
 *  1. configuredWatchPath — if it exists on disk, use it as-is.
 *  2. scriptPath — if configuredWatchPath is missing/nonexistent.
 *  3. repoRoot or configDir — last resort.
 *
 * @param {{ configuredWatchPath?: string, scriptPath?: string, repoRoot?: string, configDir?: string }} opts
 * @returns {string}
 */
function resolveDefaultWatchPath({ configuredWatchPath, scriptPath, repoRoot: root, configDir } = {}) {
  if (configuredWatchPath && existsSync(configuredWatchPath)) {
    return configuredWatchPath;
  }
  if (scriptPath && existsSync(scriptPath)) {
    return scriptPath;
  }
  // Fall back — return scriptPath regardless (caller specified it as configured)
  if (scriptPath) return scriptPath;
  if (configuredWatchPath) return configuredWatchPath;
  return root || configDir || __dirname;
}

function isWslInteropRuntime() {
  return Boolean(
    process.env.WSL_DISTRO_NAME ||
    process.env.WSL_INTEROP ||
    (process.platform === "win32" &&
      String(process.env.HOME || "")
        .trim()
        .startsWith("/home/")),
  );
}

function resolveConfigDir(repoRoot) {
  // 1. Explicit env override (BOSUN_HOME supersedes BOSUN_DIR; both are aliases)
  if (process.env.BOSUN_HOME) return resolve(process.env.BOSUN_HOME);
  if (process.env.BOSUN_DIR) return resolve(process.env.BOSUN_DIR);

  // 2. Platform-aware user home
  const preferWindowsDirs =
    process.platform === "win32" && !isWslInteropRuntime();
  const baseDir = preferWindowsDirs
    ? process.env.APPDATA ||
      process.env.LOCALAPPDATA ||
      process.env.USERPROFILE ||
      process.env.HOME ||
      os.homedir()
    : process.env.HOME ||
      process.env.XDG_CONFIG_HOME ||
      process.env.USERPROFILE ||
      process.env.APPDATA ||
      process.env.LOCALAPPDATA ||
      os.homedir();
  return resolve(baseDir, "bosun");
}

function getConfigSearchDirs(repoRoot) {
  const dirs = new Set();
  if (process.env.BOSUN_HOME) dirs.add(resolve(process.env.BOSUN_HOME));
  if (process.env.BOSUN_DIR) dirs.add(resolve(process.env.BOSUN_DIR));
  dirs.add(resolveConfigDir(repoRoot));
  if (process.env.APPDATA) dirs.add(resolve(process.env.APPDATA, "bosun"));
  if (process.env.LOCALAPPDATA) dirs.add(resolve(process.env.LOCALAPPDATA, "bosun"));
  if (process.env.USERPROFILE) dirs.add(resolve(process.env.USERPROFILE, "bosun"));
  if (process.env.HOME) dirs.add(resolve(process.env.HOME, "bosun"));
  return [...dirs].filter(Boolean);
}

function collectRepoPathsFromConfig(cfg, configDir) {
  const paths = [];
  const pushPath = (path) => {
    if (!path) return;
    paths.push(isAbsolute(path) ? path : resolve(configDir, path));
  };

  const repos = cfg.repositories || cfg.repos || [];
  if (Array.isArray(repos)) {
    for (const repo of repos) {
      const repoPath = typeof repo === "string" ? repo : (repo?.path || repo?.repoRoot);
      pushPath(repoPath);
    }
  }

  const workspaces = cfg.workspaces || [];
  if (Array.isArray(workspaces)) {
    for (const ws of workspaces) {
      const wsBase = ws?.path
        ? (isAbsolute(ws.path) ? ws.path : resolve(configDir, ws.path))
        : (ws?.id ? resolve(configDir, "workspaces", ws.id) : null);
      const wsRepos = ws?.repos || ws?.repositories || [];
      if (!Array.isArray(wsRepos)) continue;
      for (const repo of wsRepos) {
        const repoPath = typeof repo === "string" ? repo : (repo?.path || repo?.repoRoot);
        if (repoPath) {
          pushPath(repoPath);
          continue;
        }
        if (wsBase && repo?.name) pushPath(resolve(wsBase, repo.name));
      }
    }
  }

  return paths;
}

function ensurePromptWorkspaceGitIgnore(repoRoot) {
  const gitignorePath = resolve(repoRoot, ".gitignore");
  const entry = "/.bosun/";
  let existing = "";
  try {
    if (existsSync(gitignorePath)) {
      existing = readFileSync(gitignorePath, "utf8");
    }
  } catch {
    return;
  }
  const hasEntry = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(entry);
  if (hasEntry) return;
  const next =
    existing.endsWith("\n") || !existing ? existing : `${existing}\n`;
  try {
    writeFileSync(gitignorePath, `${next}${entry}\n`, "utf8");
  } catch {
    /* best effort */
  }
}

// ── .env loader ──────────────────────────────────────────────────────────────

function loadDotEnv(dir, options = {}) {
  const { override = false } = options;
  const envPath = resolve(dir, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (override || !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

function loadDotEnvFile(envPath, options = {}) {
  const { override = false } = options;
  const resolved = resolve(envPath);
  if (!existsSync(resolved)) return;
  const lines = readFileSync(resolved, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (override || !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

function readEnvValueFromFile(envPath, key) {
  if (!envPath || !existsSync(envPath)) return undefined;
  const lines = readFileSync(envPath, "utf8").split("\n");
  let found;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const parsedKey = trimmed.slice(0, eqIdx).trim();
    if (parsedKey !== key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    found = value;
  }
  return found;
}

function resolveKanbanBackendSource({ envPaths = [], configFilePath, configData }) {
  const key = "KANBAN_BACKEND";
  let source = "default";
  let sourcePath = null;

  if (process.env[key] != null && String(process.env[key]).trim() !== "") {
    let envFileMatch = null;
    for (const envPath of envPaths) {
      const value = readEnvValueFromFile(envPath, key);
      if (value != null && String(value).trim() !== "") {
        envFileMatch = envPath;
      }
    }
    if (envFileMatch) {
      source = "env-file";
      sourcePath = envFileMatch;
    } else {
      source = "process-env";
    }
  } else if (configData?.kanban?.backend != null) {
    source = "config-file";
    sourcePath = configFilePath || null;
  }

  return Object.freeze({
    key,
    rawValue:
      process.env[key] || configData?.kanban?.backend || "internal",
    source,
    sourcePath,
  });
}

function validateKanbanBackendConfig({ kanbanBackend, kanban, jira }) {
  if (kanbanBackend !== "jira") return;
  const missing = [];
  if (!jira?.baseUrl) missing.push("JIRA_BASE_URL");
  if (!jira?.email) missing.push("JIRA_EMAIL");
  if (!jira?.apiToken) missing.push("JIRA_API_TOKEN");
  const hasProjectKey = Boolean(jira?.projectKey || kanban?.projectId);
  if (!hasProjectKey) {
    missing.push("JIRA_PROJECT_KEY (or KANBAN_PROJECT_ID)");
  }
  if (missing.length > 0) {
    throw new Error(
      `[config] KANBAN_BACKEND=jira requires ${missing.join(", ")}. ` +
        `Either configure Jira credentials/project key or switch KANBAN_BACKEND=internal.`,
    );
  }
}

function loadConfigFile(configDir) {
  for (const name of CONFIG_FILES) {
    const p = resolve(configDir, name);
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      return { path: p, data: raw };
    } catch {
      return { path: p, data: null, error: "invalid-json" };
    }
  }
  // Hint about the example template
  const examplePath = resolve(configDir, "bosun.config.example.json");
  if (existsSync(examplePath)) {
    console.log(
      `[config] No bosun.config.json found. Copy the example:\n` +
        `         cp ${examplePath} ${resolve(configDir, "bosun.config.json")}`,
    );
  }
  return { path: null, data: null };
}

// ── CLI arg parser ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { _positional: [], _flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        result[key] = args[i + 1];
        i++;
      } else {
        result._flags.add(key);
      }
    } else {
      result._positional.push(args[i]);
    }
  }
  return result;
}

// ── Config/profile helpers ───────────────────────────────────────────────────

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function applyEnvProfile(profile, options = {}) {
  if (!profile || typeof profile !== "object") return;
  const env = profile.env;
  if (!env || typeof env !== "object") return;
  const override = profile.envOverride === true || options.override === true;
  for (const [key, value] of Object.entries(env)) {
    if (!override && key in process.env) continue;
    process.env[key] = String(value);
  }
}

function applyProfileOverrides(configData, profile) {
  if (!configData || typeof configData !== "object") {
    return configData || {};
  }
  if (!profile || typeof profile !== "object") {
    return configData;
  }
  const overrides =
    profile.overrides || profile.config || profile.settings || {};
  if (!overrides || typeof overrides !== "object") {
    return configData;
  }
  return {
    ...configData,
    ...overrides,
    repositories: overrides.repositories ?? configData.repositories,
    executors: overrides.executors ?? configData.executors,
    failover: overrides.failover ?? configData.failover,
    distribution: overrides.distribution ?? configData.distribution,
    agentPrompts: overrides.agentPrompts ?? configData.agentPrompts,
  };
}

function resolveRepoPath(repoPath, baseDir) {
  if (!repoPath) return "";
  if (repoPath.startsWith("~")) {
    return resolve(
      process.env.HOME || process.env.USERPROFILE || "",
      repoPath.slice(1),
    );
  }
  return resolve(baseDir, repoPath);
}

function parseEnvBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const raw = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(raw)) return true;
  if (["false", "0", "no", "n", "off"].includes(raw)) return false;
  return defaultValue;
}

function isEnvEnabled(value, defaultValue = false) {
  return parseEnvBoolean(value, defaultValue);
}

function parseListValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }
  return String(value || "")
    .split(/[,|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferExecutorModelsFromVariant(executor, variant) {
  const normalizedExecutor = normalizeExecutorKey(executor);
  if (!normalizedExecutor) return [];
  const normalizedVariant = String(variant || "DEFAULT")
    .trim()
    .toUpperCase();
  if (!normalizedVariant || normalizedVariant === "DEFAULT") return [];

  const known = getModelsForExecutor(normalizedExecutor);
  const inferred = known.filter((model) => {
    const alias = MODEL_ALIASES[model];
    return (
      String(alias?.variant || "")
        .trim()
        .toUpperCase() === normalizedVariant
    );
  });
  if (inferred.length > 0) return inferred;

  // Fallback for variants encoded as model slug with underscores.
  const slugGuess = normalizedVariant.toLowerCase().replaceAll("_", "-");
  if (known.includes(slugGuess)) return [slugGuess];

  return [];
}

function normalizeExecutorModels(executor, models, variant = "DEFAULT") {
  const normalizedExecutor = normalizeExecutorKey(executor);
  if (!normalizedExecutor) return [];
  const input = parseListValue(models);
  const known = new Set(getModelsForExecutor(normalizedExecutor));
  if (input.length === 0) {
    const inferred = inferExecutorModelsFromVariant(
      normalizedExecutor,
      variant,
    );
    return inferred.length > 0 ? inferred : [...known];
  }
  return input.filter((model) => known.has(model));
}

function normalizeExecutorEntry(entry, index = 0, total = 1) {
  if (!entry || typeof entry !== "object") return null;
  const executorType = String(entry.executor || "").trim().toUpperCase();
  if (!executorType) return null;
  const variant = String(entry.variant || "DEFAULT").trim() || "DEFAULT";
  const normalized = normalizeExecutorKey(executorType) || "codex";
  const weight = Number(entry.weight);
  const safeWeight = Number.isFinite(weight) ? weight : Math.floor(100 / Math.max(1, total));
  const role =
    String(entry.role || "").trim() ||
    (index === 0 ? "primary" : index === 1 ? "backup" : `executor-${index + 1}`);
  const name =
    String(entry.name || "").trim() ||
    `${normalized}-${String(variant || "default").toLowerCase()}`;
  const models = normalizeExecutorModels(executorType, entry.models, variant);
  const codexProfile = String(
    entry.codexProfile || entry.modelProfile || "",
  ).trim();

  return {
    name,
    executor: executorType,
    variant,
    weight: safeWeight,
    role,
    enabled: entry.enabled !== false,
    models,
    codexProfile,
  };
}

function buildDefaultTriggerTemplates({
  plannerMode,
  plannerPerCapitaThreshold,
  plannerIdleSlotThreshold,
  plannerDedupHours,
} = {}) {
  return [
    {
      id: "task-planner",
      name: "Task Planner",
      description: "Create planning tasks when backlog/slot metrics indicate replenishment.",
      enabled: false,
      action: "task-planner",
      trigger: {
        anyOf: [
          {
            kind: "metric",
            metric: "backlogPerCapita",
            operator: "lt",
            value: plannerPerCapitaThreshold,
          },
          {
            kind: "metric",
            metric: "idleSlots",
            operator: "gte",
            value: plannerIdleSlotThreshold,
          },
          {
            kind: "metric",
            metric: "backlogRemaining",
            operator: "eq",
            value: 0,
          },
        ],
      },
      minIntervalMinutes: Math.max(1, Number(plannerDedupHours || 6) * 60),
      config: {
        plannerMode,
        defaultTaskCount: Number(process.env.TASK_PLANNER_DEFAULT_COUNT || "30"),
        executor: "auto",
        model: "auto",
      },
    },
    {
      id: "daily-review-digest",
      name: "Daily Review Digest",
      description: "Create a daily review task for fleet health and backlog quality.",
      enabled: false,
      action: "create-task",
      trigger: {
        anyOf: [
          {
            kind: "interval",
            minutes: 24 * 60,
          },
        ],
      },
      minIntervalMinutes: 24 * 60,
      config: {
        title: "[m] Daily review digest",
        description:
          "Review active backlog, blocked tasks, and stale work. Capture next actions and priority adjustments.",
        priority: "medium",
        executor: "auto",
        model: "auto",
      },
    },
    {
      id: "stale-task-followup",
      name: "Stale Task Follow-up",
      description: "Create a follow-up task when stale in-progress work accumulates.",
      enabled: false,
      action: "create-task",
      trigger: {
        anyOf: [
          {
            kind: "metric",
            metric: "staleInProgressCount",
            operator: "gte",
            value: 1,
          },
        ],
      },
      minIntervalMinutes: 60,
      config: {
        title: "[m] Follow up stale in-progress tasks",
        description:
          "Audit stale in-progress tasks, unblock owners, or split work to recover flow.",
        priority: "high",
        staleHours: Number(process.env.STALE_TASK_AGE_HOURS || "24"),
        executor: "auto",
        model: "auto",
      },
    },
  ];
}

function resolveTriggerSystemConfig(configData, defaults) {
  const configTrigger =
    configData && typeof configData.triggerSystem === "object"
      ? configData.triggerSystem
      : configData && typeof configData.triggers === "object"
        ? configData.triggers
        : {};
  const templates = Array.isArray(configTrigger.templates)
    ? configTrigger.templates
    : defaults.templates;
  return Object.freeze({
    enabled: isEnvEnabled(
      process.env.TASK_TRIGGER_SYSTEM_ENABLED ?? configTrigger.enabled,
      false,
    ),
    templates,
    defaults: defaults.defaults,
  });
}

// ── Git helpers ──────────────────────────────────────────────────────────────

function detectRepoSlug(repoRoot = "") {
  const tryResolve = (cwd) => {
    try {
      const remote = execSync("git remote get-url origin", {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      const match = remote.match(/github\.com[/:]([^/]+\/[^/.]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  };

  // First try current working directory
  const direct = tryResolve(process.cwd());
  if (direct) return direct;

  // Fall back to detected repo root if provided (or detectable)
  const root = repoRoot || detectRepoRoot();
  if (root) {
    const viaRoot = tryResolve(root);
    if (viaRoot) return viaRoot;
  }

  return null;
}

function detectRepoRoot() {
  // 1. Explicit env var
  if (process.env.REPO_ROOT) {
    const envRoot = resolve(process.env.REPO_ROOT);
    if (existsSync(envRoot)) return envRoot;
  }

  // 2. Try git from cwd
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (gitRoot) return gitRoot;
  } catch {
    // not in a git repo from cwd
  }

  // 3. Bosun package directory may be inside a repo (common: scripts/bosun/ within a project)
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      cwd: __dirname,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (gitRoot) return gitRoot;
  } catch {
    // bosun installed standalone, not in a repo
  }

  // 4. Module root detection — when bosun is installed as a standalone npm package,
  //    use the module root directory as a stable base for config resolution.
  const moduleRoot = detectBosunModuleRoot();
  if (moduleRoot && moduleRoot !== process.cwd()) {
    try {
      const gitRoot = execSync("git rev-parse --show-toplevel", {
        encoding: "utf8",
        cwd: moduleRoot,
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      if (gitRoot) return gitRoot;
    } catch {
      // module root is not inside a git repo
    }
  }

  // 5. Check bosun config for workspace repos
  const configDirs = getConfigSearchDirs();
  let fallbackRepo = null;
  for (const cfgName of CONFIG_FILES) {
    for (const configDir of configDirs) {
      const cfgPath = resolve(configDir, cfgName);
      if (!existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        const repoPaths = collectRepoPathsFromConfig(cfg, configDir);
        for (const repoPath of repoPaths) {
          if (!repoPath || !existsSync(repoPath)) continue;
          if (existsSync(resolve(repoPath, ".git"))) return repoPath;
          fallbackRepo ??= repoPath;
        }
      } catch {
        /* invalid config */
      }
    }
  }
  if (fallbackRepo) return fallbackRepo;

  // 6. Final fallback — warn and return cwd.
  // git repo (e.g. when the daemon spawns with cwd=homedir), but returning
  // null would crash downstream callers like resolve(repoRoot).  The warning
  // helps diagnose "not a git repository" errors from child processes.
  console.warn("[config] detectRepoRoot: no git repository found — falling back to cwd:", process.cwd());
  return process.cwd();
}

// ── Executor Configuration ───────────────────────────────────────────────────

/**
 * Executor config schema:
 *
 * {
 *   "executors": [
 *     {
 *       "name": "copilot-claude",
 *       "executor": "COPILOT",
 *       "variant": "CLAUDE_OPUS_4_6",
 *       "weight": 50,
 *       "role": "primary",
 *       "enabled": true
 *     },
 *     {
 *       "name": "codex-default",
 *       "executor": "CODEX",
 *       "variant": "DEFAULT",
 *       "weight": 50,
 *       "role": "backup",
 *       "enabled": true
 *     }
 *   ],
 *   "failover": {
 *     "strategy": "next-in-line",   // "next-in-line" | "weighted-random" | "round-robin"
 *     "maxRetries": 3,
 *     "cooldownMinutes": 5,
 *     "disableOnConsecutiveFailures": 3
 *   },
 *   "distribution": "weighted"      // "weighted" | "round-robin" | "primary-only"
 * }
 */

const DEFAULT_EXECUTORS = {
  executors: [
    {
      name: "codex-default",
      executor: "CODEX",
      variant: "DEFAULT",
      weight: 100,
      role: "primary",
      enabled: true,
    },
  ],
  failover: {
    strategy: "next-in-line",
    maxRetries: 3,
    cooldownMinutes: 5,
    disableOnConsecutiveFailures: 3,
  },
  distribution: "primary-only",
};

function parseExecutorsFromEnv() {
  // EXECUTORS=CODEX:DEFAULT:100:gpt-5.2-codex|gpt-5.1-codex-mini
  const raw = process.env.EXECUTORS;
  if (!raw) return null;
  const entries = raw.split(",").map((e) => e.trim());
  const executors = [];
  const roles = ["primary", "backup", "tertiary"];
  for (let i = 0; i < entries.length; i++) {
    const parts = entries[i].split(":");
    if (parts.length < 2) continue;
    const executorType = parts[0].toUpperCase();
    const models = normalizeExecutorModels(
      executorType,
      parts[3] || "",
      parts[1] || "DEFAULT",
    );
    executors.push({
      name: `${parts[0].toLowerCase()}-${parts[1].toLowerCase()}`,
      executor: executorType,
      variant: parts[1],
      weight: parts[2] ? Number(parts[2]) : Math.floor(100 / entries.length),
      role: roles[i] || `executor-${i + 1}`,
      enabled: true,
      models,
    });
  }
  return executors.length ? executors : null;
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
  return raw;
}

function normalizeKanbanBackend(value) {
  const backend = String(value || "")
    .trim()
    .toLowerCase();
  if (
    backend === "internal" ||
    backend === "github" ||
    backend === "jira" ||
    backend === "vk"
  ) {
    return backend;
  }
  return "internal";
}

function normalizeKanbanSyncPolicy(value) {
  const policy = String(value || "")
    .trim()
    .toLowerCase();
  if (policy === "internal-primary" || policy === "bidirectional") {
    return policy;
  }
  return "internal-primary";
}

function normalizeProjectRequirementsProfile(value) {
  const profile = String(value || "")
    .trim()
    .toLowerCase();
  if (
    [
      "simple-feature",
      "feature",
      "large-feature",
      "system",
      "multi-system",
    ].includes(profile)
  ) {
    return profile;
  }
  return "feature";
}

function findExecutorMetadataMatch(entry, candidates, index = 0) {
  const entryExecutor = normalizeExecutorKey(entry?.executor);
  const entryVariant = String(entry?.variant || "DEFAULT")
    .trim()
    .toUpperCase();
  const entryRole = String(entry?.role || "")
    .trim()
    .toLowerCase();

  const exact = candidates.find((candidate) =>
    normalizeExecutorKey(candidate?.executor) === entryExecutor &&
    String(candidate?.variant || "DEFAULT").trim().toUpperCase() === entryVariant &&
    String(candidate?.role || "").trim().toLowerCase() === entryRole
  );
  if (exact) return exact;

  const byExecutorAndVariant = candidates.find((candidate) =>
    normalizeExecutorKey(candidate?.executor) === entryExecutor &&
    String(candidate?.variant || "DEFAULT").trim().toUpperCase() === entryVariant
  );
  if (byExecutorAndVariant) return byExecutorAndVariant;

  return candidates[index] || null;
}

function loadExecutorConfig(configDir, configData) {
  // 1. Try env var
  const fromEnv = parseExecutorsFromEnv();

  // 2. Try config file
  let fromFile = null;
  if (configData && typeof configData === "object") {
    fromFile = configData.executors ? configData : null;
  }
  if (!fromFile) {
    for (const name of CONFIG_FILES) {
      const p = resolve(configDir, name);
      if (existsSync(p)) {
        try {
          const raw = JSON.parse(readFileSync(p, "utf8"));
          fromFile = raw.executors ? raw : null;
          break;
        } catch {
          /* invalid JSON — skip */
        }
      }
    }
  }

  const baseExecutors =
    fromEnv || fromFile?.executors || DEFAULT_EXECUTORS.executors;
  const executors = (Array.isArray(baseExecutors) ? baseExecutors : [])
    .map((entry, index, arr) => normalizeExecutorEntry(entry, index, arr.length))
    .filter(Boolean);

  // Preserve file-defined metadata (for example codexProfile) even when
  // execution topology comes from EXECUTORS env.
  if (fromEnv && Array.isArray(fromFile?.executors) && executors.length > 0) {
    const fileExecutors = fromFile.executors
      .map((entry, index, arr) => normalizeExecutorEntry(entry, index, arr.length))
      .filter(Boolean);

    for (let index = 0; index < executors.length; index++) {
      const current = executors[index];
      const match = findExecutorMetadataMatch(current, fileExecutors, index);
      if (!match) continue;
      const merged = { ...current };
      if (typeof match.name === "string" && match.name.trim()) {
        merged.name = match.name.trim();
      }
      if (typeof match.enabled === "boolean") {
        merged.enabled = match.enabled;
      }
      if (Array.isArray(match.models) && match.models.length > 0) {
        merged.models = [...new Set(match.models)];
      }
      if (match.codexProfile) {
        merged.codexProfile = match.codexProfile;
      }
      executors[index] = {
        ...merged,
      };
    }
  }
  const failover = fromFile?.failover || {
    strategy:
      process.env.FAILOVER_STRATEGY || DEFAULT_EXECUTORS.failover.strategy,
    maxRetries: Number(
      process.env.FAILOVER_MAX_RETRIES || DEFAULT_EXECUTORS.failover.maxRetries,
    ),
    cooldownMinutes: Number(
      process.env.FAILOVER_COOLDOWN_MIN ||
        DEFAULT_EXECUTORS.failover.cooldownMinutes,
    ),
    disableOnConsecutiveFailures: Number(
      process.env.FAILOVER_DISABLE_AFTER ||
        DEFAULT_EXECUTORS.failover.disableOnConsecutiveFailures,
    ),
  };
  const distribution =
    fromFile?.distribution ||
    process.env.EXECUTOR_DISTRIBUTION ||
    DEFAULT_EXECUTORS.distribution;

  return { executors, failover, distribution };
}

// ── Executor Scheduler ───────────────────────────────────────────────────────

class ExecutorScheduler {
  constructor(config) {
    this.executors = config.executors.filter((e) => e.enabled !== false);
    this.failover = config.failover;
    this.distribution = config.distribution;
    this._roundRobinIndex = 0;
    this._failureCounts = new Map(); // name → consecutive failures
    this._disabledUntil = new Map(); // name → timestamp
  }

  /** Get the next executor based on distribution strategy */
  next() {
    const available = this._getAvailable();
    if (!available.length) {
      // All disabled — reset and use primary
      this._disabledUntil.clear();
      this._failureCounts.clear();
      return this.executors[0];
    }

    switch (this.distribution) {
      case "round-robin":
        return this._roundRobin(available);
      case "primary-only":
        return available[0];
      case "weighted":
      default:
        return this._weightedSelect(available);
    }
  }

  /** Report a failure for an executor */
  recordFailure(executorName) {
    const count = (this._failureCounts.get(executorName) || 0) + 1;
    this._failureCounts.set(executorName, count);
    if (count >= this.failover.disableOnConsecutiveFailures) {
      const until = Date.now() + this.failover.cooldownMinutes * 60 * 1000;
      this._disabledUntil.set(executorName, until);
      this._failureCounts.set(executorName, 0);
    }
  }

  /** Report a success for an executor */
  recordSuccess(executorName) {
    this._failureCounts.set(executorName, 0);
    this._disabledUntil.delete(executorName);
  }

  /** Get failover executor when current one fails */
  getFailover(currentName) {
    const available = this._getAvailable().filter(
      (e) => e.name !== currentName,
    );
    if (!available.length) return null;

    switch (this.failover.strategy) {
      case "weighted-random":
        return this._weightedSelect(available);
      case "round-robin":
        return available[0];
      case "next-in-line":
      default: {
        // Find the next one by role priority
        const roleOrder = [
          "primary",
          "backup",
          "tertiary",
          ...Array.from({ length: 20 }, (_, i) => `executor-${i + 1}`),
        ];
        available.sort(
          (a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role),
        );
        return available[0];
      }
    }
  }

  /** Get summary for display */
  getSummary() {
    const total = this.executors.reduce((s, e) => s + e.weight, 0);
    return this.executors.map((e) => {
      const pct = total > 0 ? Math.round((e.weight / total) * 100) : 0;
      const disabled = this._isDisabled(e.name);
      return {
        ...e,
        percentage: pct,
        status: disabled ? "cooldown" : e.enabled ? "active" : "disabled",
        consecutiveFailures: this._failureCounts.get(e.name) || 0,
      };
    });
  }

  /** Format a display string like "COPILOT ⇄ CODEX (50/50)" */
  toDisplayString() {
    const summary = this.getSummary().filter((e) => e.status === "active");
    if (!summary.length) return "No executors available";
    return summary
      .map((e) => `${e.executor}:${e.variant}(${e.percentage}%)`)
      .join(" ⇄ ");
  }

  _getAvailable() {
    return this.executors.filter(
      (e) => e.enabled !== false && !this._isDisabled(e.name),
    );
  }

  _isDisabled(name) {
    const until = this._disabledUntil.get(name);
    if (!until) return false;
    if (Date.now() >= until) {
      this._disabledUntil.delete(name);
      return false;
    }
    return true;
  }

  _roundRobin(available) {
    const idx = this._roundRobinIndex % available.length;
    this._roundRobinIndex++;
    return available[idx];
  }

  _weightedSelect(available) {
    const totalWeight = available.reduce((s, e) => s + (e.weight || 1), 0);
    let r = Math.random() * totalWeight;
    for (const e of available) {
      r -= e.weight || 1;
      if (r <= 0) return e;
    }
    return available[available.length - 1];
  }
}

// ── Multi-Repo Support ───────────────────────────────────────────────────────

/**
 * Multi-repo config schema (supports defaults + selection):
 *
 * {
 *   "defaultRepository": "backend",
 *   "repositoryDefaults": {
 *     "orchestratorScript": "./orchestrator.ps1",
 *     "orchestratorArgs": "-MaxParallel 6",
 *     "profile": "local"
 *   },
 *   "repositories": [
 *     {
 *       "name": "backend",
 *       "path": "/path/to/backend",
 *       "slug": "org/backend",
 *       "primary": true
 *     },
 *     {
 *       "name": "frontend",
 *       "path": "/path/to/frontend",
 *       "slug": "org/frontend",
 *       "profile": "frontend"
 *     }
 *   ]
 * }
 */

function normalizeRepoEntry(entry, defaults, baseDir) {
  if (!entry || typeof entry !== "object") return null;
  const name = String(entry.name || entry.id || "").trim();
  if (!name) return null;
  const repoPath =
    entry.path || entry.repoRoot || defaults.path || defaults.repoRoot || "";
  const resolvedPath = repoPath ? resolveRepoPath(repoPath, baseDir) : "";
  const slug = entry.slug || entry.repo || defaults.slug || defaults.repo || "";
  const aliases = Array.isArray(entry.aliases)
    ? entry.aliases.map(normalizeKey).filter(Boolean)
    : [];
  return {
    ...defaults,
    ...entry,
    name,
    id: normalizeKey(name),
    path: resolvedPath,
    slug,
    aliases,
    primary: entry.primary === true || defaults.primary === true,
  };
}

function resolveRepoSelection(repositories, selection) {
  if (!repositories || repositories.length === 0) return null;
  const target = normalizeKey(selection);
  if (!target) return null;
  return (
    repositories.find((repo) => repo.id === target) ||
    repositories.find((repo) => normalizeKey(repo.name) === target) ||
    repositories.find((repo) => normalizeKey(repo.slug) === target) ||
    repositories.find((repo) => repo.aliases?.includes(target)) ||
    null
  );
}

function loadRepoConfig(configDir, configData = {}, options = {}) {
  const repoRootOverride = options.repoRootOverride || "";
  const baseDir = configDir || process.cwd();
  const repoDefaults =
    configData.repositoryDefaults || configData.repositories?.defaults || {};
  let repoEntries = null;
  if (Array.isArray(configData.repositories)) {
    repoEntries = configData.repositories;
  } else if (Array.isArray(configData.repositories?.items)) {
    repoEntries = configData.repositories.items;
  } else if (Array.isArray(configData.repositories?.list)) {
    repoEntries = configData.repositories.list;
  }

  if (repoEntries && repoEntries.length) {
    return repoEntries
      .map((entry) => normalizeRepoEntry(entry, repoDefaults, baseDir))
      .filter(Boolean);
  }

  const repoRoot = repoRootOverride || detectRepoRoot();
  const slug = detectRepoSlug();
  return [
    {
      name: basename(repoRoot),
      id: normalizeKey(basename(repoRoot)),
      path: repoRoot,
      slug: process.env.GITHUB_REPO || slug || "unknown/unknown",
      primary: true,
    },
  ];
}

function loadWorkspaceRepoConfig(configDir, configData = {}, activeWorkspace = "") {
  const workspaces = Array.isArray(configData.workspaces)
    ? configData.workspaces
    : [];
  if (workspaces.length === 0) return [];

  const targetWorkspaceId = normalizeKey(activeWorkspace || configData.activeWorkspace || "");
  const targetWorkspace =
    (targetWorkspaceId
      ? workspaces.find((workspace) => normalizeKey(workspace?.id) === targetWorkspaceId)
      : null) ||
    workspaces[0];

  if (!targetWorkspace || !Array.isArray(targetWorkspace.repos)) {
    return [];
  }

  const workspacePath = resolve(configDir, "workspaces", targetWorkspace.id);
  const activeRepoName = normalizeKey(targetWorkspace.activeRepo || "");

  return targetWorkspace.repos
    .map((repo, index) => {
      if (!repo || typeof repo !== "object") return null;
      const name = String(repo.name || repo.id || "").trim();
      if (!name) return null;
      const repoPath = resolve(workspacePath, name);
      return {
        name,
        id: normalizeKey(name),
        path: repoPath,
        slug: String(repo.slug || "").trim(),
        url: String(repo.url || "").trim(),
        workspace: String(targetWorkspace.id || "").trim(),
        primary:
          repo.primary === true ||
          (activeRepoName && normalizeKey(name) === activeRepoName) ||
          (!activeRepoName && index === 0),
      };
    })
    .filter(Boolean);
}

function loadAgentPrompts(configDir, repoRoot, configData) {
  const resolved = resolveAgentPrompts(configDir, repoRoot, configData);
  return { ...resolved.prompts, _sources: resolved.sources };
}

// ── Main Configuration Loader ────────────────────────────────────────────────

/**
 * Load the full bosun configuration.
 * Returns a frozen config object used by all modules.
 */
export function loadConfig(argv = process.argv, options = {}) {
  // Apply legacy CODEX_MONITOR_* → BOSUN_* compatibility before anything else
  applyAllCompatibility();

  const { reloadEnv = false } = options;
  const cli = parseArgs(argv);

  const repoRootForConfig = detectRepoRoot();
  // Determine config directory (where bosun stores its config)
  const configDir =
    cli["config-dir"] ||
    process.env.BOSUN_DIR ||
    resolveConfigDir(repoRootForConfig);

  const configFile = loadConfigFile(configDir);
  let configData = configFile.data || {};
  const configFileHadInvalidJson = configFile.error === "invalid-json";

  const repoRootOverride = cli["repo-root"] || process.env.REPO_ROOT || "";

  // Load workspace configuration
  const workspacesDir = resolve(configDir, "workspaces");
  const activeWorkspace = cli["workspace"] ||
    process.env.BOSUN_WORKSPACE ||
    configData.activeWorkspace ||
    configData.defaultWorkspace ||
    "";

  let repositories = loadWorkspaceRepoConfig(
    configDir,
    configData,
    activeWorkspace,
  );
  if (!repositories.length) {
    repositories = loadRepoConfig(configDir, configData, {
      repoRootOverride,
    });
  }

  const repoSelection =
    cli["repo-name"] ||
    cli.repository ||
    process.env.BOSUN_REPO ||
    process.env.BOSUN_REPO_NAME ||
    process.env.REPO_NAME ||
    configData.defaultRepository ||
    configData.defaultRepo ||
    configData.repositories?.default ||
    "";

  let selectedRepository =
    resolveRepoSelection(repositories, repoSelection) ||
    repositories.find((repo) => repo.primary) ||
    repositories[0] ||
    null;

  // Resolve repoRoot with workspace-awareness:
  // When workspaces configured and the workspace repo has .git, prefer it
  // over REPO_ROOT (env); REPO_ROOT becomes "developer root" for config only.
  const selectedRepoPath = selectedRepository?.path || "";
  const selectedRepoHasGit = selectedRepoPath && existsSync(resolve(selectedRepoPath, ".git"));
  let repoRoot = (selectedRepoHasGit ? selectedRepoPath : null) || repoRootOverride || detectRepoRoot();

  // Resolve agent execution root (workspace-aware, separate from developer root)
  const agentRepoRoot = resolveAgentRepoRoot();

  // Load .env from config dir — Bosun's .env is the primary source of truth
  // for Bosun-specific configuration, so it should override any stale shell
  // env vars.  Users who want shell vars to take precedence can use profiles
  // or set BOSUN_ENV_NO_OVERRIDE=1.
  const envOverride = reloadEnv || !isEnvEnabled(process.env.BOSUN_ENV_NO_OVERRIDE, false);
  loadDotEnv(configDir, { override: envOverride });

  // Also load .env from repo root if different
  if (resolve(repoRoot) !== resolve(configDir)) {
    loadDotEnv(repoRoot, { override: envOverride });
  }

  const initialRepoRoot = repoRoot;

  const profiles = configData.profiles || configData.envProfiles || {};
  const defaultProfile =
    configData.defaultProfile ||
    configData.defaultEnvProfile ||
    (profiles.default ? "default" : "");
  const profileName =
    cli.profile ||
    process.env.BOSUN_PROFILE ||
    process.env.BOSUN_ENV_PROFILE ||
    selectedRepository?.profile ||
    selectedRepository?.envProfile ||
    defaultProfile ||
    "";
  const profile = profileName ? profiles[profileName] : null;

  if (profile?.envFile) {
    const envFilePath = resolve(configDir, profile.envFile);
    loadDotEnvFile(envFilePath, { override: profile.envOverride === true });
  }
  applyEnvProfile(profile, { override: reloadEnv });

  // Apply profile overrides (executors, repos, etc.)
  configData = applyProfileOverrides(configData, profile);
  repositories = loadWorkspaceRepoConfig(
    configDir,
    configData,
    activeWorkspace,
  );
  if (!repositories.length) {
    repositories = loadRepoConfig(configDir, configData, { repoRootOverride });
  }
  selectedRepository =
    resolveRepoSelection(
      repositories,
      repoSelection ||
        profile?.repository ||
        profile?.repo ||
        profile?.defaultRepository ||
        "",
    ) ||
    repositories.find((repo) => repo.primary) ||
    repositories[0] ||
    null;
  {
    const selPath = selectedRepository?.path || "";
    const selHasGit = selPath && existsSync(resolve(selPath, ".git"));
    repoRoot = (selHasGit ? selPath : null) || repoRootOverride || detectRepoRoot();
  }

  if (resolve(repoRoot) !== resolve(initialRepoRoot)) {
    loadDotEnv(repoRoot, { override: envOverride });
  }

  const envPaths = [
    resolve(configDir, ".env"),
    resolve(repoRoot, ".env"),
  ].filter((p, i, arr) => arr.indexOf(p) === i);
  const kanbanSource = resolveKanbanBackendSource({
    envPaths,
    configFilePath: configFile.path,
    configData,
  });

  // ── Project identity ─────────────────────────────────────
  const projectName =
    cli["project-name"] ||
    process.env.PROJECT_NAME ||
    process.env.VK_PROJECT_NAME ||
    selectedRepository?.projectName ||
    configData.projectName ||
    detectProjectName(configDir, repoRoot);

  const repoSlug =
    cli["repo"] ||
    process.env.GITHUB_REPO ||
    selectedRepository?.slug ||
    detectRepoSlug() ||
    "unknown/unknown";

  const repoUrlBase =
    process.env.GITHUB_REPO_URL ||
    selectedRepository?.repoUrlBase ||
    `https://github.com/${repoSlug}`;

  const mode =
    (
      cli.mode ||
      process.env.BOSUN_MODE ||
      configData.mode ||
      selectedRepository?.mode ||
      ""
    )
      .toString()
      .toLowerCase() ||
    (String(findOrchestratorScript(configDir, repoRoot)).includes(
      "ve-orchestrator",
    )
      ? "virtengine"
      : "generic");

  // ── Orchestrator ─────────────────────────────────────────
  const defaultScript =
    selectedRepository?.orchestratorScript ||
    configData.orchestratorScript ||
    findOrchestratorScript(configDir, repoRoot);
  const defaultArgs =
    mode === "virtengine" ? "-MaxParallel 6 -WaitForMutex" : "";
  const rawScript =
    cli.script || process.env.ORCHESTRATOR_SCRIPT || defaultScript;
  // Resolve relative paths against configDir (not cwd) so that
  // "../ve-orchestrator.ps1" always resolves to scripts/ve-orchestrator.ps1
  // regardless of what directory the process was started from.
  let scriptPath = resolve(configDir, rawScript);
  // If the resolved path doesn't exist and rawScript is just a filename (no path separators),
  // fall back to auto-detection to find it in common locations.
  if (
    !existsSync(scriptPath) &&
    !rawScript.includes("/") &&
    !rawScript.includes("\\")
  ) {
    const autoDetected = findOrchestratorScript(configDir, repoRoot);
    if (existsSync(autoDetected)) {
      scriptPath = autoDetected;
    }
  }
  const scriptArgsRaw =
    cli.args ||
    process.env.ORCHESTRATOR_ARGS ||
    selectedRepository?.orchestratorArgs ||
    configData.orchestratorArgs ||
    defaultArgs;
  const scriptArgs = scriptArgsRaw.split(" ").filter(Boolean);

  // ── Timing ───────────────────────────────────────────────
  const restartDelayMs = Number(
    cli["restart-delay"] || process.env.RESTART_DELAY_MS || "10000",
  );
  const maxRestarts = Number(
    cli["max-restarts"] || process.env.MAX_RESTARTS || "0",
  );

  // ── Logging ──────────────────────────────────────────────
  const logDir = resolve(
    cli["log-dir"] ||
      process.env.LOG_DIR ||
      selectedRepository?.logDir ||
      configData.logDir ||
      resolve(configDir, "logs"),
  );
  // Max total size of the log directory in MB. 0 = unlimited.
  const logMaxSizeMb = Number(
    process.env.LOG_MAX_SIZE_MB ?? configData.logMaxSizeMb ?? 500,
  );
  // How often to check log folder size (minutes). 0 = only at startup.
  const logCleanupIntervalMin = Number(
    process.env.LOG_CLEANUP_INTERVAL_MIN ??
      configData.logCleanupIntervalMin ??
      30,
  );

  // ── Agent SDK Selection ───────────────────────────────────
  const agentSdk = resolveAgentSdkConfig();

  // ── Feature flags ────────────────────────────────────────
  const flags = cli._flags;
  const watchEnabled = flags.has("no-watch")
    ? false
    : configData.watchEnabled !== undefined
      ? configData.watchEnabled
      : true;
  const watchPath = resolve(
    cli["watch-path"] ||
      process.env.WATCH_PATH ||
      selectedRepository?.watchPath ||
      configData.watchPath ||
      scriptPath,
  );
  const echoLogs = flags.has("echo-logs")
    ? true
    : flags.has("no-echo-logs")
      ? false
      : configData.echoLogs !== undefined
        ? configData.echoLogs
        : false;
  const autoFixEnabled = flags.has("no-autofix")
    ? false
    : configData.autoFixEnabled !== undefined
      ? configData.autoFixEnabled
      : true;
  const interactiveShellEnabled =
    flags.has("shell") ||
    flags.has("interactive") ||
    isEnvEnabled(process.env.BOSUN_SHELL, false) ||
    isEnvEnabled(process.env.BOSUN_INTERACTIVE, false) ||
    configData.interactiveShellEnabled === true ||
    configData.shellEnabled === true;
  const preflightEnabled = flags.has("no-preflight")
    ? false
    : configData.preflightEnabled !== undefined
      ? configData.preflightEnabled
      : isEnvEnabled(process.env.BOSUN_PREFLIGHT_DISABLED, false)
        ? false
        : true;
  const preflightRetryMs = Number(
    cli["preflight-retry"] ||
      process.env.BOSUN_PREFLIGHT_RETRY_MS ||
      configData.preflightRetryMs ||
      "300000",
  );
  const codexEnabled =
    !flags.has("no-codex") &&
    (configData.codexEnabled !== undefined ? configData.codexEnabled : true) &&
    !isEnvEnabled(process.env.CODEX_SDK_DISABLED, false) &&
    agentSdk.primary === "codex";
  const primaryAgent = normalizePrimaryAgent(
    cli["primary-agent"] ||
      cli.agent ||
      process.env.PRIMARY_AGENT ||
      process.env.PRIMARY_AGENT_SDK ||
      configData.primaryAgent ||
      "codex-sdk",
  );
  const primaryAgentEnabled = isEnvEnabled(
    process.env.PRIMARY_AGENT_DISABLED,
    false,
  )
    ? false
    : primaryAgent === "codex-sdk"
      ? codexEnabled
      : primaryAgent === "copilot-sdk"
        ? !isEnvEnabled(process.env.COPILOT_SDK_DISABLED, false)
        : !isEnvEnabled(process.env.CLAUDE_SDK_DISABLED, false);

  // agentPoolEnabled: true when ANY agent SDK is available for pooled operations
  // This decouples pooled prompt execution from specific SDK selection
  const agentPoolEnabled =
    !isEnvEnabled(process.env.CODEX_SDK_DISABLED, false) ||
    !isEnvEnabled(process.env.COPILOT_SDK_DISABLED, false) ||
    !isEnvEnabled(process.env.CLAUDE_SDK_DISABLED, false);

  // ── Internal Executor ────────────────────────────────────
  // Allows the monitor to run tasks via agent-pool directly instead of
  // (or alongside) the VK executor. Modes: "internal" (default), "vk", "hybrid".
  const kanbanBackend = normalizeKanbanBackend(
    process.env.KANBAN_BACKEND || configData.kanban?.backend || "internal",
  );
  const kanbanSyncPolicy = normalizeKanbanSyncPolicy(
    process.env.KANBAN_SYNC_POLICY || configData.kanban?.syncPolicy,
  );
  const kanban = Object.freeze({
    backend: kanbanBackend,
    projectId:
      process.env.KANBAN_PROJECT_ID || configData.kanban?.projectId || null,
    syncPolicy: kanbanSyncPolicy,
  });
  const githubProjectSync = Object.freeze({
    webhookPath:
      process.env.GITHUB_PROJECT_WEBHOOK_PATH ||
      configData.kanban?.github?.project?.webhook?.path ||
      "/api/webhooks/github/project-sync",
    webhookSecret:
      process.env.GITHUB_PROJECT_WEBHOOK_SECRET ||
      process.env.GITHUB_WEBHOOK_SECRET ||
      configData.kanban?.github?.project?.webhook?.secret ||
      "",
    webhookRequireSignature: isEnvEnabled(
      process.env.GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE ??
        configData.kanban?.github?.project?.webhook?.requireSignature,
      Boolean(
        process.env.GITHUB_PROJECT_WEBHOOK_SECRET ||
          process.env.GITHUB_WEBHOOK_SECRET ||
          configData.kanban?.github?.project?.webhook?.secret,
      ),
    ),
    alertFailureThreshold: Math.max(
      1,
      Number(
        process.env.GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD ||
          configData.kanban?.github?.project?.syncMonitoring
            ?.alertFailureThreshold ||
          3,
      ),
    ),
    rateLimitAlertThreshold: Math.max(
      1,
      Number(
        process.env.GITHUB_PROJECT_SYNC_RATE_LIMIT_ALERT_THRESHOLD ||
          configData.kanban?.github?.project?.syncMonitoring
            ?.rateLimitAlertThreshold ||
          3,
      ),
    ),
  });
  const jira = Object.freeze({
    baseUrl:
      process.env.JIRA_BASE_URL || configData.kanban?.jira?.baseUrl || "",
    email: process.env.JIRA_EMAIL || configData.kanban?.jira?.email || "",
    apiToken:
      process.env.JIRA_API_TOKEN || configData.kanban?.jira?.apiToken || "",
    projectKey:
      process.env.JIRA_PROJECT_KEY || configData.kanban?.jira?.projectKey || "",
    issueType:
      process.env.JIRA_ISSUE_TYPE ||
      configData.kanban?.jira?.issueType ||
      "Task",
    baseBranchField:
      process.env.JIRA_CUSTOM_FIELD_BASE_BRANCH ||
      configData.kanban?.jira?.baseBranchField ||
      "",
    statusMapping: Object.freeze({
      todo:
        process.env.JIRA_STATUS_TODO ||
        configData.kanban?.jira?.statusMapping?.todo ||
        "To Do",
      inprogress:
        process.env.JIRA_STATUS_INPROGRESS ||
        configData.kanban?.jira?.statusMapping?.inprogress ||
        "In Progress",
      inreview:
        process.env.JIRA_STATUS_INREVIEW ||
        configData.kanban?.jira?.statusMapping?.inreview ||
        "In Review",
      done:
        process.env.JIRA_STATUS_DONE ||
        configData.kanban?.jira?.statusMapping?.done ||
        "Done",
      cancelled:
        process.env.JIRA_STATUS_CANCELLED ||
        configData.kanban?.jira?.statusMapping?.cancelled ||
        "Cancelled",
    }),
    labels: Object.freeze({
      claimed:
        process.env.JIRA_LABEL_CLAIMED ||
        configData.kanban?.jira?.labels?.claimed ||
        "codex:claimed",
      working:
        process.env.JIRA_LABEL_WORKING ||
        configData.kanban?.jira?.labels?.working ||
        "codex:working",
      stale:
        process.env.JIRA_LABEL_STALE ||
        configData.kanban?.jira?.labels?.stale ||
        "codex:stale",
      ignore:
        process.env.JIRA_LABEL_IGNORE ||
        configData.kanban?.jira?.labels?.ignore ||
        "codex:ignore",
    }),
    sharedStateFields: Object.freeze({
      ownerId:
        process.env.JIRA_CUSTOM_FIELD_OWNER_ID ||
        configData.kanban?.jira?.sharedStateFields?.ownerId ||
        "",
      attemptToken:
        process.env.JIRA_CUSTOM_FIELD_ATTEMPT_TOKEN ||
        configData.kanban?.jira?.sharedStateFields?.attemptToken ||
        "",
      attemptStarted:
        process.env.JIRA_CUSTOM_FIELD_ATTEMPT_STARTED ||
        configData.kanban?.jira?.sharedStateFields?.attemptStarted ||
        "",
      heartbeat:
        process.env.JIRA_CUSTOM_FIELD_HEARTBEAT ||
        configData.kanban?.jira?.sharedStateFields?.heartbeat ||
        "",
      retryCount:
        process.env.JIRA_CUSTOM_FIELD_RETRY_COUNT ||
        configData.kanban?.jira?.sharedStateFields?.retryCount ||
        "",
      ignoreReason:
        process.env.JIRA_CUSTOM_FIELD_IGNORE_REASON ||
        configData.kanban?.jira?.sharedStateFields?.ignoreReason ||
        "",
    }),
  });
  validateKanbanBackendConfig({ kanbanBackend, kanban, jira });

  const internalExecutorConfig = configData.internalExecutor || {};
  const envInternalExecutorParallel = configFileHadInvalidJson
    ? undefined
    : process.env.INTERNAL_EXECUTOR_PARALLEL;
  const projectRequirements = {
    profile: normalizeProjectRequirementsProfile(
      process.env.PROJECT_REQUIREMENTS_PROFILE ||
        configData.projectRequirements?.profile ||
        internalExecutorConfig.projectRequirements?.profile ||
        "feature",
    ),
    notes: String(
      process.env.PROJECT_REQUIREMENTS_NOTES ||
        configData.projectRequirements?.notes ||
        internalExecutorConfig.projectRequirements?.notes ||
        "",
    ).trim(),
  };
  const replenishMin = Math.max(
    1,
    Math.min(
      2,
      Number(
        process.env.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS ||
          internalExecutorConfig.backlogReplenishment?.minNewTasks ||
          1,
      ),
    ),
  );
  const replenishMax = Math.max(
    replenishMin,
    Math.min(
      3,
      Number(
        process.env.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS ||
          internalExecutorConfig.backlogReplenishment?.maxNewTasks ||
          2,
      ),
    ),
  );
  const executorMode = (
    process.env.EXECUTOR_MODE ||
    internalExecutorConfig.mode ||
    "internal"
  ).toLowerCase();
  const reviewAgentToggleRaw =
    process.env.INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED;
  const reviewAgentEnabled =
    reviewAgentToggleRaw !== undefined &&
    String(reviewAgentToggleRaw).trim() !== ""
      ? isEnvEnabled(reviewAgentToggleRaw, true)
      : internalExecutorConfig.reviewAgentEnabled !== false;
  const internalExecutor = {
    mode: ["vk", "internal", "hybrid"].includes(executorMode)
      ? executorMode
      : "internal",
    maxParallel: Number(
      envInternalExecutorParallel ||
        internalExecutorConfig.maxParallel ||
        3,
    ),
    baseBranchParallelLimit: Number(
      process.env.INTERNAL_EXECUTOR_BASE_BRANCH_PARALLEL ||
        internalExecutorConfig.baseBranchParallelLimit ||
        0,
    ),
    pollIntervalMs: Number(
      process.env.INTERNAL_EXECUTOR_POLL_MS ||
        internalExecutorConfig.pollIntervalMs ||
        30000,
    ),
    sdk:
      process.env.INTERNAL_EXECUTOR_SDK || internalExecutorConfig.sdk || "auto",
    taskTimeoutMs: Number(
      process.env.INTERNAL_EXECUTOR_TIMEOUT_MS ||
        internalExecutorConfig.taskTimeoutMs ||
        90 * 60 * 1000,
    ),
    maxRetries: Number(
      process.env.INTERNAL_EXECUTOR_MAX_RETRIES ||
        internalExecutorConfig.maxRetries ||
        2,
    ),
    autoCreatePr: internalExecutorConfig.autoCreatePr !== false,
    projectId:
      process.env.INTERNAL_EXECUTOR_PROJECT_ID ||
      internalExecutorConfig.projectId ||
      null,
    reviewAgentEnabled,
    reviewMaxConcurrent: Number(
      process.env.INTERNAL_EXECUTOR_REVIEW_MAX_CONCURRENT ||
        internalExecutorConfig.reviewMaxConcurrent ||
        2,
    ),
    reviewTimeoutMs: Number(
      process.env.INTERNAL_EXECUTOR_REVIEW_TIMEOUT_MS ||
        internalExecutorConfig.reviewTimeoutMs ||
        300000,
    ),
    taskClaimOwnerStaleTtlMs: Number(
      process.env.TASK_CLAIM_OWNER_STALE_TTL_MS ||
        internalExecutorConfig.taskClaimOwnerStaleTtlMs ||
        10 * 60 * 1000,
    ),
    taskClaimRenewIntervalMs: Number(
      process.env.TASK_CLAIM_RENEW_INTERVAL_MS ||
        internalExecutorConfig.taskClaimRenewIntervalMs ||
        5 * 60 * 1000,
    ),
    backlogReplenishment: {
      enabled: isEnvEnabled(
        process.env.INTERNAL_EXECUTOR_REPLENISH_ENABLED,
        internalExecutorConfig.backlogReplenishment?.enabled === true,
      ),
      minNewTasks: replenishMin,
      maxNewTasks: replenishMax,
      requirePriority: isEnvEnabled(
        process.env.INTERNAL_EXECUTOR_REPLENISH_REQUIRE_PRIORITY,
        internalExecutorConfig.backlogReplenishment?.requirePriority !== false,
      ),
    },
    projectRequirements,
  };

  // ── Vibe-Kanban ──────────────────────────────────────────
  const vkRecoveryPort = process.env.VK_RECOVERY_PORT || "54089";
  const vkRecoveryHost =
    process.env.VK_RECOVERY_HOST || process.env.VK_HOST || "0.0.0.0";
  const vkEndpointUrl =
    process.env.VK_ENDPOINT_URL ||
    process.env.VK_BASE_URL ||
    `http://127.0.0.1:${vkRecoveryPort}`;
  const vkPublicUrl = process.env.VK_PUBLIC_URL || process.env.VK_WEB_URL || "";
  const vkTaskUrlTemplate = process.env.VK_TASK_URL_TEMPLATE || "";
  const vkRecoveryCooldownMin = Number(
    process.env.VK_RECOVERY_COOLDOWN_MIN || "10",
  );
  const vkSpawnDefault =
    configData.vkSpawnEnabled !== undefined
      ? configData.vkSpawnEnabled
      : mode !== "generic";
  const vkRequiredByExecutor =
    internalExecutor.mode === "vk" || internalExecutor.mode === "hybrid";
  const vkRequiredByBoard = kanban.backend === "vk";
  const vkRuntimeRequired = vkRequiredByExecutor || vkRequiredByBoard;
  const vkSpawnEnabled =
    vkRuntimeRequired &&
    !flags.has("no-vk-spawn") &&
    !isEnvEnabled(process.env.VK_NO_SPAWN, false) &&
    vkSpawnDefault;
  const vkEnsureIntervalMs = Number(
    cli["vk-ensure-interval"] || process.env.VK_ENSURE_INTERVAL || "60000",
  );

  // ── Telegram ─────────────────────────────────────────────
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN || "";
  const telegramChatId = process.env.TELEGRAM_CHAT_ID || "";
  const telegramIntervalMin = Number(process.env.TELEGRAM_INTERVAL_MIN || "10");
  const telegramCommandPollTimeoutSec = Math.max(
    5,
    Number(process.env.TELEGRAM_COMMAND_POLL_TIMEOUT_SEC || "20"),
  );
  const telegramCommandConcurrency = Math.max(
    1,
    Number(process.env.TELEGRAM_COMMAND_CONCURRENCY || "2"),
  );
  const telegramCommandMaxBatch = Math.max(
    1,
    Number(process.env.TELEGRAM_COMMAND_MAX_BATCH || "25"),
  );
  const telegramBotEnabled = !flags.has("no-telegram-bot") && !!telegramToken;
  const telegramCommandEnabled = flags.has("telegram-commands")
    ? !telegramBotEnabled
    : false;
  // Verbosity: minimal (critical+error only), summary (default — up to warnings
  // + key info), detailed (everything including debug).
  const telegramVerbosity = (
    process.env.TELEGRAM_VERBOSITY ||
    configData.telegramVerbosity ||
    "summary"
  ).toLowerCase();

  // ── Task Planner ─────────────────────────────────────────
  // Mode: "codex-sdk" (default) runs Codex directly, "kanban" creates a VK
  // task for a real agent to plan, "disabled" turns off the planner entirely.
  const plannerMode = (
    process.env.TASK_PLANNER_MODE ||
    configData.plannerMode ||
    (mode === "generic" ? "disabled" : "codex-sdk")
  ).toLowerCase();
  const plannerPerCapitaThreshold = Number(
    process.env.TASK_PLANNER_PER_CAPITA_THRESHOLD || "1",
  );
  const plannerIdleSlotThreshold = Number(
    process.env.TASK_PLANNER_IDLE_SLOT_THRESHOLD || "1",
  );
  const plannerDedupHours = Number(process.env.TASK_PLANNER_DEDUP_HOURS || "6");
  const plannerDedupMs = Number.isFinite(plannerDedupHours)
    ? plannerDedupHours * 60 * 60 * 1000
    : 24 * 60 * 60 * 1000;

  const triggerSystemDefaults = Object.freeze({
    templates: buildDefaultTriggerTemplates({
      plannerMode,
      plannerPerCapitaThreshold,
      plannerIdleSlotThreshold,
      plannerDedupHours,
    }),
    defaults: Object.freeze({
      executor: "auto",
      model: "auto",
    }),
  });
  const triggerSystem = resolveTriggerSystemConfig(
    configData,
    triggerSystemDefaults,
  );

  // ── GitHub Reconciler ───────────────────────────────────
  const ghReconcileEnabled = isEnvEnabled(
    process.env.GH_RECONCILE_ENABLED ?? configData.ghReconcileEnabled,
    process.env.VITEST ? false : true,
  );
  const ghReconcileIntervalMs = Number(
    process.env.GH_RECONCILE_INTERVAL_MS ||
      configData.ghReconcileIntervalMs ||
      5 * 60 * 1000,
  );
  const ghReconcileMergedLookbackHours = Number(
    process.env.GH_RECONCILE_MERGED_LOOKBACK_HOURS ||
      configData.ghReconcileMergedLookbackHours ||
      72,
  );
  const ghReconcileTrackingLabels = String(
    process.env.GH_RECONCILE_TRACKING_LABELS ||
      configData.ghReconcileTrackingLabels ||
      "tracking",
  )
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  // ── Branch Routing ────────────────────────────────────────
  // Maps scope patterns (from conventional commit scopes in task titles) to
  // upstream branches.  Allows e.g. all "bosun" tasks to route to
  // "origin/ve/bosun-staging" instead of the default target branch.
  //
  // Config format (bosun.config.json):
  //   "branchRouting": {
  //     "defaultBranch": "origin/staging",
  //     "scopeMap": {
  //       "bosun": "origin/ve/bosun-staging",
  //       "veid":          "origin/staging",
  //       "provider":      "origin/staging"
  //     },
  //     "autoRebaseOnMerge": true,
  //     "assessWithSdk": true
  //   }
  //
  // Env overrides:
  //   VK_TARGET_BRANCH=origin/staging        (default branch)
  //   BRANCH_ROUTING_SCOPE_MAP=bosun:origin/ve/bosun-staging,veid:origin/staging
  //   AUTO_REBASE_ON_MERGE=true
  //   ASSESS_WITH_SDK=true
  const branchRoutingRaw = configData.branchRouting || {};
  const defaultTargetBranch =
    process.env.VK_TARGET_BRANCH ||
    branchRoutingRaw.defaultBranch ||
    "origin/main";
  const scopeMapEnv = process.env.BRANCH_ROUTING_SCOPE_MAP || "";
  const scopeMapFromEnv = {};
  if (scopeMapEnv) {
    for (const pair of scopeMapEnv.split(",")) {
      const [scope, branch] = pair.split(":").map((s) => s.trim());
      if (scope && branch) scopeMapFromEnv[scope.toLowerCase()] = branch;
    }
  }
  const scopeMap = {
    ...(branchRoutingRaw.scopeMap || {}),
    ...scopeMapFromEnv,
  };
  // Normalise keys to lowercase
  const normalizedScopeMap = {};
  for (const [key, val] of Object.entries(scopeMap)) {
    normalizedScopeMap[key.toLowerCase()] = val;
  }
  const autoRebaseOnMerge = isEnvEnabled(
    process.env.AUTO_REBASE_ON_MERGE ?? branchRoutingRaw.autoRebaseOnMerge,
    true,
  );
  const assessWithSdk = isEnvEnabled(
    process.env.ASSESS_WITH_SDK ?? branchRoutingRaw.assessWithSdk,
    true,
  );
  const branchRouting = Object.freeze({
    defaultBranch: defaultTargetBranch,
    scopeMap: Object.freeze(normalizedScopeMap),
    autoRebaseOnMerge,
    assessWithSdk,
  });

  // ── Fleet Coordination ─────────────────────────────────────
  // Multi-workstation collaboration: when 2+ bosun instances share
  // the same repo, the fleet system coordinates task planning, dispatch,
  // and conflict-aware ordering.
  const fleetEnabled = isEnvEnabled(
    process.env.FLEET_ENABLED ?? configData.fleetEnabled,
    true,
  );
  const fleetBufferMultiplier = Number(
    process.env.FLEET_BUFFER_MULTIPLIER ||
      configData.fleetBufferMultiplier ||
      "3",
  );
  const fleetSyncIntervalMs = Number(
    process.env.FLEET_SYNC_INTERVAL_MS ||
      configData.fleetSyncIntervalMs ||
      String(2 * 60 * 1000), // 2 minutes
  );
  const fleetPresenceTtlMs = Number(
    process.env.FLEET_PRESENCE_TTL_MS ||
      configData.fleetPresenceTtlMs ||
      String(5 * 60 * 1000), // 5 minutes
  );
  const fleetKnowledgeEnabled = isEnvEnabled(
    process.env.FLEET_KNOWLEDGE_ENABLED ?? configData.fleetKnowledgeEnabled,
    true,
  );
  const fleetKnowledgeFile = String(
    process.env.FLEET_KNOWLEDGE_FILE ||
      configData.fleetKnowledgeFile ||
      "AGENTS.md",
  );
  const fleet = Object.freeze({
    enabled: fleetEnabled,
    bufferMultiplier: fleetBufferMultiplier,
    syncIntervalMs: fleetSyncIntervalMs,
    presenceTtlMs: fleetPresenceTtlMs,
    knowledgeEnabled: fleetKnowledgeEnabled,
    knowledgeFile: fleetKnowledgeFile,
  });

  // ── Dependabot Auto-Merge ─────────────────────────────────
  const dependabotAutoMerge = isEnvEnabled(
    process.env.DEPENDABOT_AUTO_MERGE ?? configData.dependabotAutoMerge,
    true,
  );
  const dependabotAutoMergeIntervalMin = Number(
    process.env.DEPENDABOT_AUTO_MERGE_INTERVAL_MIN || "10",
  );
  // Merge method: squash (default), merge, rebase
  const dependabotMergeMethod = String(
    process.env.DEPENDABOT_MERGE_METHOD ||
      configData.dependabotMergeMethod ||
      "squash",
  ).toLowerCase();
  // PR authors to auto-merge (comma-separated). Default: dependabot[bot]
  const dependabotAuthors = String(
    process.env.DEPENDABOT_AUTHORS ||
      configData.dependabotAuthors ||
      "dependabot[bot],app/dependabot",
  )
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  // ── Status file ──────────────────────────────────────────
  const cacheDir = resolve(
    repoRoot,
    configData.cacheDir || selectedRepository?.cacheDir || ".cache",
  );
  // Default matches ve-orchestrator.ps1's $script:StatusStatePath
  const statusPath =
    process.env.STATUS_FILE ||
    configData.statusPath ||
    selectedRepository?.statusPath ||
    resolve(cacheDir, "ve-orchestrator-status.json");
  const lockBase =
    configData.telegramPollLockPath ||
    selectedRepository?.telegramPollLockPath ||
    resolve(cacheDir, "telegram-getupdates.lock");
  const telegramPollLockPath = lockBase.endsWith(".lock")
    ? resolve(lockBase)
    : resolve(lockBase, "telegram-getupdates.lock");

  // ── Executors ────────────────────────────────────────────
  const executorConfig = loadExecutorConfig(configDir, configData);
  const scheduler = new ExecutorScheduler(executorConfig);

  // ── Agent prompts ────────────────────────────────────────
  ensurePromptWorkspaceGitIgnore(repoRoot);
  ensureAgentPromptWorkspace(repoRoot);
  const agentPrompts = loadAgentPrompts(configDir, repoRoot, configData);
  const agentPromptSources = agentPrompts._sources || {};
  delete agentPrompts._sources;
  const agentPromptCatalog = getAgentPromptDefinitions();

  // ── First-run detection ──────────────────────────────────
  const isFirstRun = !hasSetupMarkers(configDir);

  const config = {
    // Identity
    projectName,
    mode,
    repoSlug,
    repoUrlBase,
    repoRoot,
    configDir,
    envPaths,

    // Orchestrator
    scriptPath,
    scriptArgs,
    restartDelayMs,
    maxRestarts,

    // Logging
    logDir,
    logMaxSizeMb,
    logCleanupIntervalMin,

    // Agent SDK
    agentSdk,

    // Feature flags
    watchEnabled,
    watchPath,
    echoLogs,
    autoFixEnabled,
    interactiveShellEnabled,
    preflightEnabled,
    preflightRetryMs,
    codexEnabled,
    agentPoolEnabled,
    primaryAgent,
    primaryAgentEnabled,

    // Internal Executor
    internalExecutor,
    executorMode: internalExecutor.mode,
    kanban,
    kanbanSource,
    githubProjectSync,
    jira,
    projectRequirements,

    // Voice assistant
    voice: Object.freeze(configData.voice || {}),

    // Merge Strategy
    codexAnalyzeMergeStrategy:
      codexEnabled &&
      (process.env.CODEX_ANALYZE_MERGE_STRATEGY || "").toLowerCase() !==
        "false",
    mergeStrategyTimeoutMs:
      parseInt(process.env.MERGE_STRATEGY_TIMEOUT_MS, 10) || 10 * 60 * 1000,

    // Autofix mode hint (informational — actual detection uses isDevMode())
    autofixMode: process.env.AUTOFIX_MODE || "auto",

    // Vibe-Kanban
    vkRecoveryPort,
    vkRecoveryHost,
    vkEndpointUrl,
    vkPublicUrl,
    vkTaskUrlTemplate,
    vkRecoveryCooldownMin,
    vkRuntimeRequired,
    vkSpawnEnabled,
    vkEnsureIntervalMs,

    // Telegram
    telegramToken,
    telegramChatId,
    telegramIntervalMin,
    telegramCommandPollTimeoutSec,
    telegramCommandConcurrency,
    telegramCommandMaxBatch,
    telegramBotEnabled,
    telegramCommandEnabled,
    telegramVerbosity,

    // Task Planner
    plannerMode,
    plannerPerCapitaThreshold,
    plannerIdleSlotThreshold,
    plannerDedupHours,
    plannerDedupMs,
    triggerSystem,

    // GitHub Reconciler
    githubReconcile: {
      enabled: ghReconcileEnabled,
      intervalMs: ghReconcileIntervalMs,
      mergedLookbackHours: ghReconcileMergedLookbackHours,
      trackingLabels: ghReconcileTrackingLabels,
    },

    // Dependabot Auto-Merge
    dependabotAutoMerge,
    dependabotAutoMergeIntervalMin,
    dependabotMergeMethod,
    dependabotAuthors,

    // Branch Routing
    branchRouting,

    // Fleet Coordination
    fleet,

    // Paths
    statusPath,
    telegramPollLockPath,
    cacheDir,

    // Executors
    executorConfig,
    scheduler,

    // Multi-repo / Workspaces
    repositories,
    selectedRepository,
    workspacesDir,
    activeWorkspace,
    agentRepoRoot,

    // Agent prompts
    agentPrompts,
    agentPromptSources,
    agentPromptCatalog,

    // First run
    isFirstRun,

    // Security controls
    security: Object.freeze({
      // List of trusted issue creators (primary GitHub account or configured list)
      trustedCreators:
        configData.trustedCreators ||
        process.env.BOSUN_TRUSTED_CREATORS?.split(",") ||
        [],
      // Enforce all new tasks go to backlog unless planner config allows auto-push
      enforceBacklog:
        typeof configData.enforceBacklog === "boolean"
          ? configData.enforceBacklog
          : true,
      // Control agent triggers: restrict agent activation to trusted sources
      agentTriggerControl:
        typeof configData.agentTriggerControl === "boolean"
          ? configData.agentTriggerControl
          : true,
    }),
  };

  return Object.freeze(config);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function detectProjectName(configDir, repoRoot) {
  // Try package.json in repo root
  const pkgPath = resolve(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.name) return pkg.name.replace(/^@[^/]+\//, "");
    } catch {
      /* skip */
    }
  }
  // Fallback to directory name
  return basename(repoRoot);
}

function findOrchestratorScript(configDir, repoRoot) {
  const shellModeEnv = String(process.env.BOSUN_SHELL_MODE || "")
    .trim()
    .toLowerCase();
  const shellModeRequested = ["1", "true", "yes", "on"].includes(shellModeEnv);
  const orchestratorEnv = String(process.env.ORCHESTRATOR_SCRIPT || "")
    .trim()
    .toLowerCase();
  const preferShellScript =
    shellModeRequested ||
    orchestratorEnv.endsWith(".sh") ||
    (process.platform !== "win32" && !orchestratorEnv.endsWith(".ps1"));

  const shCandidates = [
    resolve(configDir, "ve-orchestrator.sh"),
    resolve(configDir, "orchestrator.sh"),
    resolve(configDir, "..", "ve-orchestrator.sh"),
    resolve(configDir, "..", "orchestrator.sh"),
    resolve(repoRoot, "scripts", "ve-orchestrator.sh"),
    resolve(repoRoot, "scripts", "orchestrator.sh"),
    resolve(repoRoot, "ve-orchestrator.sh"),
    resolve(repoRoot, "orchestrator.sh"),
    resolve(process.cwd(), "ve-orchestrator.sh"),
    resolve(process.cwd(), "orchestrator.sh"),
    resolve(process.cwd(), "scripts", "ve-orchestrator.sh"),
  ];

  const psCandidates = [
    resolve(configDir, "ve-orchestrator.ps1"),
    resolve(configDir, "orchestrator.ps1"),
    resolve(configDir, "..", "ve-orchestrator.ps1"),
    resolve(configDir, "..", "orchestrator.ps1"),
    resolve(repoRoot, "scripts", "ve-orchestrator.ps1"),
    resolve(repoRoot, "scripts", "orchestrator.ps1"),
    resolve(repoRoot, "ve-orchestrator.ps1"),
    resolve(repoRoot, "orchestrator.ps1"),
    resolve(process.cwd(), "ve-orchestrator.ps1"),
    resolve(process.cwd(), "orchestrator.ps1"),
    resolve(process.cwd(), "scripts", "ve-orchestrator.ps1"),
  ];

  const candidates = preferShellScript
    ? [...shCandidates, ...psCandidates]
    : [...psCandidates, ...shCandidates];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return preferShellScript
    ? resolve(configDir, "..", "ve-orchestrator.sh")
    : resolve(configDir, "..", "ve-orchestrator.ps1");
}

// ── Exports ──────────────────────────────────────────────────────────────────

export {
  ExecutorScheduler,
  loadExecutorConfig,
  loadRepoConfig,
  loadAgentPrompts,
  parseEnvBoolean,
  getAgentPromptDefinitions,
  resolveAgentRepoRoot,
};
export default loadConfig;
