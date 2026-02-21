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
 *   bosun task plan [--count 5] [--reason "..."]
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
    // Resolve the true repo root: walk up from cwd looking for a .git directory
    // (not a .git file, which indicates a submodule/worktree). This ensures we
    // use the top-level repo's .bosun/.cache/ store, not a submodule's.
    const repoRoot = findTrueRepoRoot(process.cwd()) || process.cwd();
    _taskStoreModule.configureTaskStore({
      storePath: resolve(repoRoot, ".bosun", ".cache", "kanban-state.json"),
    });
    _taskStoreModule.loadStore();
    _storeReady = true;
  }
  return _taskStoreModule;
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
      return await cliPlan(subArgs);
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
  }

  try {
    // Read description from stdin if --desc-stdin flag is present
    if (hasFlag(args, "--desc-stdin") || hasFlag(args, "--stdin")) {
      data.description = await readStdin();
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

async function cliPlan(args) {
  const count = parseInt(getArgValue(args, "--count") || "5", 10);
  const reason = getArgValue(args, "--reason") || "CLI-triggered task planning";

  console.log(`\n  Triggering task planner (requesting ${count} tasks)...`);
  console.log(`  Reason: ${reason}\n`);

  try {
    // Dynamically import the planner trigger from monitor
    const { triggerTaskPlanner } = await import("./monitor.mjs");
    const result = await triggerTaskPlanner(reason, "", {
      taskCount: count,
      notify: false,
    });
    if (result?.created?.length) {
      console.log(`  ✓ Created ${result.created.length} task(s):`);
      for (const t of result.created) {
        console.log(`    ${t.id?.slice(0, 8)} ${t.title}`);
      }
    } else {
      console.log("  ⚠ Planner ran but no new tasks were created.");
    }
    console.log("");
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    console.error("  Note: task planner requires a running bosun instance with Codex SDK configured.");
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

function showTaskHelp() {
  console.log(`
  bosun task — Task management CLI

  SUBCOMMANDS
    list, ls          List tasks with optional filters
    create, add       Create a new task (JSON string or flags)
    get, show         Show task details by ID (supports prefix match)
    update, edit      Update task fields by ID
    delete, rm        Delete a task by ID
    plan              Trigger the AI task planner to generate new tasks
    stats             Show aggregate task statistics
    import            Bulk import tasks from a JSON file

  LIST OPTIONS
    --status <s>      Filter by status (draft|todo|inprogress|inreview|done|blocked)
    --priority <p>    Filter by priority (low|medium|high|critical)
    --tag <tag>       Filter by tag
    --search <text>   Full-text search in title/description
    --limit <n>       Max results
    --json            Output as JSON

  CREATE OPTIONS
    bosun task create '{"title": "...", "description": "...", "priority": "high"}'
    bosun task create --title "..." --desc "..." --priority high --tags "ui,fix" --branch main
    --title <t>       Task title (required unless using JSON)
    --description, --desc <d>  Task description
    --priority <p>    Priority: low|medium|high|critical (default: medium)
    --status <s>      Initial status (default: draft)
    --tags <t>        Comma-separated tags
    --branch <b>      Target branch (default: main)
    --workspace <w>   Workspace path
    --repo <r>        Repository identifier
    --stdin           Read description from stdin
    --json            Output created task as JSON

  UPDATE OPTIONS
    bosun task update <id> --status todo --priority high
    bosun task update <id> '{"status": "todo", "priority": "high"}'
    --status <s>      New status
    --priority <p>    New priority
    --title <t>       New title
    --tags <t>        Replace tags (comma-separated)
    --branch <b>      Change base branch
    --draft           Mark as draft
    --undraft         Remove draft flag
    --json            Output updated task as JSON

  PLAN OPTIONS
    --count <n>       Number of tasks to generate (default: 5)
    --reason <text>   Reason/context for planning run

  IMPORT FORMAT
    JSON file must contain an array at top level or under "tasks" key:
    { "tasks": [{ "title": "...", "description": "..." }, ...] }

  EXAMPLES
    bosun task list --status todo --json
    bosun task create --title "[s] fix(cli): Resolve exit code handling" --priority high
    bosun task create '{"title":"[m] feat(ui): Add dark mode","tags":["ui","theme"]}'
    bosun task get abc123
    bosun task update abc123 --status todo --priority critical
    bosun task delete abc123
    bosun task stats
    bosun task import ./backlog.json
    bosun task plan --count 3 --reason "Sprint planning"
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
