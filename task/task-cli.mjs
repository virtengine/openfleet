#!/usr/bin/env node

/**
 * task-cli.mjs — CLI task management for Bosun
 *
 * Provides a complete CRUD interface for kanban tasks via the command line.
 * Used by both human operators and AI agents to manage the backlog.
 *
 * Usage:
 *   bosun task list [--status <status>] [--priority <priority>] [--tag <tag>] [--json]
 *   bosun task create <json-string>
 *   bosun task create --title "..." [--description "..."] [--priority high] [--tags ui,fix] [--branch main]
 *   bosun task get <task-id> [--json]
 *   bosun task update <task-id> <json-patch>
 *   bosun task update <task-id> --status todo --priority high
 *   bosun task delete <task-id>
 *   bosun task stats [--json]
 *   bosun task import <json-file>
 *
 * EXPORTS:
 *   runTaskCli(args)      — Main entry point for CLI routing
 *   taskCreate(data)      — Programmatic task creation
 *   taskList(filters)     — Programmatic task listing
 *   taskGet(id)           — Programmatic task fetch
 *   taskUpdate(id, patch) — Programmatic task update
 *   taskDelete(id)        — Programmatic task deletion
 *   taskStats()           — Programmatic stats
 */

import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TAG = "[task-cli]";

// ── Store helpers ─────────────────────────────────────────────────────────────

let _storeReady = false;

function ensureStore() {
  if (_storeReady) return;
  // Import is sync-cached after first call
  const { configureTaskStore, loadStore } = _getTaskStore();
  configureTaskStore();
  loadStore();
  _storeReady = true;
}

/** Lazy-load task-store to avoid circular deps */
let _taskStoreModule = null;
function _getTaskStore() {
  if (!_taskStoreModule) {
    // Dynamic import is async but we need sync access — use the fact that
    // ES module imports are cached and we can do a synchronous re-import
    // via import.meta.resolve. Instead, we eagerly import at runTaskCli().
    throw new Error("task-store not loaded — call initStore() first");
  }
  return _taskStoreModule;
}

async function initStore() {
  if (!_taskStoreModule) {
    _taskStoreModule = await import("./task-store.mjs");
  }
  if (!_storeReady) {
    const storePath = resolveKanbanStorePath();
    _taskStoreModule.configureTaskStore({ storePath });
    _taskStoreModule.loadStore();
    _storeReady = true;
  }
  return _taskStoreModule;
}

/**
 * Resolve the kanban store path with priority:
 *   1. BOSUN_STORE_PATH env var (explicit override)
 *   2. Active workspace store derived from global bosun.config.json
 *   3. Repo root walked from CWD (legacy fallback)
 */
function resolveKanbanStorePath() {
  if (process.env.BOSUN_STORE_PATH) return process.env.BOSUN_STORE_PATH;

  try {
    const bosunHome = _deriveBosunHome();
    if (bosunHome) {
      const configPath = resolve(bosunHome, "bosun.config.json");
      if (existsSync(configPath)) {
        const cfg = JSON.parse(readFileSync(configPath, "utf8"));
        const workspacesDir = cfg.workspacesDir || resolve(bosunHome, "workspaces");
        const activeWs = cfg.activeWorkspace;
        if (activeWs && workspacesDir) {
          const ws = (cfg.workspaces || []).find((w) => w.id === activeWs);
          const primaryRepoName =
            ws?.activeRepo ||
            (cfg.repos || []).find((r) => r.primary)?.name;
          if (primaryRepoName) {
            const wsStorePath = resolve(
              workspacesDir,
              activeWs,
              primaryRepoName,
              ".bosun",
              ".cache",
              "kanban-state.json",
            );
            // Use this path if the containing directory already exists
            // (daemon has initialised the workspace) or we can create it
            const wsStoreDir = dirname(wsStorePath);
            if (existsSync(wsStoreDir) || existsSync(dirname(wsStoreDir))) {
              return wsStorePath;
            }
          }
        }
      }
    }
  } catch {
    // fall through to legacy CWD-based resolution
  }

  const repoRoot = findTrueRepoRoot(process.cwd()) || process.cwd();
  return resolve(repoRoot, ".bosun", ".cache", "kanban-state.json");
}

function _deriveBosunHome() {
  if (process.env.BOSUN_HOME) return process.env.BOSUN_HOME;
  if (process.env.BOSUN_DIR) return process.env.BOSUN_DIR;
  // Windows: %APPDATA%/bosun, Unix: ~/.bosun
  if (process.env.APPDATA) return resolve(process.env.APPDATA, "bosun");
  return resolve(homedir(), ".bosun");
}

/**
 * Walk up from startDir to find the first directory with a real .git directory
 * (a directory, not a file — files indicate submodules/worktrees).
 * Falls back to the first .git of any kind.
 */
function findTrueRepoRoot(startDir) {
  let current = resolve(startDir);
  let firstGitAnything = null;
  while (true) {
    const gitPath = resolve(current, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isDirectory()) return current;
        if (!firstGitAnything) firstGitAnything = current;
      } catch {
        if (!firstGitAnything) firstGitAnything = current;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return firstGitAnything;
}

// ── Arg parsing helpers ───────────────────────────────────────────────────────

function getArgValue(args, flag) {
  const match = args.find((a) => a.startsWith(`${flag}=`));
  if (match) return match.slice(flag.length + 1).trim();
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
    return args[idx + 1].trim();
  }
  return null;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

// ── Programmatic API ──────────────────────────────────────────────────────────

/**
 * Create a new task. Accepts a plain object with task fields.
 * Returns the created task or throws on error.
 */
export async function taskCreate(data) {
  const store = await initStore();
  const id = data.id || randomUUID();
  const parsedCandidateCount = Number(data?.candidateCount);
  const candidateCount = Number.isFinite(parsedCandidateCount)
    ? Math.max(1, Math.min(12, Math.trunc(parsedCandidateCount)))
    : null;
  const inputMeta =
    data?.meta && typeof data.meta === "object" && !Array.isArray(data.meta)
      ? { ...data.meta }
      : {};
  const executionMeta =
    inputMeta.execution && typeof inputMeta.execution === "object"
      ? { ...inputMeta.execution }
      : {};
  if (candidateCount && candidateCount > 1) {
    executionMeta.candidateCount = candidateCount;
  }
  if (Object.keys(executionMeta).length > 0) {
    inputMeta.execution = executionMeta;
  }
  const taskData = {
    id,
    title: data.title,
    description: data.description || "",
    status: data.status || "draft",
    draft: data.draft ?? (data.status === "draft" || !data.status),
    priority: data.priority || "medium",
    tags: normalizeTags(data.tags),
    baseBranch: data.baseBranch || data.base_branch || "main",
    workspace: data.workspace || process.cwd(),
    repository: data.repository || "",
    repositories: data.repositories || [],
    candidateCount: candidateCount && candidateCount > 1 ? candidateCount : undefined,
    meta: inputMeta,
  };

  // Format description from structured fields if provided
  if (data.implementation_steps || data.acceptance_criteria || data.verification) {
    const parts = [taskData.description || ""];
    if (data.implementation_steps?.length) {
      parts.push("", "## Implementation Steps");
      for (const step of data.implementation_steps) {
        parts.push(`- ${step}`);
      }
    }
    if (data.acceptance_criteria?.length) {
      parts.push("", "## Acceptance Criteria");
      for (const c of data.acceptance_criteria) {
        parts.push(`- ${c}`);
      }
    }
    if (data.verification?.length) {
      parts.push("", "## Verification");
      for (const v of data.verification) {
        parts.push(`- ${v}`);
      }
    }
    taskData.description = parts.join("\n");
  }

  const result = store.addTask(taskData);
  if (!result) {
    throw new Error(`Failed to create task — addTask returned null`);
  }
  return result;
}

/**
 * List tasks with optional filters.
 * @param {object} [filters] - { status, priority, tag, search, limit }
 * @returns {object[]} Array of tasks
 */
export async function taskList(filters = {}) {
  const store = await initStore();
  let tasks = store.getAllTasks();

  if (filters.status) {
    tasks = tasks.filter((t) => t.status === filters.status);
  }
  if (filters.priority) {
    tasks = tasks.filter((t) => t.priority === filters.priority);
  }
  if (filters.tag) {
    const tag = filters.tag.toLowerCase();
    tasks = tasks.filter((t) => (t.tags || []).includes(tag));
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    tasks = tasks.filter(
      (t) =>
        (t.title || "").toLowerCase().includes(q) ||
        (t.description || "").toLowerCase().includes(q),
    );
  }

  // Sort: priority (critical > high > medium > low), then by createdAt desc
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  tasks.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 99;
    const pb = priorityOrder[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    return (b.createdAt || "").localeCompare(a.createdAt || "");
  });

  if (filters.limit) {
    tasks = tasks.slice(0, filters.limit);
  }

  return tasks;
}

/**
 * Get a single task by ID.
 * @param {string} id - Task ID (UUID or partial prefix)
 * @returns {object|null} Task or null
 */
export async function taskGet(id) {
  const store = await initStore();

  // Try exact match first
  let task = store.getTask(id);
  if (task) return task;

  // Try prefix match
  const all = store.getAllTasks();
  const matches = all.filter((t) => t.id?.startsWith(id));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous task ID prefix "${id}" — matches ${matches.length} tasks. Use a longer prefix.`,
    );
  }
  return null;
}

/**
 * Update a task by ID with a partial patch.
 * @param {string} id - Task ID
 * @param {object} patch - Fields to update
 * @returns {object} Updated task
 */
export async function taskUpdate(id, patch) {
  const store = await initStore();

  // Resolve prefix
  const task = await taskGet(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }

  // Normalize certain fields
  const updates = { ...patch };
  if (updates.tags) {
    updates.tags = normalizeTags(updates.tags);
  }
  if (updates.base_branch) {
    updates.baseBranch = updates.base_branch;
    delete updates.base_branch;
  }

  // Use setTaskStatus for status changes (tracks history)
  if (updates.status && updates.status !== task.status) {
    store.setTaskStatus(task.id, updates.status, "external");
    delete updates.status;
  }

  // Apply remaining updates
  const remaining = Object.keys(updates).filter((k) => k !== "id");
  if (remaining.length > 0) {
    const result = store.updateTask(task.id, updates);
    if (!result) {
      throw new Error(`Failed to update task ${task.id}`);
    }
    return result;
  }

  return store.getTask(task.id);
}

/**
 * Delete a task by ID.
 * @param {string} id - Task ID
 * @returns {boolean} True if deleted
 */
export async function taskDelete(id) {
  const store = await initStore();
  const task = await taskGet(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }
  return store.removeTask(task.id);
}

/**
 * Get aggregate task statistics.
 * @returns {object} Stats object
 */
export async function taskStats() {
  const store = await initStore();
  return store.getStats();
}

/**
 * Bulk import tasks from a JSON file or array.
 * @param {object[]|string} source - Array of task objects or path to JSON file
 * @returns {{ created: number, failed: number, errors: string[] }}
 */
export async function taskImport(source) {
  let tasks;
  if (typeof source === "string") {
    // File path
    const raw = readFileSync(resolve(source), "utf8");
    const parsed = JSON.parse(raw);
    tasks = parsed.tasks || parsed.backlog || parsed;
    if (!Array.isArray(tasks)) {
      throw new Error("JSON must contain an array of tasks (top-level or under 'tasks' key)");
    }
  } else if (Array.isArray(source)) {
    tasks = source;
  } else {
    throw new Error("Source must be a file path or array of task objects");
  }

  let created = 0;
  let failed = 0;
  const errors = [];

  for (const t of tasks) {
    try {
      await taskCreate(t);
      created++;
    } catch (err) {
      failed++;
      errors.push(`${t.title || "untitled"}: ${err.message}`);
    }
  }

  return { created, failed, errors };
}

// ── CLI Router ────────────────────────────────────────────────────────────────

/**
 * Main CLI entry point. Parses args and routes to subcommands.
 * @param {string[]} args - CLI arguments after "task" (e.g., ["list", "--status", "todo"])
 */
export async function runTaskCli(args) {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  // Top-level help: `bosun task --help`, `bosun task -h`, `bosun task help`, or bare `bosun task`
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    showTaskHelp();
    process.exit(0);
  }

  switch (subcommand) {
    case "list":
    case "ls":
      return await cliList(subArgs);
    case "create":
    case "add":
      return await cliCreate(subArgs);
    case "get":
    case "show":
      return await cliGet(subArgs);
    case "update":
    case "edit":
      return await cliUpdate(subArgs);
    case "delete":
    case "rm":
    case "remove":
      return await cliDelete(subArgs);
    case "plan":
      console.log("\n  Task planner has been removed. Use workflow templates instead.");
      console.log("  See: bosun workflow list\n");
      return;
    case "stats":
      return await cliStats(subArgs);
    case "import":
      return await cliImport(subArgs);
    default:
      showTaskHelp();
      process.exit(subcommand ? 1 : 0);
  }
}

// ── CLI Subcommands ───────────────────────────────────────────────────────────

async function cliList(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(`
  bosun task list — List tasks with optional filters

  USAGE
    bosun task list [options]

  OPTIONS
    --status <s>      Filter: draft|todo|inprogress|inreview|done|blocked
    --priority <p>    Filter: low|medium|high|critical
    --tag <tag>       Filter by tag
    --search <text>   Full-text search in title/description
    --limit <n>       Max results to return
    --json            Output as JSON array

  EXAMPLES
    bosun task list
    bosun task list --status todo
    bosun task list --priority high --json
    bosun task list --tag ui --limit 10
    bosun task list --search 'retry queue'
`);
    return;
  }
  const filters = {};
  const status = getArgValue(args, "--status");
  const priority = getArgValue(args, "--priority");
  const tag = getArgValue(args, "--tag");
  const search = getArgValue(args, "--search");
  const limit = getArgValue(args, "--limit");
  const json = hasFlag(args, "--json");

  if (status) filters.status = status;
  if (priority) filters.priority = priority;
  if (tag) filters.tag = tag;
  if (search) filters.search = search;
  if (limit) filters.limit = parseInt(limit, 10);

  const tasks = await taskList(filters);

  if (json) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }

  if (tasks.length === 0) {
    console.log("\n  No tasks found.\n");
    return;
  }

  console.log(`\n  ${tasks.length} task(s):\n`);
  for (const t of tasks) {
    const tags = (t.tags || []).join(", ");
    const id = t.id?.slice(0, 8) || "????????";
    const prio = (t.priority || "?").padEnd(8);
    const status = (t.status || "?").padEnd(12);
    console.log(`  ${id}  [${status}] ${prio} ${t.title || "(untitled)"}`);
    if (tags) console.log(`           tags: ${tags}`);
  }
  console.log("");
}

async function cliCreate(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    showCreateHelp();
    return;
  }

  let data;

  // Check if first positional arg (not a flag value) is a JSON string.
  // Skip args that are values of flag options (--title <value>, etc).
  let firstArg = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      // Skip the flag and its value (if next arg is not a flag)
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        i++; // skip the value
      }
      continue;
    }
    firstArg = args[i];
    break;
  }

  if (firstArg && (firstArg.startsWith("{") || firstArg.startsWith("["))) {
    try {
      const parsed = JSON.parse(firstArg);
      if (Array.isArray(parsed)) {
        // Bulk create
        let ok = 0;
        for (const item of parsed) {
          const result = await taskCreate(item);
          console.log(`  ✓ ${result.id.slice(0, 8)} ${result.title}`);
          ok++;
        }
        console.log(`\n  Created ${ok} task(s).\n`);
        return;
      }
      data = parsed;
    } catch (err) {
      console.error(`  Error: Invalid JSON — ${err.message}`);
      process.exit(1);
    }
  } else {
    // Build from flags
    const title = getArgValue(args, "--title");
    if (!title) {
      console.error("  Error: --title is required (or pass a JSON string)");
      console.error("  Usage: bosun task create --title 'Fix bug' --priority high");
      console.error("         bosun task create '{\"title\": \"Fix bug\", \"priority\": \"high\"}'");
      process.exit(1);
    }
    data = {
      title,
      description: getArgValue(args, "--description") || getArgValue(args, "--desc") || "",
      status: getArgValue(args, "--status") || "draft",
      priority: getArgValue(args, "--priority") || "medium",
      tags: getArgValue(args, "--tags")?.split(",").map((t) => t.trim()) || [],
      baseBranch: getArgValue(args, "--branch") || getArgValue(args, "--base-branch") || "main",
      workspace: getArgValue(args, "--workspace") || process.cwd(),
      repository: getArgValue(args, "--repository") || getArgValue(args, "--repo") || "",
    };
    // Collect repeatable structured-section flags
    const steps = [], acceptance = [], verification = [];
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '--step' || args[i] === '--implementation-step') && args[i + 1] && !args[i + 1].startsWith('--')) {
        steps.push(args[++i]);
      } else if ((args[i] === '--ac' || args[i] === '--acceptance') && args[i + 1] && !args[i + 1].startsWith('--')) {
        acceptance.push(args[++i]);
      } else if ((args[i] === '--verify' || args[i] === '--verification') && args[i + 1] && !args[i + 1].startsWith('--')) {
        verification.push(args[++i]);
      }
    }
    if (steps.length) data.implementation_steps = steps;
    if (acceptance.length) data.acceptance_criteria = acceptance;
    if (verification.length) data.verification = verification;
  }

  try {
    // Read description from stdin if --desc-stdin flag is present
    if (hasFlag(args, "--desc-stdin") || hasFlag(args, "--stdin")) {
      data.description = await readStdin();
    }

    // Read description from file if --desc-file <path> is provided
    const descFile = getArgValue(args, "--desc-file");
    if (descFile) {
      const descPath = resolve(descFile);
      if (!existsSync(descPath)) {
        console.error(`  Error: description file not found: ${descPath}`);
        process.exit(1);
      }
      data.description = readFileSync(descPath, "utf8");
    }

    const result = await taskCreate(data);
    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n  ✓ Created task ${result.id.slice(0, 8)}: ${result.title}\n`);
    }
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }
}

async function cliGet(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(`
  bosun task get — Show task details by ID

  USAGE
    bosun task get <id> [--json]

  ARGUMENTS
    <id>    Task ID or prefix (minimum 4 chars)

  OPTIONS
    --json  Output as JSON

  EXAMPLES
    bosun task get abc123
    bosun task get b500 --json
`);
    return;
  }
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("  Error: task ID required. Usage: bosun task get <id>");
    process.exit(1);
  }

  try {
    const task = await taskGet(id);
    if (!task) {
      console.error(`  Task not found: ${id}`);
      process.exit(1);
    }

    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(task, null, 2));
      return;
    }

    console.log(`\n  Task: ${task.id}`);
    console.log(`  Title:       ${task.title}`);
    console.log(`  Status:      ${task.status}`);
    console.log(`  Priority:    ${task.priority || "medium"}`);
    console.log(`  Tags:        ${(task.tags || []).join(", ") || "(none)"}`);
    console.log(`  Branch:      ${task.baseBranch || "main"}`);
    console.log(`  Created:     ${task.createdAt || "?"}`);
    console.log(`  Updated:     ${task.updatedAt || "?"}`);
    if (task.workspace) console.log(`  Workspace:   ${task.workspace}`);
    if (task.repository) console.log(`  Repository:  ${task.repository}`);
    if (task.description) {
      console.log(`\n  Description:\n`);
      for (const line of task.description.split("\n")) {
        console.log(`    ${line}`);
      }
    }
    console.log("");
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }
}

async function cliUpdate(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(`
  bosun task update — Update task fields by ID

  USAGE
    bosun task update <id> [flags]
    bosun task update <id> '<json-patch>'

  ARGUMENTS
    <id>           Task ID or prefix

  FLAGS
    --status <s>   New status: draft|todo|inprogress|inreview|done|blocked
    --priority <p> New priority: low|medium|high|critical
    --title <t>    New title
    --description, --desc <d>  New description
    --tags <t>     Replace tags (comma-separated)
    --branch <b>   Change base branch
    --draft        Mark as draft
    --undraft      Remove draft flag
    --json         Output updated task as JSON

  EXAMPLES
    bosun task update abc123 --status todo
    bosun task update abc123 --priority critical --tags 'ui,urgent'
    bosun task update abc123 '{"status":"inprogress","priority":"high"}'
`);
    return;
  }
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("  Error: task ID required. Usage: bosun task update <id> [--status todo] [--priority high]");
    process.exit(1);
  }

  const subArgs = args.filter((a) => a !== id);

  let patch = {};

  // Check if second non-flag arg is JSON
  const jsonArg = subArgs.find((a) => !a.startsWith("--") && a.startsWith("{"));
  if (jsonArg) {
    try {
      patch = JSON.parse(jsonArg);
    } catch (err) {
      console.error(`  Error: Invalid JSON — ${err.message}`);
      process.exit(1);
    }
  } else {
    // Build from flags
    const status = getArgValue(subArgs, "--status");
    const priority = getArgValue(subArgs, "--priority");
    const title = getArgValue(subArgs, "--title");
    const description = getArgValue(subArgs, "--description") || getArgValue(subArgs, "--desc");
    const tags = getArgValue(subArgs, "--tags");
    const branch = getArgValue(subArgs, "--branch") || getArgValue(subArgs, "--base-branch");
    const draft = hasFlag(subArgs, "--draft");
    const undraft = hasFlag(subArgs, "--undraft") || hasFlag(subArgs, "--no-draft");

    if (status) patch.status = status;
    if (priority) patch.priority = priority;
    if (title) patch.title = title;
    if (description) patch.description = description;
    if (tags) patch.tags = tags.split(",").map((t) => t.trim());
    if (branch) patch.baseBranch = branch;
    if (draft) patch.draft = true;
    if (undraft) patch.draft = false;
  }

  if (Object.keys(patch).length === 0) {
    console.error("  Error: nothing to update. Provide --status, --priority, --title, etc.");
    process.exit(1);
  }

  try {
    const result = await taskUpdate(id, patch);
    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n  ✓ Updated task ${result.id.slice(0, 8)}: ${result.title}\n`);
    }
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }
}

async function cliDelete(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(`
  bosun task delete — Delete a task by ID

  USAGE
    bosun task delete <id>

  EXAMPLES
    bosun task delete abc123
    bosun task delete b500
`);
    return;
  }
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("  Error: task ID required. Usage: bosun task delete <id>");
    process.exit(1);
  }

  try {
    const task = await taskGet(id);
    if (!task) {
      console.error(`  Task not found: ${id}`);
      process.exit(1);
    }
    await taskDelete(id);
    console.log(`\n  ✓ Deleted task ${task.id.slice(0, 8)}: ${task.title}\n`);
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }
}

async function cliStats(args) {
  const stats = await taskStats();

  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log(`\n  Task Statistics:`);
  console.log(`    Draft:       ${stats.draft || 0}`);
  console.log(`    Todo:        ${stats.todo || 0}`);
  console.log(`    In Progress: ${stats.inprogress || 0}`);
  console.log(`    In Review:   ${stats.inreview || 0}`);
  console.log(`    Done:        ${stats.done || 0}`);
  console.log(`    Blocked:     ${stats.blocked || 0}`);
  console.log(`    Total:       ${stats.total || 0}`);
  console.log("");
}

async function cliImport(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(`
  bosun task import — Bulk import tasks from a JSON file

  USAGE
    bosun task import <file.json>

  FILE FORMAT
    JSON file must contain an array at top level, or under a "tasks" key.
    Each task object supports all fields including structured sections:

    {
      "tasks": [
        {
          "title": "feat(ui): Add tabular numerals",
          "description": "Optional free-text description",
          "priority": "high",
          "status": "todo",
          "tags": ["ui", "css"],
          "implementation_steps": ["Edit variables.css", "Test in portal"],
          "acceptance_criteria": ["Numbers align in tables across all tabs"],
          "verification": ["Visual check in agents tab with live data"]
        }
      ]
    }

  EXAMPLES
    bosun task import ./backlog.json
    bosun task import ./tasks/sprint-1.json
`);
    return;
  }
  const filePath = args.find((a) => !a.startsWith("--"));
  if (!filePath) {
    console.error("  Error: file path required. Usage: bosun task import <path.json>");
    process.exit(1);
  }

  if (!existsSync(resolve(filePath))) {
    console.error(`  Error: file not found: ${filePath}`);
    process.exit(1);
  }

  try {
    const result = await taskImport(filePath);
    console.log(`\n  Import complete: ${result.created} created, ${result.failed} failed`);
    if (result.errors.length > 0) {
      console.log("  Errors:");
      for (const err of result.errors) {
        console.log(`    ✗ ${err}`);
      }
    }
    console.log("");
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }
}

// ── Help ──────────────────────────────────────────────────────────────────────

function showCreateHelp() {
  console.log(`
  bosun task create — Create a new task

  USAGE
    bosun task create --title "..." [flags]
    bosun task create '<json-object>'
    bosun task create '<json-array>'    (bulk create — all tasks at once)

  FLAGS
    --title <t>                 Task title (required when using flags)
    --description, --desc <d>   Task description (single-line inline)
    --status <s>                Initial status (default: draft)
                                  draft|todo|inprogress|inreview|done|blocked
    --priority <p>              Priority (default: medium)
                                  low|medium|high|critical
    --tags <t>                  Comma-separated tags  e.g. "ui,css,fix"
    --branch <b>                Target base branch (default: main)
    --workspace <w>             Workspace directory path
    --repo <r>                  Repository identifier  e.g. "org/repo"
    --stdin                     Read description from stdin (pipe-friendly)
    --desc-file <path>          Read description from file (supports multiline markdown)
    --step <text>               Add an implementation step (repeatable)
    --ac <text>                 Add an acceptance criterion (repeatable)
    --verify <text>             Add a verification step (repeatable)
    --json                      Output created task as JSON

  JSON OBJECT FIELDS
    title, description, status, priority, tags[],
    baseBranch, workspace, repository,
    implementation_steps[], acceptance_criteria[], verification[]

  EXAMPLES

    # Simple
    bosun task create --title "feat(ui): Add tabular numerals" --priority high --tags "ui,css"

    # With structured sections (repeatable flags)
    bosun task create \\
      --title "feat(dashboard): Live/Offline connection badge" \\
      --priority medium --status todo --tags "ui,ux" \\
      --step "Add badge component to portal header" \\
      --step "Listen for WebSocket connect/disconnect events" \\
      --ac "Badge shows green dot when connected" \\
      --ac "Badge shows grey dot when disconnected or reconnecting" \\
      --verify "Open portal, kill server, confirm badge changes state"

    # Multiline description from a file
    bosun task create --title "refactor(css): CSS vars audit" --desc-file ./tasks/css-audit.md

    # Pipe description from stdin
    echo "Fix retry backoff to use exponential intervals" | \\
      bosun task create --title "fix(retry): exponential backoff" --stdin

    # Inline JSON with structured sections
    bosun task create '{
      "title": "feat(dashboard): retry queue section",
      "priority": "high",
      "status": "todo",
      "tags": ["ui", "dashboard"],
      "implementation_steps": ["Add RetryQueue component", "Wire to /api/status"],
      "acceptance_criteria": ["Shows issue ID, attempt #, due-at, last error"],
      "verification": ["Trigger a failing task, confirm it appears in retry queue"]
    }'

    # Bulk create from JSON array
    bosun task create '[{"title":"Task A","priority":"high"},{"title":"Task B"}]'

    # Bulk import from file (best for many tasks)
    bosun task import ./backlog.json
`);
}

function showTaskHelp() {
  console.log(`
  bosun task — Task management CLI

  SUBCOMMANDS
    list, ls    List tasks                  bosun task list --help
    create, add Create a new task           bosun task create --help
    get, show   Show task details           bosun task get --help
    update, edit Update task fields         bosun task update --help
    delete, rm  Delete a task              bosun task delete --help
    stats       Aggregate statistics        bosun task stats --json
    import      Bulk import from JSON file  bosun task import --help

  QUICK REFERENCE

    # Create (flag-based)
    bosun task create --title "feat(ui): Add tabular numerals" --priority high --tags "ui,css" --status todo

    # Create with structured steps, acceptance criteria, and verification
    bosun task create \\
      --title "feat(dashboard): retry queue section" \\
      --priority high --status todo --tags "ui,dashboard" \\
      --step "Add RetryQueueSection component to dashboard" \\
      --step "Poll /api/status retrying[] array every 2s" \\
      --step "Add empty state for when queue is empty" \\
      --ac "Shows issue ID, attempt #, due-at time, and last error per row" \\
      --ac "Disappears / shows empty state when retry queue empties" \\
      --verify "Trigger a failing task, confirm it appears with correct fields"

    # Create (inline JSON — supports all fields)
    bosun task create '{"title":"...","priority":"high","tags":["ui"],"implementation_steps":["..."],"acceptance_criteria":["..."]}'

    # Create (bulk from JSON array)
    bosun task create '[{"title":"Task A"},{"title":"Task B","priority":"high"}]'

    # Bulk import from file (recommended for 3+ tasks)
    bosun task import ./backlog.json

    # List and filter
    bosun task list --status todo --priority high
    bosun task list --tag ui --json

    # Update
    bosun task update <id> --status inprogress
    bosun task update <id> --priority critical --tags "urgent,ui"

  STATUS VALUES
    draft · todo · inprogress · inreview · done · blocked

  PRIORITY VALUES
    low · medium · high · critical

  IMPORT FILE FORMAT  (bosun task import ./backlog.json)
    {
      "tasks": [
        {
          "title": "feat(ui): Add tabular numerals",
          "priority": "high",
          "status": "todo",
          "tags": ["ui", "css"],
          "implementation_steps": ["Edit variables.css", "Verify in portal"],
          "acceptance_criteria": ["Numeric columns align correctly"],
          "verification": ["Visual check in agents tab"]
        }
      ]
    }
`);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function normalizeTags(raw) {
  if (!raw) return [];
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  }
  return [];
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", reject);
    // If stdin is a TTY (no pipe), resolve empty after a short timeout
    if (process.stdin.isTTY) {
      resolve("");
    }
  });
}

// ── Direct execution support ──────────────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  runTaskCli(process.argv.slice(2)).catch((err) => {
    console.error(`${TAG} Fatal: ${err.message}`);
    process.exit(1);
  });
}
