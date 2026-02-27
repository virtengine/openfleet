/**
 * codex-config.mjs — Manages the Codex CLI config (~/.codex/config.toml)
 *
 * Ensures the user's Codex CLI configuration has:
 *   1. Sufficient stream_idle_timeout_ms on all model providers
 *   2. Recommended defaults for long-running agentic workloads
 *   3. Feature flags for sub-agents, memory, undo, collaboration
 *   4. Sandbox permissions and shell environment policy
 *   5. Common MCP servers (context7, microsoft-docs)
 *
 * NOTE: Vibe-Kanban MCP is workspace-scoped and managed by repo-config.mjs
 * inside each repo's `.codex/config.toml`. Global config no longer auto-adds
 * `[mcp_servers.vibe_kanban]`.
 *
 * SCOPE: This manages the GLOBAL ~/.codex/config.toml which contains:
 *   - Model provider configs (API keys, base URLs) — MUST be global
 *   - Stream timeouts & retry settings — per-provider, global
 *   - Sandbox workspace-write (writable_roots) — spans multiple repos, global
 *   - Feature flags, MCP servers, agent_sdk — kept as FALLBACK defaults
 *     (prefer repo-level .codex/config.toml via repo-config.mjs)
 *
 * For project-scoped settings, see repo-config.mjs which generates
 * .codex/config.toml at the repo level.
 *
 * Uses string-based TOML manipulation (no parser dependency) — we only
 * append or patch well-known sections rather than rewriting the whole file.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { resolve, dirname, parse, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveCodexProfileRuntime } from "./codex-model-profiles.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Read the vibe-kanban version from the local package.json dependency.
 * Falls back to "latest" if not found (shouldn't happen in normal usage).
 */
function getVibeKanbanVersion() {
  try {
    const pkgPath = resolve(__dirname, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.dependencies?.["vibe-kanban"] || "latest";
  } catch {
    return "latest";
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

const CODEX_DIR = resolve(homedir(), ".codex");
const CONFIG_PATH = resolve(CODEX_DIR, "config.toml");

/** Minimum recommended stream idle timeout (ms) for complex agentic tasks. */
const MIN_STREAM_IDLE_TIMEOUT_MS = 300_000; // 5 minutes

/** The recommended (generous) timeout for heavy reasoning models. */
const RECOMMENDED_STREAM_IDLE_TIMEOUT_MS = 3_600_000; // 60 minutes

// ── Agent SDK Selection (config.toml) ───────────────────────────────────────

const AGENT_SDK_HEADER = "[agent_sdk]";
const AGENT_SDK_CAPS_HEADER = "[agent_sdk.capabilities]";

const AGENTS_HEADER = "[agents]";
const DEFAULT_AGENT_MAX_THREADS = 12;

/**
 * Build the default [agent_sdk] TOML block.
 * @param {string} [primary="codex"]  The primary SDK: "codex", "copilot", or "claude"
 * @returns {string}
 */
function buildDefaultAgentSdkBlock(primary = "codex") {
  const caps = {
    codex:   { steering: true,  subagents: true,  vscodeTools: false },
    copilot: { steering: false, subagents: true,  vscodeTools: true  },
    claude:  { steering: false, subagents: true,  vscodeTools: false },
  };
  const c = caps[primary] || caps.codex;
  return [
    "",
    "# ── Agent SDK selection (added by bosun) ──",
    AGENT_SDK_HEADER,
    "# Primary agent SDK used for in-process automation.",
    '# Supported: "codex", "copilot", "claude"',
    `primary = "${primary}"`,
    "# Max concurrent agent threads per Codex session.",
    `max_threads = ${DEFAULT_AGENT_MAX_THREADS}`,
    "",
    AGENT_SDK_CAPS_HEADER,
    "# Live steering updates during an active run.",
    `steering = ${c.steering}`,
    "# Ability to spawn subagents/child tasks.",
    `subagents = ${c.subagents}`,
    "# Access to VS Code tools (Copilot extension).",
    `vscode_tools = ${c.vscodeTools}`,
    "",
  ].join("\n");
}

/**
 * @deprecated No longer used — max_threads is now managed under [agent_sdk].
 * The [agents] section in Codex CLI uses serde(flatten) to parse all keys
 * as agent role names, so bare scalar keys like max_threads = 12 cause:
 *   "invalid length 1, expected struct AgentRoleToml with 2 elements"
 * Kept only for migration removal of stale [agents] sections.
 */
const buildAgentsBlock = (_maxThreads) =>
  [
    "",
    "# ── Agent roles (added by bosun) ──",
    AGENTS_HEADER,
    "",
  ].join("\n");

// ── Feature Flags ────────────────────────────────────────────────────────────

/**
 * Feature flags that should be enabled for sub-agents, collaboration,
 * memory, and continuous operation.  Keys are the [features] TOML keys;
 * values are { default, envVar, comment }.
 */
const RECOMMENDED_FEATURES = {
  // Sub-agents & collaboration
  child_agents_md:        { default: true, envVar: "CODEX_FEATURES_CHILD_AGENTS_MD",   comment: "Enable sub-agent discovery via CODEX.md" },
  multi_agent:                 { default: true, envVar: "CODEX_FEATURES_MULTI_AGENT",             comment: "Enable collaboration mode" },
  collaboration_modes:    { default: true, envVar: "CODEX_FEATURES_COLLABORATION_MODES", comment: "Enable collaboration mode selection" },

  // Continuity & recovery
  memories:            { default: true, envVar: "CODEX_FEATURES_MEMORIES",        comment: "Persistent memory across sessions" },
  undo:                   { default: true, envVar: "CODEX_FEATURES_UNDO",               comment: "Safe rollback of agent changes" },
  steer:                  { default: true, envVar: "CODEX_FEATURES_STEER",              comment: "Live steering during runs" },
  personality:            { default: true, envVar: "CODEX_FEATURES_PERSONALITY",         comment: "Agent personality persistence" },

  // Sandbox & execution
  use_linux_sandbox_bwrap:{ default: true, envVar: "CODEX_FEATURES_BWRAP",              comment: "Linux bubblewrap sandbox" },
  shell_tool:             { default: true, envVar: null,                                 comment: "Shell tool access" },
  unified_exec:           { default: true, envVar: null,                                 comment: "Unified execution" },
  shell_snapshot:         { default: true, envVar: null,                                 comment: "Shell state snapshots" },
  request_rule:           { default: true, envVar: null,                                 comment: "Request-level approval rules" },

  // Performance & networking
  // DISABLED: enable_request_compression corrupts the JSON request body when
  // used with Azure OpenAI wire_api=responses, causing invalid_request_error:
  // "'}' is invalid after a property name" / BytePositionInLine: ~82000.
  // The compression codec embeds unescaped content inside a JSON string field,
  // breaking the Azure Responses API parser even on small (~1 paragraph) inputs.
  enable_request_compression: { default: false, envVar: "CODEX_FEATURES_REQUEST_COMPRESSION", comment: "Compress requests (DISABLED — breaks Azure wire_api=responses)" },
  remote_models:          { default: true, envVar: null,                                 comment: "Remote model support" },
  skill_mcp_dependency_install: { default: true, envVar: null,                           comment: "Auto-install MCP skill deps" },

  // Experimental (disabled by default unless explicitly enabled)
};

const CRITICAL_ALWAYS_ON_FEATURES = new Set([
  "child_agents_md",
  "memories",
  "multi_agent",
  "collaboration_modes",
  "shell_tool",
  "unified_exec",
]);

// Features that must be DISABLED regardless of user-set value.
// These cause known compatibility failures (e.g. Azure wire_api=responses
// breaks when enable_request_compression embeds unescaped content in JSON).
const CRITICAL_ALWAYS_OFF_FEATURES = new Set([
  "enable_request_compression",
]);

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolveAgentMaxThreads(envOverrides = process.env) {
  const raw =
    envOverrides.CODEX_AGENT_MAX_THREADS ??
    envOverrides.CODEX_AGENTS_MAX_THREADS ??
    envOverrides.CODEX_MAX_THREADS;
  if (raw !== undefined) {
    return {
      value: parsePositiveInt(raw),
      explicit: true,
      raw,
    };
  }
  return {
    value: DEFAULT_AGENT_MAX_THREADS,
    explicit: false,
    raw: null,
  };
}

/**
 * Ensure max_threads is set under [agent_sdk] (NOT under [agents]).
 *
 * The [agents] section in Codex CLI uses serde(flatten), so any bare scalar
 * key is parsed as an agent role name and causes a deserialization error.
 * We store max_threads under [agent_sdk] which Bosun owns.
 *
 * Also migrates any stale max_threads from [agents] if found.
 */
export function ensureAgentMaxThreads(
  toml,
  { maxThreads, overwrite = false } = {},
) {
  const result = {
    toml,
    changed: false,
    existing: null,
    applied: null,
    added: false,
    updated: false,
    skipped: false,
  };

  const desired = parsePositiveInt(maxThreads);
  if (!desired) {
    result.skipped = true;
    return result;
  }
  result.applied = desired;

  // ── Migration: remove stale max_threads from [agents] section ──
  const agentsIdx = toml.indexOf(AGENTS_HEADER);
  if (agentsIdx !== -1) {
    const afterAgentsHeader = agentsIdx + AGENTS_HEADER.length;
    const nextAgentsSection = toml.indexOf("\n[", afterAgentsHeader);
    const agentsSectionEnd = nextAgentsSection === -1 ? toml.length : nextAgentsSection;
    const agentsSection = toml.substring(afterAgentsHeader, agentsSectionEnd);
    const staleRegex = /^[ \t]*#[^\n]*max.*threads[^\n]*\n?|^[ \t]*max_threads\s*=\s*\d+[^\n]*\n?/gm;
    if (staleRegex.test(agentsSection)) {
      const cleaned = agentsSection.replace(staleRegex, "");
      toml = toml.substring(0, afterAgentsHeader) + cleaned + toml.substring(agentsSectionEnd);
      result.changed = true;
    }
    // If [agents] section is now empty (only whitespace/comments about agents),
    // remove the whole section to avoid confusing Codex CLI
    const updatedAgentsIdx = toml.indexOf(AGENTS_HEADER);
    if (updatedAgentsIdx !== -1) {
      const afterUpdated = updatedAgentsIdx + AGENTS_HEADER.length;
      const nextUpdated = toml.indexOf("\n[", afterUpdated);
      const endUpdated = nextUpdated === -1 ? toml.length : nextUpdated;
      const remaining = toml.substring(afterUpdated, endUpdated).trim();
      // If only whitespace or the bosun comment header remains, remove entire section
      if (!remaining || /^(#[^\n]*\n?\s*)*$/.test(remaining)) {
        // Remove from the line before [agents] header to section end
        const lineStart = toml.lastIndexOf("\n", updatedAgentsIdx);
        const removeFrom = lineStart === -1 ? updatedAgentsIdx : lineStart;
        toml = toml.substring(0, removeFrom) + toml.substring(endUpdated);
        result.changed = true;
      }
    }
  }

  // ── Place max_threads under [agent_sdk] ──
  const sdkIdx = toml.indexOf(AGENT_SDK_HEADER);
  if (sdkIdx === -1) {
    // No [agent_sdk] section yet — it will be created by ensureCodexConfig;
    // the DEFAULT_AGENT_SDK_BLOCK already includes max_threads.
    result.changed = true;
    result.added = true;
    return result;
  }

  const afterSdkHeader = sdkIdx + AGENT_SDK_HEADER.length;
  // Find the end of [agent_sdk] — either [agent_sdk.capabilities] or the next section
  const capsIdx = toml.indexOf(AGENT_SDK_CAPS_HEADER, afterSdkHeader);
  const nextSectionIdx = toml.indexOf("\n[", afterSdkHeader);
  // Use the capabilities sub-section boundary or next top-level section
  let sdkSectionEnd;
  if (capsIdx !== -1 && (nextSectionIdx === -1 || capsIdx <= nextSectionIdx)) {
    sdkSectionEnd = capsIdx;
  } else {
    sdkSectionEnd = nextSectionIdx === -1 ? toml.length : nextSectionIdx;
  }

  let sdkSection = toml.substring(afterSdkHeader, sdkSectionEnd);

  const maxThreadsRegex = /^max_threads\s*=\s*(\d+)/m;
  const match = sdkSection.match(maxThreadsRegex);
  if (match) {
    result.existing = parsePositiveInt(match[1]);
    if (overwrite && result.existing !== desired) {
      sdkSection = sdkSection.replace(maxThreadsRegex, `max_threads = ${desired}`);
      result.changed = true;
      result.updated = true;
    }
  } else {
    // Add max_threads right after [agent_sdk] header, before other keys
    sdkSection = sdkSection.trimEnd() + `\nmax_threads = ${desired}\n`;
    result.changed = true;
    result.added = true;
  }

  if (result.changed) {
    result.toml = toml.substring(0, afterSdkHeader) + sdkSection + toml.substring(sdkSectionEnd);
  }

  return result;
}

/**
 * Check whether config has a [features] section.
 */
export function hasFeaturesSection(toml) {
  return /^\[features\]/m.test(toml);
}

/**
 * Check whether config has a [shell_environment_policy] section.
 */
export function hasShellEnvPolicy(toml) {
  return /^\[shell_environment_policy\]/m.test(toml);
}

/**
 * Check whether config has sandbox_mode set (top-level key).
 */
export function hasSandboxMode(toml) {
  return /^sandbox_mode\s*=/m.test(toml);
}

function stripSandboxMode(toml) {
  let next = toml.replace(
    /^\s*#\s*Sandbox mode.*(?:\r?\n)?/gim,
    "",
  );
  next = next.replace(/^\s*sandbox_mode\s*=.*(?:\r?\n)?/gim, "");
  return next;
}

function extractSandboxModeValue(toml) {
  const match = toml.match(/^\s*sandbox_mode\s*=\s*(.+)$/m);
  if (!match) return "";
  const raw = String(match[1] || "").split("#")[0].trim();
  if (!raw) return "";
  const quoted = raw.match(/^"(.*)"$/) || raw.match(/^'(.*)'$/);
  if (quoted) return quoted[1];
  return raw;
}

function insertTopLevelSandboxMode(toml, modeValue) {
  const block = buildSandboxMode(modeValue).trim();
  const tableIdx = toml.search(/^\s*\[/m);
  if (tableIdx === -1) {
    return `${toml.trimEnd()}\n\n${block}\n`;
  }
  const head = toml.slice(0, tableIdx).trimEnd();
  const tail = toml.slice(tableIdx).trimStart();
  return `${head}\n\n${block}\n\n${tail}`;
}

function ensureTopLevelSandboxMode(toml, envValue) {
  const existingValue = extractSandboxModeValue(toml);
  const modeValue = envValue || existingValue || "workspace-write";
  const stripped = stripSandboxMode(toml);
  const updated = insertTopLevelSandboxMode(stripped, modeValue);
  return {
    toml: updated,
    changed: updated !== toml,
  };
}

/**
 * Build a [features] block with the recommended flags.
 * Reads environment overrides: set CODEX_FEATURES_<NAME>=false to disable.
 *
 * @param {object} [envOverrides]  Optional env map (defaults to process.env)
 * @returns {string}  TOML block
 */
export function buildFeaturesBlock(envOverrides = process.env) {
  const lines = [
    "",
    "# ── Feature flags (added by bosun) ──",
    "[features]",
  ];

  for (const [key, meta] of Object.entries(RECOMMENDED_FEATURES)) {
    let enabled = meta.default;
    // Check env override
    if (meta.envVar && envOverrides[meta.envVar] !== undefined) {
      enabled = parseBoolEnv(envOverrides[meta.envVar]);
    }
    if (meta.comment) lines.push(`# ${meta.comment}`);
    lines.push(`${key} = ${enabled}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Ensure all recommended feature flags are present in an existing [features]
 * section.  Only adds missing keys — never overwrites user choices.
 *
 * @param {string} toml  Current config.toml content
 * @param {object} [envOverrides]  Optional env map (defaults to process.env)
 * @returns {{ toml: string, added: string[] }}
 */
export function ensureFeatureFlags(toml, envOverrides = process.env) {
  const added = [];

  if (!hasFeaturesSection(toml)) {
    toml += buildFeaturesBlock(envOverrides);
    added.push(...Object.keys(RECOMMENDED_FEATURES));
    return { toml, added };
  }

  // Find the [features] section boundaries
  const header = "[features]";
  const headerIdx = toml.indexOf(header);
  const afterHeader = headerIdx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const sectionEnd = nextSection === -1 ? toml.length : nextSection;
  let section = toml.substring(afterHeader, sectionEnd);

  for (const [key, meta] of Object.entries(RECOMMENDED_FEATURES)) {
    const keyRegex = new RegExp(`^${escapeRegex(key)}\\s*=`, "m");
    const hasEnvOverride =
      meta.envVar && envOverrides[meta.envVar] !== undefined;
    const envValue = hasEnvOverride
      ? parseBoolEnv(envOverrides[meta.envVar])
      : null;

    if (!keyRegex.test(section)) {
      const enabled = hasEnvOverride ? envValue : meta.default;
      section = section.trimEnd() + `\n${key} = ${enabled}\n`;
      added.push(key);
      continue;
    }

    if (hasEnvOverride) {
      const valueRegex = new RegExp(
        `^(${escapeRegex(key)}\\s*=\\s*)(true|false)\\b.*$`,
        "m",
      );
      if (valueRegex.test(section)) {
        section = section.replace(valueRegex, `$1${envValue}`);
      }
    }

    if (CRITICAL_ALWAYS_ON_FEATURES.has(key)) {
      const disabledRegex = new RegExp(
        `^(${escapeRegex(key)}\\s*=\\s*)false\\b.*$`,
        "m",
      );
      if (disabledRegex.test(section)) {
        section = section.replace(disabledRegex, `$1true`);
      }
    }

    // Force certain features OFF regardless of what is in the file.
    // (e.g. enable_request_compression corrupts JSON bodies on Azure wire_api=responses)
    if (CRITICAL_ALWAYS_OFF_FEATURES.has(key)) {
      const enabledRegex = new RegExp(
        `^(${escapeRegex(key)}\\s*=\\s*)true\\b.*$`,
        "m",
      );
      if (enabledRegex.test(section)) {
        section = section.replace(enabledRegex, `$1false`);
      }
    }
  }

  toml = toml.substring(0, afterHeader) + section + toml.substring(sectionEnd);
  return { toml, added };
}

/**
 * Build the sandbox_mode top-level key.
 * Default: "workspace-write" for agentic workloads.
 *
 * Codex CLI expects sandbox_mode as a plain string, NOT an array.
 *
 * @param {string} [envValue]  CODEX_SANDBOX_MODE env var value
 * @returns {string}  TOML line(s)
 */
function normalizeSandboxModeValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  switch (raw.toLowerCase()) {
    case "disk-full-write-access":
    case "workspace-write":
      return "workspace-write";
    case "disk-read-only":
    case "read-only":
      return "read-only";
    case "danger-full-access":
      return "danger-full-access";
    default:
      return raw;
  }
}

export function buildSandboxMode(envValue) {
  const mode = normalizeSandboxModeValue(envValue) || "workspace-write";
  return `\n# Sandbox mode (added by bosun)\nsandbox_mode = "${mode}"\n`;
}

/**
 * @deprecated Compatibility shim for older callers.
 * `sandbox_permissions` has been replaced by `sandbox_mode` in Codex CLI.
 */
export function buildSandboxPermissions(envValue) {
  return buildSandboxMode(envValue);
}

/**
 * @deprecated Compatibility shim for older callers.
 * Retained to avoid runtime failures during mixed-version startup.
 */
export function ensureTopLevelSandboxPermissions(toml, envValue) {
  return ensureTopLevelSandboxMode(
    toml,
    normalizeSandboxModeValue(envValue) || undefined,
  );
}

function parseTomlArrayLiteral(raw) {
  if (!raw) return [];
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^"(.*)"$/, "$1"))
    .map((item) => item.replace(/\\(["\\])/g, "$1"));
}

function formatTomlArray(values) {
  return `[${values.map((value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(", ")}]`;
}

function normalizeWritableRoots(input, { repoRoot, additionalRoots, validateExistence = false } = {}) {
  const roots = new Set();
  const addRoot = (value) => {
    const trimmed = String(value || "").trim();
    if (!trimmed) return;
    // Reject bare relative paths like ".git" — they resolve relative to CWD
    // at Codex launch time and cause "writable root does not exist" errors
    // (e.g. /home/user/.codex/.git). Only accept absolute paths.
    if (!isAbsolute(trimmed)) return;
    // When validateExistence is true, skip paths that don't exist on disk.
    // This prevents the sandbox from failing to start with phantom roots.
    if (validateExistence && !existsSync(trimmed)) return;
    roots.add(trimmed);
  };
  // Always-add: these are primary roots (repo root, parent) that should be
  // present even if validateExistence is true — they're the intended CWD.
  const addPrimaryRoot = (value) => {
    const trimmed = String(value || "").trim();
    if (!trimmed || !isAbsolute(trimmed)) return;
    roots.add(trimmed);
  };
  if (Array.isArray(input)) {
    input.forEach(addRoot);
  } else if (typeof input === "string") {
    input
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach(addRoot);
  }

  // Add paths for a repo root — only if it's a non-empty absolute path
  const addRepoRootPaths = (repo) => {
    if (!repo) return;
    const r = String(repo).trim();
    if (!r || !isAbsolute(r)) return;
    // Repo root and parent are always added (they're primary working dirs)
    addPrimaryRoot(r);
    const gitDir = resolve(r, ".git");
    // Only add .git if it actually exists (prevents phantom writable roots)
    if (existsSync(gitDir)) addRoot(gitDir);
    const cacheWorktrees = resolve(r, ".cache", "worktrees");
    // Only add .cache subdirs if they exist — avoid phantom roots
    if (existsSync(cacheWorktrees)) addRoot(cacheWorktrees);
    const cacheDir = resolve(r, ".cache");
    if (existsSync(cacheDir)) addRoot(cacheDir);
    const parent = dirname(r);
    if (parent && parent !== r) addPrimaryRoot(parent);
  };

  addRepoRootPaths(repoRoot);

  // Add paths for additional workspace repo roots
  if (Array.isArray(additionalRoots)) {
    for (const root of additionalRoots) {
      addRepoRootPaths(root);
    }
  }

  // /tmp is needed for sandbox temp files, pip installs, etc.
  roots.add("/tmp");

  return Array.from(roots);
}

/**
 * Validate that a directory has a valid .git ancestor (regular repo or worktree).
 * In worktrees, .git is a file containing "gitdir: <path>" — follow the reference
 * to find the actual git object store. Returns the resolved .git directory path
 * or null if not found.
 * @param {string} dir - Directory to check
 * @returns {{ gitDir: string|null, mainWorktreeRoot: string|null, isWorktree: boolean }}
 */
export function ensureGitAncestor(dir) {
  if (!dir) return { gitDir: null, mainWorktreeRoot: null, isWorktree: false };
  let current = resolve(dir);
  const { root } = parse(current);
  while (current !== root) {
    const gitPath = resolve(current, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isDirectory()) {
          // Regular git repo
          return { gitDir: gitPath, mainWorktreeRoot: current, isWorktree: false };
        }
        if (stat.isFile()) {
          // Worktree: .git is a file with "gitdir: <relative-or-absolute-path>"
          const content = readFileSync(gitPath, "utf8").trim();
          const match = content.match(/^gitdir:\s*(.+)$/);
          if (match) {
            const gitdirRef = resolve(current, match[1].trim());
            // Worktree gitdir points to <main-repo>/.git/worktrees/<name>
            // Walk up 2 levels to get the main .git directory
            const mainGitDir = resolve(gitdirRef, "..", "..");
            const mainRepoRoot = dirname(mainGitDir);
            return {
              gitDir: mainGitDir,
              mainWorktreeRoot: mainRepoRoot,
              isWorktree: true,
            };
          }
        }
      } catch { /* permission error, race, etc. */ }
    }
    current = dirname(current);
  }
  return { gitDir: null, mainWorktreeRoot: null, isWorktree: false };
}

/**
 * Build writable roots for a specific task's execution context.
 * Combines the global config roots with task-specific paths (worktree, repo root).
 * @param {{ worktreePath?: string, repoRoot?: string, existingRoots?: string[] }} opts
 * @returns {string[]} Merged writable roots
 */
export function buildTaskWritableRoots({ worktreePath, repoRoot, existingRoots = [] } = {}) {
  const roots = new Set(existingRoots.filter(r => r && isAbsolute(r) && existsSync(r)));
  const addIfExists = (p) => {
    if (p && isAbsolute(p) && existsSync(p)) roots.add(p);
  };
  // Add path even if it doesn't exist yet (will be created by the task)
  const addRoot = (p) => {
    if (p && isAbsolute(p)) roots.add(p);
  };

  if (worktreePath) {
    addRoot(worktreePath); // Worktree dir itself may be about to be created
    // Worktrees have a .git file pointing to main repo — resolve the actual git dir
    const ancestor = ensureGitAncestor(worktreePath);
    if (ancestor.gitDir) addIfExists(ancestor.gitDir);
    if (ancestor.mainWorktreeRoot) {
      addIfExists(resolve(ancestor.mainWorktreeRoot, ".git"));
      addIfExists(resolve(ancestor.mainWorktreeRoot, ".cache", "worktrees"));
    }
  }
  if (repoRoot) {
    addRoot(repoRoot);
    const gitDir = resolve(repoRoot, ".git");
    if (existsSync(gitDir)) addIfExists(gitDir);
    addIfExists(resolve(repoRoot, ".cache", "worktrees"));
    addIfExists(resolve(repoRoot, ".cache"));
    const parent = dirname(repoRoot);
    if (parent && parent !== repoRoot) addIfExists(parent);
  }
  roots.add("/tmp");
  return Array.from(roots);
}

export function hasSandboxWorkspaceWrite(toml) {
  return /^\[sandbox_workspace_write\]/m.test(toml);
}

export function buildSandboxWorkspaceWrite(options = {}) {
  const {
    writableRoots = [],
    repoRoot,
    additionalRoots,
    networkAccess = true,
    excludeTmpdirEnvVar = false,
    excludeSlashTmp = false,
  } = options;

  const desiredRoots = normalizeWritableRoots(writableRoots, { repoRoot, additionalRoots, validateExistence: true });
  if (desiredRoots.length === 0) {
    return "";
  }
  return [
    "",
    "# ── Workspace-write sandbox defaults (added by bosun) ──",
    "[sandbox_workspace_write]",
    `network_access = ${networkAccess}`,
    `exclude_tmpdir_env_var = ${excludeTmpdirEnvVar}`,
    `exclude_slash_tmp = ${excludeSlashTmp}`,
    `writable_roots = ${formatTomlArray(desiredRoots)}`,
    "",
  ].join("\n");
}

export function ensureSandboxWorkspaceWrite(toml, options = {}) {
  const {
    writableRoots = [],
    repoRoot,
    additionalRoots,
    networkAccess = true,
    excludeTmpdirEnvVar = false,
    excludeSlashTmp = false,
  } = options;

  const desiredRoots = normalizeWritableRoots(writableRoots, { repoRoot, additionalRoots, validateExistence: true });
  if (!hasSandboxWorkspaceWrite(toml)) {
    if (desiredRoots.length === 0) {
      return { toml, changed: false, added: false, rootsAdded: [] };
    }
    const block = [
      "",
      "# ── Workspace-write sandbox defaults (added by bosun) ──",
      "[sandbox_workspace_write]",
      `network_access = ${networkAccess}`,
      `exclude_tmpdir_env_var = ${excludeTmpdirEnvVar}`,
      `exclude_slash_tmp = ${excludeSlashTmp}`,
      `writable_roots = ${formatTomlArray(desiredRoots)}`,
      "",
    ].join("\n");
    return {
      toml: toml.trimEnd() + "\n" + block,
      changed: true,
      added: true,
      rootsAdded: desiredRoots,
    };
  }

  const header = "[sandbox_workspace_write]";
  const headerIdx = toml.indexOf(header);
  if (headerIdx === -1) {
    return { toml, changed: false, added: false, rootsAdded: [] };
  }

  const afterHeader = headerIdx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const sectionEnd = nextSection === -1 ? toml.length : nextSection;
  let section = toml.substring(afterHeader, sectionEnd);
  let changed = false;
  let rootsAdded = [];

  const ensureFlag = (key, value) => {
    const keyRegex = new RegExp(`^${escapeRegex(key)}\\s*=`, "m");
    if (!keyRegex.test(section)) {
      section = section.trimEnd() + `\n${key} = ${value}\n`;
      changed = true;
    }
  };

  ensureFlag("network_access", networkAccess);
  ensureFlag("exclude_tmpdir_env_var", excludeTmpdirEnvVar);
  ensureFlag("exclude_slash_tmp", excludeSlashTmp);

  const rootsRegex = /^writable_roots\s*=\s*(\[[^\]]*\])\s*$/m;
  const match = section.match(rootsRegex);
  if (match) {
    const existingRoots = parseTomlArrayLiteral(match[1]);
    // Filter out stale roots that no longer exist on disk
    const validExisting = existingRoots.filter((r) => r === "/tmp" || existsSync(r));
    const merged = normalizeWritableRoots(validExisting, { repoRoot, validateExistence: true });
    for (const root of desiredRoots) {
      if (!merged.includes(root)) {
        merged.push(root);
        rootsAdded.push(root);
      }
    }
    // Track any roots that were removed due to non-existence
    const staleRemoved = existingRoots.filter((r) => r !== "/tmp" && !existsSync(r));
    if (staleRemoved.length > 0) changed = true;
    const formatted = formatTomlArray(merged);
    if (formatted !== match[1]) {
      section = section.replace(rootsRegex, `writable_roots = ${formatted}`);
      changed = true;
    }
  } else if (desiredRoots.length > 0) {
    section = section.trimEnd() + `\nwritable_roots = ${formatTomlArray(desiredRoots)}\n`;
    rootsAdded = desiredRoots;
    changed = true;
  }

  if (!changed) {
    return { toml, changed: false, added: false, rootsAdded: [] };
  }

  const updatedToml =
    toml.substring(0, afterHeader) + section + toml.substring(sectionEnd);

  return {
    toml: updatedToml,
    changed: true,
    added: false,
    rootsAdded,
  };
}

/**
 * Prune writable_roots in [sandbox_workspace_write] that no longer exist on disk.
 * Returns the updated TOML and a list of removed paths.
 * @param {string} toml
 * @returns {{ toml: string, changed: boolean, removed: string[] }}
 */
export function pruneStaleSandboxRoots(toml) {
  if (!hasSandboxWorkspaceWrite(toml)) {
    return { toml, changed: false, removed: [] };
  }
  const header = "[sandbox_workspace_write]";
  const headerIdx = toml.indexOf(header);
  if (headerIdx === -1) return { toml, changed: false, removed: [] };
  const afterHeader = headerIdx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const sectionEnd = nextSection === -1 ? toml.length : nextSection;
  let section = toml.substring(afterHeader, sectionEnd);

  const rootsRegex = /^writable_roots\s*=\s*(\[[^\]]*\])\s*$/m;
  const match = section.match(rootsRegex);
  if (!match) return { toml, changed: false, removed: [] };

  const existing = parseTomlArrayLiteral(match[1]);
  const valid = existing.filter((r) => r === "/tmp" || existsSync(r));
  const removed = existing.filter((r) => r !== "/tmp" && !existsSync(r));
  if (removed.length === 0) return { toml, changed: false, removed: [] };

  section = section.replace(rootsRegex, `writable_roots = ${formatTomlArray(valid)}`);
  const updatedToml =
    toml.substring(0, afterHeader) + section + toml.substring(sectionEnd);
  return { toml: updatedToml, changed: true, removed };
}

/**
 * Build the [shell_environment_policy] section.
 * Default: inherit = "all" so .NET, Go, Node etc. env vars are visible.
 *
 * @param {string} [policy]  "all" | "none" | "allowlist"
 * @returns {string}  TOML block
 */
export function buildShellEnvPolicy(policy = "all") {
  return [
    "",
    "# ── Shell environment policy (added by bosun) ──",
    "[shell_environment_policy]",
    `inherit = "${policy}"`,
    "",
  ].join("\n");
}

/**
 * Check whether config has a [mcp_servers.context7] section.
 */
export function hasContext7Mcp(toml) {
  return /^\[mcp_servers\.context7\]/m.test(toml);
}

/**
 * Check whether config has a [mcp_servers.microsoft-docs] or microsoft_docs section.
 */
export function hasMicrosoftDocsMcp(toml) {
  return /^\[mcp_servers\.microsoft[_-]docs\]/m.test(toml);
}

/**
 * Build MCP server blocks for context7 and microsoft-docs.
 * These are universally useful for documentation lookups.
 */
export function buildCommonMcpBlocks() {
  return [
    "",
    "# ── Common MCP servers (added by bosun) ──",
    "[mcp_servers.context7]",
    "startup_timeout_sec = 120",
    'command = "npx"',
    'args = ["-y", "@upstash/context7-mcp"]',
    "",
    "[mcp_servers.sequential-thinking]",
    "startup_timeout_sec = 120",
    'command = "npx"',
    'args = ["-y", "@modelcontextprotocol/server-sequential-thinking"]',
    "",
    "[mcp_servers.playwright]",
    "startup_timeout_sec = 120",
    'command = "npx"',
    'args = ["-y", "@playwright/mcp@latest"]',
    "",
    "[mcp_servers.microsoft-docs]",
    'url = "https://learn.microsoft.com/api/mcp"',
    // microsoft_docs_fetch description alone is ~2KB and breaks the Azure
    // Responses API JSON parser when combined with other MCP tool schemas.
    // Keep only the two search tools which are sufficient for most use cases.
    'tools = ["microsoft_docs_search", "microsoft_code_sample_search"]',
    "",
  ].join("\n");
}

function hasNamedMcpServer(toml, name) {
  return new RegExp(`^\\[mcp_servers\\.${escapeRegex(name)}\\]`, "m").test(
    toml,
  );
}

function ensureMcpStartupTimeout(toml, name, timeoutSec = 120) {
  const header = `[mcp_servers.${name}]`;
  const headerIdx = toml.indexOf(header);
  if (headerIdx === -1) return { toml, changed: false };

  const afterHeader = headerIdx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const sectionEnd = nextSection === -1 ? toml.length : nextSection;
  let section = toml.substring(afterHeader, sectionEnd);

  const timeoutRegex = /^startup_timeout_sec\s*=\s*\d+.*$/m;
  let changed = false;
  if (timeoutRegex.test(section)) {
    const desired = `startup_timeout_sec = ${timeoutSec}`;
    const updated = section.replace(timeoutRegex, desired);
    if (updated !== section) {
      section = updated;
      changed = true;
    }
  } else {
    section = section.trimEnd() + `\nstartup_timeout_sec = ${timeoutSec}\n`;
    changed = true;
  }

  if (!changed) return { toml, changed: false };
  return {
    toml: toml.substring(0, afterHeader) + section + toml.substring(sectionEnd),
    changed: true,
  };
}

function stripDeprecatedSandboxPermissions(toml) {
  return String(toml || "").replace(
    /^\s*sandbox_permissions\s*=.*(?:\r?\n)?/gim,
    "",
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Read the current config.toml (or return empty string if it doesn't exist).
 */
export function readCodexConfig() {
  if (!existsSync(CONFIG_PATH)) return "";
  return readFileSync(CONFIG_PATH, "utf8");
}

/**
 * Write the config.toml, creating ~/.codex/ if needed.
 */
export function writeCodexConfig(content) {
  mkdirSync(CODEX_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, content, "utf8");
}

/**
 * Get the path to the Codex config file.
 */
export function getConfigPath() {
  return CONFIG_PATH;
}

/**
 * Check whether the config already has a [mcp_servers.vibe_kanban] section.
 */
export function hasVibeKanbanMcp(toml) {
  return /^\[mcp_servers\.vibe_kanban\]/m.test(toml);
}

/**
 * Check whether the config already has a [mcp_servers.vibe_kanban.env] section.
 */
export function hasVibeKanbanEnv(toml) {
  return /^\[mcp_servers\.vibe_kanban\.env\]/m.test(toml);
}

/**
 * Remove the [mcp_servers.vibe_kanban] and [mcp_servers.vibe_kanban.env]
 * sections (and their contents) from config.toml.
 * Returns the cleaned TOML string.
 */
export function removeVibeKanbanMcp(toml) {
  // Line-based approach: walk lines and skip VK-related sections.
  const lines = toml.split("\n");
  const out = [];
  let skipping = false;
  // Track comment lines immediately preceding a VK section header
  let pendingComments = [];

  for (const line of lines) {
    // Detect section headers: lines starting with [ that aren't array values
    const isSectionHeader = /^\[[\w]/.test(line);
    const isVkSection =
      /^\[mcp_servers\.vibe_kanban\b/.test(line);

    if (isVkSection) {
      // Drop any pending comment lines (they belong to this VK section)
      pendingComments = [];
      skipping = true;
      continue;
    }

    if (skipping && isSectionHeader) {
      // We've reached the next non-VK section — stop skipping
      skipping = false;
    }

    if (skipping) continue;

    // Buffer comment/blank lines that might precede a VK section header
    if (/^#.*[Vv]ibe.[Kk]anban/.test(line) || /^# ── .*[Vv]ibe.[Kk]anban/.test(line)) {
      pendingComments.push(line);
      continue;
    }

    // Flush pending comments (they weren't followed by a VK header)
    if (pendingComments.length) {
      out.push(...pendingComments);
      pendingComments = [];
    }

    out.push(line);
  }

  // Flush any remaining pending comments
  if (pendingComments.length) {
    out.push(...pendingComments);
  }

  // Clean up excessive blank lines
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Check whether the config already has an [agent_sdk] section.
 */
export function hasAgentSdkConfig(toml) {
  return /^\[agent_sdk\]/m.test(toml);
}

/**
 * Build the default agent SDK block.
 * @param {object}  [opts]
 * @param {string}  [opts.primary="codex"]  Primary SDK: "codex", "copilot", or "claude"
 * @returns {string}
 */
export function buildAgentSdkBlock({ primary = "codex" } = {}) {
  return buildDefaultAgentSdkBlock(primary);
}

/**
 * Build the vibe_kanban MCP server block (including env vars).
 *
 * The version is pinned from the local package.json dependency to avoid
 * slow npx re-downloads when @latest resolves to a new version.
 *
 * Only VK_BASE_URL and VK_ENDPOINT_URL are set — the MCP server reads
 * the backend port from the VK port file, so PORT/HOST env vars are not
 * needed and were removed to avoid confusion.
 *
 * @param {object} opts
 * @param {string} opts.vkBaseUrl   e.g. "http://127.0.0.1:54089"
 */
export function buildVibeKanbanBlock({
  vkBaseUrl = "http://127.0.0.1:54089",
} = {}) {
  const vkVersion = getVibeKanbanVersion();
  return [
    "",
    "# ── Vibe-Kanban MCP (added by bosun) ──",
    "[mcp_servers.vibe_kanban]",
    "startup_timeout_sec = 120",
    "args = [",
    '    "-y",',
    `    "vibe-kanban@${vkVersion}",`,
    '    "--mcp",',
    "]",
    'command = "npx"',
    'tools = ["*"]',
    "",
    "[mcp_servers.vibe_kanban.env]",
    "# Ensure MCP always targets the correct VK API endpoint.",
    `VK_BASE_URL = "${vkBaseUrl}"`,
    `VK_ENDPOINT_URL = "${vkBaseUrl}"`,
    "",
  ].join("\n");
}

/**
 * Update the env vars inside an existing [mcp_servers.vibe_kanban.env] section.
 * If a key already exists with a different value, it is replaced.
 * If a key is missing, it is appended to the section.
 *
 * @param {string} toml  Current config.toml content
 * @param {object} envVars  Key-value pairs to ensure
 * @returns {string}  Updated TOML
 */
export function updateVibeKanbanEnv(toml, envVars) {
  const envHeader = "[mcp_servers.vibe_kanban.env]";
  const headerIdx = toml.indexOf(envHeader);
  if (headerIdx === -1) return toml; // section doesn't exist

  // Find the end of this section (next [header] or EOF)
  const afterHeader = headerIdx + envHeader.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const sectionEnd = nextSection === -1 ? toml.length : nextSection;

  let section = toml.substring(afterHeader, sectionEnd);

  for (const [key, value] of Object.entries(envVars)) {
    // Check if key already exists in section
    const keyRegex = new RegExp(`^${escapeRegex(key)}\\s*=\\s*.*$`, "m");
    const match = section.match(keyRegex);
    if (match) {
      // Replace existing value
      section = section.replace(keyRegex, `${key} = "${value}"`);
    } else {
      // Append before end of section
      section = section.trimEnd() + `\n${key} = "${value}"\n`;
    }
  }

  return toml.substring(0, afterHeader) + section + toml.substring(sectionEnd);
}

/**
 * Scan all [model_providers.*] sections for stream_idle_timeout_ms.
 * Returns an array of { provider, currentValue, needsUpdate }.
 */
export function auditStreamTimeouts(toml) {
  const results = [];
  // Find all model_providers sections
  const providerRegex = /^\[model_providers\.(\w+)\]/gm;
  let match;
  while ((match = providerRegex.exec(toml)) !== null) {
    const providerName = match[1];
    const sectionStart = match.index + match[0].length;
    const nextSection = toml.indexOf("\n[", sectionStart);
    const sectionEnd = nextSection === -1 ? toml.length : nextSection;
    const section = toml.substring(sectionStart, sectionEnd);

    const timeoutMatch = section.match(/stream_idle_timeout_ms\s*=\s*(\d+)/);
    const currentValue = timeoutMatch ? Number(timeoutMatch[1]) : null;

    results.push({
      provider: providerName,
      currentValue,
      needsUpdate:
        currentValue === null || currentValue < MIN_STREAM_IDLE_TIMEOUT_MS,
      recommended: RECOMMENDED_STREAM_IDLE_TIMEOUT_MS,
    });
  }
  return results;
}

/**
 * Set stream_idle_timeout_ms on a specific model provider section.
 * If the key already exists, update it.  If not, append it at the end of the section.
 *
 * @param {string} toml  Current TOML content
 * @param {string} providerName  e.g. "azure", "openai"
 * @param {number} value  Timeout in ms
 * @returns {string}  Updated TOML
 */
export function setStreamTimeout(toml, providerName, value) {
  const header = `[model_providers.${providerName}]`;
  const headerIdx = toml.indexOf(header);
  if (headerIdx === -1) return toml;

  const afterHeader = headerIdx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const sectionEnd = nextSection === -1 ? toml.length : nextSection;

  let section = toml.substring(afterHeader, sectionEnd);

  const timeoutRegex = /^stream_idle_timeout_ms\s*=\s*\d+.*$/m;
  if (timeoutRegex.test(section)) {
    section = section.replace(
      timeoutRegex,
      `stream_idle_timeout_ms = ${value}  # Updated by bosun`,
    );
  } else {
    // Append to end of section
    section =
      section.trimEnd() +
      `\nstream_idle_timeout_ms = ${value}  # Added by bosun\n`;
  }

  return toml.substring(0, afterHeader) + section + toml.substring(sectionEnd);
}

function hasModelProviderSection(toml, providerName) {
  return new RegExp(`^\\[model_providers\\.${escapeRegex(providerName)}\\]`, "m").test(
    toml,
  );
}

function buildModelProviderSection(providerName, config = {}) {
  const lines = ["", `[model_providers.${providerName}]`];
  if (config.name) lines.push(`name = "${config.name}"`);
  if (config.baseUrl) lines.push(`base_url = "${config.baseUrl}"`);
  if (config.envKey) lines.push(`env_key = "${config.envKey}"`);
  if (config.wireApi) lines.push(`wire_api = "${config.wireApi}"`);
  if (config.model) lines.push(`model = "${config.model}"`);
  lines.push("");
  return lines.join("\n");
}

function ensureModelProviderSectionsFromEnv(toml, env = process.env) {
  const added = [];
  const { env: resolvedEnv, active } = resolveCodexProfileRuntime(env);

  const activeProvider = String(active?.provider || "").toLowerCase();
  const activeBaseUrl =
    active?.baseUrl ||
    resolvedEnv.OPENAI_BASE_URL ||
    "";

  if (
    activeProvider === "azure" ||
    String(activeBaseUrl).toLowerCase().includes(".openai.azure.com")
  ) {
    if (!hasModelProviderSection(toml, "azure")) {
      toml += buildModelProviderSection("azure", {
        name: "Azure OpenAI",
        baseUrl: activeBaseUrl,
        envKey: "AZURE_OPENAI_API_KEY",
        wireApi: "responses",
        model: active?.model || resolvedEnv.CODEX_MODEL || "",
      });
      added.push("azure");
    }
  }

  if (!hasModelProviderSection(toml, "openai")) {
    toml += buildModelProviderSection("openai", {
      name: "OpenAI",
      envKey: "OPENAI_API_KEY",
    });
    added.push("openai");
  }

  return { toml, added };
}

/**
 * Ensure retry settings exist on a model provider section.
 * Adds sensible defaults for long-running agentic workloads.
 */
export function ensureRetrySettings(toml, providerName) {
  const header = `[model_providers.${providerName}]`;
  const headerIdx = toml.indexOf(header);
  if (headerIdx === -1) return toml;

  const afterHeader = headerIdx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const sectionEnd = nextSection === -1 ? toml.length : nextSection;

  let section = toml.substring(afterHeader, sectionEnd);

  const defaults = {
    request_max_retries: 6,
    stream_max_retries: 15,
  };

  for (const [key, defaultVal] of Object.entries(defaults)) {
    const keyRegex = new RegExp(`^${key}\\s*=`, "m");
    if (!keyRegex.test(section)) {
      section =
        section.trimEnd() +
        `\n${key} = ${defaultVal}  # Added by bosun\n`;
    }
  }

  return toml.substring(0, afterHeader) + section + toml.substring(sectionEnd);
}

/**
 * High-level: ensure the config.toml is properly configured for bosun.
 *
 * Returns an object describing what was done:
 *   { created, vkAdded, vkEnvUpdated, timeoutsFixed[], retriesAdded[],
 *     featuresAdded[], sandboxAdded, shellEnvAdded, commonMcpAdded, path }
 *
 * @param {object} opts
 * @param {string}  [opts.vkBaseUrl]
 * @param {boolean} [opts.skipVk]
 * @param {boolean} [opts.manageVkMcp]  Explicit opt-in to manage VK MCP in global config
 * @param {boolean} [opts.dryRun]  If true, returns result without writing
 * @param {object}  [opts.env]     Environment overrides (defaults to process.env)
 * @param {string}  [opts.primarySdk]  Primary agent SDK: "codex", "copilot", or "claude"
 */
export function ensureCodexConfig({
  vkBaseUrl = "http://127.0.0.1:54089",
  skipVk = true,
  manageVkMcp = false,
  dryRun = false,
  env = process.env,
  primarySdk,
} = {}) {
  const result = {
    path: CONFIG_PATH,
    created: false,
    vkAdded: false,
    vkRemoved: false,
    vkEnvUpdated: false,
    agentSdkAdded: false,
    featuresAdded: [],
    agentMaxThreads: null,
    agentMaxThreadsSkipped: null,
    sandboxAdded: false,
    sandboxWorkspaceAdded: false,
    sandboxWorkspaceUpdated: false,
    sandboxWorkspaceRootsAdded: [],
    sandboxStaleRootsRemoved: [],
    shellEnvAdded: false,
    commonMcpAdded: false,
    profileProvidersAdded: [],
    timeoutsFixed: [],
    retriesAdded: [],
    trustedProjectsAdded: [],
    noChanges: true,
  };

  const configExisted = existsSync(CONFIG_PATH);
  const originalToml = readCodexConfig();
  let toml = stripDeprecatedSandboxPermissions(originalToml);
  if (!configExisted) {
    result.created = true;
    toml = "";
  }

  const sandboxModeResult = ensureTopLevelSandboxMode(
    toml,
    env.CODEX_SANDBOX_MODE,
  );
  toml = sandboxModeResult.toml;
  if (sandboxModeResult.changed) {
    result.sandboxAdded = true;
  }

  const repoRoot =
    env.BOSUN_AGENT_REPO_ROOT ||
    env.REPO_ROOT ||
    env.BOSUN_HOME ||
    process.cwd();
  const additionalRoots = env.BOSUN_WORKSPACES_DIR
    ? [env.BOSUN_WORKSPACES_DIR]
    : [];
  const sandboxWorkspaceResult = ensureSandboxWorkspaceWrite(toml, {
    repoRoot,
    additionalRoots,
    writableRoots: env.CODEX_SANDBOX_WRITABLE_ROOTS,
  });
  toml = sandboxWorkspaceResult.toml;
  result.sandboxWorkspaceAdded = sandboxWorkspaceResult.added;
  result.sandboxWorkspaceUpdated =
    sandboxWorkspaceResult.changed && !sandboxWorkspaceResult.added;
  result.sandboxWorkspaceRootsAdded = sandboxWorkspaceResult.rootsAdded;

  const pruneResult = pruneStaleSandboxRoots(toml);
  toml = pruneResult.toml;
  result.sandboxStaleRootsRemoved = pruneResult.removed;

  if (!hasShellEnvPolicy(toml)) {
    toml += buildShellEnvPolicy(env.CODEX_SHELL_ENV_POLICY || "all");
    result.shellEnvAdded = true;
  }

  const rawPrimary = String(primarySdk || env.PRIMARY_AGENT || "codex")
    .trim()
    .toLowerCase();
  const normalizedPrimary =
    rawPrimary === "copilot" || rawPrimary.includes("copilot")
      ? "copilot"
      : rawPrimary === "claude" || rawPrimary.includes("claude")
        ? "claude"
        : rawPrimary === "codex" || rawPrimary.includes("codex")
          ? "codex"
          : "codex";
  if (!hasAgentSdkConfig(toml)) {
    toml += buildAgentSdkBlock({ primary: normalizedPrimary });
    result.agentSdkAdded = true;
  }

  const maxThreads = resolveAgentMaxThreads(env);
  if (maxThreads.explicit && !maxThreads.value) {
    result.agentMaxThreadsSkipped = String(maxThreads.raw);
  } else {
    const maxThreadsResult = ensureAgentMaxThreads(toml, {
      maxThreads: maxThreads.value,
      overwrite: maxThreads.explicit,
    });
    toml = maxThreadsResult.toml;
    if (maxThreadsResult.changed && !maxThreadsResult.skipped) {
      result.agentMaxThreads = {
        from: maxThreadsResult.existing,
        to: maxThreadsResult.applied,
        explicit: maxThreads.explicit,
      };
    } else if (maxThreadsResult.skipped && maxThreads.explicit) {
      result.agentMaxThreadsSkipped = String(maxThreads.raw);
    }
  }

  const featureResult = ensureFeatureFlags(toml, env);
  result.featuresAdded = featureResult.added;
  toml = featureResult.toml;

  const shouldManageGlobalVkMcp = Boolean(manageVkMcp) && !skipVk;
  if (!shouldManageGlobalVkMcp) {
    if (hasVibeKanbanMcp(toml)) {
      toml = removeVibeKanbanMcp(toml);
      result.vkRemoved = true;
    }
  } else if (!hasVibeKanbanMcp(toml)) {
    toml += buildVibeKanbanBlock({ vkBaseUrl });
    result.vkAdded = true;
  } else {
    const vkEnvValues = {
      VK_BASE_URL: vkBaseUrl,
      VK_ENDPOINT_URL: vkBaseUrl,
    };
    const beforeVkEnv = toml;
    if (!hasVibeKanbanEnv(toml)) {
      toml =
        toml.trimEnd() +
        "\n\n[mcp_servers.vibe_kanban.env]\n" +
        `VK_BASE_URL = "${vkBaseUrl}"\n` +
        `VK_ENDPOINT_URL = "${vkBaseUrl}"\n`;
    } else {
      toml = updateVibeKanbanEnv(toml, vkEnvValues);
    }
    if (toml !== beforeVkEnv) {
      result.vkEnvUpdated = true;
    }
  }

  const commonMcpBlocks = [
    {
      present: hasContext7Mcp(toml),
      block: [
        "",
        "# ── Common MCP servers (added by bosun) ──",
        "[mcp_servers.context7]",
        "startup_timeout_sec = 120",
        'command = "npx"',
        'args = ["-y", "@upstash/context7-mcp"]',
        "",
      ].join("\n"),
    },
    {
      present: hasNamedMcpServer(toml, "sequential-thinking"),
      block: [
        "",
        "[mcp_servers.sequential-thinking]",
        "startup_timeout_sec = 120",
        'command = "npx"',
        'args = ["-y", "@modelcontextprotocol/server-sequential-thinking"]',
        "",
      ].join("\n"),
    },
    {
      present: hasNamedMcpServer(toml, "playwright"),
      block: [
        "",
        "[mcp_servers.playwright]",
        "startup_timeout_sec = 120",
        'command = "npx"',
        'args = ["-y", "@playwright/mcp@latest"]',
        "",
      ].join("\n"),
    },
    {
      present: hasMicrosoftDocsMcp(toml),
      block: [
        "",
        "[mcp_servers.microsoft-docs]",
        'url = "https://learn.microsoft.com/api/mcp"',
        'tools = ["microsoft_docs_search", "microsoft_code_sample_search"]',
        "",
      ].join("\n"),
    },
  ];
  for (const item of commonMcpBlocks) {
    if (item.present) continue;
    toml += item.block;
    result.commonMcpAdded = true;
  }

  for (const serverName of ["context7", "sequential-thinking", "playwright"]) {
    const timeoutResult = ensureMcpStartupTimeout(toml, serverName, 120);
    toml = timeoutResult.toml;
  }

  const providerResult = ensureModelProviderSectionsFromEnv(toml, env);
  toml = providerResult.toml;
  result.profileProvidersAdded = providerResult.added;

  const timeoutAudit = auditStreamTimeouts(toml);
  for (const item of timeoutAudit) {
    if (!item.needsUpdate) continue;
    toml = setStreamTimeout(toml, item.provider, RECOMMENDED_STREAM_IDLE_TIMEOUT_MS);
    result.timeoutsFixed.push({
      provider: item.provider,
      from: item.currentValue,
      to: RECOMMENDED_STREAM_IDLE_TIMEOUT_MS,
    });
  }

  const providers = auditStreamTimeouts(toml).map((item) => item.provider);
  for (const provider of providers) {
    const beforeRetry = toml;
    toml = ensureRetrySettings(toml, provider);
    if (toml !== beforeRetry) {
      result.retriesAdded.push(provider);
    }
  }

  const changed = toml !== originalToml;
  result.noChanges = !result.created && !changed;

  if (!dryRun && (result.created || changed)) {
    writeCodexConfig(toml);
  }

  // Keep project-level .codex/config.toml files active by trusting the
  // current execution roots in the global user config. Without this, Codex CLI
  // warns that project config is disabled and ignores repo-scoped settings.
  const trustPaths = [repoRoot, ...additionalRoots]
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .filter((p) => isAbsolute(p));
  if (trustPaths.length > 0) {
    const trustResult = ensureTrustedProjects(trustPaths, { dryRun });
    result.trustedProjectsAdded = trustResult.added;
  }

  return result;
}

/**
 * Print a human-friendly summary of what ensureCodexConfig() did.
 * @param {object} result  Return value from ensureCodexConfig()
 * @param {(msg: string) => void} [log]  Logger (default: console.log)
 */
export function printConfigSummary(result, log = console.log) {
  if (result.noChanges) {
    log("  ✅ Codex CLI config is already up to date");
    log(`     ${result.path}`);
    return;
  }

  if (result.created) {
    log("  📝 Created new Codex CLI config");
  }

  if (result.vkAdded) {
    log("  ✅ Added Vibe-Kanban MCP server to Codex config");
  }

  if (result.vkRemoved) {
    log("  🗑️  Removed Vibe-Kanban MCP server from global config (workspace-scoped only)");
  }

  if (result.vkEnvUpdated) {
    log("  ✅ Updated Vibe-Kanban MCP environment variables");
  }

  if (result.agentSdkAdded) {
    log("  ✅ Added agent SDK selection block");
  }

  if (result.featuresAdded && result.featuresAdded.length > 0) {
    const key = result.featuresAdded.length <= 5
      ? result.featuresAdded.join(", ")
      : `${result.featuresAdded.length} feature flags`;
    log(`  ✅ Added feature flags: ${key}`);
  }

  if (result.sandboxAdded) {
    log("  ✅ Added sandbox permissions (disk-full-write-access)");
  }

  if (result.sandboxWorkspaceAdded) {
    log("  ✅ Added sandbox workspace-write defaults");
  } else if (result.sandboxWorkspaceUpdated) {
    log("  ✅ Updated sandbox workspace-write defaults");
  }

  if (result.sandboxWorkspaceRootsAdded && result.sandboxWorkspaceRootsAdded.length > 0) {
    log(
      `     Writable roots: ${result.sandboxWorkspaceRootsAdded.join(", ")}`,
    );
  }

  if (result.sandboxStaleRootsRemoved && result.sandboxStaleRootsRemoved.length > 0) {
    log(
      `  🗑️  Pruned ${result.sandboxStaleRootsRemoved.length} stale writable root(s) that no longer exist`,
    );
    for (const r of result.sandboxStaleRootsRemoved) {
      log(`     - ${r}`);
    }
  }

  if (result.shellEnvAdded) {
    log("  ✅ Added shell environment policy (inherit=all)");
  }

  if (result.agentMaxThreads) {
    const fromLabel =
      result.agentMaxThreads.from === null
        ? "unset"
        : String(result.agentMaxThreads.from);
    const toLabel = String(result.agentMaxThreads.to);
    const note = result.agentMaxThreads.explicit ? " (env override)" : "";
    log(`  ✅ Set agents.max_threads: ${fromLabel} → ${toLabel}${note}`);
  } else if (result.agentMaxThreadsSkipped) {
    log(
      `  ⚠ Skipped agents.max_threads (invalid value: ${result.agentMaxThreadsSkipped})`,
    );
  }

  if (result.commonMcpAdded) {
    log(
      "  ✅ Added common MCP servers (context7, sequential-thinking, playwright, microsoft-docs)",
    );
  }

  if (result.profileProvidersAdded && result.profileProvidersAdded.length > 0) {
    log(
      `  ✅ Added model provider sections: ${result.profileProvidersAdded.join(", ")}`,
    );
  }

  for (const t of result.timeoutsFixed) {
    const fromLabel =
      t.from === null ? "not set" : `${(t.from / 1000).toFixed(0)}s`;
    const toLabel = `${(t.to / 1000 / 60).toFixed(0)} min`;
    log(
      `  ✅ Set stream_idle_timeout_ms on [${t.provider}]: ${fromLabel} → ${toLabel}`,
    );
  }

  for (const p of result.retriesAdded) {
    log(`  ✅ Added retry settings to [${p}]`);
  }

  log(`     Config: ${result.path}`);
}

// ── Trusted Projects ─────────────────────────────────────────────────────────

/**
 * Escape a string for use inside a double-quoted TOML basic string.
 * Handles backslashes (Windows paths) and double-quote characters.
 */
function tomlEscapeStr(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Format an array of strings as a TOML array literal, correctly escaping
 * backslashes so Windows paths are stored faithfully.
 *
 * Example output:  ["C:\\Users\\jon\\bosun", "/home/jon/bosun"]
 */
function formatTomlArrayEscaped(values) {
  return `[${values.map((v) => `"${tomlEscapeStr(v)}"`).join(", ")}]`;
}

function toWindowsNamespacePath(pathValue) {
  if (process.platform !== "win32") return null;
  const value = String(pathValue || "").trim();
  if (!value) return null;
  if (value.startsWith("\\\\?\\")) return value;
  if (/^[a-zA-Z]:\\/.test(value)) return `\\\\?\\${value}`;
  return null;
}

function normalizeTrustedPathForCompare(pathValue) {
  const raw = String(pathValue || "").trim();
  if (!raw) return "";
  if (process.platform === "win32") {
    let normalized = raw.replace(/\//g, "\\");
    if (normalized.startsWith("\\\\?\\UNC\\")) {
      normalized = `\\\\${normalized.slice(8)}`;
    } else if (normalized.startsWith("\\\\?\\")) {
      normalized = normalized.slice(4);
    }
    normalized = normalized.replace(/[\\/]+$/, "");
    return normalized.toLowerCase();
  }
  return resolve(raw).replace(/\/+$/, "");
}

function buildTrustedPathVariants(pathValue) {
  const base = resolve(pathValue);
  const variants = [base];
  const namespaced = toWindowsNamespacePath(base);
  if (namespaced && namespaced !== base) variants.push(namespaced);
  return variants;
}

/**
 * Parse a TOML basic-string array literal, unescaping backslash sequences.
 */
function parseTomlArrayLiteralEscaped(raw) {
  if (!raw) return [];
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  // Split on commas that are NOT inside quotes
  const items = [];
  let buf = "";
  let inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && inStr) { buf += ch + (inner[++i] || ""); continue; }
    if (ch === '"') { inStr = !inStr; buf += ch; continue; }
    if (ch === "," && !inStr) { items.push(buf.trim()); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) items.push(buf.trim());
  return items
    .map((item) => item.replace(/^"(.*)"$/s, "$1"))              // strip outer quotes
    .map((item) => item.replace(/\\(["\\])/g, "$1"))             // unescape \" and \\
    .filter(Boolean);
}

/**
 * Ensure the given directory paths are listed in the `trusted_projects`
 * top-level key in ~/.codex/config.toml.
 *
 * Codex refuses to load a per-project .codex/config.toml unless the project
 * directory appears in this list — producing warnings like:
 *   "⚠ Project config.toml files are disabled … add <dir> as a trusted project"
 *
 * Paths are stored as-is (forward or back slashes preserved) with proper TOML
 * escaping so Windows paths survive round-trips through the file.
 *
 * @param {string[]} paths   Absolute directories to trust (e.g. [bosunHome])
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{ added: string[], already: string[], path: string }}
 */
export function ensureTrustedProjects(paths, { dryRun = false } = {}) {
  const result = { added: [], already: [], path: CONFIG_PATH };
  const desired = (paths || [])
    .flatMap((p) => buildTrustedPathVariants(p))
    .filter(Boolean);
  if (desired.length === 0) return result;

  let toml = readCodexConfig() || "";

  // Parse existing trusted_projects (multi-line arrays may span lines)
  const existingMatch = toml.match(/^trusted_projects\s*=\s*(\[[^\]]*\])/m);
  const existing = existingMatch ? parseTomlArrayLiteralEscaped(existingMatch[1]) : [];
  const existingNormalized = new Set(
    existing.map((p) => normalizeTrustedPathForCompare(p)).filter(Boolean),
  );

  let changed = false;
  for (const p of desired) {
    const normalized = normalizeTrustedPathForCompare(p);
    if (!normalized) continue;
    if (existingNormalized.has(normalized)) {
      result.already.push(p);
    } else {
      existing.push(p);
      existingNormalized.add(normalized);
      result.added.push(p);
      changed = true;
    }
  }

  if (!changed) return result;
  if (dryRun) return result;

  const newLine = `trusted_projects = ${formatTomlArrayEscaped(existing)}`;

  if (existingMatch) {
    toml = toml.replace(/^trusted_projects\s*=\s*\[[^\]]*\]/m, newLine);
  } else {
    // Insert before the first section header (or at top if no sections)
    const firstSection = toml.search(/^\[/m);
    if (firstSection === -1) {
      toml = `${newLine}\n${toml}`;
    } else {
      toml = `${toml.slice(0, firstSection)}${newLine}\n\n${toml.slice(firstSection)}`;
    }
  }

  mkdirSync(CODEX_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, toml, "utf8");
  return result;
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBoolEnv(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["0", "false", "no", "off", "n"].includes(raw)) return false;
  return true;
}
