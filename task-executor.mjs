/**
 * @module task-executor
 * @description Internal Task Executor — runs agents locally using the SDK agent pool
 * instead of delegating to VK's cloud executor. Composes kanban-adapter, agent-pool,
 * and worktree-manager to provide full task lifecycle management with configurable
 * parallelism, SDK selection, and thread persistence/resume.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import {
  getKanbanAdapter,
  getKanbanBackendName,
  listTasks,
  listProjects,
  getTask,
  updateTaskStatus,
  addComment,
} from "./kanban-adapter.mjs";
import {
  launchOrResumeThread,
  execWithRetry,
  invalidateThread,
  forceNewThread,
  pruneAllExhaustedThreads,
  getActiveThreads,
  getPoolSdkName,
  ensureThreadRegistryLoaded,
} from "./agent-pool.mjs";
import {
  acquireWorktree,
  releaseWorktree,
  getWorktreeStats,
} from "./worktree-manager.mjs";
import {
  loadConfig,
  ExecutorScheduler,
  loadExecutorConfig,
} from "./config.mjs";
import { resolvePromptTemplate } from "./agent-prompts.mjs";
import {
  loadStore as loadTaskStore,
  setTaskStatus as setInternalStatus,
  recordAgentAttempt,
  recordErrorPattern,
  setTaskCooldown,
  clearTaskCooldown,
  isTaskCoolingDown,
  updateTask as updateInternalTask,
  getTask as getInternalTask,
  getAllTasks as getAllInternalTasks,
  addTask as addInternalTask,
} from "./task-store.mjs";
import { createErrorDetector } from "./error-detector.mjs";
import { getSessionTracker } from "./session-tracker.mjs";
import { getCompactDiffSummary, getRecentCommits } from "./diff-stats.mjs";
import {
  resolveExecutorForTask,
  executorToSdk,
  formatComplexityDecision,
} from "./task-complexity.mjs";
import { evaluateBranchSafetyForPush, normalizeBaseBranch } from "./git-safety.mjs";
import {
  loadHooks,
  registerBuiltinHooks,
  executeHooks,
  executeBlockingHooks,
} from "./agent-hooks.mjs";
import {
  initTaskClaims,
  claimTask,
  renewClaim,
  releaseTask as releaseTaskClaim,
} from "./task-claims.mjs";
import { initPresence, getPresenceState } from "./presence.mjs";
import { getSharedState } from "./shared-state-manager.mjs";

// ── Constants ───────────────────────────────────────────────────────────────

const TAG = "[task-executor]";
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const CONTEXT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const GRACEFUL_SHUTDOWN_MS = 5 * 60_000; // 5 minutes — give agents time to commit/push
const MAX_NO_COMMIT_ATTEMPTS = 3; // Stop picking up a task after N consecutive no-commit completions
const NO_COMMIT_COOLDOWN_BASE_MS = 15 * 60 * 1000; // 15 minutes base cooldown for no-commit
const NO_COMMIT_MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const CLAIM_CONFLICT_COMMENT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const CODEX_TASK_LABELS = (() => {
  const raw = String(
    process.env.OPENFLEET_TASK_LABELS || "openfleet,codex-mointor",
  );
  const labels = raw
    .split(",")
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);
  return new Set(labels.length > 0 ? labels : ["openfleet"]);
})();

/** Watchdog interval: how often to check for stalled agent slots */
const WATCHDOG_INTERVAL_MS = 60_000; // 1 minute
/** Grace period after task timeout before watchdog force-kills the slot */
const WATCHDOG_GRACE_MS = 10 * 60_000; // 10 minutes — generous buffer, stream analysis handles real issues
/** Max age for in-progress tasks to auto-resume after monitor restart */
const INPROGRESS_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours — agents should be resumable for a full day

function normalizeModel(value) {
  const model = String(value || "").trim();
  return model ? model : null;
}

function normalizeSdkOverride(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "auto") return "auto";
  if (raw === "codex-sdk") return "codex";
  if (raw === "copilot-sdk") return "copilot";
  if (raw === "claude-sdk") return "claude";
  if (["codex", "copilot", "claude"].includes(raw)) return raw;
  return null;
}

// ── Stream-Based Health Monitoring Constants ──────────────────────────────
/** How long an agent can be truly silent (zero events) before we consider intervention */
const STREAM_SILENT_THRESHOLD_MS = 10 * 60_000; // 10 minutes of absolute silence
/** How long an agent can be idle (no meaningful progress) before we send CONTINUE */
const STREAM_IDLE_THRESHOLD_MS = 5 * 60_000; // 5 minutes idle = send continue
/** How long truly stalled (no events after continues) before force-kill */
const STREAM_STALLED_KILL_MS = 20 * 60_000; // 20 minutes stalled after continues = kill
/** Maximum idle continues before escalating to abort */
const MAX_IDLE_CONTINUES = 5;
/** Minimum elapsed time before watchdog even starts checking (agent setup phase) */
const WATCHDOG_WARMUP_MS = 5 * 60_000; // 5 minutes warmup
const SHARED_STATE_ENABLED = process.env.SHARED_STATE_ENABLED !== "false";
const SHARED_STATE_STALE_THRESHOLD_MS =
  Number(process.env.SHARED_STATE_STALE_THRESHOLD_MS) || 300_000;
const NO_COMMIT_STATE_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".cache",
  "no-commit-state.json",
);
const RUNTIME_STATE_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".cache",
  "task-executor-runtime.json",
);
const ORCHESTRATOR_PAUSE_FILE = (() => {
  try {
    const cfg = loadConfig();
    const base = cfg?.statusPath ? dirname(cfg.statusPath) : null;
    if (base) return resolve(base, "ve-orchestrator-pause.json");
  } catch {
    /* best effort */
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), ".cache", "ve-orchestrator-pause.json");
})();

const PRIORITY_RANK = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const REQUIREMENTS_PROFILES = new Set([
  "simple-feature",
  "feature",
  "large-feature",
  "system",
  "multi-system",
]);

function normalizePriority(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  if (key === "critical" || key === "high" || key === "medium" || key === "low") {
    return key;
  }
  return "medium";
}

const UPSTREAM_LABEL_REGEX =
  /^(?:upstream|base|target)(?:_branch)?[:=]\s*([A-Za-z0-9._/-]+)$/i;

function normalizeBranchName(value) {
  if (!value) return null;
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed : null;
}

function extractScopeFromTitle(title) {
  if (!title) return null;
  const match = String(title).match(
    /(?:^\[P\d+\]\s*)?(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\(([^)]+)\)/i,
  );
  return match ? match[1].toLowerCase().trim() : null;
}

function collectTaskLabels(task) {
  const labels = [];
  if (!task) return labels;
  for (const field of [
    "labels",
    "label",
    "tags",
    "tag",
    "categories",
    "category",
  ]) {
    const value = task[field];
    if (!value) continue;
    if (typeof value === "string") {
      labels.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!item) continue;
        if (typeof item === "string") labels.push(item);
        else if (item.name) labels.push(item.name);
        else if (item.label) labels.push(item.label);
        else if (item.title) labels.push(item.title);
      }
    }
  }
  if (task.metadata) {
    for (const field of ["labels", "tags"]) {
      const value = task.metadata[field];
      if (!value) continue;
      if (typeof value === "string") labels.push(value);
      else if (Array.isArray(value)) labels.push(...value);
    }
  }
  if (task.meta) {
    for (const field of ["labels", "tags"]) {
      const value = task.meta[field];
      if (!value) continue;
      if (typeof value === "string") labels.push(value);
      else if (Array.isArray(value)) labels.push(...value);
    }
  }
  return labels;
}

function getTaskTextBlob(task) {
  const parts = [];
  if (!task) return "";
  for (const field of [
    "title",
    "name",
    "description",
    "body",
    "details",
    "content",
  ]) {
    const value = task[field];
    if (value) parts.push(value);
  }
  const labels = collectTaskLabels(task);
  if (labels.length) parts.push(labels.join(" "));
  return parts.join("\n");
}

function extractUpstreamFromText(text) {
  if (!text) return null;
  const match = String(text).match(
    /\b(?:upstream|base|target)(?:_branch| branch)?\s*[:=]\s*([A-Za-z0-9._/-]+)/i,
  );
  if (!match) return null;
  return normalizeBranchName(match[1]);
}

function resolveUpstreamFromConfig(task, branchRouting) {
  if (!task || !branchRouting?.scopeMap) return null;

  const scope = extractScopeFromTitle(task.title || task.name);
  if (scope) {
    const exactMatch = branchRouting.scopeMap[scope];
    if (exactMatch) return exactMatch;
    for (const [key, branch] of Object.entries(branchRouting.scopeMap)) {
      if (scope.includes(key) || key.includes(scope)) return branch;
    }
  }

  const text = getTaskTextBlob(task).toLowerCase();
  for (const [key, branch] of Object.entries(branchRouting.scopeMap)) {
    if (text.includes(String(key).toLowerCase())) return branch;
  }

  return null;
}

function resolveTaskBaseBranch(task, branchRouting, defaultTargetBranch) {
  if (!task) return normalizeBranchName(defaultTargetBranch);

  const directFields = [
    "target_branch",
    "base_branch",
    "upstream_branch",
    "upstream",
    "target",
    "base",
    "targetBranch",
    "baseBranch",
    "upstreamBranch",
  ];
  for (const field of directFields) {
    if (task[field]) return normalizeBranchName(task[field]);
  }
  if (task.metadata) {
    for (const field of directFields) {
      if (task.metadata[field]) return normalizeBranchName(task.metadata[field]);
    }
  }
  if (task.meta) {
    for (const field of directFields) {
      if (task.meta[field]) return normalizeBranchName(task.meta[field]);
    }
  }

  for (const label of collectTaskLabels(task)) {
    const match = String(label).match(UPSTREAM_LABEL_REGEX);
    if (match?.[1]) return normalizeBranchName(match[1]);
  }

  const fromText = extractUpstreamFromText(getTaskTextBlob(task));
  if (fromText) return fromText;

  const fromConfig = resolveUpstreamFromConfig(task, branchRouting);
  if (fromConfig) return normalizeBranchName(fromConfig);

  return normalizeBranchName(defaultTargetBranch);
}

function normalizeBaseBranchKey(baseBranch, defaultTargetBranch) {
  const candidate =
    normalizeBranchName(baseBranch) || normalizeBranchName(defaultTargetBranch);
  if (!candidate) return null;
  try {
    return normalizeBaseBranch(candidate, "origin").branch;
  } catch {
    return candidate;
  }
}

function ensureBaseBranchAvailable(repoRoot, baseBranch, defaultTargetBranch) {
  const fallback = normalizeBranchName(defaultTargetBranch) || "origin/main";
  let candidate = normalizeBranchName(baseBranch) || fallback;
  let normalized;
  try {
    normalized = normalizeBaseBranch(candidate, "origin");
  } catch {
    normalized = normalizeBaseBranch(fallback, "origin");
    candidate = fallback;
  }
  const { branch, remoteRef } = normalized;

  const localRef = `refs/heads/${branch}`;
  const localCheck = spawnSync("git", ["show-ref", "--verify", localRef], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5000,
  });
  if (localCheck.status === 0) {
    return branch;
  }

  let remoteExists = false;
  try {
    const remoteCheck = spawnSync(
      "git",
      ["ls-remote", "--heads", "origin", branch],
      { cwd: repoRoot, encoding: "utf8", timeout: 8000 },
    );
    remoteExists =
      remoteCheck.status === 0 && (remoteCheck.stdout || "").trim().length > 0;
  } catch {
    remoteExists = false;
  }

  if (remoteExists) {
    spawnSync("git", ["branch", branch, remoteRef], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 8000,
    });
    return branch;
  }

  const fallbackNorm = normalizeBaseBranch(fallback, "origin");
  try {
    spawnSync("git", ["fetch", "origin", fallbackNorm.branch, "--quiet"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15000,
    });
  } catch {
    /* best-effort */
  }

  const createRes = spawnSync(
    "git",
    ["branch", branch, fallbackNorm.remoteRef],
    { cwd: repoRoot, encoding: "utf8", timeout: 8000 },
  );
  if (createRes.status !== 0) {
    const stderr = (createRes.stderr || "").trim();
    console.warn(
      `${TAG} failed to create base branch ${branch} from ${fallbackNorm.remoteRef}: ${stderr}`,
    );
    return fallbackNorm.remoteRef;
  }

  spawnSync("git", ["push", "-u", "origin", branch], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  return branch;
}

function writeOrchestratorPauseState(paused, reason, extra = {}) {
  try {
    mkdirSync(dirname(ORCHESTRATOR_PAUSE_FILE), { recursive: true });
    const payload = {
      paused: Boolean(paused),
      reason: reason ? String(reason) : null,
      pauseUntil: Number.isFinite(extra.pauseUntil)
        ? new Date(extra.pauseUntil).toISOString()
        : null,
      updatedAt: new Date().toISOString(),
      source: extra.source || "task-executor",
    };
    writeFileSync(
      ORCHESTRATOR_PAUSE_FILE,
      JSON.stringify(payload, null, 2),
      "utf8",
    );
  } catch (err) {
    console.warn(`${TAG} failed to write orchestrator pause state: ${err.message}`);
  }
}

function normalizeRequirementsProfile(value) {
  const profile = String(value || "")
    .trim()
    .toLowerCase();
  if (REQUIREMENTS_PROFILES.has(profile)) {
    return profile;
  }
  return "feature";
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function isSharedHeartbeatStale(heartbeat, thresholdMs) {
  if (!heartbeat) return true;
  const ts = new Date(heartbeat).getTime();
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > thresholdMs;
}

function extractBacklogCandidates(outputText) {
  const text = String(outputText || "");
  if (!text.trim()) return [];

  const fencedMatch = text.match(
    /```(?:openfleet-backlog|json)?\s*([\s\S]*?)```/i,
  );
  if (fencedMatch?.[1]) {
    try {
      const parsed = JSON.parse(fencedMatch[1].trim());
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.backlog_tasks)) return parsed.backlog_tasks;
    } catch {
      /* continue */
    }
  }

  const objectMatch = text.match(/\{[\s\S]*"backlog_tasks"\s*:\s*\[[\s\S]*\][\s\S]*\}/i);
  if (objectMatch?.[0]) {
    try {
      const parsed = JSON.parse(objectMatch[0]);
      if (Array.isArray(parsed?.backlog_tasks)) return parsed.backlog_tasks;
    } catch {
      /* continue */
    }
  }

  return [];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Agent Log Streaming ─────────────────────────────────────────────────────

const AGENT_LOGS_DIR = resolve(__dirname, "logs", "agents");

/**
 * Create an onEvent callback that streams agent SDK events to a per-task log file
 * AND feeds the session tracker for review handoff context.
 * @param {string} taskId
 * @param {string} taskTitle
 * @returns {Function}
 */
function createAgentLogStreamer(taskId, taskTitle) {
  const shortId = taskId.substring(0, 8);
  const logFile = resolve(AGENT_LOGS_DIR, `agent-${shortId}.log`);
  const tracker = getSessionTracker();

  // Ensure log dir exists
  try {
    mkdirSync(AGENT_LOGS_DIR, { recursive: true });
  } catch {
    /* ok */
  }

  // Write header
  try {
    appendFileSync(
      logFile,
      `\n${"=".repeat(80)}\n[${new Date().toISOString()}] Task: ${taskTitle}\nTask ID: ${taskId}\n${"=".repeat(80)}\n`,
      "utf8",
    );
  } catch {
    /* ok */
  }

  return (event) => {
    // Feed to session tracker (for review handoff)
    try {
      tracker.recordEvent(taskId, event);
    } catch {
      /* never let tracking crash the agent */
    }

    try {
      const ts = new Date().toISOString();
      if (event.type === "item.completed" && event.item) {
        const item = event.item;
        if (item.type === "agent_message" && item.text) {
          appendFileSync(
            logFile,
            `[${ts}] AGENT: ${item.text.slice(0, 2000)}\n`,
            "utf8",
          );
        } else if (item.type === "function_call") {
          appendFileSync(
            logFile,
            `[${ts}] TOOL: ${item.name}(${(item.arguments || "").slice(0, 200)})\n`,
            "utf8",
          );
        } else if (item.type === "function_call_output") {
          const out = (item.output || "").slice(0, 500);
          appendFileSync(logFile, `[${ts}] RESULT: ${out}\n`, "utf8");
        } else {
          appendFileSync(
            logFile,
            `[${ts}] ITEM[${item.type}]: ${JSON.stringify(item).slice(0, 300)}\n`,
            "utf8",
          );
        }
      } else if (event.type === "item.created") {
        const item = event.item || {};
        appendFileSync(
          logFile,
          `[${ts}] +${item.type || event.type}\n`,
          "utf8",
        );
      } else if (event.type) {
        // Log any other event type for debugging
        appendFileSync(logFile, `[${ts}] EVT[${event.type}]\n`, "utf8");
      }
    } catch {
      /* never let logging crash the agent */
    }
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert text to a URL/branch-safe slug.
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
  return (text || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function parseGitHubIssueNumber(value) {
  if (value == null) return null;
  const numeric = String(value)
    .trim()
    .match(/^#?(\d+)$/);
  if (numeric?.[1]) return numeric[1];
  const urlMatch = String(value).match(/\/issues\/(\d+)(?:\b|$)/i);
  return urlMatch?.[1] || null;
}

function getGitHubIssueNumber(task) {
  if (!task) return null;
  const candidates = [
    task.externalId,
    task.external_id,
    task.meta?.externalId,
    task.meta?.external_id,
    task.id,
    task.meta?.number,
    task.meta?.id,
    task.taskUrl,
    task.url,
    task.meta?.url,
    task.meta?.task_url,
  ];
  for (const candidate of candidates) {
    const issueNumber = parseGitHubIssueNumber(candidate);
    if (issueNumber) return issueNumber;
  }
  return null;
}

function getTaskAgeMs(task) {
  const ts =
    task?.updated_at || task?.updatedAt || task?.created_at || task?.createdAt;
  if (!ts) return 0;
  const parsed = new Date(ts).getTime();
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Date.now() - parsed);
}

function parseTaskTimestamp(value) {
  if (!value) return null;
  const raw =
    value.created_at ||
    value.createdAt ||
    value.created ||
    value.updated_at ||
    value.updatedAt ||
    value.updated ||
    value.started_at ||
    value.startedAt ||
    value;
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function isPlannerTaskData(task) {
  if (!task) return false;
  const title = String(task.title || "").toLowerCase();
  const desc = String(task.description || task.body || "").toLowerCase();
  if (title.includes("plan next tasks") || title.includes("plan next phase")) {
    return true;
  }
  if (title.includes("task planner")) {
    return true;
  }
  return (
    desc.includes("task planner — auto-created by openfleet") ||
    desc.includes("task planner - auto-created by openfleet")
  );
}

function getTaskLabelSet(task) {
  const labels = Array.isArray(task?.meta?.labels)
    ? task.meta.labels
    : Array.isArray(task?.labels)
      ? task.labels
      : [];
  return new Set(
    labels
      .map((entry) => (typeof entry === "string" ? entry : entry?.name))
      .map((entry) =>
        String(entry || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
}

function isDraftTask(task) {
  if (!task) return false;
  const status = String(task.status || "").toLowerCase();
  if (status === "draft") return true;
  if (task.draft === true || task?.meta?.draft === true || task?.meta?.isDraft === true) {
    return true;
  }
  const labelSet = getTaskLabelSet(task);
  if (labelSet.has("draft")) return true;
  const tags = Array.isArray(task?.tags)
    ? task.tags
    : Array.isArray(task?.meta?.tags)
      ? task.meta.tags
      : [];
  return tags.some((tag) => String(tag || "").trim().toLowerCase() === "draft");
}

function isCodexScopedTask(task) {
  if (!isGitHubBackend(task)) return true;
  const labelSet = getTaskLabelSet(task);
  for (const label of CODEX_TASK_LABELS) {
    if (labelSet.has(label)) return true;
  }
  return false;
}

// ── Issue Tracking Helpers ──────────────────────────────────────────────────

/**
 * Check whether the current kanban backend is GitHub Issues.
 * @param {Object} [task] Optional task with backend info.
 * @returns {boolean}
 */
function isGitHubBackend(task) {
  const backend = String(
    task?.backend || task?.externalBackend || getKanbanBackendName(),
  ).toLowerCase();
  return backend === "github";
}

/**
 * Get the list of commits between two git refs, with titles and changed files.
 * @param {string} worktreePath Git working directory.
 * @param {string} fromRef      Starting ref (exclusive).
 * @param {string} toRef        Ending ref (inclusive). Defaults to HEAD.
 * @returns {{ sha: string, title: string, files: string[] }[]}
 */
function getCommitDetails(worktreePath, fromRef, toRef = "HEAD") {
  if (!worktreePath || !fromRef) return [];
  try {
    // Get commit SHAs and messages
    const logResult = spawnSync(
      "git",
      ["log", "--format=%H|%s", `${fromRef}..${toRef}`],
      { cwd: worktreePath, encoding: "utf8", timeout: 10_000 },
    );
    if (logResult.status !== 0 || !logResult.stdout?.trim()) return [];

    const commits = logResult.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ...titleParts] = line.split("|");
        return {
          sha: sha.trim(),
          title: titleParts.join("|").trim(),
          files: [],
        };
      });

    // Get changed files per commit
    for (const commit of commits) {
      try {
        const filesResult = spawnSync(
          "git",
          ["diff-tree", "--no-commit-id", "--name-only", "-r", commit.sha],
          { cwd: worktreePath, encoding: "utf8", timeout: 5_000 },
        );
        if (filesResult.status === 0 && filesResult.stdout) {
          commit.files = filesResult.stdout.trim().split("\n").filter(Boolean);
        }
      } catch {
        /* best-effort */
      }
    }

    return commits;
  } catch {
    return [];
  }
}

/**
 * Get the overall changed-file summary between two refs.
 * @param {string} worktreePath
 * @param {string} fromRef
 * @param {string} toRef
 * @returns {string} Formatted diff stat or empty string.
 */
function getChangedFilesSummary(worktreePath, fromRef, toRef = "HEAD") {
  if (!worktreePath || !fromRef) return "";
  try {
    const result = spawnSync(
      "git",
      ["diff", "--stat", `${fromRef}..${toRef}`],
      { cwd: worktreePath, encoding: "utf8", timeout: 10_000 },
    );
    return result.status === 0 ? (result.stdout || "").trim() : "";
  } catch {
    return "";
  }
}

/**
 * Post a structured comment on a GitHub issue for a task, if the backend is GitHub.
 * Non-blocking, best-effort — failures are logged but don't affect task flow.
 * @param {Object} task         Task object (must have id).
 * @param {string} commentBody  Markdown body for the comment.
 * @returns {Promise<boolean>}  true if comment was posted.
 */
async function commentOnIssue(task, commentBody) {
  if (!isGitHubBackend(task)) return false;
  const issueNumber = getGitHubIssueNumber(task);
  if (!issueNumber) return false;
  try {
    return await addComment(issueNumber, commentBody);
  } catch (err) {
    console.warn(
      `${TAG} failed to comment on issue #${issueNumber}: ${err.message}`,
    );
    return false;
  }
}

// ── Typedefs ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} TaskExecutorOptions
 * @property {string}   mode            - "internal" | "vk" | "hybrid"
 * @property {number}   maxParallel     - Max concurrent agent slots (default: 3)
 * @property {number}   baseBranchParallelLimit - Max concurrent tasks per base branch (0 = unlimited)
 * @property {number}   pollIntervalMs  - How often to check for tasks (default: 30000)
 * @property {string}   sdk             - SDK preference: "codex" | "copilot" | "claude" | "auto"
 * @property {number}   taskTimeoutMs   - Timeout per task execution (default: 90 * 60 * 1000)
 * @property {number}   maxRetries      - Retries per task via execWithRetry (default: 2)
 * @property {boolean}  autoCreatePr    - Create PR after agent completes (default: true)
 * @property {string}   projectId       - VK project ID to poll (null = auto-detect first project)
 * @property {string}   repoRoot        - Repository root path
 * @property {string}   repoSlug        - "owner/repo" for gh CLI
 * @property {Object}   branchRouting   - Branch routing config (scopeMap/defaultBranch)
 * @property {string}   defaultTargetBranch - Default upstream branch
 * @property {Function} onTaskStarted   - callback(task, slotInfo)
 * @property {Function} onTaskCompleted - callback(task, result)
 * @property {Function} onTaskFailed    - callback(task, error)
 * @property {Function} sendTelegram    - optional telegram notifier function
 * @property {Object}   agentPrompts    - optional prompt templates loaded from config
 */

/**
 * @typedef {Object} SlotInfo
 * @property {string} taskId
 * @property {string} taskTitle
 * @property {string} branch
 * @property {string|null} baseBranch
 * @property {string} worktreePath
 * @property {string} threadKey       - agent-pool thread key (taskId used as threadKey)
 * @property {number} startedAt       - timestamp
 * @property {number|null} agentInstanceId - monotonic task-agent instance ID
 * @property {string} sdk             - which SDK is running this
 * @property {string} model           - model override (if any)
 * @property {number} attempt         - current attempt number
 * @property {"running"|"completing"|"failed"} status
 * @property {string|null} executorProfile - executor profile name, if resolved
 * @property {object|null} complexity - complexity decision metadata
 */

// ── TaskExecutor Class ──────────────────────────────────────────────────────

class TaskExecutor {
  /**
   * Create a new TaskExecutor.
   * @param {TaskExecutorOptions} options
   */
  constructor(options = {}) {
    const defaults = {
      mode: "internal",
      maxParallel: 3,
      baseBranchParallelLimit: 0,
      pollIntervalMs: 30_000,
      sdk: "auto",
      taskTimeoutMs: 6 * 60 * 60 * 1000, // 6 hours — stream-based watchdog handles real issues
      maxRetries: 2,
      autoCreatePr: true,
      projectId: null,
      repoRoot: process.cwd(),
      repoSlug: "",
      branchRouting: null,
      defaultTargetBranch: null,
      onTaskStarted: null,
      onTaskCompleted: null,
      onTaskFailed: null,
      sendTelegram: null,
      agentPrompts: {},
    };

    const merged = { ...defaults, ...options };

    this.mode = merged.mode;
    this.maxParallel = merged.maxParallel;
    this.baseBranchParallelLimit = clampInt(
      merged.baseBranchParallelLimit,
      0,
      1000,
      0,
    );
    this.pollIntervalMs = merged.pollIntervalMs;
    this.sdk = merged.sdk;
    this.taskTimeoutMs = merged.taskTimeoutMs;
    this.maxRetries = merged.maxRetries;
    this.autoCreatePr = merged.autoCreatePr;
    this.projectId = merged.projectId;
    this.repoRoot = merged.repoRoot;
    this.repoSlug = merged.repoSlug;
    this.branchRouting = merged.branchRouting || null;
    this.defaultTargetBranch =
      merged.defaultTargetBranch ||
      merged.branchRouting?.defaultBranch ||
      process.env.VK_TARGET_BRANCH ||
      "origin/main";
    this.onTaskStarted = merged.onTaskStarted;
    this.onTaskCompleted = merged.onTaskCompleted;
    this.onTaskFailed = merged.onTaskFailed;
    this.sendTelegram = merged.sendTelegram;
    this._agentPrompts =
      merged.agentPrompts && typeof merged.agentPrompts === "object"
        ? merged.agentPrompts
        : {};
    this._projectRequirements = {
      profile: normalizeRequirementsProfile(
        merged.projectRequirements?.profile ||
          process.env.PROJECT_REQUIREMENTS_PROFILE ||
          "feature",
      ),
      notes: String(
        merged.projectRequirements?.notes ||
          process.env.PROJECT_REQUIREMENTS_NOTES ||
          "",
      ).trim(),
    };
    const replenishment = merged.backlogReplenishment || {};
    const replenishmentMin = clampInt(
      replenishment.minNewTasks ||
        process.env.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS ||
        1,
      1,
      2,
      1,
    );
    const replenishmentMaxRaw = clampInt(
      replenishment.maxNewTasks ||
        process.env.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS ||
        2,
      1,
      3,
      2,
    );
    this._backlogReplenishment = {
      enabled:
        replenishment.enabled === true ||
        ["1", "true", "yes", "on"].includes(
          String(process.env.INTERNAL_EXECUTOR_REPLENISH_ENABLED || "")
            .trim()
            .toLowerCase(),
        ),
      minNewTasks: replenishmentMin,
      maxNewTasks: Math.max(replenishmentMin, replenishmentMaxRaw),
      requirePriority: replenishment.requirePriority !== false,
    };

    // Initialize executor scheduler for per-task SDK routing
    /** @type {ExecutorScheduler|null} */
    this._executorScheduler = null;
    try {
      const execConfig = loadExecutorConfig(
        merged.repoRoot || process.cwd(),
        null,
      );
      this._executorScheduler = new ExecutorScheduler(execConfig);
    } catch {
      // Executor config not available — fall back to sdk field
    }

    /** @type {Map<string, SlotInfo>} */
    this._activeSlots = new Map();
    /** @type {Map<string, number>} taskId → timestamp */
    this._taskCooldowns = new Map();
    this._running = false;
    this._paused = false;
    this._pausedAt = null;
    this._pauseUntil = null;
    this._pauseReason = null;
    this._pauseTimer = null;
    this._pollTimer = null;
    this._pollInProgress = false;
    this._resolvedProjectId = null;
    this._taskClaimsReady = false;
    this._taskClaimsInitPromise = null;
    this._claimConflictNotifiedAt = new Map();
    this._instanceIdExplicit =
      String(process.env.VE_INSTANCE_ID || "").trim() !== "" ||
      String(process.env.OPENFLEET_INSTANCE_ID || "").trim() !== "";
    this._instanceId =
      String(
        process.env.VE_INSTANCE_ID ||
          process.env.OPENFLEET_INSTANCE_ID ||
          `${os.hostname() || "host"}-${process.pid}`,
      ).trim() || `executor-${process.pid}`;
    this.taskClaimOwnerStaleTtlMs = Math.max(
      60_000,
      Number(
        process.env.TASK_CLAIM_OWNER_STALE_TTL_MS ||
          merged.taskClaimOwnerStaleTtlMs ||
          10 * 60 * 1000,
      ),
    );
    this.taskClaimRenewIntervalMs = Math.max(
      30_000,
      Number(
        process.env.TASK_CLAIM_RENEW_INTERVAL_MS ||
          merged.taskClaimRenewIntervalMs ||
          5 * 60 * 1000,
      ),
    );
    this._taskClaimRenewTimers = new Map();

    /** @type {Map<string, AbortController>} taskId → AbortController for per-slot abort */
    this._slotAbortControllers = new Map();
    /** @type {NodeJS.Timeout|null} watchdog interval handle */
    this._watchdogTimer = null;

    // Idle-continue tracking: how many times we've sent CONTINUE for a still-running task
    /** @type {Map<string, number>} taskId → idle-continue count */
    this._idleContinueCounts = new Map();

    // Anti-thrash: track consecutive no-commit completions per task
    /** @type {Map<string, number>} taskId → consecutive no-commit count */
    this._noCommitCounts = new Map();
    /** @type {Map<string, number>} taskId → skip-until timestamp */
    this._skipUntil = new Map();

    // Track tasks that have already been completed with a PR (prevents re-dispatch loop)
    /** @type {Set<string>} taskId set */
    this._completedWithPR = new Set();
    /** @type {Set<string>} taskId set — tracks tasks where a PR has been created for their branch */
    this._prCreatedForBranch = new Set();

    // Throttle repeated listTasks failures to avoid log spam during VK outages
    this._listTasksFailureWindowStart = 0;
    this._listTasksFailureCount = 0;
    this._listTasksBackoffUntil = 0;
    this._listTasksBackoffReason = "";
    this._projectResolveFailureWindowStart = 0;
    this._projectResolveFailureCount = 0;
    this._projectResolveBackoffUntil = 0;
    this._projectResolveBackoffReason = "";
    this._projectResolvePromise = null;
    this._noProjectsWarnedAt = 0;

    /** @type {Map<string, { taskId: string, taskTitle: string, branch: string, sdk: string, model: string, attempt: number, startedAt: number, agentInstanceId: number|null, status: string, updatedAt: number }>} */
    this._slotRuntimeState = new Map();
    this._nextAgentInstanceId = 1;

    // Repo context cache (AGENTS.md, copilot-instructions.md)
    this._contextCache = null;
    this._contextCacheTime = 0;

    // Error detector for classifying agent failures
    this._errorDetector = createErrorDetector({
      sendTelegram: this.sendTelegram,
      onErrorDetected: (taskId, classification) => {
        console.log(
          `${TAG} error detected for ${taskId}: ${classification.pattern} (${classification.confidence.toFixed(2)})`,
        );
      },
    });

    console.log(
      `${TAG} initialized (mode=${this.mode}, maxParallel=${this.maxParallel}, baseBranchParallelLimit=${this.baseBranchParallelLimit}, sdk=${this.sdk})`,
    );
  }

  /** Load anti-thrash state from disk (survives restarts). */
  _loadNoCommitState() {
    try {
      if (existsSync(NO_COMMIT_STATE_FILE)) {
        const raw = readFileSync(NO_COMMIT_STATE_FILE, "utf8");
        const data = JSON.parse(raw);
        if (data && typeof data === "object") {
          for (const [id, count] of Object.entries(data.noCommitCounts || {})) {
            this._noCommitCounts.set(id, count);
          }
          for (const [id, until] of Object.entries(data.skipUntil || {})) {
            if (until > Date.now()) {
              this._skipUntil.set(id, until);
            }
          }
          // Restore completed-with-PR tracking
          if (Array.isArray(data.completedWithPR)) {
            for (const id of data.completedWithPR) {
              this._completedWithPR.add(id);
            }
          }
          if (Array.isArray(data.prCreatedForBranch)) {
            for (const id of data.prCreatedForBranch) {
              this._prCreatedForBranch.add(id);
            }
          }
          console.log(
            `${TAG} restored anti-thrash state: ${this._noCommitCounts.size} tasks tracked, ${this._completedWithPR.size} completed with PR`,
          );
        }
      }
    } catch (err) {
      console.warn(`${TAG} failed to load anti-thrash state: ${err.message}`);
    }
  }

  /** Persist anti-thrash state to disk. */
  _saveNoCommitState() {
    try {
      const dir = resolve(__dirname, ".cache");
      mkdirSync(dir, { recursive: true });
      const data = {
        noCommitCounts: Object.fromEntries(this._noCommitCounts),
        skipUntil: Object.fromEntries(this._skipUntil),
        completedWithPR: Array.from(this._completedWithPR),
        prCreatedForBranch: Array.from(this._prCreatedForBranch),
        savedAt: new Date().toISOString(),
      };
      writeFileSync(
        NO_COMMIT_STATE_FILE,
        JSON.stringify(data, null, 2),
        "utf8",
      );
    } catch (err) {
      console.warn(`${TAG} failed to save anti-thrash state: ${err.message}`);
    }
  }

  /** Load active slot runtime state (instance IDs + startedAt) from disk. */
  _loadRuntimeState() {
    try {
      if (!existsSync(RUNTIME_STATE_FILE)) return;
      const raw = readFileSync(RUNTIME_STATE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed?.paused === "boolean") {
        this._paused = parsed.paused;
        const pausedAt = Number(parsed?.pausedAt || 0);
        this._pausedAt =
          parsed.paused && Number.isFinite(pausedAt) && pausedAt > 0
            ? pausedAt
            : parsed.paused
              ? Date.now()
              : null;
        const pauseUntil = Number(parsed?.pauseUntil || 0);
        this._pauseUntil =
          parsed.paused && Number.isFinite(pauseUntil) && pauseUntil > 0
            ? pauseUntil
            : null;
        this._pauseReason =
          parsed.paused && parsed?.pauseReason
            ? String(parsed.pauseReason)
            : null;
        if (this._pauseUntil && this._pauseUntil <= Date.now()) {
          this._paused = false;
          this._pausedAt = null;
          this._pauseUntil = null;
          this._pauseReason = null;
        } else if (this._paused && this._pauseUntil) {
          this._schedulePauseExpiry();
        }
        writeOrchestratorPauseState(this._paused, this._pauseReason, {
          pauseUntil: this._pauseUntil,
          source: "runtime-restore",
        });
      }
      const nextId = Number(parsed?.nextAgentInstanceId || 1);
      if (Number.isFinite(nextId) && nextId > 0) {
        this._nextAgentInstanceId = Math.floor(nextId);
      }

      const slots = parsed?.slots || {};
      let restored = 0;
      for (const [taskId, entry] of Object.entries(slots)) {
        const startedAt = Number(entry?.startedAt || 0);
        if (!taskId || !Number.isFinite(startedAt) || startedAt <= 0) continue;
        const agentInstanceIdRaw = Number(entry?.agentInstanceId);
        const agentInstanceId =
          Number.isFinite(agentInstanceIdRaw) && agentInstanceIdRaw > 0
            ? Math.floor(agentInstanceIdRaw)
            : null;
        if (agentInstanceId) {
          this._nextAgentInstanceId = Math.max(
            this._nextAgentInstanceId,
            agentInstanceId + 1,
          );
        }
        this._slotRuntimeState.set(taskId, {
          taskId,
          taskTitle: String(entry?.taskTitle || ""),
          branch: String(entry?.branch || ""),
          sdk: String(entry?.sdk || ""),
          model: String(entry?.model || ""),
          attempt: Number(entry?.attempt || 0),
          startedAt,
          agentInstanceId,
          status: String(entry?.status || "running"),
          updatedAt: Number(entry?.updatedAt || Date.now()),
        });
        restored++;
      }
      if (restored > 0) {
        console.log(
          `${TAG} restored runtime slot state for ${restored} task(s), next agent instance #${this._nextAgentInstanceId}`,
        );
      }
    } catch (err) {
      console.warn(`${TAG} failed to load runtime slot state: ${err.message}`);
    }
  }

  /** Persist active slot runtime state to disk (survives monitor restart). */
  _saveRuntimeState() {
    try {
      const dir = resolve(__dirname, ".cache");
      mkdirSync(dir, { recursive: true });

      const slots = {};
      for (const [taskId, entry] of this._slotRuntimeState.entries()) {
        slots[taskId] = {
          taskId,
          taskTitle: entry.taskTitle || "",
          branch: entry.branch || "",
          sdk: entry.sdk || "",
          model: entry.model || "",
          attempt: Number(entry.attempt || 0),
          startedAt: Number(entry.startedAt || Date.now()),
          agentInstanceId:
            Number.isFinite(entry.agentInstanceId) && entry.agentInstanceId > 0
              ? Number(entry.agentInstanceId)
            : null,
          status: entry.status || "running",
          updatedAt: Number(entry.updatedAt || Date.now()),
        };
      }

      writeFileSync(
        RUNTIME_STATE_FILE,
        JSON.stringify(
          {
            paused: this._paused,
            pausedAt: this._pausedAt,
            pauseUntil: this._pauseUntil,
            pauseReason: this._pauseReason,
            nextAgentInstanceId: this._nextAgentInstanceId,
            slots,
            savedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch (err) {
      console.warn(`${TAG} failed to save runtime slot state: ${err.message}`);
    }
  }

  /**
   * Mirror slot fields into persisted runtime state.
   * @param {SlotInfo} slot
   */
  _upsertRuntimeSlot(slot) {
    if (!slot?.taskId) return;
    this._slotRuntimeState.set(slot.taskId, {
      taskId: slot.taskId,
      taskTitle: slot.taskTitle || "",
      branch: slot.branch || "",
      sdk: slot.sdk || "",
      model: slot.model || "",
      attempt: Number(slot.attempt || 0),
      startedAt: Number(slot.startedAt || Date.now()),
      agentInstanceId:
        Number.isFinite(slot.agentInstanceId) && slot.agentInstanceId > 0
          ? Number(slot.agentInstanceId)
          : null,
      status: slot.status || "running",
      updatedAt: Date.now(),
    });
    this._saveRuntimeState();
  }

  /**
   * Delete runtime state for a task slot after completion/failure reset.
   * @param {string} taskId
   */
  _removeRuntimeSlot(taskId) {
    if (!taskId) return;
    if (this._slotRuntimeState.delete(taskId)) {
      this._saveRuntimeState();
    }
  }

  _shouldBackoffListTasks() {
    return (
      this._listTasksBackoffUntil && Date.now() < this._listTasksBackoffUntil
    );
  }

  _shouldBackoffProjectResolution() {
    return (
      this._projectResolveBackoffUntil &&
      Date.now() < this._projectResolveBackoffUntil
    );
  }

  _resetListTasksBackoff() {
    this._listTasksFailureWindowStart = 0;
    this._listTasksFailureCount = 0;
    this._listTasksBackoffUntil = 0;
    this._listTasksBackoffReason = "";
  }

  _noteListTasksFailure(err) {
    const now = Date.now();
    const windowMs = 30_000;
    const threshold = 3;
    const backoffMs = 60_000;
    if (
      !this._listTasksFailureWindowStart ||
      now - this._listTasksFailureWindowStart > windowMs
    ) {
      this._listTasksFailureWindowStart = now;
      this._listTasksFailureCount = 0;
    }
    this._listTasksFailureCount += 1;
    const message = err?.message || String(err);
    if (this._listTasksFailureCount >= threshold) {
      this._listTasksBackoffUntil = now + backoffMs;
      this._listTasksBackoffReason = message;
      this._listTasksFailureCount = 0;
      this._listTasksFailureWindowStart = now;
      console.warn(
        `${TAG} listTasks backing off for ${Math.round(
          backoffMs / 1000,
        )}s after repeated failures: ${message}`,
      );
      return;
    }
    console.warn(`${TAG} failed to list tasks: ${message}`);
  }

  _resetProjectResolutionBackoff() {
    this._projectResolveFailureWindowStart = 0;
    this._projectResolveFailureCount = 0;
    this._projectResolveBackoffUntil = 0;
    this._projectResolveBackoffReason = "";
  }

  _noteProjectResolutionFailure(err) {
    const now = Date.now();
    const windowMs = 60_000;
    const threshold = 3;
    const backoffMs = 2 * 60_000;
    if (
      !this._projectResolveFailureWindowStart ||
      now - this._projectResolveFailureWindowStart > windowMs
    ) {
      this._projectResolveFailureWindowStart = now;
      this._projectResolveFailureCount = 0;
    }
    this._projectResolveFailureCount += 1;
    const message = err?.message || String(err);
    if (this._projectResolveFailureCount >= threshold) {
      this._projectResolveBackoffUntil = now + backoffMs;
      this._projectResolveBackoffReason = message;
      this._projectResolveFailureCount = 0;
      this._projectResolveFailureWindowStart = now;
      console.warn(
        `${TAG} project resolution backing off for ${Math.round(
          backoffMs / 1000,
        )}s after repeated failures: ${message}`,
      );
      return;
    }
    console.warn(`${TAG} failed to list projects: ${message}`);
  }

  _warnNoProjects() {
    const now = Date.now();
    if (now - this._noProjectsWarnedAt < 60_000) {
      return;
    }
    this._noProjectsWarnedAt = now;
    if (this._shouldBackoffProjectResolution()) {
      const waitMs = Math.max(0, this._projectResolveBackoffUntil - now);
      const reason = this._projectResolveBackoffReason
        ? ` (${this._projectResolveBackoffReason})`
        : "";
      console.warn(
        `${TAG} no projects found — skipping poll for ${Math.round(
          waitMs / 1000,
        )}s${reason}`,
      );
      return;
    }
    console.warn(`${TAG} no projects found — skipping poll`);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the periodic poll loop for tasks.
   */
  start() {
    // Load internal task store
    try {
      loadTaskStore();
    } catch (err) {
      console.warn(`${TAG} task store load warning: ${err.message}`);
    }

    // Initialize agent lifecycle hooks
    try {
      loadHooks();
      registerBuiltinHooks();
      console.log(`${TAG} agent lifecycle hooks initialized`);
    } catch (err) {
      console.warn(`${TAG} hook initialization warning: ${err.message}`);
    }

    // Restore anti-thrash state from disk
    this._loadNoCommitState();
    // Restore active slot metadata (agent instance IDs + original startedAt)
    this._loadRuntimeState();

    // Recover orphaned worktrees from prior runs (async, non-blocking)
    this._recoverOrphanedWorktrees().catch((err) => {
      console.warn(`${TAG} orphan recovery failed: ${err.message}`);
    });

    this._running = true;
    // Start watchdog to detect and kill stalled agent slots
    this._startWatchdog();
    // Resume interrupted in-progress tasks first, then poll todo backlog.
    void ensureThreadRegistryLoaded()
      .catch((err) => {
        console.warn(
          `${TAG} thread registry load warning: ${err.message || err}`,
        );
      })
      .then(() => {
        const pruned = pruneAllExhaustedThreads();
        if (pruned > 0) {
          console.log(
            `${TAG} cleaned up ${pruned} stale agent threads on startup`,
          );
        }
      })
      .then(() => this._recoverInterruptedInProgressTasks())
      .catch((err) => {
        console.warn(
          `${TAG} in-progress recovery warning: ${err.message || err}`,
        );
      })
      .finally(() => {
        void this._pollLoop();
      });
    this._pollTimer = setInterval(() => this._pollLoop(), this.pollIntervalMs);
    console.log(
      `${TAG} started — polling every ${this.pollIntervalMs / 1000}s for up to ${this.maxParallel} parallel tasks`,
    );
  }

  /**
   * Gracefully stop the executor, waiting for active tasks to finish.
   * @returns {Promise<void>}
   */
  async stop() {
    this._running = false;
    this._stopWatchdog();
    this._stopAllTaskClaimRenewals();
    if (this._pauseTimer) {
      clearTimeout(this._pauseTimer);
      this._pauseTimer = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }

    // Persist runtime state before waiting so unexpected exits still recover
    this._saveRuntimeState();

    const activeCount = this._activeSlots.size;
    if (activeCount > 0) {
      console.log(
        `${TAG} stopping — waiting for ${activeCount} active task(s) to finish (${GRACEFUL_SHUTDOWN_MS / 1000}s grace)...`,
      );
      const deadline = Date.now() + GRACEFUL_SHUTDOWN_MS;
      while (this._activeSlots.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    console.log(`${TAG} stopped (${this._activeSlots.size} tasks were active)`);
  }

  /**
   * Pause task dispatch — running tasks continue, but no new tasks are picked up.
   * @returns {boolean} true if paused (false if already paused)
   */
  pause(reason = null) {
    if (this._paused) return false;
    this._paused = true;
    this._pausedAt = Date.now();
    this._pauseReason = reason ? String(reason) : this._pauseReason;
    this._saveRuntimeState();
    writeOrchestratorPauseState(true, this._pauseReason, {
      pauseUntil: this._pauseUntil,
    });
    console.log(
      `${TAG} paused — no new tasks will be dispatched (active: ${this._activeSlots.size})`,
    );
    return true;
  }

  /**
   * Resume task dispatch after a pause.
   * @returns {boolean} true if resumed (false if not paused)
   */
  resume() {
    if (!this._paused) return false;
    const pauseDuration = this._pausedAt
      ? Math.round((Date.now() - this._pausedAt) / 1000)
      : 0;
    this._paused = false;
    this._pausedAt = null;
    this._pauseUntil = null;
    this._pauseReason = null;
    if (this._pauseTimer) {
      clearTimeout(this._pauseTimer);
      this._pauseTimer = null;
    }
    this._saveRuntimeState();
    writeOrchestratorPauseState(false, null, { pauseUntil: null });
    console.log(
      `${TAG} resumed after ${pauseDuration}s pause — will pick up tasks on next poll`,
    );
    return true;
  }

  /**
   * Pause task dispatch for a fixed duration.
   * @param {number} durationMs
   * @param {string|null} reason
   * @returns {boolean}
   */
  pauseFor(durationMs, reason = null) {
    const changed = this.pause(reason);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return changed;
    }
    this._pauseUntil = Date.now() + durationMs;
    this._pauseReason = reason ? String(reason) : this._pauseReason;
    this._schedulePauseExpiry();
    this._saveRuntimeState();
    writeOrchestratorPauseState(true, this._pauseReason, {
      pauseUntil: this._pauseUntil,
    });
    console.log(
      `${TAG} pause expires in ${Math.round(durationMs / 1000)}s (${reason || "unspecified"})`,
    );
    return changed;
  }

  /**
   * Check if executor is paused.
   * @returns {boolean}
   */
  isPaused() {
    return this._paused;
  }

  /**
   * Get pause info for status display.
   * @returns {{ paused: boolean, pausedAt: number|null, pauseUntil: number|null, pauseReason: string|null, pauseDuration: number }}
   */
  getPauseInfo() {
    return {
      paused: this._paused,
      pausedAt: this._pausedAt,
      pauseUntil: this._pauseUntil,
      pauseReason: this._pauseReason,
      pauseDuration: this._pausedAt
        ? Math.round((Date.now() - this._pausedAt) / 1000)
        : 0,
    };
  }

  _schedulePauseExpiry() {
    if (!this._pauseUntil) return;
    const delay = Math.max(0, this._pauseUntil - Date.now());
    if (this._pauseTimer) {
      clearTimeout(this._pauseTimer);
    }
    this._pauseTimer = setTimeout(() => {
      if (this._paused && this._pauseUntil && Date.now() >= this._pauseUntil) {
        this.resume();
      }
    }, delay);
    if (this._pauseTimer?.unref) {
      this._pauseTimer.unref();
    }
  }

  // ── Slot Watchdog ──────────────────────────────────────────────────────

  /**
   * Start the watchdog timer that periodically checks for stalled agent slots.
   * @private
   */
  _startWatchdog() {
    this._watchdogTimer = setInterval(
      () => this._watchdog(),
      WATCHDOG_INTERVAL_MS,
    );
    console.log(
      `${TAG} stream-based watchdog started — analyzing agent health every ${WATCHDOG_INTERVAL_MS / 1000}s ` +
        `(idle threshold: ${STREAM_IDLE_THRESHOLD_MS / 60000}min, stalled kill: ${STREAM_STALLED_KILL_MS / 60000}min, ` +
        `max continues: ${MAX_IDLE_CONTINUES}, absolute limit: ${Math.round((this.taskTimeoutMs + WATCHDOG_GRACE_MS) / 60000)}min)`,
    );
  }

  /**
   * Stop the watchdog timer.
   * @private
   */
  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  /**
   * Stream-Based Watchdog: Monitors agent health by analyzing the REAL event
   * stream instead of relying on fixed timeouts. Only intervenes when actual
   * problems are detected in the agent's output stream.
   *
   * Intervention ladder:
   *  1. Agent idle for STREAM_IDLE_THRESHOLD_MS → send CONTINUE signal
   *  2. Agent silent for STREAM_SILENT_THRESHOLD_MS after continues → escalate
   *  3. Agent stalled for STREAM_STALLED_KILL_MS with no recovery → force-kill
   *  4. Hard deadline (taskTimeoutMs + WATCHDOG_GRACE_MS) as absolute safety net
   *
   * This replaces the old approach of killing agents based on arbitrary time limits.
   * Agents that are actively producing events (tool calls, messages, edits) are
   * NEVER interrupted regardless of how long they've been running.
   * @private
   */
  _watchdog() {
    const now = Date.now();
    const absoluteDeadline = this.taskTimeoutMs + WATCHDOG_GRACE_MS;
    const sessionTracker = getSessionTracker();

    for (const [taskId, slot] of this._activeSlots) {
      const elapsed = now - slot.startedAt;

      // ── 0. Warmup phase — never interfere with agent setup ──
      if (elapsed < WATCHDOG_WARMUP_MS) continue;

      const progress = sessionTracker.getProgressStatus(taskId);
      const continueCount = this._idleContinueCounts.get(taskId) || 0;
      const ac = this._slotAbortControllers.get(taskId);

      // ── 1. Stream health analysis — is the agent ACTUALLY working? ──
      const isActivelyWorking =
        progress.status === "active" &&
        progress.totalEvents > 0 &&
        progress.idleMs < STREAM_IDLE_THRESHOLD_MS;

      // If agent is actively producing events, skip ALL intervention
      if (isActivelyWorking) {
        // Reset continue count when agent shows life
        if (continueCount > 0) {
          this._idleContinueCounts.set(taskId, 0);
        }
        continue;
      }

      // ── 2. Agent has meaningful progress (edits/commits) — be very patient ──
      if (progress.hasEdits || progress.hasCommits) {
        // Agent has done real work. Only intervene if it's been truly silent
        // for a very long time (double the normal threshold)
        if (progress.idleMs < STREAM_SILENT_THRESHOLD_MS * 2) {
          continue; // Still within tolerance for an agent that has done work
        }
      }

      // ── 3. Idle detection — agent went silent, try CONTINUE ──
      if (
        (progress.status === "idle" || progress.status === "stalled") &&
        progress.idleMs >= STREAM_IDLE_THRESHOLD_MS
      ) {
        const idleSec = Math.round(progress.idleMs / 1000);

        if (continueCount < MAX_IDLE_CONTINUES) {
          if (ac && !ac.signal.aborted) {
            console.log(
              `${TAG} WATCHDOG: agent "${slot.taskTitle}" idle for ${idleSec}s ` +
                `(events: ${progress.totalEvents}, edits: ${progress.hasEdits}, ` +
                `commits: ${progress.hasCommits}) — sending CONTINUE signal ` +
                `(${continueCount + 1}/${MAX_IDLE_CONTINUES})`,
            );
            this._idleContinueCounts.set(taskId, continueCount + 1);
            ac.abort("idle_continue");
          }
          continue;
        }

        // ── 4. Exhausted continues — check if truly stalled ──
        if (progress.idleMs >= STREAM_STALLED_KILL_MS) {
          const elapsedMin = Math.round(elapsed / 60000);
          console.warn(
            `${TAG} ⚠️ WATCHDOG: agent "${slot.taskTitle}" stalled for ` +
              `${Math.round(progress.idleMs / 60000)}min after ${continueCount} continues ` +
              `(total runtime: ${elapsedMin}min, events: ${progress.totalEvents}) — force-aborting`,
          );
          if (ac && !ac.signal.aborted) {
            ac.abort("watchdog_stalled");
          }
          this._taskCooldowns.set(taskId, now);
          this.sendTelegram?.(
            `⚠️ Watchdog killed stalled agent: "${slot.taskTitle}" ` +
              `(idle ${Math.round(progress.idleMs / 60000)}min after ${continueCount} continues, ` +
              `total ${elapsedMin}min, ${progress.totalEvents} events)`,
          );
          continue;
        }
      }

      // ── 5. Absolute safety net — only triggers if stream analysis somehow missed ──
      if (elapsed > absoluteDeadline) {
        const elapsedMin = Math.round(elapsed / 60000);
        const deadlineMin = Math.round(absoluteDeadline / 60000);
        console.warn(
          `${TAG} ⚠️ WATCHDOG: absolute deadline exceeded for "${slot.taskTitle}" ` +
            `(${elapsedMin}min > ${deadlineMin}min, events: ${progress.totalEvents}, ` +
            `edits: ${progress.hasEdits}, commits: ${progress.hasCommits}) — force-aborting`,
        );
        if (ac && !ac.signal.aborted) {
          ac.abort("watchdog_timeout");
        } else if (!ac) {
          console.warn(
            `${TAG} WATCHDOG: no AbortController for "${slot.taskTitle}" — slot may be stuck permanently`,
          );
        }
        this._taskCooldowns.set(taskId, now);
        this.sendTelegram?.(
          `⚠️ Watchdog hard limit: "${slot.taskTitle}" (${elapsedMin}min > ${deadlineMin}min absolute limit)`,
        );
      }
    }
  }

  /**
   * Scan worktrees from prior runs for uncommitted/unpushed work.
   * Attempts to commit, push, and create PRs for any orphaned work.
   * @returns {Promise<void>}
   */
  async _recoverOrphanedWorktrees() {
    const worktreeDir = resolve(this.repoRoot, ".cache", "worktrees");
    if (!existsSync(worktreeDir)) return;

    const { readdirSync, statSync } = await import("node:fs");
    let dirs;
    try {
      dirs = readdirSync(worktreeDir);
    } catch {
      return;
    }

    let recovered = 0;
    let skipped = 0;

    for (const dirName of dirs) {
      // Only process ve-<taskid>-* directories
      const match = dirName.match(/^ve-([a-f0-9]{8})-/);
      if (!match) continue;

      const taskIdPrefix = match[1];
      const wtPath = resolve(worktreeDir, dirName);

      try {
        const stat = statSync(wtPath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      // Skip worktrees that are actively being used
      const isActive = [...this._activeSlots.values()].some(
        (s) => s.worktreePath && s.worktreePath.includes(dirName),
      );
      if (isActive) continue;

      // Check for uncommitted changes
      let hasChanges = false;
      let branch = "";
      try {
        const status = execSync("git status --porcelain", {
          cwd: wtPath,
          encoding: "utf8",
          stdio: "pipe",
          timeout: 10000,
        }).trim();
        hasChanges = status.length > 0;

        branch = execSync("git branch --show-current", {
          cwd: wtPath,
          encoding: "utf8",
          stdio: "pipe",
          timeout: 5000,
        }).trim();
      } catch {
        continue; // Broken worktree, skip
      }

      if (!branch || !branch.startsWith("ve/")) continue;
      const baseInfo = normalizeBaseBranch(
        this.defaultTargetBranch || "origin/main",
        "origin",
      );

      // Check if we already created a PR for this branch
      if (this._prCreatedForBranch.has(taskIdPrefix)) {
        skipped++;
        continue;
      }

      // Check for uncommitted changes OR unpushed commits
      let hasUnpushed = false;
      try {
        const unpushed = execSync(
          `git log ${baseInfo.remoteRef}..HEAD --oneline`,
          {
          cwd: wtPath,
          encoding: "utf8",
          stdio: "pipe",
          timeout: 10000,
        },
        ).trim();
        hasUnpushed = unpushed.length > 0;
      } catch {
        // No upstream tracking, that's ok
      }

      if (!hasChanges && !hasUnpushed) {
        skipped++;
        continue;
      }

      console.log(
        `${TAG} [orphan-recovery] Found orphaned work in ${dirName}: ` +
          `${hasChanges ? "uncommitted changes" : ""}${hasChanges && hasUnpushed ? " + " : ""}` +
          `${hasUnpushed ? "unpushed commits" : ""} on branch ${branch}`,
      );

      // Commit uncommitted changes
      if (hasChanges) {
        try {
          execSync("git add -A", {
            cwd: wtPath,
            stdio: "pipe",
            timeout: 15000,
          });
          execSync(
            `git commit -m "feat: auto-commit orphaned agent work" --no-verify`,
            { cwd: wtPath, stdio: "pipe", timeout: 15000 },
          );
          console.log(
            `${TAG} [orphan-recovery] Committed changes in ${dirName}`,
          );
        } catch (err) {
          console.warn(
            `${TAG} [orphan-recovery] Failed to commit in ${dirName}: ${err.message}`,
          );
          continue;
        }
      }

      // Verify branches actually has meaningful diff vs main BEFORE creating a PR
      // This prevents empty PRs from being created when worktrees have merge artifacts.
      try {
        const diffCheck = execSync(
          `git diff --name-only ${baseInfo.remoteRef}...HEAD`,
          {
          cwd: wtPath,
          encoding: "utf8",
          stdio: "pipe",
          timeout: 15000,
        },
        ).trim();
        if (diffCheck.length === 0) {
          console.log(
            `${TAG} [orphan-recovery] Skipping ${dirName} — 0 file changes vs ${baseInfo.branch} (would create empty PR)`,
          );
          skipped++;
          continue;
        }
        const fileCount = diffCheck.split("\n").filter(Boolean).length;
        console.log(
          `${TAG} [orphan-recovery] ${dirName} has ${fileCount} changed file(s) vs main`,
        );
      } catch {
        // If diff check fails, skip this worktree rather than creating a potentially empty PR
        console.warn(
          `${TAG} [orphan-recovery] Cannot verify diff for ${dirName} — skipping`,
        );
        skipped++;
        continue;
      }

      // Build a minimal task object for _createPR
      const taskObj = {
        id: taskIdPrefix,
        title: branch.replace("ve/", "").replace(/-/g, " ").substring(9), // Remove UUID prefix
        description: "Auto-recovered from orphaned worktree",
        branchName: branch,
      };

      // Try to create PR
      try {
        const prResult = await this._createPR(taskObj, wtPath, {
          agentMadeNewCommits: true,
          baseBranch: resolveTaskBaseBranch(
            taskObj,
            this.branchRouting,
            this.defaultTargetBranch,
          ),
        });
        if (prResult) {
          console.log(
            `${TAG} [orphan-recovery] PR created for ${dirName}: ${prResult}`,
          );
          this._prCreatedForBranch.add(taskIdPrefix);
          recovered++;
        }
      } catch (err) {
        console.warn(
          `${TAG} [orphan-recovery] PR creation failed for ${dirName}: ${err.message}`,
        );
      }
    }

    if (recovered > 0 || skipped > 0) {
      console.log(
        `${TAG} [orphan-recovery] complete: ${recovered} recovered, ${skipped} skipped`,
      );
    }
  }

  async _ensureResolvedProjectId() {
    if (this._resolvedProjectId) return this._resolvedProjectId;
    if (this.projectId) {
      this._resolvedProjectId = this.projectId;
      return this._resolvedProjectId;
    }
    if (this._shouldBackoffProjectResolution()) {
      return null;
    }
    if (this._projectResolvePromise) {
      return this._projectResolvePromise;
    }

    this._projectResolvePromise = (async () => {
      try {
        const projects = await listProjects();
        if (projects && projects.length > 0) {
          const wantName = (
            process.env.PROJECT_NAME ||
            process.env.VK_PROJECT_NAME ||
            ""
          ).toLowerCase();
          let matched;
          if (wantName) {
            matched = projects.find(
              (p) => (p.name || p.title || "").toLowerCase() === wantName,
            );
          }
          if (matched) {
            this._resolvedProjectId = matched.id || matched.project_id;
            console.log(
              `${TAG} matched project by name "${wantName}": ${this._resolvedProjectId}`,
            );
          } else {
            this._resolvedProjectId = projects[0].id || projects[0].project_id;
            console.log(
              `${TAG} auto-detected project (first): ${this._resolvedProjectId}`,
            );
          }
          this._resetProjectResolutionBackoff();
        }
        return this._resolvedProjectId || null;
      } catch (err) {
        this._noteProjectResolutionFailure(err);
        return null;
      } finally {
        this._projectResolvePromise = null;
      }
    })();

    return this._projectResolvePromise;
  }

  async _recoverInterruptedInProgressTasks() {
    if (!this._running) return;
    if (this._paused) return;
    if (this._activeSlots.size >= this.maxParallel) return;
    if (this._shouldBackoffListTasks()) return;
    await ensureThreadRegistryLoaded().catch(() => {
      /* best effort */
    });

    const projectId = await this._ensureResolvedProjectId();
    if (!projectId) return;

    let inProgressTasks = [];
    try {
      const fetched = await listTasks(projectId, { status: "inprogress" });
      if (Array.isArray(fetched)) {
        inProgressTasks = fetched.filter(
          (task) => task?.status === "inprogress",
        );
      }
      this._resetListTasksBackoff();
    } catch (err) {
      this._noteListTasksFailure(err);
      return;
    }

    if (!inProgressTasks.length) return;

    // Runtime metadata can outlive crashes. Drop stale records that are no
    // longer in-progress so new runs get fresh instance IDs and start times.
    const inProgressIds = new Set(
      inProgressTasks
        .map((task) => task?.id || task?.task_id)
        .filter((id) => !!id),
    );
    let prunedRuntime = 0;
    for (const taskId of Array.from(this._slotRuntimeState.keys())) {
      if (!inProgressIds.has(taskId) && !this._activeSlots.has(taskId)) {
        this._slotRuntimeState.delete(taskId);
        prunedRuntime++;
      }
    }
    if (prunedRuntime > 0) {
      this._saveRuntimeState();
    }

    const activeThreads = new Set(
      getActiveThreads()
        .map((entry) => String(entry?.taskKey || "").trim())
        .filter(Boolean),
    );

    const available = Math.max(0, this.maxParallel - this._activeSlots.size);
    if (available === 0) return;

    /** @type {Array<Object>} */
    const resumable = [];
    let resetToTodo = 0;
    let reconciledDrift = 0;
    let skippedForActiveClaim = 0;

    for (const task of inProgressTasks) {
      const id = task?.id || task?.task_id;
      if (!id || this._activeSlots.has(id)) continue;

      const internalTask = getInternalTask(id);
      const internalStatus = internalTask?.status || null;
      if (internalTask && internalStatus && internalStatus !== "inprogress") {
        try {
          await updateTaskStatus(id, internalStatus);
        } catch {
          /* best effort */
        }
        this._removeRuntimeSlot(id);
        reconciledDrift++;
        continue;
      }

      if (SHARED_STATE_ENABLED) {
        try {
          const sharedState = await getSharedState(id, this.repoRoot);
          const ownerId = sharedState?.ownerId || null;
          const heartbeat =
            sharedState?.ownerHeartbeat || sharedState?.heartbeat || null;
          if (
            ownerId &&
            ownerId !== this._instanceId &&
            !isSharedHeartbeatStale(heartbeat, SHARED_STATE_STALE_THRESHOLD_MS)
          ) {
            skippedForActiveClaim++;
            continue;
          }
        } catch {
          /* best effort */
        }
      }

      let ageMs = getTaskAgeMs(task);
      if (internalTask) {
        const internalAge = getTaskAgeMs(internalTask);
        if (internalAge > 0) {
          ageMs = ageMs > 0 ? Math.min(ageMs, internalAge) : internalAge;
        }
      }
      const hasThread = activeThreads.has(String(id));
      const isFreshEnough =
        ageMs === 0 || ageMs <= INPROGRESS_RECOVERY_MAX_AGE_MS;
      if (hasThread || isFreshEnough) {
        if (!internalTask) {
          try {
            addInternalTask({
              id,
              title: task?.title || "",
              description: task?.description || "",
              status: "inprogress",
              externalStatus: "inprogress",
              externalId: task?.externalId || null,
              externalBackend: task?.backend || null,
              projectId: task?.projectId || null,
            });
          } catch {
            /* best effort */
          }
        }
        resumable.push({ ...task, id });
        continue;
      }

      try {
        await updateTaskStatus(id, "todo");
      } catch {
        /* best effort */
      }
      try {
        setInternalStatus(id, "todo", "task-executor-recovery");
      } catch {
        /* best effort */
      }
      this._removeRuntimeSlot(id);
      resetToTodo++;
    }

    const toDispatch = this._selectTasksForBaseBranchLimit(
      resumable,
      available,
    );
    for (const task of toDispatch) {
      void this.executeTask(task).catch((err) => {
        console.error(
          `${TAG} in-progress recovery executeTask failed for "${task?.title || task?.id}": ${err.message || err}`,
        );
      });
    }

    if (toDispatch.length > 0 || resetToTodo > 0) {
      console.log(
        `${TAG} in-progress recovery: resumed ${toDispatch.length}, reset ${resetToTodo} stale task(s) to todo` +
          (reconciledDrift > 0
            ? `, reconciled ${reconciledDrift} drifted task(s)`
            : "") +
          (skippedForActiveClaim > 0
            ? `, skipped ${skippedForActiveClaim} active claim(s)`
            : ""),
      );
    }
  }

  /**
   * Returns the current executor status for monitoring / Telegram.
   * @returns {Object}
   */
  getStatus() {
    return {
      running: this._running,
      paused: this._paused,
      pausedAt: this._pausedAt,
      pauseUntil: this._pauseUntil,
      pauseReason: this._pauseReason,
      pauseDuration: this._pausedAt
        ? Math.round((Date.now() - this._pausedAt) / 1000)
        : 0,
      mode: this.mode,
      maxParallel: this.maxParallel,
      baseBranchParallelLimit: this.baseBranchParallelLimit,
      sdk: this.sdk === "auto" ? getPoolSdkName() : this.sdk,
      activeSlots: this._activeSlots.size,
      slots: Array.from(this._activeSlots.values()).map((s) => ({
        taskId: s.taskId,
        taskTitle: s.taskTitle,
        branch: s.branch,
        baseBranch: s.baseBranch || null,
        sdk: s.sdk,
        model: s.model || "",
        attempt: s.attempt,
        agentInstanceId: s.agentInstanceId ?? null,
        startedAt: s.startedAt,
        runningFor: Math.round((Date.now() - s.startedAt) / 1000),
        status: s.status,
      })),
      cooldowns: this._taskCooldowns.size,
      blockedTasks: this._getBlockedTaskIds(),
      noCommitCounts: Object.fromEntries(this._noCommitCounts),
      pollIntervalMs: this.pollIntervalMs,
      taskTimeoutMs: this.taskTimeoutMs,
      maxRetries: this.maxRetries,
      projectId: this._resolvedProjectId || this.projectId || null,
      backlogReplenishment: { ...this._backlogReplenishment },
      projectRequirements: { ...this._projectRequirements },
    };
  }

  getBacklogReplenishmentConfig() {
    return {
      ...this._backlogReplenishment,
      projectRequirements: { ...this._projectRequirements },
    };
  }

  setBacklogReplenishmentConfig(patch = {}) {
    if (!patch || typeof patch !== "object") {
      return this.getBacklogReplenishmentConfig();
    }
    if (patch.enabled !== undefined) {
      this._backlogReplenishment.enabled = Boolean(patch.enabled);
    }
    if (patch.minNewTasks !== undefined) {
      this._backlogReplenishment.minNewTasks = clampInt(
        patch.minNewTasks,
        1,
        2,
        this._backlogReplenishment.minNewTasks,
      );
    }
    if (patch.maxNewTasks !== undefined) {
      this._backlogReplenishment.maxNewTasks = clampInt(
        patch.maxNewTasks,
        1,
        3,
        this._backlogReplenishment.maxNewTasks,
      );
    }
    if (
      this._backlogReplenishment.maxNewTasks <
      this._backlogReplenishment.minNewTasks
    ) {
      this._backlogReplenishment.maxNewTasks =
        this._backlogReplenishment.minNewTasks;
    }
    if (patch.requirePriority !== undefined) {
      this._backlogReplenishment.requirePriority = Boolean(
        patch.requirePriority,
      );
    }
    if (patch.projectRequirements && typeof patch.projectRequirements === "object") {
      this.setProjectRequirements(patch.projectRequirements);
    }
    return this.getBacklogReplenishmentConfig();
  }

  getProjectRequirements() {
    return { ...this._projectRequirements };
  }

  setProjectRequirements(patch = {}) {
    if (!patch || typeof patch !== "object") {
      return this.getProjectRequirements();
    }
    if (patch.profile !== undefined) {
      this._projectRequirements.profile = normalizeRequirementsProfile(
        patch.profile,
      );
    }
    if (patch.notes !== undefined) {
      this._projectRequirements.notes = String(patch.notes || "").trim();
    }
    return this.getProjectRequirements();
  }

  /**
   * Check if a task is currently managed by the internal executor
   * (active, in cooldown, or blocked). Used by monitor to avoid
   * double-recovering tasks.
   * @param {string} taskId
   * @returns {boolean}
   */
  isTaskManaged(taskId) {
    // Currently executing
    if (this._activeSlots.has(taskId)) return true;
    // In anti-thrash cooldown
    const skipUntil = this._skipUntil.get(taskId);
    if (skipUntil && Date.now() < skipUntil) return true;
    // In failure cooldown
    const cooldownAt = this._taskCooldowns.get(taskId);
    if (cooldownAt && Date.now() - cooldownAt < COOLDOWN_MS) return true;
    // Permanently blocked for this session
    const noCommitCount = this._noCommitCounts.get(taskId) || 0;
    if (noCommitCount >= MAX_NO_COMMIT_ATTEMPTS) return true;
    return false;
  }

  /**
   * Get list of task IDs that are permanently blocked (exceeded no-commit limit).
   * @returns {string[]}
   * @private
   */
  _getBlockedTaskIds() {
    const blocked = [];
    for (const [id, count] of this._noCommitCounts) {
      if (count >= MAX_NO_COMMIT_ATTEMPTS) blocked.push(id);
    }
    return blocked;
  }

  /**
   * Initialize distributed task claims backing store.
   * Best-effort: execution continues even if claims are unavailable.
   *
   * @returns {Promise<boolean>}
   * @private
   */
  async _ensureTaskClaimsInitialized() {
    if (this._taskClaimsReady) return true;
    if (this._taskClaimsInitPromise) return this._taskClaimsInitPromise;

    this._taskClaimsInitPromise = initTaskClaims({ repoRoot: this.repoRoot })
      .then(async () => {
        try {
          await initPresence({ repoRoot: this.repoRoot });
          const presenceState = getPresenceState();
          const stableInstanceId = String(
            presenceState?.instance_id || "",
          ).trim();
          if (
            stableInstanceId &&
            !this._instanceIdExplicit &&
            stableInstanceId !== this._instanceId
          ) {
            this._instanceId = stableInstanceId;
          }
          console.log(
            `${TAG} [task-claims] using instance_id=${this._instanceId}`,
          );
        } catch (err) {
          console.warn(`${TAG} presence init warning: ${err?.message || err}`);
        }
        this._taskClaimsReady = true;
        return true;
      })
      .catch((err) => {
        this._taskClaimsReady = false;
        console.warn(`${TAG} task-claims init warning: ${err?.message || err}`);
        return false;
      })
      .finally(() => {
        this._taskClaimsInitPromise = null;
      });

    return this._taskClaimsInitPromise;
  }

  /**
   * Claim TTL should outlive long-running agents by a safe margin.
   *
   * @returns {number}
   * @private
   */
  _getTaskClaimTtlMinutes() {
    const baseMs = Math.max(this.taskTimeoutMs || 0, 60 * 60 * 1000);
    const withBufferMs = baseMs + 30 * 60 * 1000;
    const minutes = Math.ceil(withBufferMs / 60_000);
    return Math.min(Math.max(minutes, 60), 24 * 60);
  }

  _startTaskClaimRenewal(taskId, claimToken, taskTitle = "") {
    if (!taskId || !claimToken) return;
    this._stopTaskClaimRenewal(taskId);
    const intervalMs = this.taskClaimRenewIntervalMs;
    const renew = async () => {
      try {
        const renewed = await renewClaim({
          taskId,
          claimToken,
          instanceId: this._instanceId,
          ttlMinutes: this._getTaskClaimTtlMinutes(),
        });
        if (!renewed?.success) {
          console.warn(
            `${TAG} claim renewal failed for "${taskTitle || taskId}": ${renewed?.error || "unknown"}`,
          );
          if (
            renewed?.error === "task_claimed_by_different_instance" ||
            renewed?.error === "claim_token_mismatch" ||
            renewed?.error === "task_not_claimed"
          ) {
            this._stopTaskClaimRenewal(taskId);
          }
        }
      } catch (err) {
        console.warn(
          `${TAG} claim renewal warning for "${taskTitle || taskId}": ${err?.message || err}`,
        );
      }
    };
    const timer = setInterval(() => {
      void renew();
    }, intervalMs);
    if (timer?.unref) timer.unref();
    this._taskClaimRenewTimers.set(taskId, timer);
  }

  _stopTaskClaimRenewal(taskId) {
    const timer = this._taskClaimRenewTimers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this._taskClaimRenewTimers.delete(taskId);
    }
  }

  _stopAllTaskClaimRenewals() {
    for (const timer of this._taskClaimRenewTimers.values()) {
      clearInterval(timer);
    }
    this._taskClaimRenewTimers.clear();
  }

  _resolveTaskBaseBranch(task) {
    return resolveTaskBaseBranch(
      task,
      this.branchRouting,
      this.defaultTargetBranch,
    );
  }

  _resolveTaskBaseBranchKey(task) {
    return normalizeBaseBranchKey(
      this._resolveTaskBaseBranch(task),
      this.defaultTargetBranch,
    );
  }

  _buildActiveBaseBranchCounts() {
    const counts = new Map();
    for (const slot of this._activeSlots.values()) {
      const key = normalizeBaseBranchKey(
        slot.baseBranch,
        this.defaultTargetBranch,
      );
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  _selectTasksForBaseBranchLimit(candidates, remaining) {
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    if (!Number.isFinite(remaining) || remaining <= 0) return [];
    const limit = Number(this.baseBranchParallelLimit || 0);
    if (!Number.isFinite(limit) || limit <= 0) {
      return candidates.slice(0, remaining);
    }

    const counts = this._buildActiveBaseBranchCounts();
    const selected = [];
    for (const task of candidates) {
      if (selected.length >= remaining) break;
      const key = this._resolveTaskBaseBranchKey(task);
      if (!key) {
        selected.push(task);
        continue;
      }
      const current = counts.get(key) || 0;
      if (current >= limit) continue;
      counts.set(key, current + 1);
      selected.push(task);
    }
    return selected;
  }

  _isBaseBranchLimitReached(task) {
    const limit = Number(this.baseBranchParallelLimit || 0);
    if (!Number.isFinite(limit) || limit <= 0) return false;
    const key = this._resolveTaskBaseBranchKey(task);
    if (!key) return false;
    const counts = this._buildActiveBaseBranchCounts();
    return (counts.get(key) || 0) >= limit;
  }

  /**
   * Throttle duplicate "claimed by another orchestrator" issue comments.
   *
   * @param {string} taskId
   * @returns {boolean}
   * @private
   */
  _shouldNotifyClaimConflict(taskId) {
    const now = Date.now();
    const last = this._claimConflictNotifiedAt.get(taskId) || 0;
    if (now - last < CLAIM_CONFLICT_COMMENT_COOLDOWN_MS) {
      return false;
    }
    this._claimConflictNotifiedAt.set(taskId, now);
    return true;
  }

  async _verifyPlannerTaskCompletion(task) {
    const projectId =
      task?.projectId ||
      task?.project_id ||
      this.projectId ||
      (await this._ensureResolvedProjectId());
    if (!projectId) {
      return { completed: false, reason: "project_not_found", createdCount: 0 };
    }

    const tasks = await listTasks(projectId);
    const allTasks = Array.isArray(tasks) ? tasks : [];
    const sinceMs = parseTaskTimestamp(task) || Date.now();
    const candidates = allTasks.filter((candidate) => {
      if (!candidate) return false;
      if (
        String(candidate.id || "") === String(task?.id || task?.task_id || "")
      ) {
        return false;
      }
      if (isPlannerTaskData(candidate)) return false;
      const createdMs = parseTaskTimestamp(candidate);
      return Number.isFinite(createdMs) && createdMs > sinceMs;
    });
    const backlogCandidates = candidates.filter((candidate) => {
      const status = String(candidate?.status || "").toLowerCase();
      return (
        !status ||
        status === "todo" ||
        status === "inprogress" ||
        status === "inreview"
      );
    });
    const finalCandidates =
      backlogCandidates.length > 0 ? backlogCandidates : candidates;

    return {
      completed: finalCandidates.length > 0,
      createdCount: finalCandidates.length,
      reason: finalCandidates.length > 0 ? "tasks_created" : "no_new_tasks",
      sampleTitles: finalCandidates
        .slice(0, 3)
        .map((candidate) => candidate?.title || candidate?.id)
        .filter(Boolean),
    };
  }

  // ── Poll Loop ─────────────────────────────────────────────────────────────

  /**
   * Check kanban for todo tasks and dispatch execution.
   * Guarded against overlapping polls and slot saturation.
   * @private
   */
  async _pollLoop() {
    if (!this._running) return;
    if (this._paused) return; // paused — skip picking new tasks (active tasks continue)
    if (this._pollInProgress) return;
    if (this._activeSlots.size >= this.maxParallel) return;

    this._pollInProgress = true;
    try {
      const projectId = await this._ensureResolvedProjectId();
      if (!projectId) {
        this._warnNoProjects();
        return;
      }

      if (this._shouldBackoffListTasks()) {
        return;
      }

      // Fetch todo tasks
      let tasks;
      try {
        tasks = await listTasks(projectId, { status: "todo" });
        this._resetListTasksBackoff();
      } catch (err) {
        this._noteListTasksFailure(err);
        return;
      }

      // Client-side status filter — VK API may not respect the status query param
      if (tasks && tasks.length > 0) {
        const before = tasks.length;
        tasks = tasks.filter((t) => t.status === "todo");
        if (tasks.length !== before) {
          console.debug(
            `${TAG} filtered ${before - tasks.length} non-todo tasks (VK returned ${before}, kept ${tasks.length})`,
          );
        }
      }

      if (tasks && tasks.length > 0) {
        const before = tasks.length;
        tasks = tasks.filter((task) => isCodexScopedTask(task));
        if (tasks.length !== before) {
          console.debug(
            `${TAG} filtered ${before - tasks.length} non-codex-scoped task(s)`,
          );
        }
      }

      if (tasks && tasks.length > 0) {
        const before = tasks.length;
        tasks = tasks.filter((task) => !isDraftTask(task));
        if (tasks.length !== before) {
          console.debug(
            `${TAG} filtered ${before - tasks.length} draft task(s)`,
          );
        }
      }

      if (!tasks || tasks.length === 0) return;

      const now = Date.now();

      // Filter out ineligible tasks
      const eligible = tasks.filter((t) => {
        const id = t.id || t.task_id;
        if (!id) return false;
        // Already running
        if (this._activeSlots.has(id)) return false;
        // Already completed with a PR
        if (this._completedWithPR.has(id)) return false;
        // In cooldown (failure cooldown)
        const cooldownUntil = this._taskCooldowns.get(id);
        if (cooldownUntil && now - cooldownUntil < COOLDOWN_MS) return false;
        // Anti-thrash: skip tasks that repeatedly complete with no commits
        const skipUntil = this._skipUntil.get(id);
        if (skipUntil && now < skipUntil) {
          return false; // still in anti-thrash cooldown
        } else if (skipUntil && now >= skipUntil) {
          this._skipUntil.delete(id); // cooldown expired, allow retry
        }
        // Hard block: exceeded max no-commit attempts
        const noCommitCount = this._noCommitCounts.get(id) || 0;
        if (noCommitCount >= MAX_NO_COMMIT_ATTEMPTS) {
          return false; // permanently blocked for this executor session
        }
        return true;
      });

      if (eligible.length === 0) return;

      // Fill remaining slots
      const remaining = this.maxParallel - this._activeSlots.size;
      const toDispatch = this._selectTasksForBaseBranchLimit(
        eligible,
        remaining,
      );

      for (const task of toDispatch) {
        // Normalize task id
        task.id = task.id || task.task_id;
        // Fire and forget — executeTask handles its own lifecycle
        this.executeTask(task).catch((err) => {
          console.error(
            `${TAG} unhandled error in executeTask for "${task.title}": ${err.message}`,
          );
        });
      }
    } catch (err) {
      console.error(`${TAG} poll loop error: ${err.message}`);
    } finally {
      this._pollInProgress = false;
    }
  }

  // ── Task Execution ────────────────────────────────────────────────────────

  /**
   * Execute a single task through its full lifecycle:
   * slot allocation → status update → worktree → agent → result → cleanup.
   * @param {Object} task - Task object from kanban adapter
   * @returns {Promise<void>}
   */
  async executeTask(task, options = {}) {
    const taskId = task.id || task.task_id;
    const taskTitle = task.title || "(untitled)";
    if (this._paused) {
      console.log(
        `${TAG} executor paused — skipping task "${taskTitle}" (${taskId})`,
      );
      return;
    }
    if (this._isBaseBranchLimitReached(task)) {
      const baseBranch = this._resolveTaskBaseBranch(task);
      console.log(
        `${TAG} base-branch parallel limit reached (${this.baseBranchParallelLimit}) for "${taskTitle}" (${taskId}) on ${baseBranch || "default"} — deferring`,
      );
      return;
    }
    const requestedBranch = String(
      options?.branch || options?.resumeBranch || "",
    ).trim();
    const branch =
      requestedBranch ||
      task.branchName ||
      task.meta?.branch_name ||
      `ve/${taskId.substring(0, 8)}-${slugify(taskTitle)}`;
    const baseBranch = this._resolveTaskBaseBranch(task);
    let taskClaimToken = null;

    const releaseTaskClaimLock = async () => {
      this._stopTaskClaimRenewal(taskId);
      if (!taskClaimToken) return;
      try {
        await releaseTaskClaim({
          taskId,
          claimToken: taskClaimToken,
          instanceId: this._instanceId,
        });
      } catch (err) {
        console.warn(
          `${TAG} task-claim release warning for "${taskTitle}": ${err?.message || err}`,
        );
      } finally {
        taskClaimToken = null;
      }
    };

    // 1. Resolve executor profile and SDK for this task
    let resolvedSdk = this.sdk;
    let executorProfile = null;
    let complexityInfo = null;
    const overrideSdk = normalizeSdkOverride(options?.sdk);
    const overrideModel = normalizeModel(options?.model);

    if (this.sdk === "auto" && this._executorScheduler) {
      // Pick executor profile from scheduler (weighted/round-robin/primary)
      const baseProfile = this._executorScheduler.next();
      // Resolve optimal model based on task complexity
      const resolved = resolveExecutorForTask(task, baseProfile);
      executorProfile = resolved;
      complexityInfo = resolved.complexity;
      // Map executor type to SDK name
      resolvedSdk = executorToSdk(resolved.executor);
      console.log(
        `${TAG} task "${taskTitle}" → ${formatComplexityDecision(resolved)} → sdk=${resolvedSdk}`,
      );
    } else if (this.sdk !== "auto") {
      resolvedSdk = this.sdk;
    } else {
      resolvedSdk = getPoolSdkName();
    }

    const configuredCopilotModel =
      normalizeModel(process.env.COPILOT_MODEL) ||
      normalizeModel(process.env.COPILOT_SDK_MODEL);
    const configuredClaudeModel =
      normalizeModel(process.env.CLAUDE_MODEL) ||
      normalizeModel(process.env.CLAUDE_CODE_MODEL) ||
      normalizeModel(process.env.ANTHROPIC_MODEL);

    let selectedModel = normalizeModel(executorProfile?.model);
    if (resolvedSdk === "copilot" && configuredCopilotModel) {
      if (selectedModel && selectedModel !== configuredCopilotModel) {
        console.log(
          `${TAG} overriding complexity model "${selectedModel}" with COPILOT_MODEL="${configuredCopilotModel}" for task "${taskTitle}"`,
        );
      }
      selectedModel = configuredCopilotModel;
    } else if (resolvedSdk === "claude" && configuredClaudeModel) {
      if (selectedModel && selectedModel !== configuredClaudeModel) {
        console.log(
          `${TAG} overriding complexity model "${selectedModel}" with CLAUDE_MODEL="${configuredClaudeModel}" for task "${taskTitle}"`,
        );
      }
      selectedModel = configuredClaudeModel;
    }

    if (overrideSdk && overrideSdk !== "auto") {
      resolvedSdk = overrideSdk;
      executorProfile = null;
      complexityInfo = null;
      console.log(
        `${TAG} manual SDK override for "${taskTitle}" → sdk=${resolvedSdk}`,
      );
    }
    if (overrideModel) {
      selectedModel = overrideModel;
      console.log(
        `${TAG} manual model override for "${taskTitle}" → model=${selectedModel}`,
      );
    }

    // 1b. Allocate slot
    const recoveredRuntime =
      task?.status === "inprogress"
        ? this._slotRuntimeState.get(taskId) || null
        : null;
    const recoveredAgentId = Number(recoveredRuntime?.agentInstanceId || 0);
    const recoveredStartedAt = Number(recoveredRuntime?.startedAt || 0);
    const validRecoveredStartedAt =
      Number.isFinite(recoveredStartedAt) &&
      recoveredStartedAt > 0 &&
      recoveredStartedAt <= Date.now();

    let agentInstanceId = null;
    if (Number.isFinite(recoveredAgentId) && recoveredAgentId > 0) {
      agentInstanceId = Math.floor(recoveredAgentId);
      this._nextAgentInstanceId = Math.max(
        this._nextAgentInstanceId,
        agentInstanceId + 1,
      );
    } else {
      agentInstanceId = this._nextAgentInstanceId++;
    }

    /** @type {SlotInfo} */
    const slot = {
      taskId,
      taskTitle,
      branch,
      baseBranch: baseBranch || null,
      worktreePath: null,
      threadKey: taskId,
      startedAt: validRecoveredStartedAt ? recoveredStartedAt : Date.now(),
      agentInstanceId,
      sdk: resolvedSdk,
      model: selectedModel || "",
      attempt: 0,
      status: "running",
      executorProfile: executorProfile || null,
      complexity: complexityInfo || null,
    };
    this._activeSlots.set(taskId, slot);
    this._upsertRuntimeSlot(slot);

    try {
      // 0. Distributed task claim (multi-orchestrator coordination)
      const claimsReady = await this._ensureTaskClaimsInitialized();
      if (claimsReady) {
        const claimResult = await claimTask({
          taskId,
          instanceId: this._instanceId,
          ttlMinutes: this._getTaskClaimTtlMinutes(),
          ownerStaleTtlMs: this.taskClaimOwnerStaleTtlMs,
          metadata: {
            task_title: taskTitle,
            branch,
            owner: "task-executor",
            sdk: resolvedSdk,
            model: selectedModel || null,
            pid: process.pid,
            host: os.hostname(),
          },
        });

        if (claimResult?.success) {
          taskClaimToken =
            claimResult.token || claimResult.claim?.claim_token || null;
          this._startTaskClaimRenewal(taskId, taskClaimToken, taskTitle);
        } else if (claimResult?.error === "task_already_claimed") {
          const owner =
            claimResult?.existing_instance ||
            claimResult?.existing_claim?.instance_id ||
            "unknown";
          const claimedAt =
            claimResult?.existing_claim?.claimed_at || "unknown";
          const expiresAt =
            claimResult?.existing_claim?.expires_at || "unknown";

          console.log(
            `${TAG} skipping "${taskTitle}" — claimed by orchestrator "${owner}" (claimed: ${claimedAt}, expires: ${expiresAt})`,
          );
          this._taskCooldowns.set(taskId, Date.now());

          if (this._shouldNotifyClaimConflict(taskId)) {
            commentOnIssue(
              task,
              [
                `## ⏭️ Task Deferred`,
                ``,
                `This task is currently claimed by another orchestrator instance.`,
                ``,
                `- Task: \`${taskId}\``,
                `- Current orchestrator: \`${this._instanceId}\``,
                `- Claim owner: \`${owner}\``,
                `- Claimed at: ${claimedAt}`,
                `- Claim expires: ${expiresAt}`,
              ].join("\n"),
            ).catch(() => {
              /* best-effort */
            });
          }

          this._activeSlots.delete(taskId);
          this._removeRuntimeSlot(taskId);
          return;
        } else {
          console.warn(
            `${TAG} task-claim warning for "${taskTitle}": ${claimResult?.error || "unknown claim error"} — continuing without claim lock`,
          );
        }
      }

      this.onTaskStarted?.(task, slot);

      // Fire SessionStart hook
      executeHooks("SessionStart", {
        taskId,
        taskTitle,
        taskDescription: task.description || task.body || "",
        branch,
        sdk: slot.sdk || "unknown",
        slot: slot.index,
      }).catch(() => {});

      // 2. Update task status → "inprogress"
      try {
        await updateTaskStatus(taskId, "inprogress");
      } catch (err) {
        console.warn(`${TAG} failed to set task to inprogress: ${err.message}`);
      }
      // Mirror to internal store
      try {
        setInternalStatus(taskId, "inprogress", "task-executor");
      } catch {
        /* best-effort */
      }
      try {
        updateInternalTask(taskId, { branchName: branch });
      } catch {
        /* best-effort */
      }

      // 2b. Comment on GitHub issue with start info
      commentOnIssue(
        task,
        [
          `## 🤖 Agent Started`,
          ``,
          `| Field | Value |`,
          `|-------|-------|`,
          `| **Started** | ${new Date().toISOString()} |`,
          `| **Branch** | \`${branch}\` |`,
          task?.baseBranch || task?.base_branch || task?.meta?.base_branch
            ? `| **Base Branch** | \`${task.baseBranch || task.base_branch || task.meta?.base_branch}\` |`
            : "",
          `| **SDK** | ${resolvedSdk} |`,
          selectedModel ? `| **Model** | ${selectedModel} |` : "",
          `| **Executor** | openfleet (internal) |`,
          executorProfile ? `| **Profile** | ${executorProfile} |` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ).catch(() => {
        /* best-effort */
      });

      // 3. Acquire worktree
      let wt;
      try {
        const taskBaseBranch = resolveTaskBaseBranch(
          task,
          this.branchRouting,
          this.defaultTargetBranch,
        );
        const worktreeBaseBranch = ensureBaseBranchAvailable(
          this.repoRoot,
          taskBaseBranch,
          this.defaultTargetBranch,
        );
        wt = await acquireWorktree(branch, taskId, {
          owner: "task-executor",
          baseBranch: worktreeBaseBranch,
        });
      } catch (err) {
        console.error(
          `${TAG} worktree acquisition failed for "${taskTitle}": ${err.message}`,
        );
        this._taskCooldowns.set(taskId, Date.now());
        try {
          await updateTaskStatus(taskId, "todo");
        } catch {
          /* best-effort */
        }
        await releaseTaskClaimLock();
        this._activeSlots.delete(taskId);
        this._removeRuntimeSlot(taskId);
        this.onTaskFailed?.(
          task,
          new Error(`Worktree acquisition failed: ${err.message}`),
        );
        return;
      }

      if (!wt || !wt.path || !existsSync(wt.path)) {
        console.error(
          `${TAG} worktree path invalid for "${taskTitle}": ${wt?.path}`,
        );
        this._taskCooldowns.set(taskId, Date.now());
        try {
          await releaseWorktree(taskId);
        } catch {
          /* best-effort */
        }
        try {
          await updateTaskStatus(taskId, "todo");
        } catch {
          /* best-effort */
        }
        await releaseTaskClaimLock();
        this._activeSlots.delete(taskId);
        this._removeRuntimeSlot(taskId);
        this.onTaskFailed?.(
          task,
          new Error("Worktree path invalid or missing"),
        );
        return;
      }

      slot.worktreePath = wt.path;
      this._upsertRuntimeSlot(slot);

      // 4. Record pre-execution HEAD hash (to detect if agent made NEW commits)
      const preExecHead =
        spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: wt.path,
          encoding: "utf8",
          timeout: 5000,
        }).stdout?.trim() || "";

      // 5. Build prompt
      const prompt = this._buildTaskPrompt(task, wt.path, {
        retryReason: options?.retryReason,
        branch,
      });

      // 5b. Create per-task AbortController for watchdog integration
      const taskAbortController = new AbortController();
      this._slotAbortControllers.set(taskId, taskAbortController);

      // Reset idle-continue counter for this task
      this._idleContinueCounts.delete(taskId);

      // 6. Execute agent
      console.log(
        `${TAG} executing task "${taskTitle}" in ${wt.path} on branch ${branch} (sdk=${resolvedSdk})`,
      );

      // 6a. Start session tracking for review handoff
      const sessionTracker = getSessionTracker();
      sessionTracker.startSession(taskId, taskTitle);

      const result = await execWithRetry(prompt, {
        taskKey: taskId,
        cwd: wt.path,
        timeoutMs: this.taskTimeoutMs,
        maxRetries: this.maxRetries,
        maxContinues: 3,
        sdk: resolvedSdk !== "auto" ? resolvedSdk : undefined,
        model: selectedModel || undefined,
        buildRetryPrompt: (lastResult, attempt) =>
          this._buildRetryPrompt(task, lastResult, attempt),
        buildContinuePrompt: (lastResult, attempt) =>
          this._buildContinuePrompt(task, lastResult, attempt),
        onEvent: createAgentLogStreamer(taskId, taskTitle),
        abortController: taskAbortController,
        // When AbortController is replaced after idle_continue, update our reference
        onAbortControllerReplaced: (newAC) => {
          this._slotAbortControllers.set(taskId, newAC);
        },
      });

      // Track attempts on task for PR body
      task._executionResult = result;

      // 6b. End session tracking and analyze session patterns
      const sessionStatus = result.success ? "completed" : "failed";
      sessionTracker.endSession(taskId, sessionStatus);

      // Session-aware error analysis (detects behavioral patterns like tool loops, analysis paralysis)
      const sessionMessages = sessionTracker.getLastMessages(taskId);
      const sessionAnalysis =
        this._errorDetector.analyzeMessageSequence(sessionMessages);
      if (sessionAnalysis.primary) {
        console.log(
          `${TAG} session analysis for "${taskTitle}": ${sessionAnalysis.primary} — ${JSON.stringify(sessionAnalysis.details)}`,
        );
      }

      // Capture formatted session summary for review handoff
      const sessionSummary = sessionTracker.getMessageSummary(taskId);

      // Record post-execution HEAD hash
      const postExecHead =
        spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: wt.path,
          encoding: "utf8",
          timeout: 5000,
        }).stdout?.trim() || "";
      const agentMadeNewCommits =
        preExecHead && postExecHead && preExecHead !== postExecHead;

      // Build execInfo for _handleTaskResult (may be updated by auto-resume)
      const execInfo = {
        agentMadeNewCommits,
        preExecHead,
        postExecHead,
        sessionSummary,
        sessionAnalysis,
      };

      // 6c. Post-execution completion validation
      //     If agent reported success but shows signs of incomplete work,
      //     attempt one more CONTINUE before falling into anti-thrash.
      let validatedResult = result;
      if (
        result.success &&
        !agentMadeNewCommits &&
        (result.continues || 0) < 3
      ) {
        const shouldAutoResume = this._shouldAutoResume(
          taskId,
          taskTitle,
          sessionAnalysis,
          sessionMessages,
        );
        if (shouldAutoResume) {
          console.log(
            `${TAG} completion validation: "${taskTitle}" reported success but appears incomplete — auto-resuming`,
          );

          // Re-open session tracking
          sessionTracker.startSession(taskId, taskTitle);

          // Create fresh AbortController
          const resumeAC = new AbortController();
          this._slotAbortControllers.set(taskId, resumeAC);

          const continuePrompt = this._buildContinuePrompt(
            task,
            result,
            (result.attempts || 1) + 1,
          );

          const resumeResult = await execWithRetry(continuePrompt, {
            taskKey: taskId,
            cwd: wt.path,
            timeoutMs: this.taskTimeoutMs,
            maxRetries: 0,
            maxContinues: 1,
            sdk: resolvedSdk !== "auto" ? resolvedSdk : undefined,
            buildRetryPrompt: (lr, att) =>
              this._buildRetryPrompt(task, lr, att),
            buildContinuePrompt: (lr, att) =>
              this._buildContinuePrompt(task, lr, att),
            onEvent: createAgentLogStreamer(taskId, taskTitle),
            abortController: resumeAC,
            onAbortControllerReplaced: (newAC) => {
              this._slotAbortControllers.set(taskId, newAC);
            },
          });

          // Use the resumed result instead
          validatedResult = resumeResult;
          task._executionResult = resumeResult;

          // Re-analyze after resume
          sessionTracker.endSession(
            taskId,
            resumeResult.success ? "completed" : "failed",
          );
          const newMessages = sessionTracker.getLastMessages(taskId);
          const newAnalysis =
            this._errorDetector.analyzeMessageSequence(newMessages);

          // Re-check for commits
          const postResumeHead =
            spawnSync("git", ["rev-parse", "HEAD"], {
              cwd: wt.path,
              encoding: "utf8",
              timeout: 5000,
            }).stdout?.trim() || "";
          const resumeMadeCommits =
            preExecHead && postResumeHead && preExecHead !== postResumeHead;

          // Update execInfo for _handleTaskResult
          execInfo.agentMadeNewCommits = resumeMadeCommits;
          execInfo.postExecHead = postResumeHead;
          execInfo.sessionSummary = sessionTracker.getMessageSummary(taskId);
          execInfo.sessionAnalysis = newAnalysis;

          console.log(
            `${TAG} auto-resume complete for "${taskTitle}": success=${resumeResult.success}, newCommits=${resumeMadeCommits}`,
          );
        }
      }

      // 7. Handle result
      slot.status = validatedResult.success ? "completing" : "failed";
      this._upsertRuntimeSlot(slot);
      await this._handleTaskResult(task, validatedResult, wt.path, execInfo);

      // 7a. Feed back success/failure to executor scheduler for failover tracking
      if (this._executorScheduler && executorProfile?.name) {
        if (result.success) {
          this._executorScheduler.recordSuccess(executorProfile.name);
        } else {
          this._executorScheduler.recordFailure(executorProfile.name);
        }
      }

      // 8. Cleanup
      this._slotAbortControllers.delete(taskId);
      try {
        await releaseWorktree(taskId);
      } catch (err) {
        console.warn(`${TAG} worktree release warning: ${err.message}`);
      }
      await releaseTaskClaimLock();
      this._activeSlots.delete(taskId);
      this._removeRuntimeSlot(taskId);
    } catch (err) {
      // Catch-all: ensure slot is always cleaned up
      console.error(
        `${TAG} fatal error executing task "${taskTitle}": ${err.message}`,
      );
      slot.status = "failed";
      this._taskCooldowns.set(taskId, Date.now());
      this._slotAbortControllers.delete(taskId);

      try {
        await updateTaskStatus(taskId, "todo");
      } catch {
        /* best-effort */
      }
      try {
        await releaseWorktree(taskId);
      } catch {
        /* best-effort */
      }
      await releaseTaskClaimLock();

      this._activeSlots.delete(taskId);
      this._removeRuntimeSlot(taskId);
      this.onTaskFailed?.(task, err);
      this.sendTelegram?.(
        `❌ Task executor error: "${taskTitle}" — ${(err.message || "").slice(0, 200)}`,
      );
    }
  }

  // ── Prompt Building ───────────────────────────────────────────────────────

  _resolveAgentPrompt(key, values, fallbackPrompt) {
    const template = this._agentPrompts?.[key];
    return resolvePromptTemplate(template, values, fallbackPrompt);
  }

  /**
   * Build a comprehensive prompt for the agent from task details and repo context.
   * @param {Object} task
   * @param {string} worktreePath
   * @returns {string}
   * @private
   */
  _buildTaskPrompt(task, worktreePath, opts = {}) {
    const branch =
      String(opts?.branch || "").trim() ||
      task.branchName ||
      task.meta?.branch_name ||
      spawnSync("git", ["branch", "--show-current"], {
        cwd: worktreePath,
        encoding: "utf8",
        timeout: 5000,
      }).stdout?.trim() ||
      "unknown";
    const retryReason = String(opts?.retryReason || "").trim();

    const lines = [
      `# ${task.id || task.task_id} — ${task.title}`,
      ``,
    ];
    if (retryReason) {
      lines.push(
        `## Manual Retry Context`,
        `Reason: ${retryReason}`,
        `Resume on branch: \`${branch}\``,
        `If this branch has no meaningful commits yet, create a fresh branch and proceed.`,
        ``,
      );
    }
    lines.push(
      `## Description`,
      task.description ||
        "No description provided. Check the task URL for details.",
      ``,
      `## Environment`,
      `- Working Directory: ${worktreePath}`,
      `- Branch: ${branch}`,
      `- Repository: ${this.repoSlug}`,
      ``,
      `## Instructions`,
      `You are working autonomously on a software engineering task for this repository.`,
      `Autonomous mode is mandatory for this run — do not pause for approvals, confirmations, or user prompts.`,
      `1. Read the task description carefully`,
      `2. Analyze the codebase to understand what needs to change`,
      `3. Implement the required changes`,
      `4. Run the relevant test suite for touched code`,
      `5. Run linting/formatting checks used by this repository`,
      `6. Commit your changes using conventional commit format: type(scope): description`,
      `7. Push your branch: \`git push --set-upstream origin ${branch}\``,
      ``,
      `## Critical Rules`,
      `- NEVER ask for user input — this is an autonomous task`,
      `- ALWAYS use available tools/subagents/search agents when they improve execution speed or quality`,
      `- NEVER create placeholders or stubs — implement real, complete code`,
      `- NEVER skip tests — verify your changes work`,
      `- Use conventional commits: feat|fix|docs|refactor|test(scope): description`,
      `- Follow existing code patterns in the repository`,
      ``,
    );

    // Agent endpoint info for self-reporting
    const endpointPort = process.env.AGENT_ENDPOINT_PORT || "18432";
    lines.push(
      `## Agent Status Endpoint`,
      `You can report your status to the orchestrator at: http://127.0.0.1:${endpointPort}/api/tasks/${task.id || task.task_id}`,
      `- POST /status with {"status": "inreview"} when you've pushed and created a PR`,
      `- POST /heartbeat with {} to indicate you're still alive`,
      `- POST /error with {"error": "description"} if you encounter a fatal error`,
      `- POST /complete with {"hasCommits": true} when fully done`,
      ``,
    );

    // Append task URL if available
    const taskUrl = task.meta?.task_url || task.taskUrl || task.url;
    if (taskUrl) {
      lines.push(`## Task Reference`, `- URL: ${taskUrl}`, ``);
    }

    // Append cached repo context (AGENTS.md + copilot-instructions.md)
    const context = this._getRepoContext();
    if (context) {
      lines.push(`## Repository Context`, ``, context, ``);
    }

    if (this._backlogReplenishment.enabled && !isPlannerTaskData(task)) {
      const minTasks = this._backlogReplenishment.minNewTasks;
      const maxTasks = Math.max(
        minTasks,
        this._backlogReplenishment.maxNewTasks,
      );
      const reqProfile = this._projectRequirements.profile;
      const reqNotes = this._projectRequirements.notes;
      lines.push(
        `## Experimental Backlog Replenishment (Required)`,
        `After completing this task, identify ${minTasks}-${maxTasks} high-value follow-up tasks in the same or adjacent modules.`,
        `Each task must be substantial, improve project progress, and include a priority (low|medium|high|critical).`,
        `Project requirements profile: ${reqProfile}`,
        reqNotes ? `Project requirements notes: ${reqNotes}` : "",
        `Return ONLY the backlog payload below in one fenced block after your completion summary:`,
        "```openfleet-backlog",
        "[",
        '  {"title":"...","description":"...","priority":"high","module":"x/market","rationale":"..."}',
        "]",
        "```",
        `Do not include trivial chores; focus on impactful implementation tasks that can be executed autonomously.`,
        ``,
      );
    }

    const fallbackPrompt = lines.join("\n");
    return this._resolveAgentPrompt(
      "taskExecutor",
      {
        TASK_TITLE: task.title || "Untitled Task",
        TASK_DESCRIPTION:
          task.description ||
          "No description provided. Check the task URL for details.",
        WORKTREE_PATH: worktreePath,
        BRANCH: branch,
        REPO_SLUG: this.repoSlug || "unknown/unknown",
        TASK_ID: task.id || task.task_id || "unknown",
        ENDPOINT_PORT: endpointPort,
        TASK_URL_LINE: taskUrl ? `- URL: ${taskUrl}` : "- URL: (not available)",
        REPO_CONTEXT: context || "(no repository context available)",
      },
      fallbackPrompt,
    );
  }

  /**
   * Build a retry prompt for the agent after a failed attempt.
   * @param {Object} task
   * @param {Object} lastResult
   * @param {number} attemptNumber
   * @returns {string}
   * @private
   */
  _buildRetryPrompt(task, lastResult, attemptNumber) {
    // Check for plan-stuck pattern
    const classification = this._errorDetector.classify(
      lastResult?.output || "",
      lastResult?.error || "",
    );

    if (classification.pattern === "plan_stuck") {
      return this._errorDetector.getPlanStuckRecoveryPrompt(
        task.title,
        lastResult?.output || "",
      );
    }

    if (classification.pattern === "token_overflow") {
      return this._errorDetector.getTokenOverflowRecoveryPrompt(task.title);
    }

    // Session-aware analysis: check for behavioral patterns in recent messages
    try {
      const tracker = getSessionTracker();
      const messages = tracker.getLastMessages(task.id);
      if (messages.length > 0) {
        const analysis = this._errorDetector.analyzeMessageSequence(messages);
        if (analysis.primary) {
          console.log(
            `${TAG} retry using session-aware recovery: ${analysis.primary}`,
          );
          return this._errorDetector.getRecoveryPromptForAnalysis(
            task.title,
            analysis,
            lastResult?.output || "",
          );
        }
      }
    } catch {
      /* best-effort — fall through to default */
    }

    // Default retry prompt
    const fallbackPrompt = [
      `# ERROR RECOVERY — Attempt ${attemptNumber}`,
      ``,
      `Your previous attempt on task "${task.title}" encountered an issue:`,
      "```",
      (lastResult?.error || lastResult?.output || "(unknown error)").slice(
        0,
        3000,
      ),
      "```",
      ``,
      `Error classification: ${classification.pattern} (confidence: ${classification.confidence.toFixed(2)})`,
      ``,
      `Please:`,
      `1. Diagnose what went wrong`,
      `2. Fix the issue`,
      `3. Re-run tests to verify`,
      `4. Commit and push your fixes`,
      ``,
      `Original task description:`,
      task.description || "See task URL for details.",
    ].join("\n");
    return this._resolveAgentPrompt(
      "taskExecutorRetry",
      {
        ATTEMPT_NUMBER: attemptNumber,
        TASK_TITLE: task.title || "Untitled Task",
        LAST_ERROR: (
          lastResult?.error ||
          lastResult?.output ||
          "(unknown error)"
        ).slice(0, 3000),
        CLASSIFICATION_PATTERN: classification.pattern,
        CLASSIFICATION_CONFIDENCE: classification.confidence.toFixed(2),
        TASK_DESCRIPTION: task.description || "See task URL for details.",
      },
      fallbackPrompt,
    );
  }

  /**
   * Build a CONTINUE prompt when the agent went idle (stopped producing events)
   * but has not yet completed the task. This is softer than a retry — it nudges
   * the agent to resume work rather than starting error recovery.
   *
   * @param {Object} task
   * @param {Object} lastResult
   * @param {number} attemptNumber
   * @returns {string}
   * @private
   */
  _buildContinuePrompt(task, lastResult, attemptNumber) {
    // Check session for behavioral patterns to give targeted nudge
    try {
      const tracker = getSessionTracker();
      const messages = tracker.getLastMessages(task.id);
      if (messages.length > 0) {
        const analysis = this._errorDetector.analyzeMessageSequence(messages);
        if (analysis.primary) {
          console.log(
            `${TAG} continue prompt using session analysis: ${analysis.primary}`,
          );
          return this._errorDetector.getRecoveryPromptForAnalysis(
            task.title,
            analysis,
            lastResult?.output || "",
          );
        }
      }
    } catch {
      /* best-effort */
    }

    // Check what progress has been made
    const tracker = getSessionTracker();
    const progress = tracker.getProgressStatus(task.id);

    if (progress.hasCommits) {
      const fallbackPrompt = [
        `# CONTINUE — Verify and Push`,
        ``,
        `You were working on "${task.title}" and appear to have stopped.`,
        `You've made commits — make sure they are pushed:`,
        `1. Run tests to verify your changes`,
        `2. If tests pass, push: git push origin HEAD`,
        `3. If tests fail, fix issues, commit, and push`,
        `4. The task is not done until the push succeeds`,
      ].join("\n");
      return this._resolveAgentPrompt(
        "taskExecutorContinueHasCommits",
        {
          TASK_TITLE: task.title || "Untitled Task",
          TASK_DESCRIPTION: task.description || "",
        },
        fallbackPrompt,
      );
    }

    if (progress.hasEdits) {
      const fallbackPrompt = [
        `# CONTINUE — Commit and Push`,
        ``,
        `You were working on "${task.title}" and appear to have stopped.`,
        `You've made file edits but haven't committed yet:`,
        `1. Review your changes`,
        `2. Run tests: go test ./...  (or relevant test command)`,
        `3. Stage and commit: git add -A && git commit -m "feat(scope): description"`,
        `4. Push: git push origin HEAD`,
      ].join("\n");
      return this._resolveAgentPrompt(
        "taskExecutorContinueHasEdits",
        {
          TASK_TITLE: task.title || "Untitled Task",
          TASK_DESCRIPTION: task.description || "",
        },
        fallbackPrompt,
      );
    }

    const fallbackPrompt = [
      `# CONTINUE — Resume Implementation`,
      ``,
      `You were working on "${task.title}" but stopped without making progress.`,
      `This is autonomous task execution — you must complete the task end-to-end.`,
      ``,
      `DO NOT ask for permission. DO NOT create a plan. Implement NOW:`,
      `1. Read the relevant source files`,
      `2. Make the necessary changes`,
      `3. Run tests to verify`,
      `4. Commit with a conventional commit message`,
      `5. Push to the current branch`,
      ``,
      `Task: ${task.title}`,
      task.description ? `Description: ${task.description}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return this._resolveAgentPrompt(
      "taskExecutorContinueNoProgress",
      {
        TASK_TITLE: task.title || "Untitled Task",
        TASK_DESCRIPTION: task.description || "",
      },
      fallbackPrompt,
    );
  }

  /**
   * Load and cache repo context files (AGENTS.md, copilot-instructions.md).
   * Cached for CONTEXT_CACHE_TTL to avoid re-reading on every task.
   * @returns {string|null}
   * @private
   */
  _getRepoContext() {
    const now = Date.now();
    if (
      this._contextCache &&
      now - this._contextCacheTime < CONTEXT_CACHE_TTL
    ) {
      return this._contextCache;
    }

    const parts = [];
    const contextFiles = [
      { rel: "AGENTS.md", label: "AGENTS.md" },
      { rel: ".github/copilot-instructions.md", label: "Copilot Instructions" },
    ];

    for (const cf of contextFiles) {
      try {
        const fullPath = resolve(this.repoRoot, cf.rel);
        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, "utf8");
          // Truncate to 4000 chars to keep prompt reasonable
          const truncated =
            content.length > 4000
              ? content.slice(0, 4000) + "\n...(truncated)"
              : content;
          parts.push(`### ${cf.label}\n\n${truncated}`);
        }
      } catch {
        // Ignore read errors
      }
    }

    this._contextCache = parts.length > 0 ? parts.join("\n\n---\n\n") : null;
    this._contextCacheTime = now;
    return this._contextCache;
  }

  // ── Result Handling ───────────────────────────────────────────────────────

  /**
   * Handle the result of a task execution — PR creation, status update, notifications.
   * @param {Object} task
   * @param {Object} result - { success, attempts, error, output }
   * @param {string} worktreePath
   * @returns {Promise<void>}
   * @private
   */
  async _handleTaskResult(task, result, worktreePath, execInfo = {}) {
    const taskTitle = (task.title || "").slice(0, 50);
    const tag = `${TAG} task "${taskTitle}"`;
    const baseBranch = resolveTaskBaseBranch(
      task,
      this.branchRouting,
      this.defaultTargetBranch,
    );

    // Fire SessionStop hook
    executeHooks("SessionStop", {
      taskId: task.id || task.task_id,
      taskTitle,
      taskDescription: task.description || task.body || "",
      success: result.success,
      attempts: result.attempts,
      output: (result.output || "").slice(0, 500),
    }).catch(() => {});

    if (result.success) {
      console.log(
        `${tag} completed successfully (${result.attempts} attempt(s))`,
      );

      await this._processBacklogReplenishment(task, result);

      // Use HEAD tracking to determine if agent made NEW commits (not old leftovers)
      const agentMadeNewCommits = execInfo.agentMadeNewCommits === true;
      const hasAnyCommits = this._hasUnpushedCommits(worktreePath, baseBranch);

      // If already completed+PR'd, skip re-processing
      if (this._completedWithPR.has(task.id)) {
        console.log(
          `${tag} already completed with PR — skipping re-processing`,
        );
        try {
          await updateTaskStatus(task.id, "inreview");
        } catch {
          /* best-effort */
        }
        return;
      }

      // Determine effective "has commits" — only TRUE if agent actually made new commits THIS run
      // OR if it's the first time we're seeing any commits on this branch (never PR'd before)
      const hasCommits =
        agentMadeNewCommits ||
        (hasAnyCommits &&
          !this._completedWithPR.has(task.id) &&
          !this._prCreatedForBranch.has(task.id));

      if (!hasCommits && isPlannerTaskData(task)) {
        try {
          const verify = await this._verifyPlannerTaskCompletion(task);
          if (verify.completed) {
            this._noCommitCounts.delete(task.id);
            this._skipUntil.delete(task.id);
            this._saveNoCommitState();
            try {
              recordAgentAttempt(task.id, {
                output: result.output,
                hasCommits: false,
              });
              setInternalStatus(task.id, "done", "task-executor");
              updateInternalTask(task.id, { externalStatus: "done" });
              this._errorDetector.resetTask(task.id);
            } catch {
              /* best-effort */
            }
            try {
              await updateTaskStatus(task.id, "done");
            } catch {
              /* best-effort */
            }
            const sample =
              Array.isArray(verify.sampleTitles) &&
              verify.sampleTitles.length > 0
                ? ` Examples: ${verify.sampleTitles.join(", ")}`
                : "";
            this.sendTelegram?.(
              `✅ Planner task completed: "${task.title}" (${verify.createdCount} new task(s)).${sample}`,
            );
            this.onTaskCompleted?.(task, result);
            return;
          }
          console.warn(
            `${tag} planner task incomplete: no new backlog tasks detected`,
          );
        } catch (verifyErr) {
          console.warn(
            `${tag} planner completion verification failed: ${verifyErr?.message || verifyErr}`,
          );
        }
      }

      if (hasCommits && this.autoCreatePr) {
        // Real work done — reset the no-commit counter
        this._noCommitCounts.delete(task.id);
        this._skipUntil.delete(task.id);
        this._saveNoCommitState();

        // Record success in internal store
        try {
          recordAgentAttempt(task.id, {
            output: result.output,
            hasCommits: true,
          });
          setInternalStatus(task.id, "inreview", "task-executor");
          this._errorDetector.resetTask(task.id);
        } catch {
          /* best-effort */
        }

        // Run TaskComplete blocking validation before PR
        try {
          const hookResult = await executeBlockingHooks("TaskComplete", {
            taskId: task.id || task.task_id,
            taskTitle: task.title,
            taskDescription: task.description || task.body || "",
            worktreePath,
            success: true,
            hasCommits: true,
          });
          if (hookResult?.abort) {
            console.warn(
              `${TAG} TaskComplete hook blocked PR: ${hookResult.reason || "unknown reason"}`,
            );
            this.sendTelegram?.(
              `⚠️ TaskComplete hook blocked PR for "${task.title}": ${hookResult.reason || "hook validation failed"}`,
            );
          }
        } catch (hookErr) {
          console.warn(`${TAG} TaskComplete hook error: ${hookErr.message}`);
        }

        const pr = await this._createPR(task, worktreePath, {
          agentMadeNewCommits,
          baseBranch,
        });
        if (pr) {
          // Mark as completed with PR — prevents re-dispatch
          this._completedWithPR.add(task.id);
          this._prCreatedForBranch.add(task.id);
          try {
            await updateTaskStatus(task.id, "inreview");
          } catch {
            /* best-effort */
          }
          this.sendTelegram?.(
            `✅ Task completed: "${task.title}"\nPR: ${pr.url || pr}`,
          );

          // Fire PostPR hook
          executeHooks("PostPR", {
            taskId: task.id || task.task_id,
            taskTitle: task.title,
            taskDescription: task.description || task.body || "",
            prUrl: pr.url || pr,
            branch: pr.branch,
          }).catch(() => {});

          // Comment on issue with commit details and PR link
          this._commentCommitsOnIssue(task, worktreePath, execInfo, pr).catch(
            () => {
              /* best-effort */
            },
          );

          // Queue for review handoff — reviewer will identify issues, fix, push, wait for merge
          this._queueReviewHandoff(task, worktreePath, pr, execInfo);
        } else {
          // PR creation failed but task has commits — mark as completed anyway to prevent loop
          this._completedWithPR.add(task.id);
          try {
            await updateTaskStatus(task.id, "inreview");
          } catch {
            /* best-effort */
          }
          this.sendTelegram?.(
            `✅ Task completed: "${task.title}" (PR creation failed — manual review needed)`,
          );
        }
      } else if (hasCommits) {
        // Real work done — reset the no-commit counter
        this._noCommitCounts.delete(task.id);
        this._skipUntil.delete(task.id);
        this._saveNoCommitState();

        // Record success in internal store
        try {
          recordAgentAttempt(task.id, {
            output: result.output,
            hasCommits: true,
          });
          setInternalStatus(task.id, "inreview", "task-executor");
          this._errorDetector.resetTask(task.id);
        } catch {
          /* best-effort */
        }

        try {
          await updateTaskStatus(task.id, "inreview");
        } catch {
          /* best-effort */
        }
        this.sendTelegram?.(
          `✅ Task completed: "${task.title}" (auto-PR disabled)`,
        );
      } else {
        // No commits — agent completed without making changes.
        // This is NOT a real completion. Apply anti-thrash protection.
        const prevCount = this._noCommitCounts.get(task.id) || 0;
        const noCommitCount = prevCount + 1;
        this._noCommitCounts.set(task.id, noCommitCount);
        this._saveNoCommitState();

        // Only force fresh thread after 2+ consecutive no-commit completions.
        // First no-commit may be an accidental pause — allow thread resume.
        const noCommitClassificationForThread = this._errorDetector.classify(
          result.output || "",
        );
        const shouldForceNewOnNoCommit =
          noCommitCount >= 2 ||
          noCommitClassificationForThread.pattern === "plan_stuck";
        if (shouldForceNewOnNoCommit) {
          try {
            forceNewThread(
              task.id,
              `no-commit #${noCommitCount}${noCommitClassificationForThread.pattern === "plan_stuck" ? " (plan_stuck)" : ""}`,
            );
          } catch {
            /* ok */
          }
        } else {
          console.log(
            `${TAG} no-commit #${noCommitCount} for "${task.title}" — keeping thread for resume attempt`,
          );
        }

        // Record no-commit attempt in internal store
        try {
          recordAgentAttempt(task.id, {
            output: result.output,
            hasCommits: false,
          });
          if (noCommitClassificationForThread.pattern === "plan_stuck") {
            recordErrorPattern(task.id, "plan_stuck");
          }
        } catch {
          /* best-effort */
        }

        // Escalating cooldown: 15min → 30min → 1h → 2h (capped)
        const cooldownMs = Math.min(
          NO_COMMIT_COOLDOWN_BASE_MS * Math.pow(2, noCommitCount - 1),
          NO_COMMIT_MAX_COOLDOWN_MS,
        );
        const cooldownMin = Math.round(cooldownMs / 60_000);
        this._skipUntil.set(task.id, Date.now() + cooldownMs);
        this._taskCooldowns.set(task.id, Date.now());

        console.warn(
          `${tag} completed but no commits found (attempt ${noCommitCount}/${MAX_NO_COMMIT_ATTEMPTS}, cooldown ${cooldownMin}m)`,
        );

        // Set back to todo — NOT inreview (nothing to review)
        try {
          await updateTaskStatus(task.id, "todo");
        } catch {
          /* best-effort */
        }

        if (noCommitCount >= MAX_NO_COMMIT_ATTEMPTS) {
          console.warn(
            `${tag} task "${task.title}" blocked — ${MAX_NO_COMMIT_ATTEMPTS} consecutive no-commit completions. Skipping until executor restart.`,
          );
          this.sendTelegram?.(
            `🚫 Task blocked (${MAX_NO_COMMIT_ATTEMPTS}x no-commit): "${task.title}" — will not retry until executor restart`,
          );
        } else {
          this.sendTelegram?.(
            `⚠️ Task completed but no commits (${noCommitCount}/${MAX_NO_COMMIT_ATTEMPTS}): "${task.title}" — cooldown ${cooldownMin}m`,
          );
        }
      }

      this.onTaskCompleted?.(task, result);
    } else {
      console.warn(
        `${tag} failed after ${result.attempts} attempt(s): ${result.error}`,
      );
      this._taskCooldowns.set(task.id, Date.now());

      // Classify the error FIRST to decide whether to force a new thread
      const classification = this._errorDetector.classify(
        result.output || "",
        result.error || "",
      );
      const recovery = this._errorDetector.recordError(task.id, classification);

      // Only force fresh thread for errors that corrupt thread state or
      // indicate irrecoverable session issues. For build/git/plan errors,
      // keep the same thread so the agent can fix its own mistakes.
      const THREAD_KILLING_ERRORS = new Set([
        "rate_limit",
        "api_error",
        "token_overflow",
        "session_expired",
      ]);
      const shouldForceNew =
        THREAD_KILLING_ERRORS.has(classification.pattern) ||
        recovery.errorCount >= 2; // 2+ consecutive errors → always fresh thread
      if (shouldForceNew) {
        try {
          forceNewThread(
            task.id,
            `${classification.pattern} (count=${recovery.errorCount}): ${(result.error || "").slice(0, 80)}`,
          );
        } catch {
          /* ok */
        }
      } else {
        console.log(
          `${TAG} task "${task.title || task.id}" failed (${classification.pattern}, count=${recovery.errorCount}) — keeping thread for resume`,
        );
      }

      // Record in internal store
      try {
        recordAgentAttempt(task.id, {
          output: result.output,
          error: result.error,
          hasCommits: false,
        });
        recordErrorPattern(task.id, classification.pattern);
      } catch {
        /* best-effort */
      }

      // If plan-stuck, use recovery prompt instead of generic retry
      if (
        classification.pattern === "plan_stuck" &&
        recovery.action === "retry_with_prompt"
      ) {
        console.log(
          `${TAG} plan-stuck detected — will use recovery prompt on next attempt`,
        );
      }

      // If rate limiting, check executor pause
      if (this._errorDetector.shouldPauseExecutor()) {
        console.warn(
          `${TAG} too many rate limits — pausing executor for 5 minutes`,
        );
        this.pauseFor(5 * 60 * 1000, "rate-limit");
      }

      try {
        await updateTaskStatus(task.id, "todo");
      } catch {
        /* best-effort */
      }
      this.sendTelegram?.(
        `❌ Task failed: "${task.title}" — ${(result.error || "").slice(0, 200)}`,
      );
      this.onTaskFailed?.(task, result);
    }
  }

  async _processBacklogReplenishment(task, result) {
    if (!this._backlogReplenishment.enabled) return;
    if (isPlannerTaskData(task)) return;

    const candidatesRaw = extractBacklogCandidates(result?.output || "");
    if (!Array.isArray(candidatesRaw) || candidatesRaw.length === 0) {
      console.warn(
        `${TAG} backlog replenishment: no structured candidates found for ${task.id}`,
      );
      return;
    }

    const minTasks = this._backlogReplenishment.minNewTasks;
    const maxTasks = this._backlogReplenishment.maxNewTasks;
    const existing = getAllInternalTasks();
    const existingTitleSet = new Set(
      existing
        .map((item) => String(item?.title || "").trim().toLowerCase())
        .filter(Boolean),
    );

    const normalized = [];
    for (const candidate of candidatesRaw) {
      if (!candidate || typeof candidate !== "object") continue;
      const title = String(candidate.title || "").trim();
      if (title.length < 10) continue;
      const lowerTitle = title.toLowerCase();
      if (existingTitleSet.has(lowerTitle)) continue;

      const priority = normalizePriority(candidate.priority);
      if (this._backlogReplenishment.requirePriority && !candidate.priority) {
        continue;
      }
      const description = String(candidate.description || "").trim();
      const moduleHint = String(candidate.module || "").trim();
      const rationale = String(candidate.rationale || "").trim();
      normalized.push({
        title,
        description,
        priority,
        moduleHint,
        rationale,
      });
      existingTitleSet.add(lowerTitle);
    }

    normalized.sort(
      (a, b) => (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0),
    );

    const selected = normalized.slice(0, maxTasks);
    if (selected.length === 0) return;

    const created = [];
    for (const candidate of selected) {
      const id = randomUUID();
      const modulePrefix = candidate.moduleHint
        ? `[${candidate.moduleHint}] `
        : "";
      const enrichedDescription = [
        candidate.description,
        candidate.rationale ? `Why this matters: ${candidate.rationale}` : "",
        `Source task: ${task.id || task.task_id}`,
        `Requirements profile: ${this._projectRequirements.profile}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const createdTask = addInternalTask({
        id,
        title: `${modulePrefix}${candidate.title}`,
        description: enrichedDescription,
        status: "todo",
        priority: candidate.priority,
        projectId: task.projectId || this._resolvedProjectId || this.projectId || "internal",
        externalStatus: "todo",
        meta: {
          generatedByTaskId: task.id || task.task_id,
          generatedByTitle: task.title || "",
          generatedAt: new Date().toISOString(),
          generatedByMode: "experimental-backlog-replenishment",
          moduleHint: candidate.moduleHint || null,
          rationale: candidate.rationale || null,
        },
      });
      if (createdTask) {
        created.push(createdTask);
      }
    }

    if (created.length < minTasks) {
      console.warn(
        `${TAG} backlog replenishment created ${created.length}/${minTasks} minimum task(s) for ${task.id}`,
      );
    }
    if (created.length > 0) {
      this.sendTelegram?.(
        `♻️ Backlog replenished from "${task.title}": created ${created.length} prioritized follow-up task(s).`,
      );
    }
  }

  // ── Review Handoff ────────────────────────────────────────────────────────

  /**
   * Queue a task for review handoff after successful PR creation.
   * Collects diff stats + session context and passes to the review agent.
   *
   * @param {Object} task
   * @param {string} worktreePath
  /**
   * Determine if a task that reported "success" but made no commits
   * should be automatically resumed with a CONTINUE prompt.
   *
   * Returns true when the session analysis suggests the agent stopped
   * prematurely (false_completion, plan_stuck, analysis_paralysis, etc.)
   *
   * @param {string} taskId
   * @param {string} taskTitle
   * @param {Object} sessionAnalysis - from analyzeMessageSequence()
   * @param {Array} sessionMessages - raw messages
   * @returns {boolean}
   * @private
   */
  _shouldAutoResume(taskId, taskTitle, sessionAnalysis, sessionMessages) {
    // Don't auto-resume if we've already auto-resumed too many times
    const continueCount = this._idleContinueCounts.get(taskId) || 0;
    if (continueCount >= 3) {
      console.log(
        `${TAG} _shouldAutoResume: "${taskTitle}" — skipping, already ${continueCount} continues`,
      );
      return false;
    }

    // Auto-resume for detected behavioral patterns
    if (sessionAnalysis?.primary) {
      const autoResumePatterns = [
        "false_completion",
        "plan_stuck",
        "analysis_paralysis",
        "needs_clarification",
      ];
      if (autoResumePatterns.includes(sessionAnalysis.primary)) {
        console.log(
          `${TAG} _shouldAutoResume: "${taskTitle}" — YES (pattern: ${sessionAnalysis.primary})`,
        );
        this._idleContinueCounts.set(taskId, continueCount + 1);
        return true;
      }
    }

    // Auto-resume if agent had very few events (< 5) — likely stopped immediately
    if (sessionMessages && sessionMessages.length < 3) {
      console.log(
        `${TAG} _shouldAutoResume: "${taskTitle}" — YES (only ${sessionMessages.length} messages)`,
      );
      this._idleContinueCounts.set(taskId, continueCount + 1);
      return true;
    }

    // Check progress status from session tracker
    try {
      const tracker = getSessionTracker();
      const progress = tracker.getProgressStatus(taskId);
      if (progress.totalEvents < 5 && progress.elapsedMs < 5 * 60_000) {
        // Agent ran for < 5 min with < 5 events — clearly didn't do anything
        console.log(
          `${TAG} _shouldAutoResume: "${taskTitle}" — YES (${progress.totalEvents} events in ${Math.round(progress.elapsedMs / 1000)}s)`,
        );
        this._idleContinueCounts.set(taskId, continueCount + 1);
        return true;
      }
    } catch {
      /* best-effort */
    }

    return false;
  }

  /**
   * Queue a completed task for review handoff.
   * @param {Object} task
   * @param {string} worktreePath
   * @param {Object} pr - { url, branch, prNumber }
   * @param {Object} execInfo - { sessionSummary, sessionAnalysis, ... }
   * @private
   */
  _queueReviewHandoff(task, worktreePath, pr, execInfo = {}) {
    if (!this._reviewAgent) {
      console.log(
        `${TAG} no review agent configured — skipping review handoff`,
      );
      return;
    }

    try {
      // Collect diff stats
      let diffStats = "";
      try {
        diffStats = getCompactDiffSummary(worktreePath);
      } catch (err) {
        diffStats = `(error: ${err.message})`;
      }

      // Get recent commits
      let commitLog = "";
      try {
        commitLog = getRecentCommits(worktreePath, 10).join("\n");
      } catch {
        commitLog = "(no commits)";
      }

      // Queue the review
      this._reviewAgent.queueReview({
        id: task.id,
        title: task.title,
        branchName: task.branchName || pr.branch,
        prUrl: pr.url,
        description: task.description,
        worktreePath,
        sessionMessages: execInfo.sessionSummary || "",
        diffStats,
      });

      console.log(
        `${TAG} queued review handoff for "${task.title}" (PR: ${pr.url})`,
      );
    } catch (err) {
      console.warn(`${TAG} review handoff error: ${err.message}`);
    }
  }

  /**
   * Set the review agent instance (called by monitor.mjs during initialization).
   * @param {import("./review-agent.mjs").ReviewAgent} agent
   */
  setReviewAgent(agent) {
    this._reviewAgent = agent;
    console.log(`${TAG} review agent connected`);
  }

  // ── Git Helpers ───────────────────────────────────────────────────────────

  /**
   * Check whether a worktree has unpushed commits.
   * @param {string} worktreePath
   * @returns {boolean}
   * @private
   */
  _hasUnpushedCommits(worktreePath, baseBranch = "main") {
    try {
      const baseInfo = normalizeBaseBranch(baseBranch, "origin");
      // Method 1: Check vs upstream tracking branch
      const result = spawnSync("git", ["log", "@{u}..HEAD", "--oneline"], {
        cwd: worktreePath,
        encoding: "utf8",
        timeout: 10_000,
      });
      if (result.status === 0 && (result.stdout || "").trim().length > 0) {
        return true;
      }

      // Method 2: Check vs base remote ref (fetch first to be current)
      try {
        spawnSync("git", ["fetch", "origin", baseInfo.branch, "--quiet"], {
          cwd: worktreePath,
          encoding: "utf8",
          timeout: 15_000,
        });
      } catch {
        /* best-effort */
      }

      const diff = spawnSync(
        "git",
        [`log`, `${baseInfo.remoteRef}..HEAD`, "--oneline"],
        {
          cwd: worktreePath,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      if (diff.status === 0 && (diff.stdout || "").trim().length > 0) {
        return true;
      }

      // Method 3: Fallback — check if there are ANY commits not in base
      const diff2 = spawnSync(
        "git",
        [`log`, `${baseInfo.branch}..HEAD`, "--oneline"],
        {
          cwd: worktreePath,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      return diff2.status === 0 && (diff2.stdout || "").trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Push the current branch to origin. Must be called before creating a PR.
   * Handles both fresh push (--set-upstream) and subsequent pushes.
   * Skips pre-push hooks to avoid blocking on lint/test (agent already validated).
   * @param {string} worktreePath
   * @param {string} branch
   * @returns {{ success: boolean, error?: string }}
   * @private
   */
  _pushBranch(worktreePath, branch, baseBranch = "main") {
    try {
      const baseInfo = normalizeBaseBranch(baseBranch, "origin");
      // Execute PrePush hook (blocking — can abort push)
      // Note: executeBlockingHooks is async but _pushBranch is sync.
      // We fire-and-forget here since blocking would require refactoring to async.
      executeHooks("PrePush", {
        worktreePath,
        branch,
      }).catch(() => {});

      // First rebase onto upstream main to keep agent's work and stay up to date.
      // We use rebase instead of merge to avoid polluting the branch with merge commits
      // that can wipe out agent work (as --strategy-option=theirs did before).
      try {
        spawnSync("git", ["fetch", "origin", baseInfo.branch, "--quiet"], {
          cwd: worktreePath,
          encoding: "utf8",
          timeout: 30_000,
        });
        // Try rebase — this keeps agent's commits on top of latest main
        const rebaseResult = spawnSync("git", ["rebase", baseInfo.remoteRef], {
          cwd: worktreePath,
          encoding: "utf8",
          timeout: 60_000,
        });
        if (rebaseResult.status !== 0) {
          // Rebase failed (conflicts) — abort and push as-is
          console.warn(
            `${TAG} rebase failed during upstream sync — aborting rebase, will push as-is`,
          );
          spawnSync("git", ["rebase", "--abort"], {
            cwd: worktreePath,
            encoding: "utf8",
            timeout: 10_000,
          });
        }
      } catch {
        /* best-effort upstream rebase */
      }

      const safety = evaluateBranchSafetyForPush(worktreePath, {
        baseBranch,
        remote: "origin",
      });
      if (!safety.safe) {
        const reason = safety.reason || "safety check failed";
        console.error(`${TAG} refusing to push ${branch}: ${reason}`);
        return { success: false, error: reason };
      }

      // Try a normal push first. Only fall back to --force-with-lease for
      // non-fast-forward style failures.
      let result = spawnSync(
        "git",
        ["push", "--set-upstream", "origin", branch, "--no-verify"],
        {
          cwd: worktreePath,
          encoding: "utf8",
          timeout: 120_000, // 2 min — push can be slow
          env: { ...process.env },
        },
      );
      if (result.status !== 0) {
        const initialErr = (result.stderr || "").trim();
        const canForceRetry =
          /non-fast-forward|fetch first|failed to push some refs|stale info|rejected/i.test(
            initialErr,
          );
        if (canForceRetry) {
          console.warn(
            `${TAG} normal push rejected for ${branch}; retrying with --force-with-lease`,
          );
          result = spawnSync(
            "git",
            [
              "push",
              "--set-upstream",
              "--force-with-lease",
              "origin",
              branch,
              "--no-verify",
            ],
            {
              cwd: worktreePath,
              encoding: "utf8",
              timeout: 120_000,
              env: { ...process.env },
            },
          );
        }
      }

      if (result.status === 0) {
        console.log(`${TAG} pushed branch ${branch} to origin`);
        return { success: true };
      } else {
        const stderr = (result.stderr || "").trim();
        console.warn(`${TAG} push failed for ${branch}: ${stderr}`);
        return { success: false, error: stderr };
      }
    } catch (err) {
      console.warn(`${TAG} push error for ${branch}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Enable GitHub auto-merge on a PR so it merges automatically when CI passes.
   * When direct merge succeeds (no required checks), also closes the linked issue.
   * @param {string|number} prNumber
   * @param {string} worktreePath
   * @param {Object} [task] Optional task — used to close linked issue on direct merge.
   * @private
   */
  _enableAutoMerge(prNumber, worktreePath, task = null) {
    try {
      const result = spawnSync(
        "gh",
        ["pr", "merge", String(prNumber), "--auto", "--squash"],
        {
          cwd: worktreePath,
          encoding: "utf8",
          timeout: 15_000,
          env: { ...process.env },
        },
      );
      if (result.status === 0) {
        console.log(`${TAG} auto-merge enabled for PR #${prNumber}`);
        return;
      }
      const stderr = (result.stderr || "").trim();
      // "clean status" means no required status checks — auto-merge not applicable.
      // Fall back to direct merge (squash) so the PR gets merged immediately.
      if (
        stderr.includes("clean status") ||
        stderr.includes("not in the correct state")
      ) {
        console.log(
          `${TAG} auto-merge not available for PR #${prNumber}, attempting direct merge`,
        );
        const directResult = spawnSync(
          "gh",
          ["pr", "merge", String(prNumber), "--squash"],
          {
            cwd: worktreePath,
            encoding: "utf8",
            timeout: 30_000,
            env: { ...process.env },
          },
        );
        if (directResult.status === 0) {
          console.log(`${TAG} ✅ directly merged PR #${prNumber}`);
          // PR merged → close the linked GitHub issue
          if (task) {
            this._closeIssueAfterMerge(task, prNumber).catch(() => {
              /* best-effort */
            });
          }
        } else {
          const errMsg = (directResult.stderr || "").trim();
          console.warn(
            `${TAG} direct merge also failed for PR #${prNumber}: ${errMsg}`,
          );
          console.log(
            `${TAG} PR #${prNumber} will be picked up by pr-cleanup-daemon`,
          );
        }
      } else {
        console.warn(`${TAG} auto-merge failed for PR #${prNumber}: ${stderr}`);
      }
    } catch (err) {
      console.warn(`${TAG} auto-merge error: ${err.message}`);
    }
  }

  /**
   * Post a comment on the linked GitHub issue with commit details and PR info.
   * @param {Object} task
   * @param {string} worktreePath
   * @param {Object} execInfo  Contains preExecHead, postExecHead
   * @param {Object} pr        Contains url, branch, prNumber
   * @returns {Promise<void>}
   * @private
   */
  async _commentCommitsOnIssue(task, worktreePath, execInfo, pr) {
    if (!isGitHubBackend(task)) return;
    const issueNumber = getGitHubIssueNumber(task);
    if (!issueNumber) return;

    const { preExecHead, postExecHead } = execInfo || {};
    const commits = getCommitDetails(
      worktreePath,
      preExecHead,
      postExecHead || "HEAD",
    );
    const diffStat = getChangedFilesSummary(
      worktreePath,
      preExecHead,
      postExecHead || "HEAD",
    );

    const lines = [
      `## 📝 Agent Completed — Commits & PR`,
      ``,
      `**PR:** ${pr.url || `#${pr.prNumber}`}`,
      `**Branch:** \`${pr.branch}\``,
      `**Completed:** ${new Date().toISOString()}`,
      ``,
    ];

    if (commits.length > 0) {
      lines.push(`### Commits (${commits.length})`, ``);
      for (const c of commits.slice(0, 30)) {
        lines.push(`- \`${c.sha.slice(0, 8)}\` ${c.title}`);
        if (c.files.length > 0 && c.files.length <= 15) {
          for (const f of c.files) {
            lines.push(`  - ${f}`);
          }
        } else if (c.files.length > 15) {
          lines.push(`  - _${c.files.length} files changed_`);
        }
      }
      if (commits.length > 30) {
        lines.push(``, `_...and ${commits.length - 30} more commits_`);
      }
    }

    if (diffStat) {
      lines.push(``, `### Diff Summary`, `\`\`\``, diffStat, `\`\`\``);
    }

    await addComment(issueNumber, lines.join("\n"));
  }

  /**
   * Close the linked GitHub issue after a PR is merged.
   * Posts a completion comment and updates the task status to done.
   * @param {Object} task
   * @param {string|number} prNumber
   * @returns {Promise<void>}
   * @private
   */
  async _closeIssueAfterMerge(task, prNumber) {
    if (!isGitHubBackend(task)) return;
    const issueNumber = getGitHubIssueNumber(task);
    if (!issueNumber) return;

    // Comment on issue first, then close via status update
    await commentOnIssue(
      task,
      [
        `## ✅ Issue Resolved`,
        ``,
        `PR #${prNumber} has been merged. Closing this issue.`,
        ``,
        `| Field | Value |`,
        `|-------|-------|`,
        `| **Merged At** | ${new Date().toISOString()} |`,
        `| **PR** | #${prNumber} |`,
      ].join("\n"),
    );

    try {
      if (task?.id) {
        setInternalStatus(task.id, "done", "task-executor");
        updateInternalTask(task.id, { externalStatus: "done" });
      }
      await updateTaskStatus(issueNumber, "done");
      console.log(
        `${TAG} closed issue #${issueNumber} after PR #${prNumber} merge`,
      );
    } catch (err) {
      console.warn(
        `${TAG} failed to close issue #${issueNumber}: ${err.message}`,
      );
    }
  }

  /**
   * Create a pull request for the completed task using the gh CLI.
   * @param {Object} task
   * @param {string} worktreePath
   * @returns {Promise<{url: string, branch: string}|null>}
   * @private
   */
  async _createPR(task, worktreePath, opts = {}) {
    const { agentMadeNewCommits = false } = opts;
    try {
      const resolvedBase = normalizeBranchName(opts.baseBranch)
        ? opts.baseBranch
        : this.defaultTargetBranch;
      const baseInfo = normalizeBaseBranch(
        resolvedBase || "main",
        "origin",
      );
      const branch =
        task.branchName ||
        spawnSync("git", ["branch", "--show-current"], {
          cwd: worktreePath,
          encoding: "utf8",
          timeout: 5000,
        }).stdout?.trim();

      if (!branch) {
        console.warn(`${TAG} cannot create PR — no branch name detected`);
        return null;
      }

      // Fire PrePR hook
      try {
        const prHookResult = await executeBlockingHooks("PrePR", {
          taskId: task.id || task.task_id,
          taskTitle: task.title,
          taskDescription: task.description || task.body || "",
          branch,
          worktreePath,
        });
        if (prHookResult?.abort) {
          console.warn(
            `${TAG} PrePR hook blocked PR creation: ${prHookResult.reason || "unknown"}`,
          );
          return null;
        }
      } catch (hookErr) {
        console.warn(`${TAG} PrePR hook error: ${hookErr.message}`);
      }

      const safety = evaluateBranchSafetyForPush(worktreePath, {
        baseBranch: baseInfo.branch,
        remote: "origin",
      });
      if (!safety.safe) {
        const reason = safety.reason || "unsafe branch diff";
        console.error(
          `${TAG} branch safety guard blocked ${branch}: ${reason}`,
        );
        this.sendTelegram?.(
          `🚨 Branch safety guard blocked push/PR for ${branch}: ${reason}`,
        );
        const err = new Error(
          `Branch safety guard blocked ${branch}: ${reason}`,
        );
        err.name = "BranchSafetyError";
        throw err;
      }

      // ── Step 0: Check if PR already exists for this branch ─────────────
      // This prevents duplicate PRs when the same task is re-dispatched
      let existingPrUrl = null;
      let existingPrNumber = null;
      try {
        const prList = spawnSync(
          "gh",
          [
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            "all",
            "--json",
            "number,url,state",
            "--limit",
            "5",
          ],
          {
            cwd: worktreePath,
            encoding: "utf8",
            timeout: 10_000,
            env: { ...process.env },
          },
        );
        if (prList.status === 0) {
          const prs = JSON.parse(prList.stdout || "[]");
          // Prefer open PR, fall back to most recent merged
          const openPr = prs.find((p) => p.state === "OPEN");
          const mergedPr = prs.find((p) => p.state === "MERGED");
          const existing = openPr || mergedPr;
          if (existing) {
            existingPrUrl = existing.url;
            existingPrNumber = String(existing.number);
            if (mergedPr && !openPr) {
              if (!agentMadeNewCommits) {
                // PR already merged and agent made no new commits — skip
                console.log(
                  `${TAG} PR already merged for branch ${branch}: #${existingPrNumber} (no new commits)`,
                );
                return {
                  url: existingPrUrl,
                  branch,
                  prNumber: existingPrNumber,
                };
              }
              // PR was merged but agent made NEW commits — need a new PR
              console.log(
                `${TAG} PR #${existingPrNumber} was merged but agent made new commits — creating new PR`,
              );
            }
            if (openPr) {
              // Open PR exists — just push latest commits and enable auto-merge
              console.log(
                `${TAG} Open PR #${existingPrNumber} already exists for branch ${branch}`,
              );
              this._pushBranch(worktreePath, branch, baseInfo.branch);
              this._enableAutoMerge(existingPrNumber, worktreePath, task);
              return { url: existingPrUrl, branch, prNumber: existingPrNumber };
            }
          }
        }
      } catch {
        /* best-effort — continue to create PR */
      }

      // ── Step 1: Push branch to origin ──────────────────────────────────
      const pushResult = this._pushBranch(
        worktreePath,
        branch,
        baseInfo.branch,
      );
      if (!pushResult.success) {
        console.warn(
          `${TAG} cannot create PR — push failed: ${pushResult.error}`,
        );
        // Still try to create PR in case agent already pushed
      }

      // ── Step 1.5: Verify branch actually has a diff vs base ────────────
      // If the branch is identical to base (0 file changes), skip PR creation.
      // This prevents empty PRs from being created when merge/rebase wiped changes.
      try {
        const diffResult = spawnSync(
          "git",
          ["diff", "--name-only", `${baseInfo.remoteRef}...HEAD`],
          { cwd: worktreePath, encoding: "utf8", timeout: 15_000 },
        );
        const changedFiles = (diffResult.stdout || "").trim();
        if (diffResult.status === 0 && changedFiles.length === 0) {
          console.warn(
            `${TAG} branch ${branch} has 0 file changes vs ${baseInfo.branch} — skipping PR creation (would be empty)`,
          );
          return null;
        }
        const fileCount = changedFiles.split("\n").filter(Boolean).length;
        console.log(
          `${TAG} branch ${branch} has ${fileCount} changed file(s) vs ${baseInfo.branch}`,
        );
      } catch {
        // If diff check fails, continue with PR creation anyway
      }

      // ── Step 2: Create the PR ──────────────────────────────────────────
      const title = task.title;
      const kanbanBackend = String(
        task.backend || task.externalBackend || getKanbanBackendName(),
      ).toLowerCase();
      const githubIssueNumber =
        kanbanBackend === "github" ? getGitHubIssueNumber(task) : null;
      const githubIssueUrl =
        task.meta?.task_url ||
        task.taskUrl ||
        task.meta?.url ||
        (githubIssueNumber && this.repoSlug
          ? `https://github.com/${this.repoSlug}/issues/${githubIssueNumber}`
          : null);
      const body = [
        `## Summary`,
        task.description
          ? task.description.slice(0, 2000)
          : "Automated task completion.",
        ``,
        `## Task Reference`,
        `- Task ID: \`${task.id}\``,
        githubIssueNumber ? `- GitHub Issue: #${githubIssueNumber}` : "",
        githubIssueUrl ? `- Task URL: ${githubIssueUrl}` : "",
        ``,
        `## Executor`,
        `- Mode: internal (task-executor)`,
        `- SDK: ${getPoolSdkName()}`,
        `- Attempts: ${task._executionResult?.attempts || "N/A"}`,
        githubIssueNumber ? `Closes #${githubIssueNumber}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const result = spawnSync(
        "gh",
        [
          "pr",
          "create",
          "--title",
          title,
          "--body",
          body,
          "--head",
          branch,
          "--base",
          baseInfo.branch,
        ],
        {
          cwd: worktreePath,
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env },
        },
      );

      let prUrl = null;
      let prNumber = null;

      if (result.status === 0) {
        prUrl = (result.stdout || "").trim();
        console.log(`${TAG} PR created: ${prUrl}`);
        // Extract PR number from URL (e.g., https://github.com/owner/repo/pull/123)
        const prMatch = prUrl.match(/\/pull\/(\d+)/);
        prNumber = prMatch ? prMatch[1] : null;
      } else {
        const stderr = (result.stderr || "").trim();
        if (stderr.includes("already exists")) {
          console.log(`${TAG} PR already exists for ${branch}`);
          // Try to get the existing PR number
          try {
            const prList = spawnSync(
              "gh",
              [
                "pr",
                "list",
                "--head",
                branch,
                "--json",
                "number,url",
                "--limit",
                "1",
              ],
              {
                cwd: worktreePath,
                encoding: "utf8",
                timeout: 10_000,
                env: { ...process.env },
              },
            );
            if (prList.status === 0) {
              const prs = JSON.parse(prList.stdout || "[]");
              if (prs.length > 0) {
                prUrl = prs[0].url;
                prNumber = String(prs[0].number);
              }
            }
          } catch {
            /* best-effort */
          }
          prUrl = prUrl || "(existing)";
        } else {
          console.warn(`${TAG} PR creation failed: ${stderr}`);
          return null;
        }
      }

      // ── Step 3: Enable auto-merge ──────────────────────────────────────
      if (prNumber) {
        this._enableAutoMerge(prNumber, worktreePath, task);
      }

      return { url: prUrl, branch, prNumber };
    } catch (err) {
      console.warn(`${TAG} PR creation error: ${err.message}`);
      return null;
    }
  }
}

// ── Singleton & Module Exports ──────────────────────────────────────────────

/** @type {TaskExecutor|null} */
let _instance = null;

/**
 * Get or create the singleton TaskExecutor.
 * @param {TaskExecutorOptions} [opts]
 * @returns {TaskExecutor}
 */
export function getTaskExecutor(opts) {
  if (!_instance) {
    _instance = new TaskExecutor(opts || loadExecutorOptionsFromConfig());
  }
  return _instance;
}

/**
 * Load executor options from config/env.
 * @returns {TaskExecutorOptions}
 */
export function loadExecutorOptionsFromConfig() {
  let config;
  try {
    config = loadConfig();
  } catch {
    config = {};
  }

  const envMode = (process.env.EXECUTOR_MODE || "").toLowerCase();
  const configExec = config.internalExecutor || config.taskExecutor || {};
  const configReq = config.projectRequirements || configExec.projectRequirements || {};
  const reviewAgentRaw = process.env.INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED;
  const reviewAgentEnabled =
    reviewAgentRaw !== undefined && String(reviewAgentRaw).trim() !== ""
      ? !["0", "false", "no", "off"].includes(
          String(reviewAgentRaw).trim().toLowerCase(),
        )
      : configExec.reviewAgentEnabled !== false;

  return {
    mode: envMode || configExec.mode || "internal",
    maxParallel: Number(
      process.env.INTERNAL_EXECUTOR_PARALLEL || configExec.maxParallel || 3,
    ),
    baseBranchParallelLimit: Number(
      process.env.INTERNAL_EXECUTOR_BASE_BRANCH_PARALLEL ||
        configExec.baseBranchParallelLimit ||
        0,
    ),
    pollIntervalMs: Number(
      process.env.INTERNAL_EXECUTOR_POLL_MS ||
        configExec.pollIntervalMs ||
        30_000,
    ),
    sdk: process.env.INTERNAL_EXECUTOR_SDK || configExec.sdk || "auto",
    taskTimeoutMs: Number(
      process.env.INTERNAL_EXECUTOR_TIMEOUT_MS ||
        configExec.taskTimeoutMs ||
        90 * 60 * 1000,
    ),
    maxRetries: Number(
      process.env.INTERNAL_EXECUTOR_MAX_RETRIES || configExec.maxRetries || 2,
    ),
    autoCreatePr: configExec.autoCreatePr !== false,
    projectId:
      process.env.INTERNAL_EXECUTOR_PROJECT_ID || configExec.projectId || null,
    reviewAgentEnabled,
    reviewMaxConcurrent: Number(
      process.env.INTERNAL_EXECUTOR_REVIEW_MAX_CONCURRENT ||
        configExec.reviewMaxConcurrent ||
        2,
    ),
    reviewTimeoutMs: Number(
      process.env.INTERNAL_EXECUTOR_REVIEW_TIMEOUT_MS ||
        configExec.reviewTimeoutMs ||
        300000,
    ),
    taskClaimOwnerStaleTtlMs: Number(
      process.env.TASK_CLAIM_OWNER_STALE_TTL_MS ||
        configExec.taskClaimOwnerStaleTtlMs ||
        10 * 60 * 1000,
    ),
    taskClaimRenewIntervalMs: Number(
      process.env.TASK_CLAIM_RENEW_INTERVAL_MS ||
        configExec.taskClaimRenewIntervalMs ||
        5 * 60 * 1000,
    ),
    backlogReplenishment: {
      enabled:
        ["1", "true", "yes", "on"].includes(
          String(process.env.INTERNAL_EXECUTOR_REPLENISH_ENABLED || "")
            .trim()
            .toLowerCase(),
        ) || configExec.backlogReplenishment?.enabled === true,
      minNewTasks: Number(
        process.env.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS ||
          configExec.backlogReplenishment?.minNewTasks ||
          1,
      ),
      maxNewTasks: Number(
        process.env.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS ||
          configExec.backlogReplenishment?.maxNewTasks ||
          2,
      ),
      requirePriority:
        process.env.INTERNAL_EXECUTOR_REPLENISH_REQUIRE_PRIORITY === undefined
          ? configExec.backlogReplenishment?.requirePriority !== false
          : !["0", "false", "no", "off"].includes(
              String(process.env.INTERNAL_EXECUTOR_REPLENISH_REQUIRE_PRIORITY)
                .trim()
                .toLowerCase(),
            ),
    },
    projectRequirements: {
      profile:
        process.env.PROJECT_REQUIREMENTS_PROFILE || configReq.profile || "feature",
      notes:
        process.env.PROJECT_REQUIREMENTS_NOTES || configReq.notes || "",
    },
    repoRoot: config.repoRoot || process.cwd(),
    repoSlug: config.repoSlug || "",
    branchRouting: config.branchRouting || null,
    defaultTargetBranch:
      config.branchRouting?.defaultBranch ||
      process.env.VK_TARGET_BRANCH ||
      "origin/main",
    agentPrompts: config.agentPrompts || {},
  };
}

/**
 * Check whether internal executor mode is enabled.
 * @returns {boolean}
 */
export function isInternalExecutorEnabled() {
  const mode = (process.env.EXECUTOR_MODE || "").toLowerCase();
  if (DISABLED_MODES.has(mode)) return false;
  if (mode === "internal" || mode === "hybrid") return true;
  try {
    const config = loadConfig();
    const configMode = (
      config.internalExecutor?.mode ||
      config.taskExecutor?.mode ||
      ""
    ).toLowerCase();
    if (DISABLED_MODES.has(configMode)) return false;
    return configMode === "internal" || configMode === "hybrid";
  } catch {
    return false;
  }
}

/** Valid executor modes — "disabled"/"none"/"monitor-only" stop all task execution. */
const VALID_EXECUTOR_MODES = [
  "vk",
  "internal",
  "hybrid",
  "disabled",
  "none",
  "monitor-only",
];
const DISABLED_MODES = new Set(["disabled", "none", "monitor-only"]);

/**
 * Convenience: get executor mode.
 * @returns {"vk"|"internal"|"hybrid"|"disabled"|"none"|"monitor-only"}
 */
export function getExecutorMode() {
  const mode = (process.env.EXECUTOR_MODE || "").toLowerCase();
  if (VALID_EXECUTOR_MODES.includes(mode)) return mode;
  try {
    const config = loadConfig();
    const configMode = (
      config.internalExecutor?.mode ||
      config.taskExecutor?.mode ||
      "internal"
    ).toLowerCase();
    if (VALID_EXECUTOR_MODES.includes(configMode)) return configMode;
  } catch {
    /* ignore */
  }
  return "internal";
}

/**
 * Check whether task execution is completely disabled.
 * @returns {boolean}
 */
export function isExecutorDisabled() {
  return DISABLED_MODES.has(getExecutorMode());
}

export { TaskExecutor };
export default TaskExecutor;
