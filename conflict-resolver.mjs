import { resolvePromptTemplate } from "./agent-prompts.mjs";

const DEFAULT_AUTO_RESOLVE_THEIRS = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "go.sum",
];
const DEFAULT_AUTO_RESOLVE_OURS = [
  "CHANGELOG.md",
  "coverage.txt",
  "results.txt",
];
const DEFAULT_AUTO_RESOLVE_LOCK_EXTENSIONS = [".lock"];

export const DIRTY_TASK_DEFAULTS = {
  maxAgeHours: 24,
  minCountToReserve: 1,
  maxCandidates: 5,
};

function normalizeTimestamp(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function classifyConflictedFiles(files) {
  const manualFiles = [];
  const strategies = [];

  for (const file of files) {
    const fileName = file.split("/").pop();
    let strategy = null;

    if (DEFAULT_AUTO_RESOLVE_THEIRS.includes(fileName)) {
      strategy = "theirs";
    } else if (DEFAULT_AUTO_RESOLVE_OURS.includes(fileName)) {
      strategy = "ours";
    } else if (
      DEFAULT_AUTO_RESOLVE_LOCK_EXTENSIONS.some((ext) => fileName.endsWith(ext))
    ) {
      strategy = "theirs";
    }

    if (strategy) {
      strategies.push(`${fileName}→${strategy}`);
    } else {
      manualFiles.push(file);
    }
  }

  return {
    allResolvable: manualFiles.length === 0,
    manualFiles,
    summary: strategies.join(", ") || "none",
  };
}

export function getDirtyTasks(attempts = [], opts = {}) {
  if (!Array.isArray(attempts)) return [];
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs =
    (opts.maxAgeHours ?? DIRTY_TASK_DEFAULTS.maxAgeHours) * 60 * 60 * 1000;

  return attempts.filter((attempt) => {
    if (!attempt || !attempt.branch) return false;
    const updatedAt =
      normalizeTimestamp(attempt.updated_at) ??
      normalizeTimestamp(attempt.updatedAt) ??
      normalizeTimestamp(attempt.last_process_completed_at);
    if (!updatedAt) return false;
    return nowMs - updatedAt <= maxAgeMs;
  });
}

export function prioritizeDirtyTasks(tasks = [], opts = {}) {
  if (!Array.isArray(tasks)) return [];
  const maxCandidates = opts.maxCandidates ?? DIRTY_TASK_DEFAULTS.maxCandidates;

  return [...tasks]
    .sort((a, b) => {
      const aPriority = Number(a?.priority ?? 0);
      const bPriority = Number(b?.priority ?? 0);
      if (aPriority !== bPriority) return bPriority - aPriority;
      const aUpdated =
        normalizeTimestamp(a?.updated_at) ??
        normalizeTimestamp(a?.updatedAt) ??
        0;
      const bUpdated =
        normalizeTimestamp(b?.updated_at) ??
        normalizeTimestamp(b?.updatedAt) ??
        0;
      return bUpdated - aUpdated;
    })
    .slice(0, maxCandidates);
}

export function shouldReserveDirtySlot(tasks = [], opts = {}) {
  const minCount =
    opts.minCountToReserve ?? DIRTY_TASK_DEFAULTS.minCountToReserve;
  return Array.isArray(tasks) && tasks.length >= minCount;
}

export function getDirtySlotReservation(tasks = [], opts = {}) {
  return {
    reserved: shouldReserveDirtySlot(tasks, opts),
    count: Array.isArray(tasks) ? tasks.length : 0,
    reason: Array.isArray(tasks) && tasks.length > 0 ? "dirty-tasks" : "none",
  };
}

export function buildConflictResolutionPrompt({
  conflictFiles = [],
  upstreamBranch = "origin/main",
  template = "",
} = {}) {
  const files = Array.isArray(conflictFiles) ? conflictFiles : [];
  const classification = classifyConflictedFiles(files);
  const lines = [
    `Conflicts detected while rebasing onto ${upstreamBranch}.`,
    `Auto-resolve summary: ${classification.summary}.`,
  ];

  if (classification.manualFiles.length) {
    lines.push("Manual conflicts remain:");
    lines.push(...classification.manualFiles.map((file) => `- ${file}`));
  }

  lines.push(
    `Use 'git checkout --theirs <file>' for lockfiles and 'git checkout --ours <file>' for CHANGELOG.md/coverage.txt/results.txt.`,
  );

  const fallback = lines.join("\n");
  const manualSection = classification.manualFiles.length
    ? ["Manual conflicts remain:", ...classification.manualFiles.map((f) => `- ${f}`)].join("\n")
    : "Manual conflicts remain: none";
  return resolvePromptTemplate(
    template,
    {
      UPSTREAM_BRANCH: upstreamBranch,
      AUTO_RESOLVE_SUMMARY: classification.summary,
      MANUAL_CONFLICTS_SECTION: manualSection,
    },
    fallback,
  );
}

export function isFileOverlapWithDirtyPR(files = [], dirtyFiles = []) {
  const left = new Set((files || []).map((file) => file.toLowerCase()));
  return (dirtyFiles || []).some((file) =>
    left.has(String(file).toLowerCase()),
  );
}

// ── In-memory dirty task registry ────────────────────────────────────────────
// Tracks tasks whose PRs have merge conflicts so the monitor can reserve
// executor slots for conflict resolution and avoid file-overlap collisions.

const _dirtyTaskRegistry = new Map();

/**
 * Register a task as "dirty" (PR has merge conflicts).
 * @param {{ taskId: string, prNumber?: number, branch?: string, title?: string, files?: string[] }} entry
 */
export function registerDirtyTask({
  taskId,
  prNumber,
  branch,
  title,
  files,
} = {}) {
  if (!taskId) return;
  _dirtyTaskRegistry.set(taskId, {
    taskId,
    prNumber: prNumber ?? null,
    branch: branch ?? null,
    title: title ?? "",
    files: Array.isArray(files) ? files : [],
    registeredAt: Date.now(),
  });
}

/**
 * Remove a task from the dirty registry (e.g. after successful merge or resolution).
 * @param {string} taskId
 */
export function clearDirtyTask(taskId) {
  _dirtyTaskRegistry.delete(taskId);
}

/**
 * Check whether a task is currently registered as dirty.
 * @param {string} taskId
 * @returns {boolean}
 */
export function isDirtyTask(taskId) {
  return _dirtyTaskRegistry.has(taskId);
}

/**
 * Return a HIGH complexity tier override for dirty/conflict tasks.
 * @returns {{ tier: string, reason: string }}
 */
export function getHighTierForDirty() {
  return { tier: "HIGH", reason: "dirty-conflict-override" };
}

// ── Resolution cooldown tracking ─────────────────────────────────────────────
// Prevents the monitor from re-triggering conflict resolution too quickly
// for the same task.

const _resolutionAttempts = new Map();
const RESOLUTION_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Record that a conflict-resolution attempt was made for a task.
 * @param {string} taskId
 */
export function recordResolutionAttempt(taskId) {
  _resolutionAttempts.set(taskId, Date.now());
}

/**
 * Check whether a task is still within the resolution cooldown window.
 * @param {string} taskId
 * @param {{ cooldownMs?: number }} opts
 * @returns {boolean}
 */
export function isOnResolutionCooldown(taskId, opts = {}) {
  const lastAttempt = _resolutionAttempts.get(taskId);
  if (!lastAttempt) return false;
  const cooldown = opts.cooldownMs ?? RESOLUTION_COOLDOWN_MS;
  return Date.now() - lastAttempt < cooldown;
}

/**
 * Return a human-readable summary of the current dirty task state.
 * @returns {string}
 */
export function formatDirtyTaskSummary() {
  const count = _dirtyTaskRegistry.size;
  if (count === 0) return "Dirty tasks: 0";
  const entries = [..._dirtyTaskRegistry.values()]
    .map((e) => `${e.title || e.taskId} (PR #${e.prNumber ?? "?"})`)
    .join(", ");
  return `Dirty tasks: ${count} — ${entries}`;
}
