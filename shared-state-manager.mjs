/**
 * @fileoverview Shared State Manager for OpenFleet Task Coordination
 *
 * Manages distributed task execution state across multiple agents and workstations.
 * Provides atomic operations for claiming, updating, and releasing task ownership
 * with heartbeat-based liveness detection and conflict resolution.
 *
 * Designed for eventual consistency on distributed filesystems.
 */

import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * @typedef {Object} EventLogEntry
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {string} event - Event type (claimed/renewed/released/abandoned/failed/conflict)
 * @property {string} ownerId - Owner identifier at time of event
 * @property {string} [details] - Optional event details
 */

/**
 * @typedef {Object} TaskSharedState
 * @property {string} taskId - Unique task identifier
 * @property {string} ownerId - Current owner (workstation ID + agent ID)
 * @property {string} ownerHeartbeat - ISO 8601 timestamp of last heartbeat
 * @property {string} attemptToken - UUID for this attempt
 * @property {string} attemptStarted - ISO 8601 timestamp when attempt began
 * @property {string} attemptStatus - claimed/working/failed/abandoned/complete
 * @property {number} retryCount - Number of previous attempts
 * @property {string} [lastError] - Error message from last failure
 * @property {string} [ignoreReason] - Reason task should be ignored by agents
 * @property {EventLogEntry[]} eventLog - Chronological event history
 */

/**
 * @typedef {Object} SharedStateRegistry
 * @property {string} version - Schema version
 * @property {string} lastUpdated - ISO 8601 timestamp
 * @property {Object.<string, TaskSharedState>} tasks - Map of taskId to state
 */

const REGISTRY_VERSION = "1.0.0";
const DEFAULT_TTL_SECONDS = 300; // 5 minutes
const MAX_EVENT_LOG_ENTRIES = 100;

/**
 * Get the path to the shared state registry file
 * @param {string} [repoRoot] - Repository root path
 * @returns {string} Registry file path
 */
function getRegistryPath(repoRoot = process.cwd()) {
  return join(repoRoot, ".cache", "openfleet", "shared-task-states.json");
}

/**
 * Ensure registry directory exists
 * @param {string} registryPath - Registry file path
 * @returns {Promise<void>}
 */
async function ensureRegistryDir(registryPath) {
  const dir = dirname(registryPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Load registry from disk with corruption recovery
 * @param {string} registryPath - Registry file path
 * @returns {Promise<SharedStateRegistry>}
 */
async function loadRegistry(registryPath) {
  try {
    if (!existsSync(registryPath)) {
      return createEmptyRegistry();
    }

    const content = await readFile(registryPath, "utf-8");
    const registry = JSON.parse(content);

    // Validate structure
    if (
      !registry.version ||
      !registry.tasks ||
      typeof registry.tasks !== "object"
    ) {
      console.warn(
        "[SharedStateManager] Invalid registry structure, resetting",
      );
      return createEmptyRegistry();
    }

    return registry;
  } catch (error) {
    console.error(
      "[SharedStateManager] Registry corruption detected:",
      error.message,
    );

    // Attempt to backup corrupted file
    try {
      const backupPath = `${registryPath}.corrupt-${Date.now()}.bak`;
      await rename(registryPath, backupPath);
      console.log(
        `[SharedStateManager] Corrupted registry backed up to: ${backupPath}`,
      );
    } catch (backupError) {
      console.error(
        "[SharedStateManager] Failed to backup corrupted registry:",
        backupError.message,
      );
    }

    return createEmptyRegistry();
  }
}

/**
 * Create empty registry structure
 * @returns {SharedStateRegistry}
 */
function createEmptyRegistry() {
  return {
    version: REGISTRY_VERSION,
    lastUpdated: new Date().toISOString(),
    tasks: {},
  };
}

/**
 * Save registry to disk with atomic write
 * @param {string} registryPath - Registry file path
 * @param {SharedStateRegistry} registry - Registry data
 * @returns {Promise<void>}
 */
async function saveRegistry(registryPath, registry) {
  await ensureRegistryDir(registryPath);

  registry.lastUpdated = new Date().toISOString();

  const tempPath = `${registryPath}.tmp-${randomUUID()}`;

  try {
    await writeFile(tempPath, JSON.stringify(registry, null, 2), "utf-8");

    // Atomic rename
    await rename(tempPath, registryPath);
  } catch (error) {
    // Clean up temp file on failure
    try {
      if (existsSync(tempPath)) {
        await unlink(tempPath);
      }
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Add event to task's event log
 * @param {TaskSharedState} state - Task state
 * @param {string} event - Event type
 * @param {string} ownerId - Owner ID
 * @param {string} [details] - Optional details
 */
function logEvent(state, event, ownerId, details) {
  if (!state.eventLog) {
    state.eventLog = [];
  }

  state.eventLog.push({
    timestamp: new Date().toISOString(),
    event,
    ownerId,
    ...(details && { details }),
  });

  // Keep log bounded
  if (state.eventLog.length > MAX_EVENT_LOG_ENTRIES) {
    state.eventLog = state.eventLog.slice(-MAX_EVENT_LOG_ENTRIES);
  }
}

/**
 * Check if a heartbeat is stale
 * @param {string} heartbeat - ISO timestamp
 * @param {number} staleThresholdMs - Threshold in milliseconds
 * @returns {boolean}
 */
function isHeartbeatStale(heartbeat, staleThresholdMs) {
  const heartbeatTime = new Date(heartbeat).getTime();
  const now = Date.now();
  return now - heartbeatTime > staleThresholdMs;
}

/**
 * Resolve conflict between two claims
 * @param {TaskSharedState} existing - Existing state
 * @param {string} newOwnerId - New claimant
 * @param {number} staleThresholdMs - Heartbeat staleness threshold
 * @returns {{winner: string, reason: string}} - Resolution decision
 */
function resolveConflict(existing, newOwnerId, staleThresholdMs) {
  const existingStale = isHeartbeatStale(
    existing.ownerHeartbeat,
    staleThresholdMs,
  );

  if (existingStale) {
    return {
      winner: newOwnerId,
      reason: "existing_owner_stale",
    };
  }

  // Both active - prefer existing owner (first-come-first-served)
  return {
    winner: existing.ownerId,
    reason: "existing_owner_active",
  };
}

/**
 * Claim a task in shared state with heartbeat-based leasing
 *
 * @param {string} taskId - Task identifier
 * @param {string} ownerId - Owner identifier (workstationId + agentId)
 * @param {string} attemptToken - Unique attempt token
 * @param {number} [ttlSeconds=300] - Heartbeat TTL in seconds
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{success: boolean, reason?: string, state?: TaskSharedState}>}
 */
export async function claimTaskInSharedState(
  taskId,
  ownerId,
  attemptToken,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  repoRoot = process.cwd(),
) {
  const registryPath = getRegistryPath(repoRoot);
  const staleThresholdMs = ttlSeconds * 1000;

  try {
    const registry = await loadRegistry(registryPath);
    const existing = registry.tasks[taskId];
    const now = new Date().toISOString();

    // Task has ignore flag - cannot claim
    if (existing?.ignoreReason) {
      return {
        success: false,
        reason: `task_ignored: ${existing.ignoreReason}`,
      };
    }

    // No existing claim or terminal status - claim it
    if (
      !existing ||
      existing.attemptStatus === "complete" ||
      existing.attemptStatus === "failed" ||
      existing.attemptStatus === "abandoned" ||
      existing.attemptStatus === "ignored"
    ) {
      const newState = {
        taskId,
        ownerId,
        ownerHeartbeat: now,
        attemptToken,
        attemptStarted: now,
        attemptStatus: "claimed",
        retryCount: existing ? existing.retryCount + 1 : 0,
        ttlSeconds,
        eventLog: existing?.eventLog || [],
      };

      if (existing?.lastError) {
        newState.lastError = existing.lastError;
      }

      logEvent(newState, "claimed", ownerId);
      registry.tasks[taskId] = newState;
      await saveRegistry(registryPath, registry);

      return { success: true, state: newState };
    }

    // Existing claim - check for conflict
    if (existing.ownerId !== ownerId) {
      const existingStaleMs = (existing.ttlSeconds || ttlSeconds) * 1000;
      const resolution = resolveConflict(existing, ownerId, existingStaleMs);

      if (resolution.winner === ownerId) {
        // Take over stale claim
        const newState = {
          ...existing,
          ownerId,
          ownerHeartbeat: now,
          attemptToken,
          attemptStarted: now,
          attemptStatus: "claimed",
          retryCount: existing.retryCount + 1,
          ttlSeconds,
        };

        logEvent(
          newState,
          "conflict",
          ownerId,
          `takeover: ${resolution.reason}`,
        );
        registry.tasks[taskId] = newState;
        await saveRegistry(registryPath, registry);

        return { success: true, state: newState };
      } else {
        // Existing owner wins
        logEvent(
          existing,
          "conflict",
          ownerId,
          `rejected: ${resolution.reason}`,
        );
        registry.tasks[taskId] = existing;
        await saveRegistry(registryPath, registry);

        return {
          success: false,
          reason: `conflict: ${resolution.reason}`,
          state: existing,
        };
      }
    }

    // Same owner reclaiming - update heartbeat
    existing.ownerHeartbeat = now;
    existing.attemptToken = attemptToken;
    existing.ttlSeconds = ttlSeconds;
    logEvent(existing, "reclaimed", ownerId);
    registry.tasks[taskId] = existing;
    await saveRegistry(registryPath, registry);

    return { success: true, state: existing };
  } catch (error) {
    console.error("[SharedStateManager] Failed to claim task:", error);
    return {
      success: false,
      reason: `error: ${error.message}`,
    };
  }
}

/**
 * Renew heartbeat for an active task claim
 *
 * @param {string} taskId - Task identifier
 * @param {string} ownerId - Owner identifier
 * @param {string} attemptToken - Attempt token for verification
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
export async function renewSharedStateHeartbeat(
  taskId,
  ownerId,
  attemptToken,
  repoRoot = process.cwd(),
) {
  const registryPath = getRegistryPath(repoRoot);

  try {
    const registry = await loadRegistry(registryPath);
    const state = registry.tasks[taskId];

    if (!state) {
      return {
        success: false,
        reason: "task_not_found",
      };
    }

    if (state.ownerId !== ownerId) {
      return {
        success: false,
        reason: "owner_mismatch",
      };
    }

    if (state.attemptToken !== attemptToken) {
      return {
        success: false,
        reason: "attempt_token_mismatch",
      };
    }

    if (
      state.attemptStatus === "complete" ||
      state.attemptStatus === "failed"
    ) {
      return {
        success: false,
        reason: `task_already_${state.attemptStatus}`,
      };
    }

    state.ownerHeartbeat = new Date().toISOString();
    state.attemptStatus = "working";
    logEvent(state, "renewed", ownerId);

    await saveRegistry(registryPath, registry);

    return { success: true };
  } catch (error) {
    console.error("[SharedStateManager] Failed to renew heartbeat:", error);
    return {
      success: false,
      reason: `error: ${error.message}`,
    };
  }
}

/**
 * Release task claim by marking it complete, failed, or abandoned
 *
 * @param {string} taskId - Task identifier
 * @param {string} attemptToken - Attempt token for verification
 * @param {'complete'|'failed'|'abandoned'} status - Final status
 * @param {string} [errorMessage] - Error message if failed
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
export async function releaseSharedState(
  taskId,
  attemptToken,
  status,
  errorMessage,
  repoRoot = process.cwd(),
) {
  const registryPath = getRegistryPath(repoRoot);

  try {
    const registry = await loadRegistry(registryPath);
    const state = registry.tasks[taskId];

    if (!state) {
      return {
        success: false,
        reason: "task_not_found",
      };
    }

    if (state.attemptToken !== attemptToken) {
      return {
        success: false,
        reason: "attempt_token_mismatch",
      };
    }

    const now = new Date().toISOString();
    state.attemptStatus = status;
    state.ownerHeartbeat = now;

    if (errorMessage) {
      state.lastError = errorMessage;
    }

    logEvent(state, "released", state.ownerId, `status: ${status}`);

    await saveRegistry(registryPath, registry);

    return { success: true };
  } catch (error) {
    console.error("[SharedStateManager] Failed to release state:", error);
    return {
      success: false,
      reason: `error: ${error.message}`,
    };
  }
}

/**
 * Get current shared state for a task
 *
 * @param {string} taskId - Task identifier
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<TaskSharedState|null>}
 */
export async function getSharedState(taskId, repoRoot = process.cwd()) {
  const registryPath = getRegistryPath(repoRoot);

  try {
    const registry = await loadRegistry(registryPath);
    return registry.tasks[taskId] || null;
  } catch (error) {
    console.error("[SharedStateManager] Failed to get shared state:", error);
    return null;
  }
}

/**
 * Get all shared states (for monitoring/debugging)
 *
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<Object.<string, TaskSharedState>>}
 */
export async function getAllSharedStates(repoRoot = process.cwd()) {
  const registryPath = getRegistryPath(repoRoot);

  try {
    const registry = await loadRegistry(registryPath);
    return registry.tasks || {};
  } catch (error) {
    console.error(
      "[SharedStateManager] Failed to get all shared states:",
      error,
    );
    return {};
  }
}

/**
 * Sweep through tasks and mark stale owners as abandoned
 *
 * @param {number} staleThresholdMs - Heartbeat staleness threshold in milliseconds
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{sweptCount: number, abandonedTasks: string[]}>}
 */
export async function sweepStaleSharedStates(
  staleThresholdMs,
  repoRoot = process.cwd(),
) {
  const registryPath = getRegistryPath(repoRoot);

  try {
    const registry = await loadRegistry(registryPath);
    const abandonedTasks = [];
    let sweptCount = 0;

    for (const [taskId, state] of Object.entries(registry.tasks)) {
      // Skip already completed/failed tasks
      if (
        state.attemptStatus === "complete" ||
        state.attemptStatus === "failed"
      ) {
        continue;
      }

      // Skip tasks with ignore flag
      if (state.ignoreReason) {
        continue;
      }

      if (isHeartbeatStale(state.ownerHeartbeat, staleThresholdMs)) {
        state.attemptStatus = "abandoned";
        state.lastError = `Heartbeat stale (last: ${state.ownerHeartbeat})`;
        logEvent(state, "abandoned", "system", "stale_heartbeat");

        abandonedTasks.push(taskId);
        sweptCount++;
      }
    }

    if (sweptCount > 0) {
      await saveRegistry(registryPath, registry);
    }

    return { sweptCount, abandonedTasks };
  } catch (error) {
    console.error("[SharedStateManager] Failed to sweep stale states:", error);
    return { sweptCount: 0, abandonedTasks: [] };
  }
}

/**
 * Check if a task should be retried or permanently ignored
 *
 * @param {string} taskId - Task identifier
 * @param {number} maxRetries - Maximum retry attempts
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{shouldRetry: boolean, reason: string}>}
 */
export async function shouldRetryTask(
  taskId,
  maxRetries,
  repoRoot = process.cwd(),
) {
  try {
    const state = await getSharedState(taskId, repoRoot);

    if (!state) {
      return { shouldRetry: true, reason: "no_previous_attempts" };
    }

    if (state.ignoreReason) {
      return { shouldRetry: false, reason: `ignored: ${state.ignoreReason}` };
    }

    if (state.attemptStatus === "complete") {
      return { shouldRetry: false, reason: "already_complete" };
    }

    if (state.retryCount >= maxRetries) {
      return {
        shouldRetry: false,
        reason: `max_retries_exceeded: ${state.retryCount}/${maxRetries}`,
      };
    }

    // Check if currently claimed by active owner
    if (
      state.attemptStatus === "claimed" ||
      state.attemptStatus === "working"
    ) {
      const staleThresholdMs = (state.ttlSeconds || DEFAULT_TTL_SECONDS) * 1000;
      if (!isHeartbeatStale(state.ownerHeartbeat, staleThresholdMs)) {
        return {
          shouldRetry: false,
          reason: "currently_owned_by_active_agent",
        };
      }
    }

    return { shouldRetry: true, reason: "eligible_for_retry" };
  } catch (error) {
    console.error(
      "[SharedStateManager] Failed to check retry eligibility:",
      error,
    );
    return { shouldRetry: true, reason: "error_checking_state" };
  }
}

/**
 * Mark a task as permanently ignored by agents
 *
 * @param {string} taskId - Task identifier
 * @param {string} reason - Reason for ignoring (e.g., "human_created", "invalid_spec")
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
export async function setIgnoreFlag(taskId, reason, repoRoot = process.cwd()) {
  const registryPath = getRegistryPath(repoRoot);

  try {
    const registry = await loadRegistry(registryPath);
    let state = registry.tasks[taskId];

    if (!state) {
      // Create new state entry for ignored task
      state = {
        taskId,
        ownerId: "system",
        ownerHeartbeat: new Date().toISOString(),
        attemptToken: "N/A",
        attemptStarted: new Date().toISOString(),
        attemptStatus: "ignored",
        retryCount: 0,
        ignoreReason: reason,
        eventLog: [],
      };
    } else {
      state.ignoreReason = reason;
    }

    logEvent(state, "ignored", "system", reason);
    registry.tasks[taskId] = state;
    await saveRegistry(registryPath, registry);

    return { success: true };
  } catch (error) {
    console.error("[SharedStateManager] Failed to set ignore flag:", error);
    return {
      success: false,
      reason: `error: ${error.message}`,
    };
  }
}

/**
 * Clear ignore flag from a task
 *
 * @param {string} taskId - Task identifier
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
export async function clearIgnoreFlag(taskId, repoRoot = process.cwd()) {
  const registryPath = getRegistryPath(repoRoot);

  try {
    const registry = await loadRegistry(registryPath);
    const state = registry.tasks[taskId];

    if (!state) {
      return {
        success: false,
        reason: "task_not_found",
      };
    }

    if (!state.ignoreReason) {
      return {
        success: false,
        reason: "not_ignored",
      };
    }

    delete state.ignoreReason;
    logEvent(state, "unignored", "system");
    await saveRegistry(registryPath, registry);

    return { success: true };
  } catch (error) {
    console.error("[SharedStateManager] Failed to clear ignore flag:", error);
    return {
      success: false,
      reason: `error: ${error.message}`,
    };
  }
}

/**
 * Clean up old completed/failed task states
 *
 * @param {number} retentionDays - Days to retain completed tasks
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{cleanedCount: number, cleanedTasks: string[]}>}
 */
export async function cleanupOldStates(
  retentionDays,
  repoRoot = process.cwd(),
) {
  const registryPath = getRegistryPath(repoRoot);
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const cutoffTime = Date.now() - retentionMs;

  try {
    const registry = await loadRegistry(registryPath);
    const cleanedTasks = [];
    let cleanedCount = 0;

    for (const [taskId, state] of Object.entries(registry.tasks)) {
      // Only clean up completed/failed tasks
      if (
        state.attemptStatus !== "complete" &&
        state.attemptStatus !== "failed"
      ) {
        continue;
      }

      // Check if old enough
      const lastUpdate = new Date(state.ownerHeartbeat).getTime();
      if (lastUpdate < cutoffTime) {
        delete registry.tasks[taskId];
        cleanedTasks.push(taskId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      await saveRegistry(registryPath, registry);
      console.log(
        `[SharedStateManager] Cleaned up ${cleanedCount} old task states`,
      );
    }

    return { cleanedCount, cleanedTasks };
  } catch (error) {
    console.error("[SharedStateManager] Failed to cleanup old states:", error);
    return { cleanedCount: 0, cleanedTasks: [] };
  }
}

/**
 * Get statistics about current shared state
 *
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<Object>}
 */
export async function getStateStatistics(repoRoot = process.cwd()) {
  try {
    const registry = await loadRegistry(getRegistryPath(repoRoot));
    const stats = {
      total: 0,
      claimed: 0,
      working: 0,
      complete: 0,
      failed: 0,
      abandoned: 0,
      ignored: 0,
      stale: 0,
      byOwner: {},
    };

    for (const state of Object.values(registry.tasks)) {
      stats.total++;

      if (state.ignoreReason) {
        stats.ignored++;
      } else {
        stats[state.attemptStatus] = (stats[state.attemptStatus] || 0) + 1;
      }

      if (
        state.attemptStatus !== "complete" &&
        state.attemptStatus !== "failed" &&
        state.attemptStatus !== "ignored"
      ) {
        const staleMs = (state.ttlSeconds || DEFAULT_TTL_SECONDS) * 1000;
        if (isHeartbeatStale(state.ownerHeartbeat, staleMs)) {
          stats.stale++;
        }
      }

      if (!stats.byOwner[state.ownerId]) {
        stats.byOwner[state.ownerId] = 0;
      }
      stats.byOwner[state.ownerId]++;
    }

    return stats;
  } catch (error) {
    console.error("[SharedStateManager] Failed to get statistics:", error);
    return {
      total: 0,
      claimed: 0,
      working: 0,
      complete: 0,
      failed: 0,
      abandoned: 0,
      ignored: 0,
      stale: 0,
      byOwner: {},
    };
  }
}

// Export constants for external use
export { REGISTRY_VERSION, DEFAULT_TTL_SECONDS, MAX_EVENT_LOG_ENTRIES };
