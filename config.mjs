#!/usr/bin/env node

/**
 * openfleet — Configuration System
 *
 * Loads configuration from (in priority order):
 *   1. CLI flags (--key value)
 *   2. Environment variables
 *   3. .env file
 *   4. openfleet.config.json (project config)
 *   5. Built-in defaults
 *
 * Executor configuration supports N executors with weights and failover.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename, relative, isAbsolute } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveAgentSdkConfig } from "./agent-sdk.mjs";
import {
  ensureAgentPromptWorkspace,
  getAgentPromptDefinitions,
  resolveAgentPrompts,
} from "./agent-prompts.mjs";
import { applyAllCompatibility } from "./compat.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_FILES = [
  "openfleet.config.json",
  ".openfleet.json",
  "openfleet.json",
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
  const repoPath = resolve(repoRoot || process.cwd());
  const packageDir = resolve(__dirname);
  if (isPathInside(repoPath, packageDir) || hasConfigFiles(packageDir)) {
    return packageDir;
  }
  const preferWindowsDirs =
    process.platform === "win32" && !isWslInteropRuntime();
  const baseDir = preferWindowsDirs
    ? process.env.APPDATA ||
      process.env.LOCALAPPDATA ||
      process.env.USERPROFILE ||
      process.env.HOME ||
      process.cwd()
    : process.env.HOME ||
      process.env.XDG_CONFIG_HOME ||
      process.env.USERPROFILE ||
      process.env.APPDATA ||
      process.env.LOCALAPPDATA ||
      process.cwd();
  return resolve(baseDir, "openfleet");
}

function ensurePromptWorkspaceGitIgnore(repoRoot) {
  const gitignorePath = resolve(repoRoot, ".gitignore");
  const entry = "/.openfleet/";
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
  const examplePath = resolve(configDir, "openfleet.config.example.json");
  if (existsSync(examplePath)) {
    console.log(
      `[config] No openfleet.config.json found. Copy the example:\n` +
        `         cp ${examplePath} ${resolve(configDir, "openfleet.config.json")}`,
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

// ── Git helpers ──────────────────────────────────────────────────────────────

function detectRepoSlug() {
  try {
    const remote = execSync("git remote get-url origin", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const match = remote.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function detectRepoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
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
  // EXECUTORS=CODEX:DEFAULT:100
  const raw = process.env.EXECUTORS;
  if (!raw) return null;
  const entries = raw.split(",").map((e) => e.trim());
  const executors = [];
  const roles = ["primary", "backup", "tertiary"];
  for (let i = 0; i < entries.length; i++) {
    const parts = entries[i].split(":");
    if (parts.length < 2) continue;
    executors.push({
      name: `${parts[0].toLowerCase()}-${parts[1].toLowerCase()}`,
      executor: parts[0].toUpperCase(),
      variant: parts[1],
      weight: parts[2] ? Number(parts[2]) : Math.floor(100 / entries.length),
      role: roles[i] || `executor-${i + 1}`,
      enabled: true,
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

  const executors =
    fromEnv || fromFile?.executors || DEFAULT_EXECUTORS.executors;
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

function loadAgentPrompts(configDir, repoRoot, configData) {
  const resolved = resolveAgentPrompts(configDir, repoRoot, configData);
  return { ...resolved.prompts, _sources: resolved.sources };
}

// ── Main Configuration Loader ────────────────────────────────────────────────

/**
 * Load the full openfleet configuration.
 * Returns a frozen config object used by all modules.
 */
export function loadConfig(argv = process.argv, options = {}) {
  // Apply legacy CODEX_MONITOR_* → OPENFLEET_* compatibility before anything else
  applyAllCompatibility();

  const { reloadEnv = false } = options;
  const cli = parseArgs(argv);

  const repoRootForConfig = detectRepoRoot();
  // Determine config directory (where openfleet stores its config)
  const configDir =
    cli["config-dir"] ||
    process.env.OPENFLEET_DIR ||
    resolveConfigDir(repoRootForConfig);

  const configFile = loadConfigFile(configDir);
  let configData = configFile.data || {};

  const repoRootOverride = cli["repo-root"] || process.env.REPO_ROOT || "";
  let repositories = loadRepoConfig(configDir, configData, {
    repoRootOverride,
  });

  const repoSelection =
    cli["repo-name"] ||
    cli.repository ||
    process.env.OPENFLEET_REPO ||
    process.env.OPENFLEET_REPO_NAME ||
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

  let repoRoot =
    repoRootOverride || selectedRepository?.path || detectRepoRoot();

  // Load .env from config dir
  loadDotEnv(configDir, { override: reloadEnv });

  // Also load .env from repo root if different
  if (resolve(repoRoot) !== resolve(configDir)) {
    loadDotEnv(repoRoot, { override: reloadEnv });
  }

  const initialRepoRoot = repoRoot;

  const profiles = configData.profiles || configData.envProfiles || {};
  const defaultProfile =
    configData.defaultProfile ||
    configData.defaultEnvProfile ||
    (profiles.default ? "default" : "");
  const profileName =
    cli.profile ||
    process.env.OPENFLEET_PROFILE ||
    process.env.OPENFLEET_ENV_PROFILE ||
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
  repositories = loadRepoConfig(configDir, configData, { repoRootOverride });
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
  repoRoot = repoRootOverride || selectedRepository?.path || detectRepoRoot();

  if (resolve(repoRoot) !== resolve(initialRepoRoot)) {
    loadDotEnv(repoRoot, { override: reloadEnv });
  }

  const envPaths = [
    resolve(configDir, ".env"),
    resolve(repoRoot, ".env"),
  ].filter((p, i, arr) => arr.indexOf(p) === i);

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
      process.env.OPENFLEET_MODE ||
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
    isEnvEnabled(process.env.OPENFLEET_SHELL, false) ||
    isEnvEnabled(process.env.OPENFLEET_INTERACTIVE, false) ||
    configData.interactiveShellEnabled === true ||
    configData.shellEnabled === true;
  const preflightEnabled = flags.has("no-preflight")
    ? false
    : configData.preflightEnabled !== undefined
      ? configData.preflightEnabled
      : isEnvEnabled(process.env.OPENFLEET_PREFLIGHT_DISABLED, false)
        ? false
        : true;
  const preflightRetryMs = Number(
    cli["preflight-retry"] ||
      process.env.OPENFLEET_PREFLIGHT_RETRY_MS ||
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

  const internalExecutorConfig = configData.internalExecutor || {};
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
      process.env.INTERNAL_EXECUTOR_PARALLEL ||
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
  // upstream branches.  Allows e.g. all "openfleet" tasks to route to
  // "origin/ve/openfleet-staging" instead of the default target branch.
  //
  // Config format (openfleet.config.json):
  //   "branchRouting": {
  //     "defaultBranch": "origin/staging",
  //     "scopeMap": {
  //       "openfleet": "origin/ve/openfleet-staging",
  //       "veid":          "origin/staging",
  //       "provider":      "origin/staging"
  //     },
  //     "autoRebaseOnMerge": true,
  //     "assessWithSdk": true
  //   }
  //
  // Env overrides:
  //   VK_TARGET_BRANCH=origin/staging        (default branch)
  //   BRANCH_ROUTING_SCOPE_MAP=openfleet:origin/ve/openfleet-staging,veid:origin/staging
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
  // Multi-workstation collaboration: when 2+ openfleet instances share
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
    githubProjectSync,
    jira,
    projectRequirements,

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

    // Multi-repo
    repositories,
    selectedRepository,

    // Agent prompts
    agentPrompts,
    agentPromptSources,
    agentPromptCatalog,

    // First run
    isFirstRun,
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
  const shellModeEnv = String(process.env.OPENFLEET_SHELL_MODE || "")
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
};
export default loadConfig;
