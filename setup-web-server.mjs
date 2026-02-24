#!/usr/bin/env node

/**
 * bosun — Web-Based Setup Wizard Server
 *
 * Starts a lightweight HTTP server that serves the setup wizard UI
 * and provides REST API endpoints for configuration operations.
 *
 * Usage:
 *   bosun --setup               # launches this web wizard
 *   bosun --setup-terminal      # launches the legacy terminal wizard
 */

import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { scaffoldSkills } from "./bosun-skills.mjs";
import { ensureCodexConfig, ensureTrustedProjects } from "./codex-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Vendor file serving (hoisting-safe) ───────────────────────────────────────────
// Resolution order:
//   1. ui/vendor/ bundled files — shipped in the npm tarball, zero CDN dependency
//   2. Node module resolution via createRequire — handles global install hoisting
//   3. CDN redirect — last resort
const _require = createRequire(import.meta.url);
const BUNDLED_VENDOR_DIR = resolve(__dirname, "ui", "vendor");

const VENDOR_FILES = {
  "preact.js":                { specifier: "preact/dist/preact.module.js",                  cdn: "https://esm.sh/preact@10.25.4" },
  "preact-hooks.js":          { specifier: "preact/hooks/dist/hooks.module.js",              cdn: "https://esm.sh/preact@10.25.4/hooks" },
  "preact-compat.js":         { specifier: "preact/compat/dist/compat.module.js",            cdn: "https://esm.sh/preact@10.25.4/compat" },
  "htm.js":                   { specifier: "htm/dist/htm.module.js",                         cdn: "https://esm.sh/htm@3.1.1" },
  "preact-signals-core.js":   { specifier: "@preact/signals-core/dist/signals-core.module.js", cdn: "https://cdn.jsdelivr.net/npm/@preact/signals-core@1.8.0/dist/signals-core.module.js" },
  "preact-signals.js":        { specifier: "@preact/signals/dist/signals.module.js",         cdn: "https://esm.sh/@preact/signals@1.3.1?deps=preact@10.25.4" },
  "es-module-shims.js":       { specifier: "es-module-shims/dist/es-module-shims.js",        cdn: "https://cdn.jsdelivr.net/npm/es-module-shims@1.10.0/dist/es-module-shims.min.js" },
};

function resolveVendorPath(specifier) {
  // Direct resolution first (works when package exports allow the sub-path)
  try { return _require.resolve(specifier); } catch (e) {
    if (e.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") return null;
  }
  // ERR_PACKAGE_PATH_NOT_EXPORTED: walk up from the package main entry to find the file
  const isScoped = specifier.startsWith("@");
  const firstSlash = specifier.indexOf("/");
  const secondSlash = isScoped ? specifier.indexOf("/", firstSlash + 1) : firstSlash;
  if (secondSlash === -1) return null;
  const pkgName = specifier.slice(0, secondSlash);
  const filePath = specifier.slice(secondSlash + 1);
  try {
    const pkgMain = _require.resolve(pkgName);
    let dir = dirname(pkgMain);
    while (dir !== dirname(dir)) {
      if (existsSync(resolve(dir, "package.json"))) {
        const candidate = resolve(dir, filePath);
        return existsSync(candidate) ? candidate : null;
      }
      dir = dirname(dir);
    }
  } catch { /* not installed */ }
  return null;
}

/** Returns { ok, files: [{name, resolved, available}] } */
function checkVendorFiles() {
  const files = Object.entries(VENDOR_FILES).map(([name, { specifier, cdn }]) => {
    const resolved = resolveVendorPath(specifier);
    return { name, specifier, cdn, resolved, available: !!(resolved && existsSync(resolved)) };
  });
  const allOk = files.every((f) => f.available);
  return { ok: allOk, files };
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 3456;
const MAX_PORT_ATTEMPTS = 20;
const CALLBACK_PORT = Number(process.env.BOSUN_CALLBACK_PORT) || 54317;

const MODELS = {
  copilot: [
    { value: "claude-opus-4.6", label: "claude-opus-4.6", recommended: true },
    { value: "claude-sonnet-4.6", label: "claude-sonnet-4.6" },
    { value: "claude-opus-4.5", label: "claude-opus-4.5" },
    { value: "claude-sonnet-4.5", label: "claude-sonnet-4.5" },
    { value: "claude-sonnet-4", label: "claude-sonnet-4" },
    { value: "claude-haiku-4.5", label: "claude-haiku-4.5" },
    { value: "gpt-5.2-codex", label: "gpt-5.2-codex" },
    { value: "gpt-5.3-codex", label: "gpt-5.3-codex" },
    { value: "gpt-5.1-codex", label: "gpt-5.1-codex" },
    { value: "gpt-5.1-codex-mini", label: "gpt-5.1-codex-mini" },
    { value: "gpt-5.1-codex-max", label: "gpt-5.1-codex-max" },
    { value: "gpt-5.2", label: "gpt-5.2" },
    { value: "gpt-5.1", label: "gpt-5.1" },
    { value: "gpt-5-mini", label: "gpt-5-mini" },
    { value: "gemini-3.1-pro", label: "gemini-3.1-pro" },
    { value: "gemini-3-pro", label: "gemini-3-pro" },
    { value: "gemini-3-flash", label: "gemini-3-flash" },
    { value: "gemini-2.5-pro", label: "gemini-2.5-pro" },
    { value: "grok-code-fast-1", label: "grok-code-fast-1" },
  ],
  codex: [
    { value: "gpt-5.3-codex", label: "gpt-5.3-codex", recommended: true },
    { value: "gpt-5.2-codex", label: "gpt-5.2-codex" },
    { value: "gpt-5.1-codex", label: "gpt-5.1-codex" },
    { value: "gpt-5.1-codex-mini", label: "gpt-5.1-codex-mini" },
    { value: "gpt-5.1-codex-max", label: "gpt-5.1-codex-max" },
    { value: "gpt-5.2", label: "gpt-5.2" },
    { value: "gpt-5.1", label: "gpt-5.1" },
    { value: "gpt-5-mini", label: "gpt-5-mini" },
  ],
  claude: [
    { value: "claude-opus-4.6", label: "claude-opus-4.6", recommended: true },
    { value: "claude-sonnet-4.6", label: "claude-sonnet-4.6" },
    { value: "claude-opus-4.5", label: "claude-opus-4.5" },
    { value: "claude-sonnet-4.5", label: "claude-sonnet-4.5" },
    { value: "claude-sonnet-4", label: "claude-sonnet-4" },
    { value: "claude-haiku-4.5", label: "claude-haiku-4.5" },
  ],
};

const EXECUTOR_TYPES = [
  { value: "COPILOT", label: "GitHub Copilot (recommended)", recommended: true },
  { value: "CODEX", label: "OpenAI Codex CLI" },
  { value: "CLAUDE_CODE", label: "Claude Code" },
];

const KANBAN_BACKENDS = [
  { value: "internal", label: "Internal (SQLite — recommended)", recommended: true },
  { value: "github", label: "GitHub Projects" },
  { value: "jira", label: "Atlassian Jira" },
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getVersion() {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

function commandExists(cmd) {
  try {
    const check = process.platform === "win32"
      ? `where ${cmd} 2>nul`
      : `command -v ${cmd} 2>/dev/null`;
    execSync(check, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getCommandVersion(cmd) {
  try {
    return execSync(`${cmd} --version`, { stdio: "pipe", encoding: "utf8" }).trim().split("\n")[0];
  } catch {
    return null;
  }
}

/**
 * Resolve the Bosun Home directory — the single root where bosun stores all its
 * configs, workspaces, and tooling.  Resolution order:
 *   1. BOSUN_HOME env var  (set by bosun after first run)
 *   2. BOSUN_DIR env var   (legacy compat)
 *   3. cwd if it already has a bosun.config.json AND is not inside a git repo
 *      we don't own (safety: prevents "bosun --setup" from contaminating whatever
 *      repo the user happened to be in when they ran the command)
 *   4. ~/bosun             (cross-platform stable default)
 */
function resolveConfigDir() {
  if (process.env.BOSUN_HOME) return resolve(process.env.BOSUN_HOME);
  if (process.env.BOSUN_DIR)  return resolve(process.env.BOSUN_DIR);

  const cwd = process.cwd();

  // Only treat CWD as an existing bosun home when:
  //  (a) it has a bosun.config.json (unambiguous marker — a generic .env is NOT enough
  //      because many repos ship one and we must not corrupt them), AND
  //  (b) it does NOT appear to be a foreign git repository
  //      (i.e. there is no .git directory that was initialised by someone else).
  const hasBosunConfig = existsSync(resolve(cwd, "bosun.config.json"));
  if (hasBosunConfig) {
    // Confirm it looks like an intentional bosun home (has .env too, or is ~/bosun)
    const isExpectedHome = resolve(homedir(), "bosun") === cwd ||
      existsSync(resolve(cwd, ".env"));
    if (isExpectedHome) return cwd;
  }

  // Stable default: ~/bosun — same path on every OS
  return resolve(homedir(), "bosun");
}

/**
 * Ensure the given directory is listed in Claude Code's global
 * ~/.claude/settings.json under permissions.additionalDirectories.
 *
 * Claude Code uses this list to decide which directories outside the current
 * project root are readable/writable without per-session permission prompts.
 *
 * @param {string} dirPath  Absolute path to add
 * @returns {{ added: boolean, path: string }}
 */
function ensureClaudeAdditionalDirectory(dirPath) {
  const claudeDir = resolve(homedir(), ".claude");
  const settingsPath = resolve(claudeDir, "settings.json");
  const targetPath = resolve(dirPath);

  try {
    mkdirSync(claudeDir, { recursive: true });
    let settings = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* keep empty */ }
    }

    const perms = settings.permissions || (settings.permissions = {});
    const additional = perms.additionalDirectories || (perms.additionalDirectories = []);

    if (!additional.includes(targetPath)) {
      additional.push(targetPath);
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
      return { added: true, path: settingsPath };
    }
    return { added: false, path: settingsPath };
  } catch (err) {
    console.warn("[setup] could not update ~/.claude/settings.json:", err.message);
    return { added: false, path: settingsPath };
  }
}

/**
 * All projects live under here; global shared configs also live here.
 * Default: BOSUN_HOME/workspaces
 */
function resolveWorkspacesDir(bosunHome) {
  if (process.env.BOSUN_WORKSPACES_DIR) return resolve(process.env.BOSUN_WORKSPACES_DIR);
  return resolve(bosunHome || resolveConfigDir(), "workspaces");
}

function hasSetupMarkers(dir) {
  return [".env", "bosun.config.json", ".bosun.json", "bosun.json"]
    .some((name) => existsSync(resolve(dir, name)));
}

function detectRepoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { stdio: "pipe", encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

function detectRepoSlug() {
  try {
    const url = execSync("git remote get-url origin", { stdio: "pipe", encoding: "utf8" }).trim();
    const m = url.match(/github\.com[/:](.+?)(?:\.git)?$/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function detectProjectName(repoRoot) {
  try {
    const pkg = resolve(repoRoot, "package.json");
    if (existsSync(pkg)) {
      return JSON.parse(readFileSync(pkg, "utf8")).name || "";
    }
  } catch { /* ignore */ }
  return "";
}

function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(data);
}

function textResponse(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// ── API Handlers ─────────────────────────────────────────────────────────────

function handlePrerequisites() {
  const git = commandExists("git");
  const gh = commandExists("gh");
  const node = commandExists("node");
  const pwsh = commandExists("pwsh");

  let ghAuth = false;
  if (gh) {
    try {
      execSync("gh auth status", { stdio: "pipe" });
      ghAuth = true;
    } catch { /* not authed */ }
  }

  return {
    ok: true,
    prerequisites: {
      git: {
        installed: git,
        version: git ? getCommandVersion("git") : null,
        required: true,
      },
      gh: {
        installed: gh,
        authenticated: ghAuth,
        version: gh ? getCommandVersion("gh") : null,
        required: true,
      },
      node: {
        installed: node,
        version: node ? process.version : null,
        required: true,
      },
      pwsh: {
        installed: pwsh,
        version: pwsh ? getCommandVersion("pwsh") : null,
        required: process.platform === "win32",
      },
    },
  };
}

function handleStatus() {
  const configDir = resolveConfigDir();
  const configured = hasSetupMarkers(configDir);
  const repoRoot = detectRepoRoot();
  const slug = detectRepoSlug();
  const projectName = detectProjectName(repoRoot);

  let existingConfig = null;
  const configPath = resolve(configDir, "bosun.config.json");
  if (existsSync(configPath)) {
    try {
      existingConfig = JSON.parse(readFileSync(configPath, "utf8"));
    } catch { /* ignore */ }
  }

  let existingEnv = {};
  const envPath = resolve(configDir, ".env");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        existingEnv[key] = value;
      }
    }
  }

  return {
    ok: true,
    configured,
    configDir,
    bosunHome: configDir,
    workspacesDir: resolveWorkspacesDir(configDir),
    repoRoot,
    slug,
    projectName,
    existingConfig,
    existingEnv,
    version: getVersion(),
  };
}

function handleDefaults() {
  const repoRoot = detectRepoRoot();
  const slug = detectRepoSlug();
  const projectName = detectProjectName(repoRoot);
  const bosunHome = resolveConfigDir();
  const workspacesDir = resolveWorkspacesDir(bosunHome);

  return {
    ok: true,
    defaults: {
      projectName: projectName || slug?.split("/").pop() || "my-project",
      repoSlug: slug,
      repoRoot,
      configDir: bosunHome,
      bosunHome,
      workspacesDir,
      executor: "COPILOT",
      model: "claude-sonnet-4",
      kanbanBackend: "internal",
      maxParallel: 6,
      maxRetries: 3,
      cooldownMinutes: 5,
      distribution: "weighted",
      failoverStrategy: "next-in-line",
    },
  };
}

function handleModels() {
  return { ok: true, models: MODELS };
}

function handleExecutors() {
  return { ok: true, executors: EXECUTOR_TYPES, kanbanBackends: KANBAN_BACKENDS };
}

/**
 * Attempt to fetch the live model list from an OpenAI-compatible endpoint.
 * Falls back to the static MODELS list if the probe fails.
 */
async function handleModelsProbe(body) {
  const { executor = "CODEX", apiKey = "", baseUrl = "" } = body || {};

  // Copilot and Claude Code use OAuth — we can't probe their model lists from
  // the server side. Return the static list with a note.
  if (executor === "COPILOT" || executor === "CLAUDE_CODE") {
    const key = executor === "COPILOT" ? "copilot" : "claude";
    return {
      ok: true,
      models: MODELS[key] || [],
      source: "static",
      note: `${executor} uses OAuth authentication. Models listed are known-good values; your actual available models depend on your subscription.`,
    };
  }

  // For OpenAI / compatible endpoints, try GET /v1/models
  const resolvedBase = (baseUrl || "https://api.openai.com").replace(/\/+$/, "");
  const endpoint = `${resolvedBase}/v1/models`;

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const resp = await fetch(endpoint, { headers, signal: controller.signal });
    clearTimeout(timeout);

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }

    const data = await resp.json();
    const ids = (data.data || [])
      .map((m) => m.id)
      .filter((id) => typeof id === "string" && id.length > 0)
      .sort();

    if (!ids.length) {
      throw new Error("Response contained no models");
    }

    // Mark the first id as recommended; preserve static recommendations where
    // they overlap with the live list.
    const staticRecommended = new Set(
      (MODELS.codex || []).filter((m) => m.recommended).map((m) => m.value),
    );

    const models = ids.map((id) => ({
      value: id,
      label: id,
      recommended: staticRecommended.has(id),
      live: true,
    }));

    // If none are recommended, recommend the first
    if (!models.some((m) => m.recommended) && models.length > 0) {
      models[0].recommended = true;
    }

    return { ok: true, models, source: "live", endpoint };
  } catch (err) {
    // Probe failed — return static list with a warning
    return {
      ok: true,
      models: MODELS.codex || [],
      source: "static",
      warning: `Could not reach ${endpoint}: ${err.message}. Showing static model list.`,
    };
  }
}

function handleValidate(body) {
  const errors = {};
  const { field, value } = body || {};

  if (!field) return { ok: false, error: "Missing 'field' in request body" };

  switch (field) {
    case "projectName":
      if (!value || typeof value !== "string" || value.trim().length === 0) {
        errors.projectName = "Project name is required";
      } else if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_ -]*$/.test(value.trim())) {
        errors.projectName = "Project name must start with a letter/number and contain only letters, numbers, spaces, hyphens, underscores";
      }
      break;
    case "repoSlug":
      if (value && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value.trim())) {
        errors.repoSlug = "Repo slug must be in owner/repo format";
      }
      break;
    case "telegramToken":
      if (value && !/^\d+:[A-Za-z0-9_-]+$/.test(value.trim())) {
        errors.telegramToken = "Invalid Telegram bot token format (expected: 123456:ABCdef...)";
      }
      break;
    case "telegramChatId":
      if (value && !/^-?\d+$/.test(value.trim())) {
        errors.telegramChatId = "Chat ID must be a number (can be negative for groups)";
      }
      break;
    default:
      break;
  }

  return { ok: true, valid: Object.keys(errors).length === 0, errors };
}

function handleApply(body) {
  try {
    const { env = {}, configJson = {} } = body || {};

    // Resolve home + workspaces dirs — prefer what the user chose in the wizard
    const bosunHome    = env.bosunHome    ? resolve(env.bosunHome)    : resolveConfigDir();
    const workspacesDir = env.workspacesDir ? resolve(env.workspacesDir) : resolveWorkspacesDir(bosunHome);

    // ── Create directory scaffold ───────────────────────────────────────────
    mkdirSync(bosunHome, { recursive: true });
    mkdirSync(workspacesDir, { recursive: true });

    // Global Codex CLI settings (shared across all workspaces)
    const codexDir = resolve(workspacesDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const codexConfigPath = resolve(codexDir, "config.json");
    if (!existsSync(codexConfigPath)) {
      writeFileSync(codexConfigPath, JSON.stringify({
        "$schema": "https://openai.github.io/codex/schemas/config.json",
        fullAutoErrorMode: "ask",
        notify: false,
        history: { enabled: true, maxItems: 1000 },
        dangerouslyAllowFilePatterns: ["AGENTS.md", ".bosun/"],
      }, null, 2) + "\n", "utf8");
    }

    // Global VS Code / Copilot settings (shared across all workspaces)
    const vscodeDir = resolve(workspacesDir, ".vscode");
    mkdirSync(vscodeDir, { recursive: true });
    const vscodeSettingsPath = resolve(vscodeDir, "settings.json");
    if (!existsSync(vscodeSettingsPath)) {
      writeFileSync(vscodeSettingsPath, JSON.stringify({
        "github.copilot.enable": { "*": true },
        "github.copilot.editor.enableAutoCompletions": true,
        "chat.agent.enabled": true,
        "github.copilot.advanced": { "listCount": 10 },
      }, null, 2) + "\n", "utf8");
    }

    // Global hook templates + shared prompt library
    mkdirSync(resolve(workspacesDir, ".bosun", "hooks"),   { recursive: true });
    mkdirSync(resolve(workspacesDir, ".bosun", "prompts"), { recursive: true });

    // Scaffold built-in skills knowledge base
    try {
      scaffoldSkills(bosunHome);
    } catch (error_) {
      console.warn("[setup] skills scaffold warning:", error_.message);
    }

    // Self-documenting README
    const workspacesReadme = resolve(workspacesDir, "README.md");
    if (!existsSync(workspacesReadme)) {
      writeFileSync(workspacesReadme, [
        "# Bosun Workspaces",
        "",
        "Managed by [Bosun](https://github.com/virtengine/bosun).",
        "",
        "Each sub-directory here is a **workspace** (project). Bosun clones the repos",
        "it needs to work on into each workspace folder and manages hooks, prompts, and",
        "configs for each one.",
        "",
        "## Global settings (apply to every workspace)",
        "",
        "| Path | Purpose |",
        "|------|---------|",
        "| `.codex/config.json` | OpenAI Codex CLI config |",
        "| `.vscode/settings.json` | VS Code / Copilot settings |",
        "| `.bosun/hooks/` | Git hook templates (override per workspace) |",
        "| `.bosun/prompts/` | Shared agent prompt library |",
        "",
        "## Per-workspace settings",
        "",
        "Create `<workspace>/.bosun/config.json` to override any global setting for",
        "that workspace only. Hooks in `<workspace>/.bosun/hooks/` take priority over",
        "the global templates above.",
      ].join("\n") + "\n", "utf8");
    }

    // ── Build .env ──────────────────────────────────────────────────────────
    const envLines = [
      "# Generated by bosun setup wizard",
      `# ${new Date().toISOString()}`,
      "",
      "# Bosun home — root for all bosun data",
      `BOSUN_HOME=${bosunHome}`,
      `BOSUN_WORKSPACES_DIR=${workspacesDir}`,
      "",
    ];

    const envMap = {
      PROJECT_NAME: env.projectName || "",
      GITHUB_REPO: env.repoSlug || "",
      ORCHESTRATOR_ARGS: env.orchestratorArgs || `-MaxParallel ${env.maxParallel || 6}`,
      EXECUTORS: env.executors || "",
      KANBAN_BACKEND: env.kanbanBackend || "internal",
      VK_PROJECT_DIR: bosunHome,
    };

    if (env.telegramToken)       envMap.TELEGRAM_BOT_TOKEN      = env.telegramToken;
    if (env.telegramChatId)      envMap.TELEGRAM_CHAT_ID         = env.telegramChatId;
    if (env.jiraUrl)             envMap.JIRA_URL                 = env.jiraUrl;
    if (env.jiraProjectKey)      envMap.JIRA_PROJECT_KEY         = env.jiraProjectKey;
    if (env.jiraApiToken)        envMap.JIRA_API_TOKEN           = env.jiraApiToken;
    if (env.githubProjectNumber) envMap.GITHUB_PROJECT_NUMBER    = String(env.githubProjectNumber);

    // Write executor-specific API keys for any executor configured with api-key auth mode.
    // Executors using OAuth login (codex auth login / gh auth login / claude login)
    // do NOT need env vars — omitting them lets the executor use its stored credentials.
    if (Array.isArray(configJson.executors)) {
      for (const ex of configJson.executors) {
        if (ex?.authMode !== "api-key") continue;
        const type = (ex.executor || "").toUpperCase();
        if (type === "CODEX" || type === "OPENAI") {
          const connections = Array.isArray(ex.connections) ? ex.connections.filter((c) => c.apiKey || c.baseUrl) : [];
          if (connections.length > 0) {
            // Multi-connection path — first connection is the primary key/endpoint
            const primary = connections[0];
            if (primary.apiKey)  envMap.OPENAI_API_KEY  = primary.apiKey;
            if (primary.baseUrl) envMap.OPENAI_BASE_URL = primary.baseUrl;
            // Additional connections become named Codex model profiles
            for (let ci = 1; ci < connections.length; ci++) {
              const conn = connections[ci];
              const profileName = (conn.name || `profile${ci}`)
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, "_");
              if (conn.apiKey)  envMap[`CODEX_MODEL_PROFILE_${profileName}_API_KEY`]  = conn.apiKey;
              if (conn.baseUrl) envMap[`CODEX_MODEL_PROFILE_${profileName}_BASE_URL`] = conn.baseUrl;
            }
          } else {
            // Legacy single-key path (no connections array configured)
            if (ex.apiKey)  envMap.OPENAI_API_KEY  = ex.apiKey;
            if (ex.baseUrl) envMap.OPENAI_BASE_URL = ex.baseUrl;
          }
        } else if (type === "CLAUDE_CODE" || type === "ANTHROPIC") {
          if (ex.apiKey)  envMap.ANTHROPIC_API_KEY  = ex.apiKey;
          if (ex.baseUrl) envMap.ANTHROPIC_BASE_URL = ex.baseUrl;
          // Note: Anthropic does not have a native multi-profile env-var system;
          // only a single key/endpoint is supported for this executor type.
        }
        // COPILOT uses gh auth — no API key env vars needed.
      }
    }

    for (const [key, value] of Object.entries(envMap)) {
      if (value !== undefined && value !== null && value !== "") {
        envLines.push(`${key}=${value}`);
      }
    }

    const envPath = resolve(bosunHome, ".env");
    writeFileSync(envPath, envLines.join("\n") + "\n", "utf8");

    // ── Build bosun.config.json ─────────────────────────────────────────────
    const config = {
      projectName: configJson.projectName || env.projectName || "my-project",
      bosunHome,
      workspacesDir,
      executors: configJson.executors || [],
      failover: configJson.failover || {
        strategy: env.failoverStrategy || "next-in-line",
        maxRetries: Number(env.maxRetries) || 3,
        cooldownMinutes: Number(env.cooldownMinutes) || 5,
        disableOnConsecutiveFailures: 3,
      },
      distribution: configJson.distribution || env.distribution || "weighted",
    };

    if (configJson.repos?.length) config.repos = configJson.repos;
    if (configJson.kanban)        config.kanban = configJson.kanban;

    const configPath = resolve(bosunHome, "bosun.config.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    // ── Trust the BOSUN_HOME in every agent CLI ─────────────────────────────
    // Without this, running a codex agent from bosunHome is rejected with:
    //   "⚠ Project config.toml files are disabled…"
    // We also register bosunHome with Claude Code so it won't prompt for
    // permission when accessing the workspace directories.

    // 1. Codex: add bosunHome to trusted_projects in ~/.codex/config.toml
    try {
      const trustedResult = ensureTrustedProjects([bosunHome, workspacesDir]);
      if (trustedResult.added.length > 0) {
        console.log("  ✅ Codex: trusted bosun home directory:", trustedResult.added.join(", "));
      }
    } catch (err) {
      console.warn("[setup] could not update codex trusted_projects:", err.message);
    }

    // 2. Claude Code: add bosunHome to additionalDirectories
    try {
      const claudeResult = ensureClaudeAdditionalDirectory(bosunHome);
      const claudeWs = ensureClaudeAdditionalDirectory(workspacesDir);
      if (claudeResult.added || claudeWs.added) {
        console.log("  ✅ Claude: added bosun directories to additionalDirectories");
      }
    } catch (err) {
      console.warn("[setup] could not update claude settings:", err.message);
    }

    // 3. Call ensureCodexConfig to ensure ~/.codex/config.toml has all bosun
    //    recommended settings (MCP servers, sandbox, feature flags, etc.).
    try {
      ensureCodexConfig({
        vkBaseUrl: process.env.VK_BASE_URL || "http://127.0.0.1:54089",
        skipVk: (env.kanbanBackend || "") !== "internal" && (env.kanbanBackend || "") !== "",
        env: { ...process.env, BOSUN_HOME: bosunHome, BOSUN_WORKSPACES_DIR: workspacesDir },
      });
    } catch (err) {
      console.warn("[setup] could not update codex global config:", err.message);
    }

    return { ok: true, bosunHome, workspacesDir, envPath, configPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Server ───────────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // Health check / relay-page detection
  if (url.pathname === "/ping") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ ok: true, server: "setup" }));
    return;
  }

  // Vendor library files for the setup UI
  // Priority: bundled ui/vendor/ → node_modules resolution → CDN redirect
  if (url.pathname.startsWith("/vendor/")) {
    const name = url.pathname.replace(/^\/vendor\//, "");
    const entry = VENDOR_FILES[name];
    if (!entry) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    const vendorHeaders = {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
    };
    // ── 1. Bundled static file ─────────────────────────────────────────────
    const bundledPath = resolve(BUNDLED_VENDOR_DIR, name);
    if (existsSync(bundledPath)) {
      try {
        const data = readFileSync(bundledPath);
        res.writeHead(200, { ...vendorHeaders, "X-Bosun-Vendor": "bundled" });
        res.end(data);
        return;
      } catch { /* fall through */ }
    }
    // ── 2. node_modules resolution ────────────────────────────────────────
    const localPath = resolveVendorPath(entry.specifier);
    if (localPath && existsSync(localPath)) {
      try {
        const data = readFileSync(localPath);
        res.writeHead(200, { ...vendorHeaders, "X-Bosun-Vendor": "node_modules" });
        res.end(data);
        return;
      } catch { /* fall through to CDN */ }
    }
    // ── 3. CDN fallback ───────────────────────────────────────────────────
    res.writeHead(302, { Location: entry.cdn, "Cache-Control": "no-store" });
    res.end();
    return;
  }

  // API routes
  if (url.pathname.startsWith("/api/setup/")) {
    const route = url.pathname.replace("/api/setup/", "");

    try {
      switch (route) {
        case "status":
          jsonResponse(res, 200, handleStatus());
          return;
        case "vendor-status":
          jsonResponse(res, 200, checkVendorFiles());
          return;
        case "prerequisites":
          jsonResponse(res, 200, handlePrerequisites());
          return;
        case "defaults":
          jsonResponse(res, 200, handleDefaults());
          return;
        case "models":
          jsonResponse(res, 200, handleModels());
          return;
        case "models/probe":
          if (req.method !== "POST") {
            jsonResponse(res, 405, { ok: false, error: "POST required" });
            return;
          }
          jsonResponse(res, 200, await handleModelsProbe(await readBody(req)));
          return;
        case "executors":
          jsonResponse(res, 200, handleExecutors());
          return;
        case "validate":
          if (req.method !== "POST") {
            jsonResponse(res, 405, { ok: false, error: "POST required" });
            return;
          }
          jsonResponse(res, 200, handleValidate(await readBody(req)));
          return;
        case "apply":
          if (req.method !== "POST") {
            jsonResponse(res, 405, { ok: false, error: "POST required" });
            return;
          }
          jsonResponse(res, 200, handleApply(await readBody(req)));
          return;
        case "complete":
          if (req.method !== "POST") {
            jsonResponse(res, 405, { ok: false, error: "POST required" });
            return;
          }
          jsonResponse(res, 200, { ok: true, message: "Setup complete" });
          // Shut down server after response is sent
          setTimeout(() => {
            console.log("\n  ✅ Setup complete — shutting down wizard server.\n");
            if (callbackServer) callbackServer.close();
            server.close();
            process.exit(0);
          }, 500);
          return;
        case "oauth-state": {
          // The setup wizard polls this to detect when the GitHub OAuth callback
          // has been received (possibly on a different port).
          const pendingPath = oauthPendingPath();
          if (existsSync(pendingPath)) {
            try {
              const raw = readFileSync(pendingPath, "utf8");
              const data = JSON.parse(raw);
              // Delete the file so it's only claimed once
              try { unlinkSync(pendingPath); } catch { /* ignore */ }
              jsonResponse(res, 200, { ok: true, pending: true, ...data });
            } catch {
              jsonResponse(res, 200, { ok: true, pending: false });
            }
          } else {
            jsonResponse(res, 200, { ok: true, pending: false });
          }
          return;
        }
        default:
          jsonResponse(res, 404, { ok: false, error: `Unknown route: ${route}` });
          return;
      }
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
      return;
    }
  }

  // Static file serving from ui/
  const uiRoot = resolve(__dirname, "ui");
  let pathname = url.pathname === "/" || url.pathname === "/setup" ? "/setup.html" : url.pathname;
  const filePath = resolve(uiRoot, `.${pathname}`);

  if (!filePath.startsWith(uiRoot)) {
    textResponse(res, 403, "Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    // Fallback to setup.html for SPA-style routing
    const fallback = resolve(uiRoot, "setup.html");
    if (existsSync(fallback)) {
      const data = readFileSync(fallback);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(data);
      return;
    }
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

let server = null;
let callbackServer = null;

// Path for persisting a received OAuth code until the setup wizard claims it
function oauthPendingPath() {
  return resolve(homedir(), ".bosun", "pending-oauth.json");
}

/**
 * Starts a small HTTP server on CALLBACK_PORT (default 54317) whose only job
 * is to catch the GitHub OAuth redirect that GitHub fires after the user
 * authorises the Bosun GitHub App from the Marketplace.
 *
 * Why a separate server?
 *   • The setup wizard runs on a random port (default 3456).
 *   • The GitHub App's OAuth callback URL is registered as
 *     http://127.0.0.1:54317/github/callback in the GitHub App settings.
 *   • When a brand-new user installs from the Marketplace the OAuth redirect
 *     lands on port 54317 — but nothing is listening there unless we bind it.
 *   • This catcher runs whenever `bosun --setup` is active so the redirect is
 *     caught, the code is saved, and the user is bounced back to the wizard.
 *
 * @param {number} setupPort  The port the setup wizard is listening on
 */
async function startCallbackCatcher(setupPort) {
  const WAITING_PAGE = (port) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bosun — GitHub App Setup</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         background:#0d1117;color:#c9d1d9;display:flex;align-items:center;
         justify-content:center;min-height:100vh;padding:20px}
    .card{background:#161b22;border:1px solid #30363d;border-radius:12px;
          padding:40px 48px;max-width:520px;width:100%;text-align:center}
    h1{font-size:22px;margin-bottom:8px;color:#f0f6fc}
    p{color:#8b949e;font-size:14px;line-height:1.6;margin-bottom:20px}
    .step{background:#0d1117;border:1px solid #30363d;border-radius:8px;
          padding:12px 16px;text-align:left;margin-bottom:10px;font-size:13px}
    .step strong{color:#58a6ff}
    code{background:#30363d;padding:2px 6px;border-radius:4px;font-size:12px;
         color:#79c0ff}
    .btn{display:inline-block;margin-top:16px;padding:10px 24px;
         background:#238636;color:#fff;border-radius:6px;text-decoration:none;
         font-size:14px;font-weight:600}
    .logo{font-size:40px;margin-bottom:16px}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🚀</div>
    <h1>Bosun GitHub App Setup</h1>
    <p>Bosun needs to be running on your machine before you complete the GitHub Marketplace installation.</p>
    <div class="step"><strong>Step 1:</strong> Open a terminal and run:<br><br><code>bosun --setup</code></div>
    <div class="step"><strong>Step 2:</strong> Keep the setup wizard open, then return to the GitHub Marketplace and click <strong>Install</strong> again.</div>
    <div class="step"><strong>Step 3:</strong> GitHub will redirect back here automatically and you'll be taken to the setup wizard.</div>
    <a href="http://localhost:${port}" class="btn">Open Setup Wizard →</a>
  </div>
</body>
</html>`;

  const SUCCESS_PAGE = (setupPort) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bosun — Authorized!</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         background:#0d1117;color:#c9d1d9;display:flex;align-items:center;
         justify-content:center;min-height:100vh}
    .card{text-align:center;padding:40px;max-width:420px}
    .icon{font-size:56px;margin-bottom:16px}
    h1{color:#f0f6fc;font-size:22px;margin-bottom:8px}
    p{color:#8b949e;font-size:14px}
  </style>
  <meta http-equiv="refresh" content="2;url=http://localhost:${setupPort}/?oauth=success">
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>GitHub App Authorized!</h1>
    <p>Redirecting you to the Bosun setup wizard…</p>
  </div>
</body>
</html>`;

  callbackServer = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${CALLBACK_PORT}`);
    const pathname = url.pathname;

    // Health check for relay pages / JS polling
    if (pathname === "/ping") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ ok: true, setupPort }));
      return;
    }

    // The actual OAuth callback GitHub redirects to
    if (pathname === "/github/callback" || pathname === "/api/github/callback") {
      const code = url.searchParams.get("code") || "";
      const installationId = url.searchParams.get("installation_id") || "";
      const setupAction = url.searchParams.get("setup_action") || "";

      if (!code) {
        // No code — user navigated here directly; show instructions
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(WAITING_PAGE(setupPort));
        return;
      }

      // Persist the code so the setup wizard can pick it up via polling
      try {
        const dir = resolve(homedir(), ".bosun");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(oauthPendingPath(), JSON.stringify({
          code,
          installation_id: installationId,
          setup_action: setupAction,
          received_at: new Date().toISOString(),
        }), "utf8");
      } catch { /* non-fatal — redirect still works */ }

      // Redirect to setup wizard, passing the code as query params
      const redir = new URL(`http://localhost:${setupPort}/`);
      redir.searchParams.set("oauth_code", code);
      if (installationId) redir.searchParams.set("installation_id", installationId);
      if (setupAction) redir.searchParams.set("setup_action", setupAction);

      // Show a brief success splash, then meta-refresh to setup wizard
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_PAGE(setupPort));
      return;
    }

    // Anything else → instructions page
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(WAITING_PAGE(setupPort));
  });

  try {
    await tryListen(callbackServer, CALLBACK_PORT);
    console.log(`  📡 GitHub OAuth callback listener: http://127.0.0.1:${CALLBACK_PORT}/github/callback`);
    console.log(`     ↳ Keep this terminal open while installing from GitHub Marketplace.\n`);
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      // Another Bosun instance (or the main UI server) is already on this port — that's fine.
      console.log(`  ℹ️  Port ${CALLBACK_PORT} is already in use (main Bosun server may be running).\n`);
    } else {
      console.warn(`  ⚠️  Could not start OAuth callback listener on port ${CALLBACK_PORT}: ${err.message}`);
    }
    callbackServer = null;
  }
}

function tryListen(srv, port) {
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "0.0.0.0", () => {
      srv.removeListener("error", reject);
      resolve(srv.address().port);
    });
  });
}

function openBrowser(url) {
  const cmd =
    process.platform === "win32" ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"`
    : `xdg-open "${url}"`;
  try {
    execSync(cmd, { stdio: "ignore" });
  } catch { /* ignore — user can open manually */ }
}

export async function startSetupServer(options = {}) {
  const preferredPort = options.port ?? (Number(process.env.BOSUN_SETUP_PORT) || DEFAULT_PORT);

  server = createServer(handleRequest);

  let actualPort;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    try {
      actualPort = await tryListen(server, preferredPort + attempt);
      break;
    } catch (err) {
      if (err.code !== "EADDRINUSE" || attempt === MAX_PORT_ATTEMPTS - 1) {
        // Last resort: random port
        try {
          actualPort = await tryListen(server, 0);
          break;
        } catch (e) {
          console.error(`  ❌ Could not start setup server: ${e.message}`);
          process.exit(1);
        }
      }
    }
  }

  const url = `http://localhost:${actualPort}`;
  const version = getVersion();

  // Start the OAuth callback catcher on the dedicated callback port so that
  // GitHub Marketplace redirects land somewhere even before bosun is fully set up.
  await startCallbackCatcher(actualPort);

  console.log(`
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │   🚀  Bosun Setup Wizard v${version.padEnd(25)}│
  │                                                  │
  │   Open in your browser:                          │
  │   ${url.padEnd(45)}│
  │                                                  │
  │   Press Ctrl+C to cancel setup                   │
  │                                                  │
  └──────────────────────────────────────────────────┘
`);

  openBrowser(url);

  // Keep the process alive
  return new Promise((resolve) => {
    server.on("close", resolve);
    process.on("SIGINT", () => {
      console.log("\n  Setup cancelled.\n");
      if (callbackServer) callbackServer.close();
      server.close();
      process.exit(0);
    });
  });
}

// Entry point when run directly
const __filename_setup_web = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename_setup_web)) {
  startSetupServer().catch((err) => {
    console.error(`\n  Setup server failed: ${err.message}\n`);
    process.exit(1);
  });
}
