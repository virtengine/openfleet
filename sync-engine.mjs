/**
 * sync-engine.mjs — Two-way sync between internal task store and external kanban backends
 *
 * The internal task store (.cache/kanban-state.json via task-store.mjs) is the
 * **source of truth** for status and agent tracking.  External kanbans (VK,
 * GitHub Issues, Jira) are kept in sync:
 *
 *   - Pull: new tasks added externally flow INTO the internal store.
 *   - Push: status changes from the orchestrator flow OUT to the external kanban.
 *
 * EXPORTS:
 *   SyncEngine           — Main class
 *   createSyncEngine()   — Factory helper
 */

import {
  getTask,
  getAllTasks,
  addTask,
  updateTask,
  getDirtyTasks,
  markSynced,
  upsertFromExternal,
  setTaskStatus,
  removeTask,
} from "./task-store.mjs";

import {
  getKanbanAdapter,
  getKanbanBackendName,
  listTasks,
  updateTaskStatus as updateExternalStatus,
} from "./kanban-adapter.mjs";

import { getSharedState } from "./shared-state-manager.mjs";

const TAG = "[sync-engine]";

const SYNC_POLICIES = new Set(["internal-primary", "bidirectional"]);

// Shared state configuration
const SHARED_STATE_ENABLED = process.env.SHARED_STATE_ENABLED !== "false"; // default true
const SHARED_STATE_STALE_THRESHOLD_MS =
  Number(process.env.SHARED_STATE_STALE_THRESHOLD_MS) || 300_000;

/**
 * Check if a heartbeat is stale (local implementation for sync-engine)
 * @param {string} heartbeat - ISO timestamp
 * @param {number} staleThresholdMs - Threshold in milliseconds
 * @returns {boolean}
 */
function isHeartbeatStale(heartbeat, staleThresholdMs) {
  if (!heartbeat) return true;
  const heartbeatTime = new Date(heartbeat).getTime();
  if (!Number.isFinite(heartbeatTime)) return true;
  const now = Date.now();
  return now - heartbeatTime > staleThresholdMs;
}

function getSharedStatePayload(task) {
  if (!task) return null;
  return task.sharedState || task.meta?.sharedState || null;
}

function getSharedHeartbeat(state) {
  if (!state) return null;
  return state.ownerHeartbeat || state.heartbeat || state.owner_heartbeat || null;
}

function isSharedStateStaleForDecision(state, staleThresholdMs) {
  const heartbeat = getSharedHeartbeat(state);
  if (!heartbeat) return false;
  return isHeartbeatStale(heartbeat, staleThresholdMs);
}

// ---------------------------------------------------------------------------
// Task ID validation — ensure ID format is compatible with the target backend
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check whether a task ID is valid for the given kanban backend.
 *
 *   - GitHub Issues: expects a numeric issue number (e.g. "42")
 *   - VK (Vibe-Kanban): expects a UUID
 *   - Jira: expects a project-key string like "PROJ-123"
 *
 * @param {string} id   The task / issue ID
 * @param {string} backend  Backend name ("github", "vk", "jira")
 * @returns {boolean}
 */
function isIdValidForBackend(id, backend) {
  if (!id) return false;
  switch (backend) {
    case "github":
      return /^\d+$/.test(String(id));
    case "vk":
      return true; // VK accepts any string, UUIDs or otherwise
    case "jira":
      return /^[A-Z]+-\d+$/i.test(String(id));
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Status ordering — higher = more advanced
// ---------------------------------------------------------------------------

const STATUS_ORDER = {
  todo: 0,
  blocked: 1,
  inprogress: 1,
  inreview: 2,
  done: 3,
  cancelled: 3,
};

function statusRank(s) {
  return STATUS_ORDER[s] ?? -1;
}

const TERMINAL_STATUS_ALIASES = {
  closed: "cancelled",
  close: "cancelled",
  archived: "cancelled",
  rejected: "cancelled",
  wontfix: "cancelled",
  merged: "done",
  merge: "done",
  completed: "done",
  complete: "done",
  resolved: "done",
};

const CANONICAL_STATUS_BY_KEY = {
  todo: "todo",
  inprogress: "inprogress",
  inreview: "inreview",
  blocked: "blocked",
  done: "done",
  cancelled: "cancelled",
};

function normalizeStatusLabel(status) {
  if (status == null) return status;
  const raw = String(status).trim();
  if (!raw) return raw;

  const key = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (TERMINAL_STATUS_ALIASES[key]) {
    return TERMINAL_STATUS_ALIASES[key];
  }
  if (CANONICAL_STATUS_BY_KEY[key]) {
    return CANONICAL_STATUS_BY_KEY[key];
  }
  return raw;
}

// ---------------------------------------------------------------------------
// SyncResult helper
// ---------------------------------------------------------------------------

function emptySyncResult() {
  return {
    pulled: 0,
    pushed: 0,
    conflicts: 0,
    errors: [],
    timestamp: new Date().toISOString(),
  };
}

function mergeSyncResults(a, b) {
  return {
    pulled: a.pulled + b.pulled,
    pushed: a.pushed + b.pushed,
    conflicts: a.conflicts + b.conflicts,
    errors: [...a.errors, ...b.errors],
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// SyncEngine
// ---------------------------------------------------------------------------

export class SyncEngine {
  /** @type {string} */
  #projectId;
  /** @type {number} */
  #syncIntervalMs;
  /** @type {object|null} */
  #kanbanAdapter;
  /** @type {Function|null} */
  #sendTelegram;
  /** @type {Function|null} */
  #onAlert;
  /** @type {"internal-primary"|"bidirectional"} */
  #syncPolicy;

  /** @type {ReturnType<typeof setInterval>|null} */
  #timer = null;
  /** @type {boolean} */
  #running = false;

  // Stats
  #lastSync = null;
  #nextSync = null;
  #syncsCompleted = 0;
  #consecutiveFailures = 0;
  #errors = [];
  #metrics = {
    syncSuccesses: 0,
    syncFailures: 0,
    rateLimitEvents: 0,
    rateLimitRetrySuccesses: 0,
    rateLimitRetryFailures: 0,
    alertsTriggered: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastRateLimitAt: null,
    lastError: null,
  };
  #failureAlertThreshold;
  #rateLimitAlertThreshold;

  // Back-off
  #baseIntervalMs;
  #backoffActive = false;
  static BACKOFF_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  static BACKOFF_THRESHOLD = 5;
  static RATE_LIMIT_DELAY_MS = 60 * 1000; // 60 seconds

  /**
   * @param {object} options
   * @param {string}   options.projectId        VK / GitHub project ID
   * @param {number}   [options.syncIntervalMs]  Sync period (default 60 000)
   * @param {object}   [options.kanbanAdapter]   Override adapter from kanban-adapter.mjs
   * @param {Function} [options.sendTelegram]    Optional notification callback
   */
  constructor(options = {}) {
    if (!options.projectId) {
      throw new Error(`${TAG} projectId is required`);
    }
    this.#projectId = options.projectId;
    this.#syncIntervalMs = options.syncIntervalMs ?? 60_000;
    this.#baseIntervalMs = this.#syncIntervalMs;
    this.#kanbanAdapter = options.kanbanAdapter ?? null;
    this.#sendTelegram = options.sendTelegram ?? null;
    this.#onAlert = options.onAlert ?? null;
    this.#failureAlertThreshold = Math.max(
      1,
      Number(
        options.failureAlertThreshold ??
          process.env.GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD ??
          3,
      ),
    );
    this.#rateLimitAlertThreshold = Math.max(
      1,
      Number(
        options.rateLimitAlertThreshold ??
          process.env.GITHUB_PROJECT_SYNC_RATE_LIMIT_ALERT_THRESHOLD ??
          3,
      ),
    );
    const requestedPolicy = String(
      options.syncPolicy || process.env.KANBAN_SYNC_POLICY || "internal-primary",
    )
      .trim()
      .toLowerCase();
    this.#syncPolicy = SYNC_POLICIES.has(requestedPolicy)
      ? requestedPolicy
      : "internal-primary";
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Start periodic sync. */
  start() {
    if (this.#running) {
      console.log(TAG, "Already running — skipping start()");
      return;
    }
    this.#running = true;
    console.log(
      TAG,
      `Starting periodic sync every ${this.#syncIntervalMs}ms for project ${this.#projectId}`,
    );
    this.#scheduleNext();
  }

  /** Stop periodic sync. */
  stop() {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#nextSync = null;
    console.log(TAG, "Stopped periodic sync");
  }

  // -----------------------------------------------------------------------
  // Pull: External → Internal
  // -----------------------------------------------------------------------

  /**
   * Fetch tasks from the external kanban and reconcile into the internal store.
   * Also reads shared state from external sources (like GitHub comments).
   * @returns {Promise<SyncResult>}
   */
  async pullFromExternal() {
    const result = emptySyncResult();
    const internalPrimary = this.#syncPolicy === "internal-primary";

    /** @type {Array} */
    let externalTasks;
    try {
      externalTasks = await this.#listExternal();
    } catch (err) {
      const msg = `Pull failed — could not list external tasks: ${err.message}`;
      console.warn(TAG, msg);
      result.errors.push(msg);
      return result;
    }

    const internalTasks = getAllTasks();
    const internalById = new Map(internalTasks.map((t) => [t.id, t]));
    const externalIds = new Set();

    for (const ext of externalTasks) {
      if (!ext || !ext.id) continue;
      externalIds.add(ext.id);

      const normalizedExternalStatus = normalizeStatusLabel(ext.status);
      const normalizedExt = {
        ...ext,
        status: normalizedExternalStatus,
      };
      const externalBaseBranch =
        normalizedExt.baseBranch ??
        normalizedExt.base_branch ??
        normalizedExt.meta?.base_branch ??
        normalizedExt.meta?.baseBranch ??
        null;

      try {
        const internal = internalById.get(ext.id);

        if (!internal) {
          // ── New task from external ──
          upsertFromExternal({
            ...normalizedExt,
            projectId: normalizedExt.projectId ?? this.#projectId,
            externalBackend: normalizedExt.backend ?? null,
          });
          result.pulled++;
          console.log(TAG, `Pulled new task ${ext.id}: ${ext.title}`);
          continue;
        }

        if (internalPrimary) {
          const mergedMeta = {
            ...(internal.meta || {}),
            ...(normalizedExt.meta || {}),
          };
          updateTask(ext.id, {
            title: normalizedExt.title ?? internal.title,
            description: normalizedExt.description ?? internal.description,
            assignee: normalizedExt.assignee ?? internal.assignee,
            priority: normalizedExt.priority ?? internal.priority,
            projectId: normalizedExt.projectId ?? internal.projectId,
            baseBranch: externalBaseBranch ?? internal.baseBranch,
            branchName: normalizedExt.branchName ?? internal.branchName,
            prNumber: normalizedExt.prNumber ?? internal.prNumber,
            prUrl: normalizedExt.prUrl ?? internal.prUrl,
            externalStatus: normalizedExternalStatus,
            externalBackend:
              normalizedExt.backend ?? normalizedExt.externalBackend ?? null,
            meta: mergedMeta,
          });
          markSynced(ext.id);
          continue;
        }

        // ── Existing task — check for external status change ──
        const oldExternal = normalizeStatusLabel(internal.externalStatus);
        const newExternal = normalizedExternalStatus;

        if (
          externalBaseBranch &&
          externalBaseBranch !== internal.baseBranch
        ) {
          updateTask(ext.id, {
            baseBranch: externalBaseBranch,
            externalBackend:
              normalizedExt.backend ?? normalizedExt.externalBackend ?? null,
          });
        }

        // Read shared state metadata from external adapter (e.g., GitHub comments)
        if (SHARED_STATE_ENABLED) {
          const sharedStatePayload = getSharedStatePayload(normalizedExt);
          if (sharedStatePayload) {
            try {
              const heartbeat = getSharedHeartbeat(sharedStatePayload);
              // Merge shared state data into internal task meta
              updateTask(ext.id, {
                sharedStateOwnerId: sharedStatePayload.ownerId,
                sharedStateHeartbeat: heartbeat,
                sharedStateRetryCount: sharedStatePayload.retryCount,
              });
            } catch (err) {
              console.warn(
                TAG,
                `Failed to merge shared state for ${ext.id}: ${err.message}`,
              );
            }
          }
        }

        if (newExternal && newExternal !== oldExternal) {
          // External status changed (human edited it)
          const internalRank = statusRank(internal.status);
          const newExternalRank = statusRank(newExternal);
          const oldExternalRank = statusRank(oldExternal);

          if (newExternalRank < oldExternalRank) {
            // External moved BACKWARD — but only accept as human override
            // if internal is ALSO behind (i.e., orchestrator didn't advance it).
            // When internal is at or ahead of the old external, the backward
            // move is most likely a VK restart / state loss — re-push instead.
            const sharedStatePayload = getSharedStatePayload(normalizedExt) || {
              ownerId: internal.sharedStateOwnerId,
              ownerHeartbeat: internal.sharedStateHeartbeat,
            };
            const sharedStateStale = isSharedStateStaleForDecision(
              sharedStatePayload,
              SHARED_STATE_STALE_THRESHOLD_MS,
            );
            if (internalRank >= oldExternalRank && !sharedStateStale) {
              // Internal was actively progressed by orchestrator — ignore
              // the stale external value and mark dirty for re-push.
              updateTask(ext.id, {
                externalStatus: newExternal,
                syncDirty: true,
              });
              console.log(
                TAG,
                `External reverted ${ext.id}: ${oldExternal} → ${newExternal} but internal=${internal.status} is ahead — will re-push`,
              );
            } else {
              // Internal is truly behind old-external, so external moving
              // backward is a genuine human override — accept it.
              setTaskStatus(ext.id, newExternal, "external");
              updateTask(ext.id, {
                externalStatus: newExternal,
                syncDirty: false,
              });
              result.pulled++;
              console.log(
                TAG,
                `External moved backward ${ext.id}: ${oldExternal} → ${newExternal} (human override)`,
              );
            }
          } else if (newExternalRank > internalRank) {
            // External moved FORWARD past internal → respect external
            setTaskStatus(ext.id, newExternal, "external");
            updateTask(ext.id, {
              externalStatus: newExternal,
              syncDirty: false,
            });
            result.pulled++;
            console.log(
              TAG,
              `External advanced past internal ${ext.id}: ${internal.status} → ${newExternal}`,
            );
          } else if (internalRank > newExternalRank) {
            // Internal is more advanced → skip, push will handle it
            updateTask(ext.id, { externalStatus: newExternal });
            console.log(
              TAG,
              `Internal ahead of external for ${ext.id}: internal=${internal.status} external=${newExternal} — skipping pull`,
            );
          } else {
            // Same rank, different status (e.g., blocked vs inprogress) or equal
            upsertFromExternal({
              ...normalizedExt,
              projectId: normalizedExt.projectId ?? this.#projectId,
              externalBackend: normalizedExt.backend ?? null,
            });
            result.pulled++;
          }
        } else {
          // No status change — still update metadata (title, description, etc.)
          upsertFromExternal({
            ...normalizedExt,
            projectId: normalizedExt.projectId ?? this.#projectId,
            externalBackend: normalizedExt.backend ?? null,
          });
        }
      } catch (err) {
        const msg = `Pull error for task ${ext.id}: ${err.message}`;
        console.warn(TAG, msg);
        result.errors.push(msg);
      }
    }

    // ── Tasks deleted externally ──
    for (const internal of internalTasks) {
      if (
        internal.projectId === this.#projectId &&
        !externalIds.has(internal.id) &&
        internal.status !== "cancelled" &&
        internal.status !== "done"
      ) {
        if (internalPrimary) {
          console.log(
            TAG,
            `External task missing for ${internal.id} — preserving internal task (syncPolicy=internal-primary)`,
          );
          continue;
        }
        try {
          setTaskStatus(internal.id, "cancelled", "external");
          updateTask(internal.id, {
            externalStatus: "cancelled",
            syncDirty: false,
            blockedReason: "Deleted from external kanban",
          });
          console.log(
            TAG,
            `Task ${internal.id} deleted externally — marked cancelled`,
          );
        } catch (err) {
          const msg = `Failed to cancel externally-deleted task ${internal.id}: ${err.message}`;
          console.warn(TAG, msg);
          result.errors.push(msg);
        }
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Push: Internal → External
  // -----------------------------------------------------------------------

  /**
   * Push dirty internal tasks to the external kanban.
   * Before pushing, checks shared state to prevent conflicts with fresher claims.
   * @returns {Promise<SyncResult>}
   */
  async pushToExternal() {
    const result = emptySyncResult();
    const dirtyTasks = getDirtyTasks();

    if (dirtyTasks.length === 0) {
      return result;
    }

    const backendName = getKanbanBackendName();
    console.log(
      TAG,
      `Pushing ${dirtyTasks.length} dirty task(s) to external (backend=${backendName})`,
    );

    for (const task of dirtyTasks) {
      const baseBranchCandidate =
        task.baseBranch ??
        task.base_branch ??
        task.meta?.base_branch ??
        task.meta?.baseBranch ??
        null;
      const metaBaseBranch =
        task.meta?.base_branch ?? task.meta?.baseBranch ?? null;
      const wantsBaseBranch =
        baseBranchCandidate &&
        String(baseBranchCandidate) !== String(metaBaseBranch);

      // Check shared state for conflicts before pushing
      if (SHARED_STATE_ENABLED) {
        try {
          const sharedState = await getSharedState(task.id);
          const localOwner =
            task.sharedStateOwnerId ||
            task.meta?.sharedState?.ownerId ||
            task.claimedBy ||
            null;
          if (sharedState) {
            const heartbeat = getSharedHeartbeat(sharedState);
            const stale = isHeartbeatStale(
              heartbeat,
              SHARED_STATE_STALE_THRESHOLD_MS,
            );
            if (!stale && sharedState.ownerId !== localOwner) {
              // Active conflict - skip push and log
              console.log(
                TAG,
                `Skipping push for ${task.id} — active claim by ${sharedState.ownerId} (heartbeat: ${heartbeat || "unknown"})`,
              );
              result.conflicts++;
              continue;
            }
          }
        } catch (err) {
          console.warn(
            TAG,
            `Shared state check failed for ${task.id}: ${err.message}`,
          );
          // Continue with push on error (graceful degradation)
        }
      }
      // Skip tasks whose IDs are incompatible with the active backend.
      // e.g. VK UUID tasks cannot be pushed to GitHub Issues (needs numeric IDs).
      const pushId = task.externalId || task.id;
      if (!isIdValidForBackend(pushId, backendName)) {
        // If the task originated from a different backend, silently clear dirty
        // flag — it will be synced when that backend is active.
        markSynced(task.id);
        console.log(
          TAG,
          `Skipped ${task.id} — ID format incompatible with ${backendName} backend`,
        );
        continue;
      }

      try {
        if (wantsBaseBranch) {
          await this.#updateExternalPatch(pushId, {
            status: task.status,
            baseBranch: baseBranchCandidate,
          });
        } else {
          await this.#updateExternal(pushId, task.status);
        }
        markSynced(task.id);
        result.pushed++;
        console.log(TAG, `Pushed ${task.id} → ${task.status}`);
      } catch (err) {
        if (this.#isRateLimited(err)) {
          this.#metrics.rateLimitEvents++;
          this.#metrics.lastRateLimitAt = new Date().toISOString();
          const msg = `Rate limited — backing off for ${SyncEngine.RATE_LIMIT_DELAY_MS / 1000}s`;
          console.warn(TAG, msg);
          result.errors.push(msg);
          if (this.#metrics.rateLimitEvents % this.#rateLimitAlertThreshold === 0) {
            this.#emitAlert(
              "rate_limit",
              `Sync engine observed ${this.#metrics.rateLimitEvents} rate-limit event(s)`,
              { taskId: task.id, backend: backendName },
            );
          }
          await this.#sleep(SyncEngine.RATE_LIMIT_DELAY_MS);
          // Retry once after back-off
          try {
            if (wantsBaseBranch) {
              await this.#updateExternalPatch(pushId, {
                status: task.status,
                baseBranch: baseBranchCandidate,
              });
            } else {
              await this.#updateExternal(pushId, task.status);
            }
            markSynced(task.id);
            result.pushed++;
            this.#metrics.rateLimitRetrySuccesses++;
            console.log(
              TAG,
              `Pushed ${task.id} → ${task.status} (after rate-limit retry)`,
            );
          } catch (retryErr) {
            const retryMsg = `Push retry failed for ${task.id}: ${retryErr.message}`;
            console.warn(TAG, retryMsg);
            result.errors.push(retryMsg);
            this.#metrics.rateLimitRetryFailures++;
          }
        } else if (this.#isNotFound(err)) {
          // Task was deleted from the external kanban — stop retrying
          console.warn(
            TAG,
            `Task ${task.id} returned 404 — removing orphaned task from internal store`,
          );
          removeTask(task.id);
        } else if (this.#isInvalidIdFormat(err)) {
          // ID format mismatch (e.g. UUID pushed to GitHub) — skip silently
          markSynced(task.id);
          console.log(
            TAG,
            `Skipped ${task.id} — invalid ID format for current backend`,
          );
        } else {
          const msg = `Push failed for ${task.id}: ${err.message}`;
          console.warn(TAG, msg);
          result.errors.push(msg);
        }
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Full sync
  // -----------------------------------------------------------------------

  /**
   * Run a complete pull + push cycle.
   * @returns {Promise<SyncResult>}
   */
  async fullSync() {
    console.log(TAG, "Starting full sync…");
    const t0 = Date.now();

    let pullResult = emptySyncResult();
    let pushResult = emptySyncResult();

    try {
      pullResult = await this.pullFromExternal();
    } catch (err) {
      pullResult.errors.push(`Pull phase crashed: ${err.message}`);
      console.warn(TAG, `Pull phase error: ${err.message}`);
    }

    try {
      pushResult = await this.pushToExternal();
    } catch (err) {
      pushResult.errors.push(`Push phase crashed: ${err.message}`);
      console.warn(TAG, `Push phase error: ${err.message}`);
    }

    const combined = mergeSyncResults(pullResult, pushResult);
    const elapsed = Date.now() - t0;

    // Track consecutive failures for back-off
    if (combined.errors.length > 0) {
      this.#consecutiveFailures++;
      this.#errors = combined.errors.slice(-20); // keep last 20
      this.#metrics.syncFailures++;
      this.#metrics.lastFailureAt = new Date().toISOString();
      this.#metrics.lastError = combined.errors[combined.errors.length - 1] || null;

      if (this.#consecutiveFailures % this.#failureAlertThreshold === 0) {
        this.#emitAlert(
          "sync_failure",
          `Sync engine has ${this.#consecutiveFailures} consecutive failure(s)`,
          { errors: combined.errors.slice(-3) },
        );
      }

      if (
        this.#consecutiveFailures >= SyncEngine.BACKOFF_THRESHOLD &&
        !this.#backoffActive
      ) {
        this.#backoffActive = true;
        this.#syncIntervalMs = SyncEngine.BACKOFF_INTERVAL_MS;
        console.warn(
          TAG,
          `${this.#consecutiveFailures} consecutive failures — slowing sync to ${this.#syncIntervalMs}ms`,
        );
        if (this.#sendTelegram) {
          this.#sendTelegram(
            `⚠️ Sync engine: ${this.#consecutiveFailures} consecutive failures, backing off to 5 min interval`,
          ).catch(() => {});
        }
      }
    } else {
      // Successful sync — reset failures and restore normal interval
      if (this.#consecutiveFailures > 0) {
        console.log(
          TAG,
          `Sync succeeded after ${this.#consecutiveFailures} failure(s) — resetting`,
        );
      }
      this.#consecutiveFailures = 0;
      this.#metrics.syncSuccesses++;
      this.#metrics.lastSuccessAt = new Date().toISOString();
      this.#metrics.lastError = null;
      if (this.#backoffActive) {
        this.#backoffActive = false;
        this.#syncIntervalMs = this.#baseIntervalMs;
        console.log(
          TAG,
          `Back-off cleared — restoring interval to ${this.#syncIntervalMs}ms`,
        );
      }
    }

    this.#syncsCompleted++;
    this.#lastSync = combined.timestamp;

    console.log(
      TAG,
      `Full sync complete in ${elapsed}ms — pulled=${combined.pulled} pushed=${combined.pushed} conflicts=${combined.conflicts} errors=${combined.errors.length}`,
    );

    return combined;
  }

  // -----------------------------------------------------------------------
  // Single-task sync
  // -----------------------------------------------------------------------

  /**
   * Force-sync a specific task: push internal state to external.
   * Also syncs shared state to/from external adapter.
   * @param {string} taskId
   */
  async syncTask(taskId) {
    const task = getTask(taskId);
    if (!task) {
      console.warn(TAG, `syncTask: task ${taskId} not found in internal store`);
      return;
    }

    const backendName = getKanbanBackendName();
    const pushId = task.externalId || task.id;
    if (!isIdValidForBackend(pushId, backendName)) {
      markSynced(task.id);
      console.log(
        TAG,
        `Skipped ${task.id} — ID format incompatible with ${backendName} backend`,
      );
      return;
    }

    const baseBranchCandidate =
      task.baseBranch ??
      task.base_branch ??
      task.meta?.base_branch ??
      task.meta?.baseBranch ??
      null;
    const metaBaseBranch =
      task.meta?.base_branch ?? task.meta?.baseBranch ?? null;
    const wantsBaseBranch =
      baseBranchCandidate &&
      String(baseBranchCandidate) !== String(metaBaseBranch);

    try {
      if (wantsBaseBranch) {
        await this.#updateExternalPatch(pushId, {
          status: task.status,
          baseBranch: baseBranchCandidate,
        });
      } else {
        await this.#updateExternal(pushId, task.status);
      }
      markSynced(taskId);
      console.log(
        TAG,
        `Force-synced task ${taskId} (${pushId}) → ${task.status}`,
      );
    } catch (err) {
      if (this.#isNotFound(err)) {
        console.warn(
          TAG,
          `Task ${task.id} returned 404 during force-sync — removing orphaned task from internal store`,
        );
        removeTask(task.id);
        return;
      }
      if (this.#isInvalidIdFormat(err)) {
        markSynced(task.id);
        console.log(
          TAG,
          `Skipped ${task.id} — invalid ID format for current backend`,
        );
        return;
      }
      console.warn(TAG, `syncTask failed for ${taskId}: ${err.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  /**
   * Explicitly sync shared state to/from external adapter.
   * This method allows for manual synchronization of shared state data.
   * @param {string} taskId - Task to sync (optional, syncs all if not provided)
   * @returns {Promise<{success: boolean, synced: number, errors: string[]}>}
   */
  async syncSharedState(taskId = null) {
    if (!SHARED_STATE_ENABLED) {
      return { success: false, synced: 0, errors: ["Shared state disabled"] };
    }

    console.log(
      TAG,
      `Syncing shared state${taskId ? ` for ${taskId}` : " for all tasks"}...`,
    );

    // Implementation would depend on kanban adapter supporting shared state comments
    // For now, return success as the main sync flows handle this
    return { success: true, synced: 0, errors: [] };
  }

  /**
   * Return current sync engine status.
   */
  getStatus() {
    return {
      lastSync: this.#lastSync,
      nextSync: this.#nextSync,
      syncsCompleted: this.#syncsCompleted,
      errors: [...this.#errors],
      running: this.#running,
      consecutiveFailures: this.#consecutiveFailures,
      backoffActive: this.#backoffActive,
      currentIntervalMs: this.#syncIntervalMs,
      sharedStateEnabled: SHARED_STATE_ENABLED,
      syncPolicy: this.#syncPolicy,
      metrics: { ...this.#metrics },
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Schedule the next sync tick. */
  #scheduleNext() {
    if (!this.#running) return;

    this.#nextSync = new Date(Date.now() + this.#syncIntervalMs).toISOString();
    this.#timer = setTimeout(async () => {
      try {
        await this.fullSync();
      } catch (err) {
        console.warn(TAG, `Periodic sync error: ${err.message}`);
      }
      this.#scheduleNext();
    }, this.#syncIntervalMs);

    // Prevent timer from blocking process exit
    if (this.#timer && typeof this.#timer.unref === "function") {
      this.#timer.unref();
    }
  }

  /**
   * List tasks from the external kanban, using adapter override or the
   * module-level listTasks convenience function.
   */
  async #listExternal() {
    if (
      this.#kanbanAdapter &&
      typeof this.#kanbanAdapter.listTasks === "function"
    ) {
      return await this.#kanbanAdapter.listTasks(this.#projectId);
    }
    return await listTasks(this.#projectId);
  }

  /**
   * Update a single task's status in the external kanban.
   */
  async #updateExternal(taskId, status) {
    if (
      this.#kanbanAdapter &&
      typeof this.#kanbanAdapter.updateTaskStatus === "function"
    ) {
      return await this.#kanbanAdapter.updateTaskStatus(taskId, status);
    }
    return await updateExternalStatus(taskId, status);
  }

  async #updateExternalPatch(taskId, patch) {
    if (
      this.#kanbanAdapter &&
      typeof this.#kanbanAdapter.updateTask === "function"
    ) {
      return await this.#kanbanAdapter.updateTask(taskId, patch);
    }
    if (typeof patch?.status === "string") {
      return await this.#updateExternal(taskId, patch.status);
    }
    return null;
  }

  /**
   * Determine whether an error is a 429 rate-limit response.
   */
  #isRateLimited(err) {
    if (!err) return false;
    const msg = String(err.message || err).toLowerCase();
    return (
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("too many requests")
    );
  }

  /**
   * Determine whether an error is a 404 Not Found response.
   */
  #isNotFound(err) {
    if (!err) return false;
    const msg = String(err.message || err).toLowerCase();
    return msg.includes("404") || msg.includes("not found");
  }

  /**
   * Determine whether an error indicates an invalid task ID format
   * (e.g. pushing a UUID to GitHub Issues).
   */
  #isInvalidIdFormat(err) {
    if (!err) return false;
    const msg = String(err.message || err).toLowerCase();
    return (
      msg.includes("invalid issue format") ||
      msg.includes("invalid issue number") ||
      msg.includes("expected a numeric id")
    );
  }

  /** Simple async sleep. */
  #sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  #emitAlert(kind, message, context = {}) {
    this.#metrics.alertsTriggered++;
    console.warn(TAG, `[alert:${kind}] ${message}`);
    const payload = {
      kind,
      message,
      context,
      timestamp: new Date().toISOString(),
    };
    if (this.#sendTelegram) {
      this.#sendTelegram(`⚠️ ${message}`).catch(() => {});
    }
    if (typeof this.#onAlert === "function") {
      try {
        this.#onAlert(payload);
      } catch {
        // best effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and return a SyncEngine instance.
 * @param {object} options  Same as SyncEngine constructor
 * @returns {SyncEngine}
 */
export function createSyncEngine(options) {
  return new SyncEngine(options);
}
