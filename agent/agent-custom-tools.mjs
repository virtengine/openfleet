/**
 * agent-custom-tools.mjs — Persistent Custom Tool Library
 *
 * Inspired by Live-SWE-agent's self-evolving scaffold, this module lets agents
 * write and reuse executable helper scripts that persist across sessions.
 *
 * Storage layout:
 *   <workspace>/.bosun/tools/          workspace-scoped (higher priority)
 *   BOSUN_HOME/.bosun/tools/            global (shared across all workspaces)
 *
 * Index: .bosun/tools/index.json
 *
 * Supported script languages:
 *   .mjs  — Node.js ES module (fastest, no deps)
 *   .sh   — bash/sh shell script
 *   .py   — Python (requires python3 in PATH)
 *
 * Agent lifecycle:
 *   1. Before starting a task, load the tools context via getToolsPromptBlock()
 *      and inject into the agent system prompt.
 *   2. When an agent notices a repeated or complex subtask, create a tool via
 *      registerCustomTool() — the script is saved + indexed immediately.
 *   3. Invoke persisted tools via invokeCustomTool() within the same or future
 *      sessions. Usage stats are tracked automatically.
 *   4. High-value tools discovered across tasks can be promoted to global scope
 *      via promoteToGlobal() so all workspaces benefit.
 *
 * EXPORTS:
 *   TOOL_CATEGORIES              — canonical category list
 *   TOOL_DIR                     — relative dir within workspace/.bosun/
 *   listCustomTools(root, opts)  — query the tool index
 *   getCustomTool(root, id)      — fetch one tool entry + script text
 *   registerCustomTool(root, def)— save script + update index
 *   invokeCustomTool(root, id, args, opts) — run a tool, returns { stdout, stderr, exitCode }
 *   deleteCustomTool(root, id)   — remove tool + index entry
 *   promoteToGlobal(root, id)    — copy workspace tool to BOSUN_HOME global store
 *   recordToolUsage(root, id)    — increment usageCount + set lastUsed
 *   getToolsPromptBlock(root, opts) — formatted Markdown for agent context injection
 *   buildToolsContext(root, opts)— structured object for programmatic use
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the committed built-in tool scripts directory */
export const BUILTIN_TOOLS_DIR = resolve(__dirname, "..", "tools");

const execFileAsync = promisify(execFile);

// ── Constants ─────────────────────────────────────────────────────────────────

export const TOOL_DIR = ".bosun/tools";
export const TOOL_INDEX = "index.json";

/**
 * Canonical tool categories. Agents should pick the closest match when
 * registering a new tool — this keeps the library discoverable.
 *
 * @type {Readonly<string[]>}
 */
export const TOOL_CATEGORIES = Object.freeze([
  "analysis",   // codebase inspection, pattern detection, metrics
  "testing",    // test generation, test runners, assertion helpers
  "git",        // git operations beyond basic commit/push
  "build",      // compile, bundle, transpile helpers
  "transform",  // code/data transformation, codemods, reformatting
  "search",     // grep helpers, semantic search, dependency tracing
  "validation", // lint, type-check, schema validation
  "utility",    // miscellaneous helpers that don't fit elsewhere
]);

const VALID_LANGS = Object.freeze(["mjs", "sh", "py"]);

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

// ── Built-in Tool Catalog ─────────────────────────────────────────────────────

/**
 * Bosun-managed built-in tools committed to the repository under bosun/tools/.
 * These are always available as a baseline — workspace and global tools take
 * priority when they share the same ID.
 *
 * Each entry:
 *   id          — filename without extension (must match bosun/tools/<id>.<lang>)
 *   skills      — skill filenames that make this tool especially relevant
 *   agents      — agent-type strings that benefit from this tool automatically
 *   templates   — workflow template names this tool supports
 *   autoInject  — if true, always surface in agent context even without explicit request
 *
 * @type {Readonly<import('./agent-custom-tools.mjs').BuiltinToolDef[]>}
 */
export const BUILTIN_TOOLS = Object.freeze([
  {
    id: "list-todos",
    title: "List TODO/FIXME/HACK Comments",
    description: "Scans codebase for TODO/FIXME/HACK/XXX markers and prints them with file + line number",
    category: "search",
    lang: "mjs",
    tags: ["todo", "fixme", "technical-debt", "comments", "review"],
    skills: ["code-quality-anti-patterns.md"],
    agents: ["review-agent", "primary-agent"],
    templates: [],
    autoInject: false,
    version: "1.0.0",
  },
  {
    id: "test-file-pairs",
    title: "Test File Coverage Pairs",
    description: "Finds source files that lack a corresponding test file (*.test.mjs / .spec.ts / __tests__)",
    category: "testing",
    lang: "mjs",
    tags: ["test", "coverage", "missing", "tdd"],
    skills: ["tdd-pattern.md"],
    agents: ["primary-agent", "review-agent"],
    templates: [],
    autoInject: false,
    version: "1.0.0",
  },
  {
    id: "git-hot-files",
    title: "Git Hot Files (Churn Rank)",
    description: "Ranks files by commit frequency over a configurable window — high churn = higher conflict/review risk",
    category: "git",
    lang: "mjs",
    tags: ["git", "churn", "risk", "hotspot", "review"],
    skills: ["pr-workflow.md", "commit-conventions.md", "agent-coordination.md"],
    agents: ["review-agent"],
    templates: [],
    autoInject: false,
    version: "1.0.0",
  },
  {
    id: "imports-graph",
    title: "Imports Graph (Who Uses Module)",
    description: "Shows all files that import a given module or path fragment — impact analysis before rename/delete",
    category: "analysis",
    lang: "mjs",
    tags: ["imports", "dependency", "impact", "refactor", "graph"],
    skills: ["code-quality-anti-patterns.md"],
    agents: ["primary-agent", "review-agent"],
    templates: [],
    autoInject: false,
    version: "1.0.0",
  },
  {
    id: "validate-no-floating-promises",
    title: "Validate No Floating Promises",
    description: "Detects void asyncFn() calls and other bare async patterns that cause unhandled rejections",
    category: "validation",
    lang: "mjs",
    tags: ["async", "promise", "void", "unhandled", "crash", "quality"],
    skills: ["code-quality-anti-patterns.md"],
    agents: ["review-agent", "primary-agent"],
    templates: [],
    autoInject: false,
    version: "1.0.0",
  },
  {
    id: "dead-exports-scan",
    title: "Dead Exports Scanner",
    description: "Finds exported symbols never imported elsewhere — candidates for removal or cleanup",
    category: "analysis",
    lang: "mjs",
    tags: ["dead-code", "exports", "unused", "cleanup", "refactor"],
    skills: ["code-quality-anti-patterns.md"],
    agents: ["review-agent"],
    templates: [],
    autoInject: false,
    version: "1.0.0",
  },
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBosunHome() {
  return (
    process.env.BOSUN_HOME ||
    process.env.BOSUN_DIR ||
    resolve(homedir(), ".bosun")
  );
}

function getToolStore(rootDir, { global: isGlobal = false } = {}) {
  const base = isGlobal
    ? resolve(getBosunHome(), "tools")
    : resolve(rootDir, TOOL_DIR);
  mkdirSync(base, { recursive: true });
  return base;
}

function getIndexPath(storeDir) {
  return resolve(storeDir, TOOL_INDEX);
}

function safeReadIndex(storeDir) {
  const idx = getIndexPath(storeDir);
  if (!existsSync(idx)) return [];
  try {
    const parsed = JSON.parse(readFileSync(idx, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveIndex(storeDir, entries) {
  writeFileSync(
    getIndexPath(storeDir),
    JSON.stringify(entries, null, 2) + "\n",
    "utf8",
  );
}

function nowISO() {
  return new Date().toISOString();
}

function slugify(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function scriptPath(storeDir, id, lang) {
  return resolve(storeDir, `${id}.${lang}`);
}

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CustomToolEntry
 * @property {string}   id           - unique slug (auto-derived from title if not given)
 * @property {string}   title        - short human-readable name
 * @property {string}   description  - one-line summary of what the tool does
 * @property {string[]} tags         - free-form search tags
 * @property {string}   category     - one of TOOL_CATEGORIES
 * @property {"mjs"|"sh"|"py"} lang  - script language / file extension
 * @property {string}   createdBy    - agentId or "manual"
 * @property {string}   [taskId]     - task that originated the tool
 * @property {string}   createdAt    - ISO timestamp
 * @property {string}   updatedAt    - ISO timestamp
 * @property {number}   usageCount   - number of times invoked
 * @property {string}   [lastUsed]   - ISO timestamp of last invocation
 * @property {"workspace"|"global"|"builtin"} scope
 * @property {string[]} [skills]     - skill filenames this tool complements (affinity wiring)
 * @property {string[]} [agents]     - agent types that benefit from this tool automatically
 * @property {string[]} [templates]  - workflow template names this tool supports
 * @property {boolean}  [autoInject] - surface in every agent context without explicit request
 * @property {string}   [version]    - semver version of the tool script
 * @property {boolean}  [builtin]    - true for tools shipped with bosun
 */

/**
 * @typedef {Object} BuiltinToolDef
 * @property {string}   id
 * @property {string}   title
 * @property {string}   description
 * @property {string}   category
 * @property {"mjs"|"sh"|"py"} lang
 * @property {string[]} tags
 * @property {string[]} skills
 * @property {string[]} agents
 * @property {string[]} templates
 * @property {boolean}  autoInject
 * @property {string}   version
 */

// ── Core API ──────────────────────────────────────────────────────────────────

/**
 * List tools from workspace (and optionally merged with global).
 *
 * @param {string} rootDir
 * @param {{ category?: string, tags?: string[], scope?: 'workspace'|'global'|'all', search?: string, includeGlobal?: boolean }} [opts]
 * @returns {CustomToolEntry[]}
 */
export function listCustomTools(rootDir, opts = {}) {
  const {
    category,
    tags = [],
    scope = "all",
    search,
    includeGlobal = true,
    includeBuiltins = true,
  } = opts;

  let entries = [];

  // Workspace tools
  if (scope !== "global") {
    const wsStore = getToolStore(rootDir, { global: false });
    const wsEntries = safeReadIndex(wsStore).map((e) => ({
      ...e,
      scope: "workspace",
    }));
    entries = entries.concat(wsEntries);
  }

  // Global tools (merged in, workspace takes precedence by id)
  if (includeGlobal && scope !== "workspace") {
    const globalStore = getToolStore(rootDir, { global: true });
    const globalEntries = safeReadIndex(globalStore).map((e) => ({
      ...e,
      scope: "global",
    }));
    const wsIds = new Set(entries.map((e) => e.id));
    for (const ge of globalEntries) {
      if (!wsIds.has(ge.id)) entries.push(ge);
    }
  }

  // Builtin tools (lowest priority — overridden by workspace/global with same id)
  if (includeBuiltins && scope !== "workspace" && scope !== "global") {
    const existingIds = new Set(entries.map((e) => e.id));
    for (const be of listBuiltinTools()) {
      if (!existingIds.has(be.id)) entries.push(be);
    }
  }

  // Filters
  if (category) {
    entries = entries.filter((e) => e.category === category);
  }
  if (tags.length > 0) {
    entries = entries.filter((e) =>
      tags.some((t) => (e.tags || []).includes(t)),
    );
  }
  if (search) {
    const q = search.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.id.includes(q) ||
        e.title.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        (e.tags || []).some((t) => t.includes(q)),
    );
  }

  return entries.sort((a, b) => b.usageCount - a.usageCount);
}

/**
 * Get a specific tool entry and its script content.
 *
 * @param {string} rootDir
 * @param {string} toolId
 * @returns {{ entry: CustomToolEntry, script: string }|null}
 */
export function getCustomTool(rootDir, toolId) {
  // Workspace-scoped takes precedence, then global, then builtin
  for (const isGlobal of [false, true]) {
    const storeDir = getToolStore(rootDir, { global: isGlobal });
    const index = safeReadIndex(storeDir);
    const entry = index.find((e) => e.id === toolId);
    if (!entry) continue;

    const sPath = scriptPath(storeDir, entry.id, entry.lang);
    if (!existsSync(sPath)) continue;

    return {
      entry: { ...entry, scope: isGlobal ? "global" : "workspace" },
      script: readFileSync(sPath, "utf8"),
    };
  }

  // Fall back to built-in tools shipped with bosun
  const builtinDef = BUILTIN_TOOLS.find((b) => b.id === toolId);
  if (builtinDef) {
    const sPath = resolve(BUILTIN_TOOLS_DIR, `${builtinDef.id}.${builtinDef.lang}`);
    if (existsSync(sPath)) {
      return {
        entry: {
          ...builtinDef,
          scope: "builtin",
          builtin: true,
          createdBy: "bosun",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          usageCount: 0,
        },
        script: readFileSync(sPath, "utf8"),
      };
    }
  }

  return null;
}

/**
 * Register (create or update) a custom tool.
 * Saves the script file and updates index.json.
 *
 * @param {string} rootDir
 * @param {{ id?: string, title: string, description: string, tags?: string[], category: string, lang: 'mjs'|'sh'|'py', script: string, createdBy?: string, taskId?: string, global?: boolean }} def
 * @returns {CustomToolEntry}
 */
export function registerCustomTool(rootDir, def) {
  const {
    title,
    description,
    tags = [],
    category,
    lang,
    script,
    createdBy = "agent",
    taskId,
    global: isGlobal = false,
    // Affinity / wiring metadata
    skills = [],
    agents = [],
    templates = [],
    autoInject = false,
    version,
  } = def;

  if (!title || typeof title !== "string") {
    throw new TypeError("registerCustomTool: title is required");
  }
  if (!script || typeof script !== "string") {
    throw new TypeError("registerCustomTool: script is required");
  }
  if (!TOOL_CATEGORIES.includes(category)) {
    throw new RangeError(
      `registerCustomTool: invalid category "${category}". Must be one of: ${TOOL_CATEGORIES.join(", ")}`,
    );
  }
  if (!VALID_LANGS.includes(lang)) {
    throw new RangeError(
      `registerCustomTool: invalid lang "${lang}". Must be one of: ${VALID_LANGS.join(", ")}`,
    );
  }

  const storeDir = getToolStore(rootDir, { global: isGlobal });
  const index = safeReadIndex(storeDir);

  const id = def.id || slugify(title) || `tool-${Date.now()}`;
  const existingIdx = index.findIndex((e) => e.id === id);
  const now = nowISO();

  /** @type {CustomToolEntry} */
  const entry = {
    id,
    title,
    description: description || "",
    tags: Array.from(new Set(tags.map((t) => String(t).toLowerCase()))),
    category,
    lang,
    createdBy,
    ...(taskId ? { taskId } : {}),
    createdAt: existingIdx >= 0 ? index[existingIdx].createdAt : now,
    updatedAt: now,
    usageCount: existingIdx >= 0 ? index[existingIdx].usageCount ?? 0 : 0,
    ...(existingIdx >= 0 && index[existingIdx].lastUsed
      ? { lastUsed: index[existingIdx].lastUsed }
      : {}),
    scope: isGlobal ? "global" : "workspace",
    // Affinity metadata (persisted for future skill/agent matching)
    ...(skills.length > 0 ? { skills } : {}),
    ...(agents.length > 0 ? { agents } : {}),
    ...(templates.length > 0 ? { templates } : {}),
    ...(autoInject ? { autoInject } : {}),
    ...(version ? { version } : {}),
  };

  // Write script file
  const sPath = scriptPath(storeDir, id, lang);
  writeFileSync(sPath, script, "utf8");
  if (lang === "sh" && process.platform !== "win32") {
    try {
      chmodSync(sPath, 0o755);
    } catch {
      /* best-effort on unsupported filesystems */
    }
  }

  // Update index
  if (existingIdx >= 0) {
    index[existingIdx] = entry;
  } else {
    index.push(entry);
  }
  saveIndex(storeDir, index);

  return entry;
}

/**
 * Invoke a custom tool by ID.
 *
 * @param {string} rootDir
 * @param {string} toolId
 * @param {string[]} [args]       - CLI arguments passed to the script
 * @param {{ timeout?: number, cwd?: string, env?: Record<string,string> }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export async function invokeCustomTool(rootDir, toolId, args = [], opts = {}) {
  const result = getCustomTool(rootDir, toolId);
  if (!result) {
    throw new Error(`invokeCustomTool: tool "${toolId}" not found`);
  }

  const { entry } = result;
  let sPath;
  if (entry.scope === "builtin") {
    sPath = resolve(BUILTIN_TOOLS_DIR, `${entry.id}.${entry.lang}`);
  } else {
    const isGlobal = entry.scope === "global";
    const storeDir = getToolStore(rootDir, { global: isGlobal });
    sPath = scriptPath(storeDir, entry.id, entry.lang);
  }

  const timeout = opts.timeout ?? DEFAULT_TOOL_TIMEOUT_MS;
  const cwd = opts.cwd ?? rootDir;
  const env = { ...process.env, ...opts.env };

  let cmd, cmdArgs;
  switch (entry.lang) {
    case "mjs":
      cmd = process.execPath; // use same node binary
      cmdArgs = [sPath, ...args];
      break;
    case "sh":
      cmd = process.platform === "win32" ? "bash" : "/bin/sh";
      cmdArgs = [sPath, ...args];
      break;
    case "py":
      cmd = "python3";
      cmdArgs = [sPath, ...args];
      break;
    default:
      throw new Error(`invokeCustomTool: unsupported lang "${entry.lang}"`);
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const out = await execFileAsync(cmd, cmdArgs, {
      cwd,
      env,
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    });
    // Node versions/environments may resolve promisified execFile as:
    // - { stdout, stderr } (modern child_process custom promisify)
    // - stdout string/buffer only (legacy/mocked fallback)
    // - [stdout, stderr] tuple (some custom wrappers)
    if (out && typeof out === "object" && !Array.isArray(out)) {
      stdout = String(out.stdout ?? "");
      stderr = String(out.stderr ?? "");
    } else if (Array.isArray(out)) {
      stdout = String(out[0] ?? "");
      stderr = String(out[1] ?? "");
    } else {
      stdout = String(out ?? "");
      stderr = "";
    }
  } catch (err) {
    stdout = String(err?.stdout ?? "");
    stderr = String(err?.stderr ?? err?.message ?? "");
    const numericExit = Number(err?.code);
    const numericStatus = Number(err?.status);
    exitCode = Number.isFinite(numericExit)
      ? numericExit
      : Number.isFinite(numericStatus)
        ? numericStatus
        : 1;
  }

  // Record usage non-blocking
  recordToolUsage(rootDir, toolId).catch(() => {});

  return { stdout, stderr, exitCode };
}

/**
 * Increment usageCount and update lastUsed for a tool.
 *
 * @param {string} rootDir
 * @param {string} toolId
 * @returns {Promise<void>}
 */
export async function recordToolUsage(rootDir, toolId) {
  for (const isGlobal of [false, true]) {
    const storeDir = getToolStore(rootDir, { global: isGlobal });
    const index = safeReadIndex(storeDir);
    const idx = index.findIndex((e) => e.id === toolId);
    if (idx < 0) continue;
    index[idx].usageCount = (index[idx].usageCount ?? 0) + 1;
    index[idx].lastUsed = nowISO();
    saveIndex(storeDir, index);
    return;
  }
}

/**
 * Delete a custom tool (removes script + index entry).
 *
 * @param {string} rootDir
 * @param {string} toolId
 * @param {{ global?: boolean }} [opts]
 * @returns {boolean} true if the tool was found and removed
 */
export function deleteCustomTool(rootDir, toolId, { global: isGlobal = false } = {}) {
  const storeDir = getToolStore(rootDir, { global: isGlobal });
  const index = safeReadIndex(storeDir);
  const idx = index.findIndex((e) => e.id === toolId);
  if (idx < 0) return false;

  const entry = index[idx];
  const sPath = scriptPath(storeDir, entry.id, entry.lang);
  if (existsSync(sPath)) {
    try {
      rmSync(sPath);
    } catch {
      /* best effort */
    }
  }

  index.splice(idx, 1);
  saveIndex(storeDir, index);
  return true;
}

/**
 * Promote a workspace-scoped tool to the global store.
 * This makes the tool available across all workspaces on this machine.
 *
 * @param {string} rootDir
 * @param {string} toolId
 * @returns {Promise<CustomToolEntry>} the entry as it now exists in global scope
 */
export async function promoteToGlobal(rootDir, toolId) {
  const wsStore = getToolStore(rootDir, { global: false });
  const wsIndex = safeReadIndex(wsStore);
  const wsEntry = wsIndex.find((e) => e.id === toolId);
  if (!wsEntry) {
    throw new Error(
      `promoteToGlobal: workspace tool "${toolId}" not found`,
    );
  }

  const srcPath = scriptPath(wsStore, wsEntry.id, wsEntry.lang);
  if (!existsSync(srcPath)) {
    throw new Error(
      `promoteToGlobal: script file for "${toolId}" missing`,
    );
  }

  const globalStore = getToolStore(rootDir, { global: true });
  const globalIndex = safeReadIndex(globalStore);

  // Copy script
  const destPath = scriptPath(globalStore, wsEntry.id, wsEntry.lang);
  await copyFile(srcPath, destPath);

  // Upsert in global index
  const globalEntry = { ...wsEntry, scope: "global", updatedAt: nowISO() };
  const existingIdx = globalIndex.findIndex((e) => e.id === toolId);
  if (existingIdx >= 0) {
    globalIndex[existingIdx] = globalEntry;
  } else {
    globalIndex.push(globalEntry);
  }
  saveIndex(globalStore, globalIndex);

  return globalEntry;
}

// ── Agent Context Integration ─────────────────────────────────────────────────

/**
 * Returns a Markdown block listing available custom tools.
 * Inject this into the agent system prompt so agents know what's available
 * and reflect on whether to create new tools.
 *
 * @param {string} rootDir
 * @param {{ limit?: number, category?: string, tags?: string[], emitReflectHint?: boolean, activeSkills?: string[], agentType?: string, template?: string, includeBuiltins?: boolean, eagerOnly?: boolean, discoveryMode?: boolean }} [opts]
 * @returns {string}
 */
export function getToolsPromptBlock(rootDir, opts = {}) {
  const {
    limit = 16,
    category,
    tags,
    emitReflectHint = true,
    // Affinity context — when provided, relevant tools are surfaced first
    activeSkills,
    agentType,
    template,
    includeBuiltins = true,
    eagerOnly = false,
    discoveryMode = false,
  } = opts;

  let tools;
  if (activeSkills?.length > 0 || agentType || template) {
    // Affinity pass first: tools wired to the active skills/agent/template
    const affinityTools = getAffinityTools(rootDir, {
      activeSkills,
      agentType,
      template,
      limit,
      includeBuiltins,
    });
    const affinityIds = new Set(affinityTools.map((t) => t.id));
    const remaining = listCustomTools(rootDir, { category, tags, includeBuiltins })
      .filter((t) => !affinityIds.has(t.id))
      .slice(0, Math.max(0, limit - affinityTools.length));
    tools = [...affinityTools, ...remaining];
  } else {
    tools = listCustomTools(rootDir, { category, tags, includeBuiltins }).slice(0, limit);
  }

  if (eagerOnly) {
    tools = tools.filter((tool) => {
      if (tool.autoInject) return true;
      if (activeSkills?.length > 0 && tool.skills?.length > 0) {
        return activeSkills.some((skill) => tool.skills.includes(skill));
      }
      return false;
    });
  }

  const lines = [
    "## Custom Tools Library",
    "",
    discoveryMode
      ? "Only eagerly-loaded tools are listed below. Use the MCP discovery tools to find the rest at runtime."
      : "The following reusable helper scripts are available. Run them via",
    discoveryMode
      ? "Use `search`, then `get_schema`, then `execute` for tools not listed here. Use `call_discovered_tool` only for simple direct calls."
      : "`node <tool>.mjs`, `bash <tool>.sh`, or `python3 <tool>.py`.",
    "Built-in tools live in `bosun/tools/`; workspace tools in `.bosun/tools/`.",
    "",
  ];

  if (tools.length === 0) {
    lines.push("_(No custom tools registered yet.)_");
  } else {
    // Group by category
    /** @type {Map<string, CustomToolEntry[]>} */
    const byCategory = new Map();
    for (const t of tools) {
      const cat = t.category ?? "utility";
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(t);
    }

    for (const [cat, entries] of byCategory) {
      lines.push(`### ${cat}`);
      for (const e of entries) {
        const scopeTag =
          e.scope === "global" ? " *(global)*"
          : e.scope === "builtin" ? " *(builtin)*"
          : "";
        const usageTag = e.usageCount > 0 ? ` — used ${e.usageCount}×` : "";
        lines.push(`- **${e.id}.${e.lang}** — ${e.description}${scopeTag}${usageTag}`);
        if (e.skills?.length > 0) {
          lines.push(`  Skills: ${e.skills.join(", ")}`);
        }
        if (e.tags?.length > 0) {
          lines.push(`  Tags: \`${e.tags.join("`, `")}\``);
        }
      }
      lines.push("");
    }
  }

  if (emitReflectHint) {
    lines.push(
      "---",
      "",
      "**Reflect:** Before writing repetitive inline code, check if an existing",
      "custom tool covers the need. If you encounter a pattern that future agents",
      "(or yourself on retry) would benefit from having as a persistent script,",
      "save it to `.bosun/tools/` and register it via the Bosun SDK so the whole",
      "team benefits. Good candidates: analysis helpers, test generators, codemods,",
      "build/lint wrappers that differ from what `npm run *` provides.",
      "",
    );
  }

  return lines.join("\n");
}

/**
 * Return a structured context object for programmatic consumption
 * (e.g., UI display, analytics, or downstream processing).
 *
 * @param {string} rootDir
 * @param {{ limit?: number }} [opts]
 * @returns {{ tools: CustomToolEntry[], categories: Record<string, number>, totalGlobal: number, totalWorkspace: number }}
 */
export function buildToolsContext(rootDir, opts = {}) {
  const { limit = 50, includeBuiltins = true } = opts;
  const allTools = listCustomTools(rootDir, { includeGlobal: true, includeBuiltins });
  const tools = allTools.slice(0, limit);

  const categories = {};
  let totalGlobal = 0;
  let totalWorkspace = 0;
  let totalBuiltin = 0;
  for (const t of allTools) {
    categories[t.category] = (categories[t.category] ?? 0) + 1;
    if (t.scope === "global") totalGlobal++;
    else if (t.scope === "builtin") totalBuiltin++;
    else totalWorkspace++;
  }

  return { tools, categories, totalGlobal, totalWorkspace, totalBuiltin };
}

// ── Builtin & Affinity API ──────────────────────────────────────────────────

/**
 * Return all built-in tools as CustomToolEntry objects.
 * These are the tools committed to bosun/tools/ and shipped with the package.
 * They are always available at lowest priority (workspace/global override by id).
 *
 * @returns {CustomToolEntry[]}
 */
export function listBuiltinTools() {
  return BUILTIN_TOOLS.map((b) => ({
    id: b.id,
    title: b.title,
    description: b.description,
    category: b.category,
    lang: b.lang,
    tags: b.tags ?? [],
    skills: b.skills ?? [],
    agents: b.agents ?? [],
    templates: b.templates ?? [],
    autoInject: b.autoInject ?? false,
    version: b.version ?? "1.0.0",
    builtin: true,
    scope: "builtin",
    createdBy: "bosun",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    usageCount: 0,
  }));
}

/**
 * Return tools most relevant to the current agent context.
 *
 * Tools are scored by how many affinity criteria they satisfy:
 *   - Each matching skill  = +3 points
 *   - Matching agentType   = +2 points
 *   - Matching template    = +2 points
 *   - autoInject flag set  = +1 point
 *
 * If no criteria are passed, returns the top tools by usage count.
 *
 * @param {string} rootDir
 * @param {{
 *   activeSkills?: string[],
 *   agentType?: string,
 *   template?: string,
 *   limit?: number,
 *   includeBuiltins?: boolean,
 *   category?: string,
 *   tags?: string[],
 * }} [opts]
 * @returns {CustomToolEntry[]}
 */
export function getAffinityTools(rootDir, opts = {}) {
  const {
    activeSkills = [],
    agentType,
    template,
    limit = 8,
    includeBuiltins = true,
    category,
    tags,
  } = opts;

  const all = listCustomTools(rootDir, { includeBuiltins, category, tags });

  const hasCriteria = activeSkills.length > 0 || !!agentType || !!template;

  const scored = all.map((tool) => {
    let score = 0;

    // Skills affinity (strongest signal — tool was explicitly designed for this skill)
    if (activeSkills.length > 0 && tool.skills?.length > 0) {
      const hits = activeSkills.filter((s) => tool.skills.includes(s)).length;
      score += hits * 3;
    }

    // Agent type affinity
    if (agentType && tool.agents?.includes(agentType)) {
      score += 2;
    }

    // Template affinity
    if (template && tool.templates?.includes(template)) {
      score += 2;
    }

    // autoInject tools always appear in context
    if (tool.autoInject) score += 1;

    return { tool, score };
  });

  return scored
    .filter((s) => !hasCriteria || s.score > 0)
    .sort((a, b) => b.score - a.score || b.tool.usageCount - a.tool.usageCount)
    .slice(0, limit)
    .map((s) => s.tool);
}
