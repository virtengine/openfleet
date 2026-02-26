import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, isAbsolute, relative, join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILES = [
  "bosun.config.json",
  ".bosun.json",
  "bosun.json",
];

function parseBool(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function isPositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n);
}

function isUrl(value) {
  try {
    if (!value) return false;
    const parsed = new URL(String(value));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
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

function readProcValue(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function isUserNamespaceDisabled() {
  if (process.platform !== "linux") return false;
  const unpriv = readProcValue("/proc/sys/kernel/unprivileged_userns_clone");
  if (unpriv === "0") return true;
  const maxUserNs = readProcValue("/proc/sys/user/max_user_namespaces");
  if (maxUserNs && Number(maxUserNs) === 0) return true;
  return false;
}

function isPathInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function hasSetupMarkers(dir) {
  const markers = [".env", ...CONFIG_FILES];
  return markers.some((name) => existsSync(resolve(dir, name)));
}

function isWslInteropRuntime() {
  return Boolean(
    process.env.WSL_DISTRO_NAME ||
      process.env.WSL_INTEROP ||
      (process.platform === "win32" &&
        String(process.env.HOME || "").trim().startsWith("/home/")),
  );
}

function resolveConfigDir(repoRoot) {
  const explicit = process.env.BOSUN_DIR;
  if (explicit) return resolve(explicit);

  const repoPath = resolve(repoRoot || process.cwd());
  const packageDir = resolve(__dirname);
  if (isPathInside(repoPath, packageDir) || hasSetupMarkers(packageDir)) {
    return packageDir;
  }

  const preferWindowsDirs =
    process.platform === "win32" && !isWslInteropRuntime();
  const baseDir =
    preferWindowsDirs
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
  return resolve(baseDir, "bosun");
}

function loadDotEnvToObject(envPath) {
  if (!envPath || !existsSync(envPath)) return {};
  const out = {};
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function mergeNoOverride(base, extra) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    if (!(key in merged)) {
      merged[key] = value;
    }
  }
  return merged;
}

function commandExists(command) {
  try {
    const checker = process.platform === "win32" ? "where" : "which";
    spawnSync(checker, [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function findConfigFile(configDir) {
  for (const name of CONFIG_FILES) {
    const p = resolve(configDir, name);
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

function validateExecutors(raw, issues) {
  if (!raw) return;
  const entries = String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    issues.errors.push({
      code: "EXECUTORS_EMPTY",
      message: "EXECUTORS is set but empty.",
      fix: "Use format EXECUTOR:VARIANT:WEIGHT, e.g. EXECUTORS=CODEX:DEFAULT:100",
    });
    return;
  }
  for (const entry of entries) {
    const [executor, variant, weight] = entry.split(":");
    if (!executor || !variant) {
      issues.errors.push({
        code: "EXECUTORS_FORMAT",
        message: `Invalid EXECUTORS entry: ${entry}`,
        fix: "Each entry must be EXECUTOR:VARIANT[:WEIGHT]",
      });
      continue;
    }
    if (weight && !isPositiveInt(weight)) {
      issues.errors.push({
        code: "EXECUTORS_WEIGHT",
        message: `Invalid executor weight in entry: ${entry}`,
        fix: "Use integer weights > 0",
      });
    }
  }
}

export function runConfigDoctor(options = {}) {
  const repoRoot = resolve(options.repoRoot || detectRepoRoot());
  const configDir = resolve(options.configDir || resolveConfigDir(repoRoot));
  const configEnvPath = resolve(configDir, ".env");
  const repoEnvPath = resolve(repoRoot, ".env");
  const configFilePath = findConfigFile(configDir);

  const fromConfigEnv = loadDotEnvToObject(configEnvPath);
  const fromRepoEnv =
    resolve(repoEnvPath) === resolve(configEnvPath)
      ? {}
      : loadDotEnvToObject(repoEnvPath);

  let effective = {};
  effective = mergeNoOverride(effective, fromConfigEnv);
  effective = mergeNoOverride(effective, fromRepoEnv);
  effective = { ...effective, ...process.env };

  const issues = {
    errors: [],
    warnings: [],
    infos: [],
  };

  const telegramToken = effective.TELEGRAM_BOT_TOKEN || "";
  const telegramChatId = effective.TELEGRAM_CHAT_ID || "";
  if (
    (telegramToken && !telegramChatId) ||
    (!telegramToken && telegramChatId)
  ) {
    issues.errors.push({
      code: "TELEGRAM_PARTIAL",
      message:
        "Telegram is partially configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID mismatch).",
      fix: "Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or unset both.",
    });
  }

  const telegramInterval = effective.TELEGRAM_INTERVAL_MIN;
  if (telegramInterval && !isPositiveInt(telegramInterval)) {
    issues.errors.push({
      code: "TELEGRAM_INTERVAL_MIN",
      message: `Invalid TELEGRAM_INTERVAL_MIN: ${telegramInterval}`,
      fix: "Use a positive integer (minutes), e.g. TELEGRAM_INTERVAL_MIN=10",
    });
  }

  const backend = String(effective.KANBAN_BACKEND || "internal").toLowerCase();
  if (!["internal", "vk", "github", "jira"].includes(backend)) {
    issues.errors.push({
      code: "KANBAN_BACKEND",
      message: `Invalid KANBAN_BACKEND: ${effective.KANBAN_BACKEND}`,
      fix: "Use one of: internal, vk, github, jira",
    });
  }

  const syncPolicy = String(
    effective.KANBAN_SYNC_POLICY || "internal-primary",
  ).toLowerCase();
  if (!["internal-primary", "bidirectional"].includes(syncPolicy)) {
    issues.errors.push({
      code: "KANBAN_SYNC_POLICY",
      message: `Invalid KANBAN_SYNC_POLICY: ${effective.KANBAN_SYNC_POLICY}`,
      fix: "Use one of: internal-primary, bidirectional",
    });
  }

  const requirementsProfile = String(
    effective.PROJECT_REQUIREMENTS_PROFILE || "feature",
  ).toLowerCase();
  if (
    ![
      "simple-feature",
      "feature",
      "large-feature",
      "system",
      "multi-system",
    ].includes(requirementsProfile)
  ) {
    issues.errors.push({
      code: "PROJECT_REQUIREMENTS_PROFILE",
      message: `Invalid PROJECT_REQUIREMENTS_PROFILE: ${effective.PROJECT_REQUIREMENTS_PROFILE}`,
      fix: "Use one of: simple-feature, feature, large-feature, system, multi-system",
    });
  }

  const replenishMin = Number(
    effective.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS || "1",
  );
  const replenishMax = Number(
    effective.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS || "2",
  );
  if (!Number.isFinite(replenishMin) || replenishMin < 1 || replenishMin > 2) {
    issues.errors.push({
      code: "INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS",
      message: `Invalid INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS: ${effective.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS}`,
      fix: "Use an integer between 1 and 2",
    });
  }
  if (!Number.isFinite(replenishMax) || replenishMax < 1 || replenishMax > 3) {
    issues.errors.push({
      code: "INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS",
      message: `Invalid INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS: ${effective.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS}`,
      fix: "Use an integer between 1 and 3",
    });
  }
  if (
    Number.isFinite(replenishMin) &&
    Number.isFinite(replenishMax) &&
    replenishMax < replenishMin
  ) {
    issues.errors.push({
      code: "INTERNAL_EXECUTOR_REPLENISH_RANGE",
      message:
        "INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS cannot be lower than INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS.",
      fix: "Set max >= min",
    });
  }

  const mode = String(effective.EXECUTOR_MODE || "internal").toLowerCase();
  if (!["internal", "vk", "hybrid"].includes(mode)) {
    issues.errors.push({
      code: "EXECUTOR_MODE",
      message: `Invalid EXECUTOR_MODE: ${effective.EXECUTOR_MODE}`,
      fix: "Use one of: internal, vk, hybrid",
    });
  }

  validateExecutors(effective.EXECUTORS, issues);

  if (backend === "github") {
    const hasSlug =
      Boolean(effective.GITHUB_REPO) ||
      Boolean(effective.GITHUB_REPOSITORY) ||
      (Boolean(effective.GITHUB_REPO_OWNER) &&
        Boolean(effective.GITHUB_REPO_NAME));
    if (!hasSlug) {
      issues.errors.push({
        code: "GITHUB_BACKEND_REPO",
        message: "KANBAN_BACKEND=github requires repository identification.",
        fix: "Set GITHUB_REPOSITORY=owner/repo (or GITHUB_REPO, or owner + name).",
      });
    }
  }

  if (backend === "jira") {
    const missing = [];
    if (!effective.JIRA_BASE_URL) missing.push("JIRA_BASE_URL");
    if (!effective.JIRA_EMAIL) missing.push("JIRA_EMAIL");
    if (!effective.JIRA_API_TOKEN) missing.push("JIRA_API_TOKEN");
    const hasProjectKey = Boolean(
      effective.JIRA_PROJECT_KEY || effective.KANBAN_PROJECT_ID,
    );
    if (!hasProjectKey) {
      missing.push("JIRA_PROJECT_KEY (or KANBAN_PROJECT_ID)");
    }
    if (missing.length > 0) {
      issues.errors.push({
        code: "JIRA_BACKEND_REQUIRED",
        message: `KANBAN_BACKEND=jira is missing required config: ${missing.join(", ")}`,
        fix:
          "Set required JIRA_* variables (and project key), or switch KANBAN_BACKEND=internal.",
      });
    }
  }

  const vkNeeded = backend === "vk" || mode === "vk" || mode === "hybrid";
  if (vkNeeded) {
    const vkBaseUrl = effective.VK_BASE_URL || "";
    const vkPort = effective.VK_RECOVERY_PORT || "";
    if (vkBaseUrl && !isUrl(vkBaseUrl)) {
      issues.errors.push({
        code: "VK_BASE_URL",
        message: `Invalid VK_BASE_URL: ${vkBaseUrl}`,
        fix: "Use a full URL, e.g. http://127.0.0.1:54089",
      });
    }
    if (vkPort && !isPositiveInt(vkPort)) {
      issues.errors.push({
        code: "VK_RECOVERY_PORT",
        message: `Invalid VK_RECOVERY_PORT: ${vkPort}`,
        fix: "Use a positive integer port, e.g. VK_RECOVERY_PORT=54089",
      });
    }
  }

  if (parseBool(effective.WHATSAPP_ENABLED)) {
    if (!effective.WHATSAPP_CHAT_ID) {
      issues.warnings.push({
        code: "WHATSAPP_CHAT_ID",
        message: "WHATSAPP_ENABLED is on but WHATSAPP_CHAT_ID is not set.",
        fix: "Set WHATSAPP_CHAT_ID to restrict accepted chat(s).",
      });
    }
  }

  // ── API Key Validation ──────────────────────────────────────────────
  // Parse EXECUTORS to determine which SDK backends need keys
  const executorsList = String(effective.EXECUTORS || "").toLowerCase();
  const needsOpenAI =
    executorsList.includes("codex") || executorsList.includes("openai");
  const needsClaude =
    executorsList.includes("claude") || executorsList.includes("anthropic");
  const needsCopilot = executorsList.includes("copilot");

  if (needsOpenAI) {
    const openaiKey =
      effective.OPENAI_API_KEY || effective.AZURE_OPENAI_API_KEY || "";
    if (!openaiKey) {
      issues.errors.push({
        code: "OPENAI_API_KEY_MISSING",
        message:
          "EXECUTORS uses codex/openai but OPENAI_API_KEY is not set.",
        fix: "Set OPENAI_API_KEY=sk-... or AZURE_OPENAI_API_KEY in your .env",
      });
    } else if (
      openaiKey.startsWith("sk-") &&
      openaiKey.length < 20
    ) {
      issues.warnings.push({
        code: "OPENAI_API_KEY_SHORT",
        message: "OPENAI_API_KEY looks too short — may be truncated.",
        fix: "Verify the full key from platform.openai.com/api-keys",
      });
    }
  }

  if (needsClaude) {
    const claudeKey =
      effective.ANTHROPIC_API_KEY ||
      effective.CLAUDE_API_KEY ||
      effective.CLAUDE_KEY ||
      "";
    if (!claudeKey) {
      issues.errors.push({
        code: "ANTHROPIC_API_KEY_MISSING",
        message:
          "EXECUTORS uses claude/anthropic but no Anthropic API key is set.",
        fix: "Set ANTHROPIC_API_KEY=sk-ant-... in your .env",
      });
    } else if (
      !claudeKey.startsWith("sk-ant-") &&
      !claudeKey.startsWith("anthropic-")
    ) {
      issues.warnings.push({
        code: "ANTHROPIC_API_KEY_FORMAT",
        message:
          "ANTHROPIC_API_KEY doesn't match expected prefix (sk-ant-... or anthropic-...).",
        fix: "Verify the key from console.anthropic.com",
      });
    }
  }

  if (needsCopilot) {
    const ghToken = effective.GITHUB_TOKEN || "";
    if (!ghToken) {
      issues.warnings.push({
        code: "GITHUB_TOKEN_MISSING",
        message:
          "EXECUTORS uses copilot but GITHUB_TOKEN is not set. " +
          "Copilot may fall back to `gh auth token` at runtime.",
        fix: "Set GITHUB_TOKEN or run `gh auth login`",
      });
    }
  }

  // ── Model Name Validation ─────────────────────────────────────────
  const modelVars = [
    "COPILOT_MODEL",
    "CLAUDE_MODEL",
    "OPENAI_MODEL",
    "CODEX_MODEL",
  ];
  for (const varName of modelVars) {
    const val = effective[varName] || "";
    if (val && /\s/.test(val)) {
      issues.errors.push({
        code: `${varName}_INVALID`,
        message: `${varName} contains whitespace: "${val}"`,
        fix: `Fix the model name — model IDs never contain spaces`,
      });
    }
  }

  if (parseBool(effective.CONTAINER_ENABLED)) {
    const runtime = String(effective.CONTAINER_RUNTIME || "auto").toLowerCase();
    if (!["auto", "docker", "podman", "container"].includes(runtime)) {
      issues.errors.push({
        code: "CONTAINER_RUNTIME",
        message: `Invalid CONTAINER_RUNTIME: ${effective.CONTAINER_RUNTIME}`,
        fix: "Use one of: auto, docker, podman, container",
      });
    }
    if (runtime !== "auto" && !commandExists(runtime)) {
      issues.warnings.push({
        code: "CONTAINER_RUNTIME_MISSING",
        message: `Container runtime not found on PATH: ${runtime}`,
        fix: "Install runtime or set CONTAINER_RUNTIME=auto",
      });
    }
  }

  if (effective.MAX_PARALLEL && !isPositiveInt(effective.MAX_PARALLEL)) {
    issues.errors.push({
      code: "MAX_PARALLEL",
      message: `Invalid MAX_PARALLEL: ${effective.MAX_PARALLEL}`,
      fix: "Use a positive integer, e.g. MAX_PARALLEL=6",
    });
  }

  if (effective.ORCHESTRATOR_SCRIPT) {
    const scriptPath = resolve(configDir, effective.ORCHESTRATOR_SCRIPT);
    if (!existsSync(scriptPath)) {
      issues.warnings.push({
        code: "ORCHESTRATOR_SCRIPT",
        message: `ORCHESTRATOR_SCRIPT does not exist: ${effective.ORCHESTRATOR_SCRIPT}`,
        fix: "Set a valid absolute path or path relative to config directory",
      });
    }
  }

  if (configFilePath && existsSync(configFilePath)) {
    try {
      JSON.parse(readFileSync(configFilePath, "utf8"));
    } catch (error) {
      issues.errors.push({
        code: "CONFIG_JSON",
        message: `Invalid JSON in ${configFilePath}`,
        fix: `Fix JSON syntax (${error.message})`,
      });
    }
  } else {
    issues.warnings.push({
      code: "CONFIG_JSON_MISSING",
      message: "No bosun config JSON found.",
      fix: "Run bosun --setup to generate bosun.config.json",
    });
  }

  if (!existsSync(configEnvPath) && !existsSync(repoEnvPath)) {
    issues.warnings.push({
      code: "ENV_MISSING",
      message: "No .env file found in config directory or repo root.",
      fix: "Run bosun --setup to generate .env",
    });
  }

  const vscodeSettingsPath = resolve(repoRoot, ".vscode", "settings.json");
  if (!existsSync(vscodeSettingsPath)) {
    issues.warnings.push({
      code: "VSCODE_SETTINGS_MISSING",
      message:
        "No .vscode/settings.json found — Copilot autonomous/subagent defaults may be missing.",
      fix: "Run bosun --setup to generate recommended workspace settings.",
    });
  } else {
    try {
      const settings = JSON.parse(readFileSync(vscodeSettingsPath, "utf8"));
      const requiredKeys = [
        "github.copilot.chat.searchSubagent.enabled",
        "github.copilot.chat.switchAgent.enabled",
        "github.copilot.chat.cli.customAgents.enabled",
        "github.copilot.chat.cli.mcp.enabled",
      ];
      const missing = requiredKeys.filter((key) => settings[key] !== true);
      if (missing.length > 0) {
        issues.warnings.push({
          code: "VSCODE_SETTINGS_PARTIAL",
          message:
            "Workspace Copilot settings are missing recommended autonomous/subagent flags.",
          fix: "Run bosun --setup to merge the recommended .vscode/settings.json defaults.",
        });
      }
    } catch {
      issues.warnings.push({
        code: "VSCODE_SETTINGS_INVALID",
        message: ".vscode/settings.json is not valid JSON.",
        fix: "Fix JSON syntax or rerun bosun --setup to regenerate it.",
      });
    }
  }

  // ── Codex config.toml feature flag / sub-agent checks ──────────────────────
  const codexConfigToml = join(repoRoot, ".codex", "config.toml");
  if (existsSync(codexConfigToml)) {
    const toml = readFileSync(codexConfigToml, "utf-8");
    if (!/^\[features\]/m.test(toml)) {
      issues.warnings.push({
        code: "CODEX_NO_FEATURES",
        message: "Codex config.toml has no [features] section — sub-agents and advanced features disabled.",
        fix: "Run bosun --setup to auto-configure features, or add [features] manually",
      });
    } else {
      if (!/child_agents_md\s*=\s*true/i.test(toml)) {
        issues.warnings.push({
          code: "CODEX_NO_CHILD_AGENTS",
          message: "child_agents_md not enabled — Codex cannot spawn sub-agents or discover CODEX.md.",
          fix: 'Add child_agents_md = true under [features] in .codex/config.toml',
        });
      }
      if (!/memories\s*=\s*true/i.test(toml)) {
        issues.warnings.push({
          code: "CODEX_NO_MEMORY",
          message: "memories not enabled — Codex has no persistent memory across sessions.",
          fix: 'Add memories = true under [features] in .codex/config.toml',
        });
      }
    }
    if (
      !/^\s*sandbox_mode\s*=/m.test(toml) &&
      !/^\[sandbox_mode\]/m.test(toml)
    ) {
      issues.warnings.push({
        code: "CODEX_NO_SANDBOX_MODE",
        message: "No sandbox_mode in Codex config — may restrict agent file access.",
        fix: "Run bosun --setup to auto-configure sandbox mode",
      });
    }
    if (
      isUserNamespaceDisabled() &&
      /use_linux_sandbox_bwrap\s*=\s*true/i.test(toml)
    ) {
      issues.warnings.push({
        code: "CODEX_BWRAP_DISABLED",
        message: "Bubblewrap sandbox is enabled but unprivileged user namespaces appear disabled.",
        fix: "Set CODEX_FEATURES_BWRAP=false and re-run bosun --setup (or edit .codex/config.toml [features]).",
      });
    }
  } else {
    issues.warnings.push({
      code: "CODEX_CONFIG_MISSING",
      message: "repo-level .codex/config.toml not found — Codex CLI may not be configured for this workspace.",
      fix: "Run bosun --setup to create initial config",
    });
  }

  // ── CODEX.md repo-level check ──────────────────────────────────────────────
  const codexMd = join(repoRoot, "CODEX.md");
  if (!existsSync(codexMd)) {
    issues.warnings.push({
      code: "CODEX_MD_MISSING",
      message: "No CODEX.md in repo root — Codex sub-agents cannot discover repo instructions.",
      fix: "Create CODEX.md (copy from AGENTS.md) for Codex CLI sub-agent discovery",
    });
  }

  issues.infos.push({
    code: "PATHS",
    message: `Config directory: ${configDir}`,
    fix: null,
  });
  issues.infos.push({
    code: "PATHS",
    message: `Repo root: ${repoRoot}`,
    fix: null,
  });

  return {
    ok: issues.errors.length === 0,
    ...issues,
    details: {
      configDir,
      repoRoot,
      configFilePath,
      configEnvPath: existsSync(configEnvPath) ? configEnvPath : null,
      repoEnvPath:
        existsSync(repoEnvPath) &&
        resolve(repoEnvPath) !== resolve(configEnvPath)
          ? repoEnvPath
          : null,
    },
  };
}

export function formatConfigDoctorReport(result) {
  const lines = [];
  lines.push("=== bosun config doctor ===");
  lines.push(
    `Status: ${result.ok ? "OK" : "FAILED"} (${result.errors.length} error(s), ${result.warnings.length} warning(s))`,
  );
  lines.push("");

  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const issue of result.errors) {
      lines.push(`  - ${issue.message}`);
      if (issue.fix) lines.push(`    fix: ${issue.fix}`);
    }
    lines.push("");
  }

  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const issue of result.warnings) {
      lines.push(`  - ${issue.message}`);
      if (issue.fix) lines.push(`    fix: ${issue.fix}`);
    }
    lines.push("");
  }

  if (result.infos.length > 0) {
    lines.push("Info:");
    for (const info of result.infos) {
      lines.push(`  - ${info.message}`);
    }
    lines.push("");
  }

  if (result.ok) {
    lines.push("Doctor check passed — configuration looks consistent.");
  } else {
    lines.push(
      "Doctor check failed — fix the errors above and run: bosun --doctor",
    );
  }

  return lines.join("\n");
}

/**
 * Run workspace-specific health checks.
 * Validates workspace repos, git status, writable roots, worktree health.
 * @param {{ configDir?: string, repoRoot?: string }} options
 * @returns {{ ok: boolean, workspaces: Array, issues: { errors: Array, warnings: Array, infos: Array } }}
 */
export function runWorkspaceHealthCheck(options = {}) {
  const configDir = options.configDir || process.env.BOSUN_DIR || join(homedir(), "bosun");
  const repoRoot = options.repoRoot || process.cwd();
  const issues = { errors: [], warnings: [], infos: [] };
  const workspaceResults = [];

  // 1. Check if workspaces are configured
  let workspaces = [];
  try {
    const configPath = join(configDir, "bosun.config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      workspaces = config.workspaces || [];
    }
  } catch (err) {
    issues.errors.push({
      code: "WS_CONFIG_READ_FAILED",
      message: `Failed to read workspace config: ${err.message}`,
      fix: "Check bosun.config.json is valid JSON",
    });
  }

  if (workspaces.length === 0) {
    issues.infos.push({
      code: "WS_NONE_CONFIGURED",
      message: "No workspaces configured — agents use developer repo directly.",
      fix: "Run 'bosun --workspace-add <name>' to create a workspace for isolated agent execution.",
    });
    return { ok: true, workspaces: workspaceResults, issues };
  }

  // 2. Check each workspace
  for (const ws of workspaces) {
    const wsResult = {
      id: ws.id || "unknown",
      name: ws.name || ws.id || "unnamed",
      path: ws.path || "",
      repos: [],
      ok: true,
    };

    // 2a. Workspace directory exists
    const wsPath = ws.path || join(configDir, "workspaces", ws.id || ws.name);
    if (!existsSync(wsPath)) {
      issues.warnings.push({
        code: "WS_DIR_MISSING",
        message: `Workspace "${wsResult.name}" directory missing: ${wsPath}`,
        fix: `Run 'bosun --setup' or mkdir -p "${wsPath}"`,
      });
      wsResult.ok = false;
    }

    // 2b. Check repos in workspace
    for (const repo of ws.repos || []) {
      const repoName = repo.name || repo.slug || "unknown";
      const repoPath = join(wsPath, repoName);
      const repoStatus = { name: repoName, path: repoPath, ok: true, issues: [] };

      if (!existsSync(repoPath)) {
        repoStatus.ok = false;
        repoStatus.issues.push("directory missing");
        issues.errors.push({
          code: "WS_REPO_MISSING",
          message: `Workspace repo "${repoName}" not found at ${repoPath}`,
          fix: `Run 'bosun --workspace-add-repo <url>' or 'bosun --setup' to clone it`,
        });
      } else {
        const gitPath = join(repoPath, ".git");
        if (!existsSync(gitPath)) {
          repoStatus.ok = false;
          repoStatus.issues.push(".git missing");
          issues.errors.push({
            code: "WS_REPO_NO_GIT",
            message: `Workspace repo "${repoName}" has no .git at ${repoPath}`,
            fix: `Clone the repo: git clone <url> "${repoPath}"`,
          });
        } else {
          // Check remote connectivity (quick)
          try {
            const branch = execSync("git rev-parse --abbrev-ref HEAD", {
              cwd: repoPath, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
            }).trim();
            repoStatus.branch = branch;
            repoStatus.issues.push(`on branch: ${branch}`);
          } catch {
            repoStatus.issues.push("git status check failed");
          }

          // Check for uncommitted changes
          try {
            const status = execSync("git status --porcelain", {
              cwd: repoPath, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
            }).trim();
            if (status) {
              const lines = status.split("\n").length;
              repoStatus.issues.push(`${lines} uncommitted change(s)`);
              issues.infos.push({
                code: "WS_REPO_DIRTY",
                message: `Workspace repo "${repoName}" has ${lines} uncommitted change(s)`,
                fix: null,
              });
            }
          } catch { /* ignore */ }
        }
      }

      wsResult.repos.push(repoStatus);
      if (!repoStatus.ok) wsResult.ok = false;
    }

    workspaceResults.push(wsResult);
  }

  // 3. Check Codex sandbox writable_roots coverage
  const codexConfigPath = join(homedir(), ".codex", "config.toml");
  if (existsSync(codexConfigPath)) {
    try {
      const toml = readFileSync(codexConfigPath, "utf8");
      const rootsMatch = toml.match(/writable_roots\s*=\s*\[([^\]]*)\]/);
      if (rootsMatch) {
        const roots = rootsMatch[1].split(",").map(r => r.trim().replace(/^"|"$/g, "")).filter(Boolean);
        for (const ws of workspaces) {
          const wsPath = ws.path || join(configDir, "workspaces", ws.id || ws.name);
          for (const repo of ws.repos || []) {
            const repoPath = join(wsPath, repo.name || repo.slug || "");
            const gitPath = join(repoPath, ".git");
            if (existsSync(gitPath) && !roots.some(r => gitPath.startsWith(r) || r === gitPath)) {
              issues.warnings.push({
                code: "WS_SANDBOX_MISSING_ROOT",
                message: `Workspace repo .git not in Codex writable_roots: ${gitPath}`,
                fix: `Run 'bosun --setup' to update Codex sandbox config, or add "${gitPath}" to writable_roots in ~/.codex/config.toml`,
              });
            }
          }
        }

        // Check for phantom/relative writable roots
        for (const root of roots) {
          if (!root.startsWith("/")) {
            issues.warnings.push({
              code: "WS_SANDBOX_RELATIVE_ROOT",
              message: `Relative path in Codex writable_roots: "${root}" — may resolve incorrectly`,
              fix: `Remove "${root}" from writable_roots in ~/.codex/config.toml and run 'bosun --setup'`,
            });
          } else if (!existsSync(root) && root !== "/tmp") {
            issues.infos.push({
              code: "WS_SANDBOX_PHANTOM_ROOT",
              message: `Codex writable_root path does not exist: ${root}`,
              fix: null,
            });
          }
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // 4. Check BOSUN_AGENT_REPO_ROOT
  const agentRoot = process.env.BOSUN_AGENT_REPO_ROOT || "";
  if (agentRoot) {
    if (!existsSync(agentRoot)) {
      issues.warnings.push({
        code: "WS_AGENT_ROOT_MISSING",
        message: `BOSUN_AGENT_REPO_ROOT points to non-existent path: ${agentRoot}`,
        fix: "Run 'bosun --setup' to bootstrap workspace repos",
      });
    } else if (!existsSync(join(agentRoot, ".git"))) {
      issues.warnings.push({
        code: "WS_AGENT_ROOT_NO_GIT",
        message: `BOSUN_AGENT_REPO_ROOT has no .git: ${agentRoot}`,
        fix: "Clone the repo at the workspace path or update BOSUN_AGENT_REPO_ROOT",
      });
    } else {
      issues.infos.push({
        code: "WS_AGENT_ROOT_OK",
        message: `Agent repo root: ${agentRoot}`,
        fix: null,
      });
    }
  }

  const hasErrors = issues.errors.length > 0;
  return { ok: !hasErrors, workspaces: workspaceResults, issues };
}

/**
 * Format workspace health report for CLI output.
 * @param {{ ok: boolean, workspaces: Array, issues: object }} result
 * @returns {string}
 */
export function formatWorkspaceHealthReport(result) {
  const lines = [];
  lines.push("=== bosun workspace health ===");
  lines.push(`Status: ${result.ok ? "HEALTHY" : "ISSUES FOUND"}`);
  lines.push("");

  if (result.workspaces.length === 0) {
    lines.push("  No workspaces configured.");
    lines.push("");
  }

  for (const ws of result.workspaces) {
    const icon = ws.ok ? "✓" : "✗";
    lines.push(`  ${icon} ${ws.name} (${ws.id})`);
    for (const repo of ws.repos) {
      const rIcon = repo.ok ? "✓" : "✗";
      const details = repo.issues.length > 0 ? ` — ${repo.issues.join(", ")}` : "";
      lines.push(`    ${rIcon} ${repo.name}${details}`);
    }
  }
  lines.push("");

  if (result.issues.errors.length > 0) {
    lines.push("Errors:");
    for (const e of result.issues.errors) {
      lines.push(`  ✗ ${e.message}`);
      if (e.fix) lines.push(`    fix: ${e.fix}`);
    }
    lines.push("");
  }
  if (result.issues.warnings.length > 0) {
    lines.push("Warnings:");
    for (const w of result.issues.warnings) {
      lines.push(`  ⚠ ${w.message}`);
      if (w.fix) lines.push(`    fix: ${w.fix}`);
    }
    lines.push("");
  }
  if (result.issues.infos.length > 0) {
    lines.push("Info:");
    for (const i of result.issues.infos) {
      lines.push(`  ℹ ${i.message}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
