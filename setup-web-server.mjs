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
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 3456;
const MAX_PORT_ATTEMPTS = 20;

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

function resolveConfigDir() {
  const explicit = process.env.BOSUN_DIR;
  if (explicit) return resolve(explicit);

  // If there's already a bosun config in cwd (e.g. running from repo root), use that.
  const cwd = process.cwd();
  if ([".env", "bosun.config.json", ".bosun.json", "bosun.json"].some((f) => existsSync(resolve(cwd, f)))) {
    return cwd;
  }

  const isWindows = process.platform === "win32";
  const baseDir = isWindows
    ? process.env.APPDATA || process.env.LOCALAPPDATA || process.env.USERPROFILE || homedir()
    : process.env.HOME || process.env.XDG_CONFIG_HOME || homedir();
  return resolve(baseDir, "bosun");
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
  const configDir = resolveConfigDir();

  return {
    ok: true,
    defaults: {
      projectName: projectName || slug?.split("/").pop() || "my-project",
      repoSlug: slug,
      repoRoot,
      configDir,
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
    const configDir = resolveConfigDir();
    mkdirSync(configDir, { recursive: true });

    const { env = {}, configJson = {} } = body || {};

    // Build .env file
    const envLines = [
      "# Generated by bosun setup wizard",
      `# ${new Date().toISOString()}`,
      "",
    ];

    const envMap = {
      PROJECT_NAME: env.projectName || "",
      GITHUB_REPO: env.repoSlug || "",
      REPO_ROOT: env.repoRoot || "",
      ORCHESTRATOR_SCRIPT: env.orchestratorScript || "",
      ORCHESTRATOR_ARGS: env.orchestratorArgs || `-MaxParallel ${env.maxParallel || 6}`,
      EXECUTORS: env.executors || "",
      KANBAN_BACKEND: env.kanbanBackend || "internal",
      VK_PROJECT_DIR: configDir,
    };

    if (env.telegramToken) envMap.TELEGRAM_BOT_TOKEN = env.telegramToken;
    if (env.telegramChatId) envMap.TELEGRAM_CHAT_ID = env.telegramChatId;
    if (env.jiraUrl) envMap.JIRA_URL = env.jiraUrl;
    if (env.jiraProjectKey) envMap.JIRA_PROJECT_KEY = env.jiraProjectKey;
    if (env.jiraApiToken) envMap.JIRA_API_TOKEN = env.jiraApiToken;
    if (env.githubProjectNumber) envMap.GITHUB_PROJECT_NUMBER = String(env.githubProjectNumber);

    for (const [key, value] of Object.entries(envMap)) {
      if (value !== undefined && value !== null && value !== "") {
        envLines.push(`${key}=${value}`);
      }
    }

    const envPath = resolve(configDir, ".env");
    writeFileSync(envPath, envLines.join("\n") + "\n", "utf8");

    // Build bosun.config.json
    const config = {
      projectName: configJson.projectName || env.projectName || "my-project",
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
    if (configJson.kanban) config.kanban = configJson.kanban;

    const configPath = resolve(configDir, "bosun.config.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    return { ok: true, configDir, envPath, configPath };
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

  // API routes
  if (url.pathname.startsWith("/api/setup/")) {
    const route = url.pathname.replace("/api/setup/", "");

    try {
      switch (route) {
        case "status":
          jsonResponse(res, 200, handleStatus());
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
            server.close();
            process.exit(0);
          }, 500);
          return;
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
