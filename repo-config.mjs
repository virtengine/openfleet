/**
 * repo-config.mjs — Generates repo-level configuration files for AI executors.
 *
 * Produces per-repo configs for all 3 AI agent SDKs:
 *   1. `.codex/config.toml`       — Codex CLI project-level config
 *   2. `.claude/settings.local.json` — Claude Code project permissions + hooks
 *   3. `.vscode/settings.json`    — VS Code / Copilot settings
 *   4. `.vscode/mcp.json`         — Copilot MCP server definitions
 *
 * Unlike the global `~/.codex/config.toml` managed by codex-config.mjs,
 * these files live **inside** the repo directory and contain only settings
 * that are project-scoped (MCP servers, sandbox permissions, features,
 * shell env policy, agent SDK).  Global/user-level settings (API keys,
 * model providers, writable_roots, stream timeouts) stay in the global
 * config.
 *
 * Usage:
 *   import { ensureRepoConfigs, printRepoConfigSummary } from "./repo-config.mjs";
 *   const result = ensureRepoConfigs("/path/to/repo", { vkBaseUrl: "..." });
 *   printRepoConfigSummary(result);
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFeaturesBlock,
  buildShellEnvPolicy,
  buildSandboxMode,
  buildSandboxWorkspaceWrite,
  buildCommonMcpBlocks,
  buildVibeKanbanBlock,
  buildAgentSdkBlock,
} from "./codex-config.mjs";

import {
  buildRecommendedVsCodeSettings,
} from "./setup.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read a JSON file, returning null on missing/invalid.
 * @param {string} filePath
 * @returns {object|null}
 */
function loadJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write a JSON file with pretty printing, creating parent dirs as needed.
 * @param {string} filePath
 * @param {object} data
 */
function writeJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/**
 * Shallow-merge two plain objects. `updates` keys overwrite `base` keys
 * except when the base value is non-empty and both are plain objects
 * (in which case we recurse).
 * @param {object} base
 * @param {object} updates
 * @returns {object}
 */
function mergePlainObjects(base, updates) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(updates || {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === "object" &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergePlainObjects(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Merge two arrays, keeping all unique entries (set union by JSON identity).
 * @param {any[]} existing
 * @param {any[]} additions
 * @returns {any[]}
 */
function mergeArrayUnique(existing, additions) {
  const seen = new Set((existing || []).map((v) => JSON.stringify(v)));
  const result = [...(existing || [])];
  for (const item of additions || []) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

/**
 * Check whether a TOML string contains a given section header.
 * @param {string} toml
 * @param {string} header  e.g. "[features]"
 * @returns {boolean}
 */
function hasTomlSection(toml, header) {
  return toml.includes(header);
}

/**
 * Append a TOML block to a string only if the section header is not present.
 * @param {string} toml     Current content
 * @param {string} header   Section header to look for
 * @param {string} block    Block to append if missing
 * @returns {{ toml: string, added: boolean }}
 */
function appendTomlBlockIfMissing(toml, header, block) {
  if (hasTomlSection(toml, header)) {
    return { toml, added: false };
  }
  return { toml: toml.trimEnd() + "\n" + block, added: true };
}

/**
 * Resolve the default bosun bridge script path.
 * @param {string} [explicit]  Explicit override
 * @returns {string}
 */
function resolveBridgePath(explicit) {
  if (explicit) return explicit;
  return resolve(__dirname, "agent-hook-bridge.mjs");
}

// ── 1. Codex project-level config.toml ──────────────────────────────────────

/**
 * Build the full content of a project-level `.codex/config.toml`.
 *
 * This generates ONLY project-scoped settings:
 *   - MCP servers (vibe_kanban, context7, sequential-thinking, playwright, microsoft-docs)
 *   - sandbox_mode
 *   - [sandbox_workspace_write]
 *   - [features] section
 *   - [shell_environment_policy]
 *   - [agent_sdk] with primary, max_threads, capabilities
 *
 * It does NOT contain (these belong in the global ~/.codex/config.toml):
 *   - [model_providers.*] — API keys are user-level
 *   - stream_idle_timeout_ms, retry settings — per-provider, global
 *
 * @param {object} options
 * @param {string}  options.repoRoot       Absolute path to the repo
 * @param {string}  [options.vkBaseUrl]    VK API base URL (default: "http://127.0.0.1:54089")
 * @param {boolean} [options.skipVk]       Whether to skip the VK MCP server (default: false)
 * @param {string}  [options.primarySdk]   "codex" | "copilot" | "claude" (default: "codex")
 * @param {object}  [options.env]          Environment overrides
 * @returns {string}  TOML content
 */
export function buildRepoCodexConfig(options = {}) {
  const {
    repoRoot,
    vkBaseUrl = "http://127.0.0.1:54089",
    skipVk = false,
    primarySdk = "codex",
    env = process.env,
  } = options;

  const parts = [
    "# Codex CLI project-level configuration",
    "# Generated by bosun repo-config — project-scoped settings only.",
    "#",
    "# Global settings (API keys, model providers) live in",
    "# ~/.codex/config.toml and are NOT duplicated here.",
    "",
  ];

  // ── Sandbox mode ──
  parts.push(buildSandboxMode(env.CODEX_SANDBOX_MODE || undefined).trim());
  parts.push("");

  // ── Sandbox workspace write ──
  if (repoRoot) {
    const workspaceWriteBlock = buildSandboxWorkspaceWrite({
      writableRoots: env.CODEX_SANDBOX_WRITABLE_ROOTS || "",
      repoRoot,
    });
    if (workspaceWriteBlock) {
      parts.push(workspaceWriteBlock.trim());
      parts.push("");
    }
  }

  // ── Features ──
  parts.push(buildFeaturesBlock(env).trim());
  parts.push("");

  // ── Shell environment policy ──
  parts.push(buildShellEnvPolicy(env.CODEX_SHELL_ENV_POLICY || "all").trim());
  parts.push("");

  // ── Agent SDK ──
  const resolvedPrimary = (() => {
    if (primarySdk && ["codex", "copilot", "claude"].includes(primarySdk)) {
      return primarySdk;
    }
    const envPrimary = (env.PRIMARY_AGENT || "").trim().toLowerCase().replace(/-sdk$/, "");
    if (["codex", "copilot", "claude"].includes(envPrimary)) return envPrimary;
    return "codex";
  })();
  parts.push(buildAgentSdkBlock({ primary: resolvedPrimary }).trim());
  parts.push("");

  // ── MCP servers ──
  if (!skipVk) {
    parts.push(buildVibeKanbanBlock({ vkBaseUrl }).trim());
    parts.push("");
  }

  parts.push(buildCommonMcpBlocks().trim());
  parts.push("");

  return parts.join("\n") + "\n";
}

/**
 * Merge a generated TOML config into an existing one.
 *
 * Strategy: for each well-known section header in the generated content,
 * if the existing content already has that section, leave it untouched.
 * Otherwise, append the section.  This preserves user customizations
 * while filling in missing defaults.
 *
 * @param {string} existing  Current file content
 * @param {string} generated Full generated content
 * @returns {string}  Merged content
 */
function mergeCodexToml(existing, generated) {
  // Extract sections from generated content
  // A section starts with a line matching /^\[.+\]/ and runs until the next
  // section header or EOF.
  const sectionRegex = /^(\[[\w._-]+\])/gm;
  const sections = [];
  let match;
  while ((match = sectionRegex.exec(generated)) !== null) {
    sections.push({ header: match[1], index: match.index });
  }

  // Also handle top-level keys that appear before the first section
  const firstSectionIdx = sections.length > 0 ? sections[0].index : generated.length;
  const preamble = generated.substring(0, firstSectionIdx);

  // Check for top-level keys in preamble (e.g. sandbox_permissions = ...)
  const topLevelKeys = [];
  for (const line of preamble.split("\n")) {
    const keyMatch = line.match(/^(\w+)\s*=/);
    if (keyMatch) topLevelKeys.push(keyMatch[1]);
  }

  let result = existing.trimEnd();

  // Add missing top-level keys
  for (const key of topLevelKeys) {
    const keyRegex = new RegExp(`^${escapeRegex(key)}\\s*=`, "m");
    if (!keyRegex.test(result)) {
      // Find the line in the preamble
      for (const line of preamble.split("\n")) {
        if (line.startsWith(`${key} `) || line.startsWith(`${key}=`)) {
          result += "\n" + line;
          break;
        }
      }
    }
  }

  // Add missing sections
  for (let i = 0; i < sections.length; i++) {
    const { header, index: startIdx } = sections[i];
    const endIdx = i + 1 < sections.length ? sections[i + 1].index : generated.length;
    const block = generated.substring(startIdx, endIdx);

    if (!hasTomlSection(result, header)) {
      result = result.trimEnd() + "\n\n" + block.trim();
    }
  }

  return result.trimEnd() + "\n";
}

// ── 2. Claude settings.local.json ───────────────────────────────────────────

/**
 * Default Claude Code permission allowlist for Bosun-managed repos.
 *
 * Comprehensive enough to allow agents full autonomous operation
 * without interactive prompts, while staying explicit about what's allowed.
 */
const CLAUDE_PERMISSIONS_ALLOW = [
  // Full bash access
  "Bash(*)",
  // Explicit safe command families
  "Bash(git:*)",
  "Bash(gh:*)",
  "Bash(go:*)",
  "Bash(make:*)",
  "Bash(cd:*)",
  "Bash(ls:*)",
  // MCP tools
  "mcp__vibe_kanban__*",
  // Web access (trusted domains)
  "WebFetch(domain:github.com)",
  "WebFetch(domain:bosun.ai)",
  // Go toolchain
  "go *",
  // File editing
  "Edit",
  "MultiEdit",
  // File read/write
  "Read",
  "Write",
  // Computer tool
  "computer:*",
];

/** Claude Code permission deny list (empty — we trust managed repos). */
const CLAUDE_PERMISSIONS_DENY = [];

/**
 * Build the Claude hooks object using the bosun bridge.
 * @param {string} bridgePath  Absolute path to agent-hook-bridge.mjs
 * @returns {object}  Hooks section for settings.local.json
 */
function buildClaudeHooks(bridgePath) {
  const nodeBin = (process.env.BOSUN_HOOK_NODE_BIN || "node").trim();
  const mkCmd = (event) => `${nodeBin} ${bridgePath} --agent claude --event ${event}`;
  return {
    UserPromptSubmit: [
      {
        matcher: "",
        hooks: [{ type: "command", command: mkCmd("UserPromptSubmit") }],
      },
    ],
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: mkCmd("PreToolUse") }],
      },
    ],
    PostToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: mkCmd("PostToolUse") }],
      },
    ],
    Stop: [
      {
        matcher: "",
        hooks: [{ type: "command", command: mkCmd("Stop") }],
      },
    ],
  };
}

/**
 * Build the `.claude/settings.local.json` content for a repo.
 *
 * Includes:
 *   - `permissions.allow` — comprehensive tool allowlist
 *   - `permissions.deny`  — empty (trusted repos)
 *   - `hooks`             — lifecycle hooks via bosun bridge
 *
 * @param {object} options
 * @param {string}  options.repoRoot         Absolute path to the repo
 * @param {string}  [options.bosunBridgePath]  Path to agent-hook-bridge.mjs
 * @returns {object}  JSON-serializable settings object
 */
export function buildRepoClaudeSettings(options = {}) {
  const { bosunBridgePath } = options;
  const bridgePath = resolveBridgePath(bosunBridgePath);

  return {
    permissions: {
      allow: [...CLAUDE_PERMISSIONS_ALLOW],
      deny: [...CLAUDE_PERMISSIONS_DENY],
    },
    hooks: buildClaudeHooks(bridgePath),
  };
}

/**
 * Merge generated Claude settings into an existing settings.local.json.
 *
 * - permissions.allow: union (add missing, keep existing)
 * - permissions.deny: replace with generated (empty)
 * - hooks: replace with latest bridge path
 *
 * @param {object|null} existing  Current file content (parsed JSON)
 * @param {object}      generated Generated settings
 * @returns {object}  Merged settings
 */
function mergeClaudeSettings(existing, generated) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing }
      : {};

  // Merge permissions
  const existingPerms = base.permissions && typeof base.permissions === "object"
    ? base.permissions
    : {};
  const genPerms = generated.permissions || {};

  base.permissions = {
    allow: mergeArrayUnique(existingPerms.allow, genPerms.allow),
    deny: genPerms.deny || [],
  };

  // Hooks: always replace with latest bridge paths
  base.hooks = generated.hooks;

  return base;
}

// ── 3. VS Code settings ─────────────────────────────────────────────────────

/**
 * Build the `.vscode/settings.json` content object for a repo.
 *
 * Delegates to `buildRecommendedVsCodeSettings` from setup.mjs for
 * consistent settings across wizard and repo-config paths.
 *
 * @param {object} [options]
 * @param {object} [options.env]  Environment overrides
 * @returns {object}  JSON-serializable settings
 */
export function buildRepoVsCodeSettings(options = {}) {
  const { env = {} } = options;
  return buildRecommendedVsCodeSettings(env);
}

// ── 4. VS Code MCP config ──────────────────────────────────────────────────

/**
 * Build the `.vscode/mcp.json` content object.
 *
 * Includes all recommended MCP servers for Copilot:
 *   - context7, sequential-thinking, playwright, microsoft-docs
 *
 * @returns {object}  JSON-serializable MCP config
 */
export function buildRepoVsCodeMcpConfig() {
  return {
    mcpServers: {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
      "sequential-thinking": {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      },
      playwright: {
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
      },
      "microsoft-docs": {
        url: "https://learn.microsoft.com/api/mcp",
      },
    },
  };
}

// ── 5. Main entry point ─────────────────────────────────────────────────────

/**
 * @typedef {object} FileResult
 * @property {string}  path     Absolute path to the file
 * @property {boolean} created  True if the file was freshly created
 * @property {boolean} updated  True if the file was updated (merged)
 * @property {boolean} skipped  True if no changes were needed
 */

/**
 * @typedef {object} RepoConfigResult
 * @property {FileResult} codexConfig    `.codex/config.toml`
 * @property {FileResult} claudeSettings `.claude/settings.local.json`
 * @property {FileResult} vsCodeSettings `.vscode/settings.json`
 * @property {FileResult} vsCodeMcp      `.vscode/mcp.json`
 */

/**
 * Ensure ALL repo-level AI executor configs exist in a given repo directory.
 *
 * For each config file:
 *   - `.codex/config.toml`:          Create or merge (add missing sections, don't overwrite)
 *   - `.claude/settings.local.json`: Merge permissions.allow (add missing entries), replace hooks
 *   - `.vscode/settings.json`:       Merge (existing values take priority, add missing)
 *   - `.vscode/mcp.json`:            Merge servers (existing take priority, add missing)
 *
 * @param {string} repoRoot  Absolute path to the repo directory
 * @param {object} [options]
 * @param {string}  [options.vkBaseUrl]        VK API base URL (default: "http://127.0.0.1:54089")
 * @param {boolean} [options.skipVk]           Whether to skip VK MCP server
 * @param {string}  [options.primarySdk]       "codex" | "copilot" | "claude" (default: "codex")
 * @param {string}  [options.bosunBridgePath]  Path to agent-hook-bridge.mjs
 * @param {object}  [options.env]              Environment overrides
 * @param {boolean} [options.dryRun]           If true, return results without writing files
 * @returns {RepoConfigResult}
 */
export function ensureRepoConfigs(repoRoot, options = {}) {
  const {
    vkBaseUrl = "http://127.0.0.1:54089",
    skipVk = false,
    primarySdk = "codex",
    bosunBridgePath,
    env = process.env,
    dryRun = false,
  } = options;

  const root = resolve(repoRoot);

  /** @type {RepoConfigResult} */
  const result = {
    codexConfig: { path: "", created: false, updated: false, skipped: false },
    claudeSettings: { path: "", created: false, updated: false, skipped: false },
    vsCodeSettings: { path: "", created: false, updated: false, skipped: false },
    vsCodeMcp: { path: "", created: false, updated: false, skipped: false },
  };

  // ── 1. .codex/config.toml ────────────────────────────────

  {
    const configPath = resolve(root, ".codex", "config.toml");
    result.codexConfig.path = configPath;

    const generated = buildRepoCodexConfig({ repoRoot: root, vkBaseUrl, skipVk, primarySdk, env });

    if (existsSync(configPath)) {
      const existing = readFileSync(configPath, "utf8");
      const merged = mergeCodexToml(existing, generated);
      if (merged.trimEnd() === existing.trimEnd()) {
        result.codexConfig.skipped = true;
      } else if (!dryRun) {
        writeFileSync(configPath, merged, "utf8");
        result.codexConfig.updated = true;
      } else {
        result.codexConfig.updated = true;
      }
    } else {
      if (!dryRun) {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, generated, "utf8");
      }
      result.codexConfig.created = true;
    }
  }

  // ── 2. .claude/settings.local.json ────────────────────────

  {
    const settingsPath = resolve(root, ".claude", "settings.local.json");
    result.claudeSettings.path = settingsPath;

    const generated = buildRepoClaudeSettings({ repoRoot: root, bosunBridgePath });

    if (existsSync(settingsPath)) {
      const existing = loadJson(settingsPath);
      if (existing === null) {
        // File exists but is invalid JSON — write fresh
        if (!dryRun) {
          writeJson(settingsPath, generated);
        }
        result.claudeSettings.updated = true;
      } else {
        const merged = mergeClaudeSettings(existing, generated);
        const existingStr = JSON.stringify(existing, null, 2);
        const mergedStr = JSON.stringify(merged, null, 2);
        if (existingStr === mergedStr) {
          result.claudeSettings.skipped = true;
        } else if (!dryRun) {
          writeJson(settingsPath, merged);
          result.claudeSettings.updated = true;
        } else {
          result.claudeSettings.updated = true;
        }
      }
    } else {
      if (!dryRun) {
        writeJson(settingsPath, generated);
      }
      result.claudeSettings.created = true;
    }
  }

  // ── 3. .vscode/settings.json ──────────────────────────────

  {
    const settingsPath = resolve(root, ".vscode", "settings.json");
    result.vsCodeSettings.path = settingsPath;

    const recommended = buildRepoVsCodeSettings({ env });

    if (existsSync(settingsPath)) {
      let existing = {};
      try {
        existing = JSON.parse(readFileSync(settingsPath, "utf8"));
      } catch {
        existing = {};
      }

      // Existing values take priority for non-empty keys; add missing keys
      const merged = { ...recommended, ...existing };
      const existingStr = JSON.stringify(existing, null, 2);
      const mergedStr = JSON.stringify(merged, null, 2);
      if (existingStr === mergedStr) {
        result.vsCodeSettings.skipped = true;
      } else if (!dryRun) {
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
        result.vsCodeSettings.updated = true;
      } else {
        result.vsCodeSettings.updated = true;
      }
    } else {
      if (!dryRun) {
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(recommended, null, 2) + "\n", "utf8");
      }
      result.vsCodeSettings.created = true;
    }
  }

  // ── 4. .vscode/mcp.json ──────────────────────────────────

  {
    const mcpPath = resolve(root, ".vscode", "mcp.json");
    result.vsCodeMcp.path = mcpPath;

    const generated = buildRepoVsCodeMcpConfig();

    if (existsSync(mcpPath)) {
      let existing = {};
      try {
        existing = JSON.parse(readFileSync(mcpPath, "utf8"));
      } catch {
        existing = {};
      }

      const existingServers =
        existing.mcpServers ||
        existing["github.copilot.mcpServers"] ||
        (typeof existing === "object" && !existing.mcpServers ? existing : {});

      // Existing servers take priority; add missing from generated
      const mergedServers = {
        ...generated.mcpServers,
        ...(typeof existingServers === "object" ? existingServers : {}),
      };

      const next = { mcpServers: mergedServers };
      const existingStr = JSON.stringify(existing, null, 2);
      const nextStr = JSON.stringify(next, null, 2);
      if (existingStr === nextStr) {
        result.vsCodeMcp.skipped = true;
      } else if (!dryRun) {
        mkdirSync(dirname(mcpPath), { recursive: true });
        writeFileSync(mcpPath, JSON.stringify(next, null, 2) + "\n", "utf8");
        result.vsCodeMcp.updated = true;
      } else {
        result.vsCodeMcp.updated = true;
      }
    } else {
      if (!dryRun) {
        mkdirSync(dirname(mcpPath), { recursive: true });
        writeFileSync(mcpPath, JSON.stringify(generated, null, 2) + "\n", "utf8");
      }
      result.vsCodeMcp.created = true;
    }
  }

  return result;
}

// ── 6. Summary printer ──────────────────────────────────────────────────────

/**
 * Print a human-readable summary of what `ensureRepoConfigs()` did.
 *
 * @param {RepoConfigResult} result  Return value from ensureRepoConfigs()
 * @param {(msg: string) => void} [log]  Logger function (default: console.log)
 */
export function printRepoConfigSummary(result, log = console.log) {
  const entries = [
    { label: ".codex/config.toml", data: result.codexConfig },
    { label: ".claude/settings.local.json", data: result.claudeSettings },
    { label: ".vscode/settings.json", data: result.vsCodeSettings },
    { label: ".vscode/mcp.json", data: result.vsCodeMcp },
  ];

  let anyChange = false;

  for (const { label, data } of entries) {
    if (data.created) {
      log(`  + ${label}  (created)`);
      anyChange = true;
    } else if (data.updated) {
      log(`  ~ ${label}  (updated)`);
      anyChange = true;
    } else if (data.skipped) {
      log(`  = ${label}  (up to date)`);
    }
  }

  if (!anyChange) {
    log("  All repo-level AI configs are already up to date.");
  }
}

// ── Internal regex helper ────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
