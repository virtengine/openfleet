/**
 * task-store.mjs — Internal JSON kanban store (source of truth for all task state)
 *
 * Stores data in .cache/kanban-state.json relative to this file.
 * Provides an in-memory cache with auto-persist on every mutation.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
} from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TAG = "[task-store]";

function inferRepoRoot(startDir) {
  let current = resolve(startDir || process.cwd());
  while (true) {
    if (existsSync(resolve(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveDefaultStorePath() {
  const repoRoot =
    inferRepoRoot(process.cwd()) || resolve(__dirname, "..", "..");
  return resolve(repoRoot, ".openfleet", ".cache", "kanban-state.json");
}

let storePath = resolveDefaultStorePath();
let storeTmpPath = storePath + ".tmp";
const MAX_STATUS_HISTORY = 50;
const MAX_AGENT_OUTPUT = 2000;
const MAX_ERROR_LENGTH = 1000;

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let _store = null; // { _meta: {...}, tasks: { [id]: Task } }
let _loaded = false;
let _writeChain = Promise.resolve(); // simple write lock

export function configureTaskStore(options = {}) {
  const baseDir = options.baseDir ? resolve(options.baseDir) : null;
  const nextPath = options.storePath
    ? resolve(baseDir || process.cwd(), options.storePath)
    : resolve(
        baseDir ||
          inferRepoRoot(process.cwd()) ||
          resolve(__dirname, "..", ".."),
        ".openfleet",
        ".cache",
        "kanban-state.json",
      );

  if (nextPath !== storePath) {
    storePath = nextPath;
    storeTmpPath = storePath + ".tmp";
    _store = null;
    _loaded = false;
    _writeChain = Promise.resolve();
  }

  return storePath;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now() {
  return new Date().toISOString();
}

function truncate(str, max) {
  if (str == null) return null;
  const s = String(str);
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeTags(raw) {
  if (!raw) return [];
  const values = Array.isArray(raw)
    ? raw
    : String(raw || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
  const seen = new Set();
  const tags = [];
  for (const value of values) {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

function defaultMeta() {
  return {
    version: 1,
    projectId: null,
    lastFullSync: null,
    taskCount: 0,
    stats: {
      draft: 0,
      todo: 0,
      inprogress: 0,
      inreview: 0,
      done: 0,
      blocked: 0,
    },
  };
}

function defaultTask(overrides = {}) {
  const ts = now();
  return {
    id: null,
    title: "",
    description: "",
    status: "todo",
    externalStatus: null,
    externalId: null,
    externalBackend: null,
    assignee: null,
    priority: null,
    tags: [],
    draft: false,
    projectId: null,
    baseBranch: null,
    branchName: null,
    prNumber: null,
    prUrl: null,

    createdAt: ts,
    updatedAt: ts,
    lastActivityAt: ts,
    statusHistory: [],

    agentAttempts: 0,
    consecutiveNoCommits: 0,
    lastAgentOutput: null,
    lastError: null,
    errorPattern: null,

    reviewStatus: null,
    reviewIssues: null,
    reviewedAt: null,

    cooldownUntil: null,
    blockedReason: null,

    lastSyncedAt: null,
    syncDirty: false,

    meta: {},
    ...overrides,
  };
}

function recalcStats() {
  const stats = {
    draft: 0,
    todo: 0,
    inprogress: 0,
    inreview: 0,
    done: 0,
    blocked: 0,
  };
  for (const t of Object.values(_store.tasks)) {
    if (t.status === "blocked") {
      stats.blocked++;
    } else if (stats[t.status] !== undefined) {
      stats[t.status]++;
    }
  }
  _store._meta.taskCount = Object.keys(_store.tasks).length;
  _store._meta.stats = stats;
}

function ensureLoaded() {
  if (!_loaded) {
    loadStore();
  }
}

// ---------------------------------------------------------------------------
// Store management
// ---------------------------------------------------------------------------

/**
 * Load store from disk. Called automatically on first access.
 */
export function loadStore() {
  try {
    if (existsSync(storePath)) {
      const raw = readFileSync(storePath, "utf-8");
      const data = JSON.parse(raw);
      _store = {
        _meta: { ...defaultMeta(), ...(data._meta || {}) },
        tasks: data.tasks || {},
      };
      console.log(
        TAG,
        `Loaded ${Object.keys(_store.tasks).length} tasks from disk`,
      );
    } else {
      _store = { _meta: defaultMeta(), tasks: {} };
      console.log(TAG, "No store file found — initialised empty store");
    }
  } catch (err) {
    console.error(TAG, "Failed to load store, starting fresh:", err.message);
    _store = { _meta: defaultMeta(), tasks: {} };
  }
  _loaded = true;
}

/**
 * Persist store to disk (atomic write via tmp+rename).
 */
export function saveStore() {
  ensureLoaded();
  recalcStats();

  _writeChain = _writeChain
    .then(() => {
      try {
        const dir = dirname(storePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        const json = JSON.stringify(_store, null, 2);
        writeFileSync(storeTmpPath, json, "utf-8");
        renameSync(storeTmpPath, storePath);
      } catch (err) {
        console.error(TAG, "Failed to save store:", err.message);
      }
    })
    .catch((err) => {
      console.error(TAG, "Write chain error:", err.message);
    });
}

/**
 * Return the resolved path of the store file.
 */
export function getStorePath() {
  return storePath;
}

// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

/**
 * Get a single task by ID. Returns null if not found.
 */
export function getTask(taskId) {
  ensureLoaded();
  if (!taskId) return null;
  return _store.tasks[taskId] ?? null;
}

/**
 * Get all tasks as an array.
 */
export function getAllTasks() {
  ensureLoaded();
  return Object.values(_store.tasks);
}

/**
 * Get tasks filtered by status.
 */
export function getTasksByStatus(status) {
  ensureLoaded();
  return Object.values(_store.tasks).filter((t) => t.status === status);
}

/**
 * Partial update of a task. Auto-sets updatedAt and syncDirty.
 * Returns the updated task or null if not found.
 */
export function updateTask(taskId, updates) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `updateTask: task ${taskId} not found`);
    return null;
  }

  // Apply updates (shallow merge)
  for (const [k, v] of Object.entries(updates)) {
    if (k === "id") continue; // never overwrite id
    if (k === "lastAgentOutput") {
      task[k] = truncate(v, MAX_AGENT_OUTPUT);
    } else if (k === "lastError") {
      task[k] = truncate(v, MAX_ERROR_LENGTH);
    } else if (k === "tags") {
      task[k] = normalizeTags(v);
    } else {
      task[k] = v;
    }
  }

  if (typeof updates.draft === "boolean") {
    task.draft = updates.draft;
    if (updates.draft && task.status !== "draft") {
      task.status = "draft";
    } else if (!updates.draft && task.status === "draft") {
      task.status = "todo";
    }
  }
  if (task.status === "draft") {
    task.draft = true;
  } else if (task.draft && updates.draft == null) {
    task.draft = false;
  }

  task.updatedAt = now();
  task.syncDirty = true;

  saveStore();
  return { ...task };
}

/**
 * Add a new task to the store. Sets createdAt.
 * Returns the created task.
 */
export function addTask(taskData) {
  ensureLoaded();
  const task = defaultTask(taskData);
  if (!task.id) {
    console.error(TAG, "addTask: task must have an id");
    return null;
  }
  task.tags = normalizeTags(task.tags);
  task.draft = Boolean(task.draft || task.status === "draft");
  if (task.draft) task.status = "draft";
  task.lastAgentOutput = truncate(task.lastAgentOutput, MAX_AGENT_OUTPUT);
  task.lastError = truncate(task.lastError, MAX_ERROR_LENGTH);

  _store.tasks[task.id] = task;
  console.log(TAG, `Added task ${task.id}: ${task.title}`);

  saveStore();
  return { ...task };
}

/**
 * Remove a task from the store. Returns true if removed, false if not found.
 */
export function removeTask(taskId) {
  ensureLoaded();
  if (!_store.tasks[taskId]) return false;
  delete _store.tasks[taskId];
  console.log(TAG, `Removed task ${taskId}`);
  saveStore();
  return true;
}

// ---------------------------------------------------------------------------
// Status management
// ---------------------------------------------------------------------------

/**
 * Set task status with source tracking. Appends to statusHistory.
 * source: "agent" | "orchestrator" | "external" | "review"
 */
export function setTaskStatus(taskId, status, source) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `setTaskStatus: task ${taskId} not found`);
    return null;
  }

  const prev = task.status;
  task.status = status;
  task.updatedAt = now();
  task.lastActivityAt = now();

  // Append to history (FIFO, max 50)
  task.statusHistory.push({
    status,
    timestamp: now(),
    source: source || "unknown",
  });
  if (task.statusHistory.length > MAX_STATUS_HISTORY) {
    task.statusHistory = task.statusHistory.slice(-MAX_STATUS_HISTORY);
  }

  // Mark dirty unless change came from external source
  if (source !== "external") {
    task.syncDirty = true;
  }

  console.log(
    TAG,
    `Task ${taskId} status: ${prev} → ${status} (source: ${source})`,
  );

  saveStore();
  return { ...task };
}

/**
 * Get the status history for a task.
 */
export function getTaskHistory(taskId) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return [];
  return [...task.statusHistory];
}

// ---------------------------------------------------------------------------
// Agent tracking
// ---------------------------------------------------------------------------

/**
 * Record an agent attempt on a task.
 * @param {string} taskId
 * @param {{ output?: string, error?: string, hasCommits?: boolean }} info
 */
export function recordAgentAttempt(taskId, { output, error, hasCommits } = {}) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `recordAgentAttempt: task ${taskId} not found`);
    return null;
  }

  task.agentAttempts = (task.agentAttempts || 0) + 1;
  task.lastActivityAt = now();
  task.updatedAt = now();

  if (output !== undefined) {
    task.lastAgentOutput = truncate(output, MAX_AGENT_OUTPUT);
  }
  if (error !== undefined) {
    task.lastError = truncate(error, MAX_ERROR_LENGTH);
  }

  if (hasCommits) {
    task.consecutiveNoCommits = 0;
  } else {
    task.consecutiveNoCommits = (task.consecutiveNoCommits || 0) + 1;
  }

  task.syncDirty = true;
  saveStore();
  return { ...task };
}

/**
 * Record a classified error pattern on a task.
 * @param {string} taskId
 * @param {string|null} pattern - "plan_stuck" | "rate_limit" | "token_overflow" | "api_error" | null
 */
export function recordErrorPattern(taskId, pattern) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `recordErrorPattern: task ${taskId} not found`);
    return null;
  }

  task.errorPattern = pattern;
  task.updatedAt = now();
  task.syncDirty = true;

  saveStore();
  return { ...task };
}

/**
 * Set a cooldown on a task (prevents re-scheduling until timestamp).
 */
export function setTaskCooldown(taskId, untilTimestamp, reason) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `setTaskCooldown: task ${taskId} not found`);
    return null;
  }

  task.cooldownUntil = untilTimestamp;
  task.blockedReason = reason || null;
  task.updatedAt = now();
  task.syncDirty = true;

  console.log(
    TAG,
    `Task ${taskId} cooldown until ${untilTimestamp}: ${reason}`,
  );

  saveStore();
  return { ...task };
}

/**
 * Clear the cooldown on a task.
 */
export function clearTaskCooldown(taskId) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `clearTaskCooldown: task ${taskId} not found`);
    return null;
  }

  task.cooldownUntil = null;
  task.blockedReason = null;
  task.updatedAt = now();
  task.syncDirty = true;

  saveStore();
  return { ...task };
}

/**
 * Check if a task is currently cooling down.
 */
export function isTaskCoolingDown(taskId) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task || !task.cooldownUntil) return false;
  return new Date(task.cooldownUntil) > new Date();
}

// ---------------------------------------------------------------------------
// Review tracking
// ---------------------------------------------------------------------------

/**
 * Set the review result for a task.
 * @param {string} taskId
 * @param {{ approved: boolean, issues?: Array<{severity: string, description: string}> }} result
 */
export function setReviewResult(taskId, { approved, issues } = {}) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `setReviewResult: task ${taskId} not found`);
    return null;
  }

  task.reviewStatus = approved ? "approved" : "changes_requested";
  task.reviewIssues = issues || null;
  task.reviewedAt = now();
  task.updatedAt = now();
  task.lastActivityAt = now();
  task.syncDirty = true;

  console.log(
    TAG,
    `Task ${taskId} review: ${task.reviewStatus}${issues ? ` (${issues.length} issues)` : ""}`,
  );

  saveStore();
  return { ...task };
}

/**
 * Get tasks that are pending review (status === "inreview").
 */
export function getTasksPendingReview() {
  ensureLoaded();
  return Object.values(_store.tasks).filter((t) => t.status === "inreview");
}

// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------

/**
 * Get all tasks that need syncing to external backend.
 */
export function getDirtyTasks() {
  ensureLoaded();
  return Object.values(_store.tasks).filter((t) => t.syncDirty);
}

/**
 * Mark a task as synced (clears syncDirty, sets lastSyncedAt).
 */
export function markSynced(taskId) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return;

  task.syncDirty = false;
  task.lastSyncedAt = now();

  saveStore();
}

/**
 * Add or update a task from an external source.
 * Only overrides fields the external backend controls.
 * Sets syncDirty = false for the imported data.
 */
export function upsertFromExternal(externalTask) {
  ensureLoaded();
  if (!externalTask || !externalTask.id) {
    console.warn(TAG, "upsertFromExternal: task must have an id");
    return null;
  }

  const existing = _store.tasks[externalTask.id];

  if (existing) {
    const externalBaseBranch =
      externalTask.baseBranch ??
      externalTask.base_branch ??
      externalTask.meta?.base_branch ??
      externalTask.meta?.baseBranch;
    // Update only externally-controlled fields
    if (externalTask.title !== undefined) existing.title = externalTask.title;
    if (externalTask.description !== undefined)
      existing.description = externalTask.description;
    if (externalTask.assignee !== undefined)
      existing.assignee = externalTask.assignee;
    if (externalTask.priority !== undefined)
      existing.priority = externalTask.priority;
    if (externalTask.projectId !== undefined)
      existing.projectId = externalTask.projectId;
    if (externalBaseBranch !== undefined)
      existing.baseBranch = externalBaseBranch;
    if (externalTask.branchName !== undefined)
      existing.branchName = externalTask.branchName;
    if (externalTask.prNumber !== undefined)
      existing.prNumber = externalTask.prNumber;
    if (externalTask.prUrl !== undefined) existing.prUrl = externalTask.prUrl;
    if (externalTask.meta !== undefined)
      existing.meta = { ...existing.meta, ...externalTask.meta };

    // Update external tracking fields
    if (externalTask.externalId !== undefined)
      existing.externalId = externalTask.externalId;
    if (externalTask.externalBackend !== undefined)
      existing.externalBackend = externalTask.externalBackend;

    // Only update status if external changed it (human override)
    if (
      externalTask.status !== undefined &&
      externalTask.status !== existing.externalStatus
    ) {
      existing.externalStatus = externalTask.status;
      // If the external status differs from our status, adopt it
      if (externalTask.status !== existing.status) {
        existing.status = externalTask.status;
        existing.statusHistory.push({
          status: externalTask.status,
          timestamp: now(),
          source: "external",
        });
        if (existing.statusHistory.length > MAX_STATUS_HISTORY) {
          existing.statusHistory =
            existing.statusHistory.slice(-MAX_STATUS_HISTORY);
        }
      }
    } else if (externalTask.status !== undefined) {
      existing.externalStatus = externalTask.status;
    }

    existing.updatedAt = now();
    existing.syncDirty = false;
    existing.lastSyncedAt = now();

    saveStore();
    return { ...existing };
  }

  // New task from external — create it
  const externalBaseBranch =
    externalTask.baseBranch ??
    externalTask.base_branch ??
    externalTask.meta?.base_branch ??
    externalTask.meta?.baseBranch;
  const task = defaultTask({
    ...externalTask,
    ...(externalBaseBranch !== undefined ? { baseBranch: externalBaseBranch } : {}),
    externalStatus: externalTask.status || null,
    syncDirty: false,
    lastSyncedAt: now(),
  });
  task.lastAgentOutput = truncate(task.lastAgentOutput, MAX_AGENT_OUTPUT);
  task.lastError = truncate(task.lastError, MAX_ERROR_LENGTH);

  _store.tasks[task.id] = task;
  console.log(TAG, `Upserted external task ${task.id}: ${task.title}`);

  saveStore();
  return { ...task };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Get aggregate stats across all tasks.
 */
export function getStats() {
  ensureLoaded();
  recalcStats();
  return {
    ..._store._meta.stats,
    total: _store._meta.taskCount,
  };
}

/**
 * Get tasks that have been "inprogress" for longer than maxAgeMs.
 */
export function getStaleInProgressTasks(maxAgeMs) {
  ensureLoaded();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  return Object.values(_store.tasks).filter(
    (t) => t.status === "inprogress" && t.lastActivityAt < cutoff,
  );
}

/**
 * Get tasks that have been "inreview" for longer than maxAgeMs.
 */
export function getStaleInReviewTasks(maxAgeMs) {
  ensureLoaded();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  return Object.values(_store.tasks).filter(
    (t) => t.status === "inreview" && t.lastActivityAt < cutoff,
  );
}
