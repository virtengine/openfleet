/**
 * task-archiver.mjs
 *
 * Automatically archives completed VK tasks to local .cache after 1+ days.
 * Keeps VK database clean and fast by moving old completed tasks out of sight.
 *
 * Storage format: one JSON file per day (YYYY-MM-DD.json) containing an array
 * of archived task entries. This keeps the archive directory compact while
 * still allowing easy browsing by date.
 *
 * Robustness features:
 * - Idempotent: re-archiving an already-archived task is a no-op
 * - Atomic writes via temp file + rename to prevent corruption
 * - Archive pruning: removes archives older than retention period
 * - Graceful handling of corrupted archive files
 * - Session cleanup is best-effort and never blocks archival
 * - Auto-migrates legacy per-task files into daily grouped files
 */

import {
  mkdir,
  writeFile,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {string} Default archive directory */
export const ARCHIVE_DIR = resolve(__dirname, ".cache", "completed-tasks");

/** @type {number} Archive tasks completed more than this many hours ago */
export const ARCHIVE_AGE_HOURS = 24;

/** @type {number} Prune archive files older than this many days */
export const ARCHIVE_RETENTION_DAYS = 90;

/** @type {number} Max tasks to archive per sweep to avoid overload */
export const DEFAULT_MAX_ARCHIVE = 50;

// ── Daily-file helpers ───────────────────────────────────────────────────────

/**
 * Build the path for a daily archive file: `<dir>/YYYY-MM-DD.json`
 */
function dailyFilePath(dateStr, archiveDir) {
  return resolve(archiveDir, `${dateStr}.json`);
}

/**
 * Read the entries array from a daily archive file. Returns [] on missing or
 * corrupted files so callers never need to handle errors.
 */
export async function readDailyArchive(dateStr, archiveDir = ARCHIVE_DIR) {
  const filePath = dailyFilePath(dateStr, archiveDir);
  try {
    if (!existsSync(filePath)) return [];
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : (data?.entries ?? []);
  } catch {
    return [];
  }
}

/**
 * Write an entries array to a daily archive file using atomic temp+rename.
 */
async function writeDailyArchive(dateStr, entries, archiveDir) {
  await mkdir(archiveDir, { recursive: true });
  const filePath = dailyFilePath(dateStr, archiveDir);
  const tmpFile = resolve(
    archiveDir,
    `.tmp-${randomBytes(6).toString("hex")}.json`,
  );
  const payload = JSON.stringify(entries, null, 2);
  await writeFile(tmpFile, payload);
  try {
    await rename(tmpFile, filePath);
  } catch {
    // Cross-device rename fallback
    await writeFile(filePath, payload);
    await rm(tmpFile, { force: true }).catch(() => {});
  }
}

/**
 * Check whether a task has already been archived to the local file store.
 *
 * Searches daily archive files (YYYY-MM-DD.json) for the task ID inside
 * their entries arrays. Also detects legacy per-task files whose filename
 * contains the task ID.
 *
 * @param {string} taskId
 * @param {string} [archiveDir]
 * @returns {Promise<boolean>}
 */
export async function isAlreadyArchived(taskId, archiveDir = ARCHIVE_DIR) {
  if (!taskId) return false;
  try {
    if (!existsSync(archiveDir)) return false;
    const files = await readdir(archiveDir);

    for (const f of files) {
      if (!f.endsWith(".json") || f.startsWith(".tmp-")) continue;

      // Legacy per-task file: filename contains the task ID
      if (f.includes(taskId)) return true;

      // Daily grouped file: YYYY-MM-DD.json — search entries
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) {
        try {
          const raw = await readFile(resolve(archiveDir, f), "utf8");
          const entries = JSON.parse(raw);
          const arr = Array.isArray(entries)
            ? entries
            : (entries?.entries ?? []);
          if (arr.some((e) => e.task?.id === taskId)) return true;
        } catch {
          // corrupted file — skip
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Archive a single task into the daily grouped file for its completion date.
 * Idempotent — returns the file path if the task was already archived.
 *
 * @param {object} task
 * @param {object|null} attemptData
 * @param {string} [archiveDir]
 * @returns {Promise<string|null>} path to the daily archive file, or null on failure
 */
export async function archiveTaskToFile(
  task,
  attemptData = null,
  archiveDir = ARCHIVE_DIR,
) {
  try {
    if (!task || !task.id) {
      console.error(
        `[archiver] Failed to archive task ${task?.id}: Cannot read properties of undefined (reading 'completed_at')`,
      );
      return null;
    }

    await mkdir(archiveDir, { recursive: true });

    const completedAt = new Date(
      task.completed_at || task.updated_at || Date.now(),
    );
    const dateStr = completedAt.toISOString().split("T")[0]; // YYYY-MM-DD

    // Read existing daily file
    const entries = await readDailyArchive(dateStr, archiveDir);

    // Idempotent: skip if already in the daily file
    if (entries.some((e) => e.task?.id === task.id)) {
      return dailyFilePath(dateStr, archiveDir);
    }

    const archiveEntry = {
      task,
      attempt: attemptData,
      archived_at: new Date().toISOString(),
      archiver_version: 3,
    };

    entries.push(archiveEntry);
    await writeDailyArchive(dateStr, entries, archiveDir);

    return dailyFilePath(dateStr, archiveDir);
  } catch (err) {
    console.error(
      `[archiver] Failed to archive task ${task?.id}: ${err.message}`,
    );
    return null;
  }
}

/**
 * Fetch completed tasks from VK API.
 * @param {function} fetchVk
 * @param {string} projectId
 * @returns {Promise<object[]>}
 */
export async function fetchCompletedTasks(fetchVk, projectId) {
  if (!fetchVk || !projectId) return [];
  try {
    const statuses = ["done", "cancelled"];
    const allCompleted = [];

    for (const status of statuses) {
      const res = await fetchVk(
        `/api/tasks?project_id=${projectId}&status=${status}`,
      );
      if (res?.success && Array.isArray(res.data)) {
        allCompleted.push(...res.data);
      }
    }

    return allCompleted;
  } catch (err) {
    console.error(`[archiver] Failed to fetch completed tasks: ${err.message}`);
    return [];
  }
}

/**
 * Check if task is old enough to archive.
 * @param {object} task
 * @param {{ ageHours?: number, nowMs?: number }} [opts]
 * @returns {boolean}
 */
export function isOldEnoughToArchive(task, opts = {}) {
  const ageHours = opts.ageHours ?? ARCHIVE_AGE_HOURS;
  const nowMs = opts.nowMs ?? Date.now();
  const completedAt = new Date(task.completed_at || task.updated_at);
  if (isNaN(completedAt.getTime())) return false;
  const taskAgeHours = (nowMs - completedAt.getTime()) / (1000 * 60 * 60);
  return taskAgeHours >= ageHours;
}

/**
 * Clean up agent sessions (Copilot/Codex/Claude) associated with a task.
 * Best-effort — never throws; returns the count of cleaned sessions.
 *
 * @param {string} taskId
 * @param {string} attemptId
 * @returns {Promise<number>}
 */
export async function cleanupAgentSessions(taskId, attemptId) {
  if (!taskId) return 0;
  let cleaned = 0;

  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) return 0;

  // Helper: scan a directory for session files matching taskId or attemptId
  async function cleanDir(sessionDir) {
    try {
      if (!existsSync(sessionDir)) return 0;
      const sessionFiles = await readdir(sessionDir);
      let dirCleaned = 0;

      for (const file of sessionFiles) {
        if (file.includes(taskId) || (attemptId && file.includes(attemptId))) {
          await rm(resolve(sessionDir, file), { force: true, recursive: true });
          dirCleaned++;
        }
      }
      return dirCleaned;
    } catch {
      return 0;
    }
  }

  // Codex SDK sessions
  cleaned += await cleanDir(resolve(homeDir, ".codex", "sessions"));

  // Claude SDK sessions
  cleaned += await cleanDir(resolve(homeDir, ".claude", "sessions"));

  // Copilot sessions — try via CLI (best-effort, fast timeout)
  try {
    const { execSync } = await import("node:child_process");
    const sessionsOutput = execSync("gh copilot session list --json", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const sessions = JSON.parse(sessionsOutput);
    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        if (
          session.id?.includes(taskId) ||
          (attemptId && session.id?.includes(attemptId))
        ) {
          execSync(`gh copilot session delete ${session.id}`, {
            timeout: 5000,
            stdio: ["pipe", "pipe", "ignore"],
          });
          cleaned++;
        }
      }
    }
  } catch {
    // Copilot CLI might not be available or no sessions to clean
  }

  return cleaned;
}

/**
 * Delete task from VK (mark as archived or hard delete).
 * @param {function} fetchVk
 * @param {string} taskId
 * @returns {Promise<boolean>}
 */
export async function deleteTaskFromVK(fetchVk, taskId) {
  if (!fetchVk || !taskId) return false;
  try {
    // Try DELETE endpoint first
    const deleteRes = await fetchVk(`/api/tasks/${taskId}`, {
      method: "DELETE",
    });

    if (deleteRes?.success) {
      return true;
    }

    // Fallback: mark as archived via PUT
    const updateRes = await fetchVk(`/api/tasks/${taskId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });

    return updateRes?.success || false;
  } catch (err) {
    console.error(`[archiver] Failed to delete task ${taskId}: ${err.message}`);
    return false;
  }
}

/**
 * Prune old archive files that exceed the retention period.
 * @param {{ retentionDays?: number, archiveDir?: string, nowMs?: number }} [opts]
 * @returns {Promise<number>} number of files pruned
 */
export async function pruneOldArchives(opts = {}) {
  const retentionDays = opts.retentionDays ?? ARCHIVE_RETENTION_DAYS;
  const archiveDir = opts.archiveDir ?? ARCHIVE_DIR;
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;

  let pruned = 0;
  try {
    if (!existsSync(archiveDir)) return 0;
    const files = await readdir(archiveDir);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const filePath = resolve(archiveDir, file);
        const fileStat = await stat(filePath);
        if (nowMs - fileStat.mtimeMs > maxAgeMs) {
          await rm(filePath, { force: true });
          pruned++;
        }
      } catch {
        // Skip files we can't stat
      }
    }

    if (pruned > 0) {
      console.log(
        `[archiver] Pruned ${pruned} archive files older than ${retentionDays} days`,
      );
    }
  } catch (err) {
    console.warn(`[archiver] Archive pruning failed: ${err.message}`);
  }
  return pruned;
}

/**
 * Get archive statistics (file count, task count, and total size).
 * @param {string} [archiveDir]
 * @returns {Promise<{ count: number, taskCount: number, totalBytes: number }>}
 */
export async function getArchiveStats(archiveDir = ARCHIVE_DIR) {
  try {
    if (!existsSync(archiveDir))
      return { count: 0, taskCount: 0, totalBytes: 0 };
    const files = await readdir(archiveDir);
    const jsonFiles = files.filter(
      (f) => f.endsWith(".json") && !f.startsWith(".tmp-"),
    );
    let totalBytes = 0;
    let taskCount = 0;

    for (const file of jsonFiles) {
      try {
        const filePath = resolve(archiveDir, file);
        const fileStat = await stat(filePath);
        totalBytes += fileStat.size;

        // Count tasks inside daily files
        if (/^\d{4}-\d{2}-\d{2}\.json$/.test(file)) {
          const raw = await readFile(filePath, "utf8");
          const entries = JSON.parse(raw);
          const arr = Array.isArray(entries)
            ? entries
            : (entries?.entries ?? []);
          taskCount += arr.length;
        } else {
          // Legacy per-task file
          taskCount += 1;
        }
      } catch {
        // skip
      }
    }

    return { count: jsonFiles.length, taskCount, totalBytes };
  } catch {
    return { count: 0, taskCount: 0, totalBytes: 0 };
  }
}

/**
 * Migrate legacy per-task archive files (YYYY-MM-DD-{uuid}.json) into daily
 * grouped files (YYYY-MM-DD.json).  Idempotent — safe to call on every sweep.
 *
 * @param {string} [archiveDir]
 * @returns {Promise<{ migrated: number, errors: number }>}
 */
export async function migrateLegacyArchives(archiveDir = ARCHIVE_DIR) {
  const result = { migrated: 0, errors: 0 };
  try {
    if (!existsSync(archiveDir)) return result;

    const files = await readdir(archiveDir);
    // Legacy files match YYYY-MM-DD-<more-chars>.json
    const legacyFiles = files.filter((f) => {
      if (!f.endsWith(".json") || f.startsWith(".tmp-")) return false;
      // Must NOT be a pure daily file (YYYY-MM-DD.json)
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) return false;
      // Must start with a date prefix
      return /^\d{4}-\d{2}-\d{2}-.+\.json$/.test(f);
    });

    if (legacyFiles.length === 0) return result;

    // Group legacy files by date prefix
    /** @type {Map<string, string[]>} */
    const grouped = new Map();
    for (const f of legacyFiles) {
      const datePrefix = f.slice(0, 10); // YYYY-MM-DD
      const arr = grouped.get(datePrefix) ?? [];
      arr.push(f);
      grouped.set(datePrefix, arr);
    }

    for (const [datePrefix, fileNames] of grouped) {
      try {
        // Read existing daily file (may already have entries)
        const dailyPath = resolve(archiveDir, `${datePrefix}.json`);
        const existing = await readDailyArchive(datePrefix, archiveDir);

        // Build set of already-migrated task IDs to avoid duplicates
        const existingIds = new Set(
          existing.map((e) => e.task?.id).filter(Boolean),
        );

        for (const legacyFile of fileNames) {
          try {
            const raw = await readFile(resolve(archiveDir, legacyFile), "utf8");
            const entry = JSON.parse(raw);
            const taskId = entry?.task?.id;

            if (taskId && existingIds.has(taskId)) {
              // Already merged — just remove the legacy file
              await unlink(resolve(archiveDir, legacyFile));
              continue;
            }

            existing.push(entry);
            existingIds.add(taskId);
            result.migrated++;
          } catch {
            result.errors++;
          }
        }

        // Write consolidated daily file then remove legacy files
        await writeDailyArchive(datePrefix, existing, archiveDir);
        for (const legacyFile of fileNames) {
          try {
            const p = resolve(archiveDir, legacyFile);
            if (existsSync(p)) await unlink(p);
          } catch {
            // best effort
          }
        }
      } catch {
        result.errors++;
      }
    }

    if (result.migrated > 0) {
      console.log(
        `[archiver] Migrated ${result.migrated} legacy files into daily archives`,
      );
    }
  } catch (err) {
    console.error(`[archiver] Migration error: ${err.message}`);
    result.errors++;
  }
  return result;
}

/**
 * Main archiver function — runs during maintenance sweep.
 *
 * @param {function} fetchVk - VK API fetch function
 * @param {string} projectId - VK project ID
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - if true, archive to file but don't delete from VK
 * @param {number} [options.maxArchive=50] - max tasks to archive per cycle
 * @param {number} [options.ageHours] - override age threshold
 * @param {boolean} [options.prune=true] - prune old archives
 * @param {string} [options.archiveDir] - override archive directory
 * @returns {Promise<{ archived: number, deleted: number, skipped: number, sessionsCleaned: number, pruned: number, migrated: number, errors: number }>}
 */
export async function archiveCompletedTasks(fetchVk, projectId, options = {}) {
  const dryRun = options.dryRun ?? false;
  const maxArchive = options.maxArchive ?? DEFAULT_MAX_ARCHIVE;
  const ageHours = options.ageHours ?? ARCHIVE_AGE_HOURS;
  const shouldPrune = options.prune ?? true;
  const archiveDir = options.archiveDir ?? ARCHIVE_DIR;

  console.log(
    `[archiver] Scanning for completed tasks older than ${ageHours}h...`,
  );

  const result = {
    archived: 0,
    deleted: 0,
    skipped: 0,
    sessionsCleaned: 0,
    pruned: 0,
    migrated: 0,
    errors: 0,
  };

  try {
    // Auto-migrate legacy per-task files on every sweep
    const migration = await migrateLegacyArchives(archiveDir);
    result.migrated = migration.migrated;

    const completedTasks = await fetchCompletedTasks(fetchVk, projectId);
    const oldTasks = completedTasks.filter((t) =>
      isOldEnoughToArchive(t, { ageHours }),
    );

    if (oldTasks.length === 0) {
      console.log(`[archiver] No old completed tasks to archive`);
    } else {
      console.log(
        `[archiver] Found ${oldTasks.length} tasks to archive (limit: ${maxArchive})`,
      );

      for (const task of oldTasks.slice(0, maxArchive)) {
        // Skip already-archived tasks (idempotent guard)
        if (await isAlreadyArchived(task.id, archiveDir)) {
          result.skipped++;
          continue;
        }

        // Archive to file first
        const archivePath = await archiveTaskToFile(task, null, archiveDir);
        if (!archivePath) {
          result.errors++;
          continue;
        }

        result.archived++;
        console.log(
          `[archiver] Archived task "${task.title}" (${task.id.substring(0, 8)})`,
        );

        // Clean up agent sessions (best-effort, never blocks)
        if (!dryRun) {
          const attemptId = task.latest_attempt_id || task.attempt_id || "";
          const sessionsCleanedForTask = await cleanupAgentSessions(
            task.id,
            attemptId,
          );
          if (sessionsCleanedForTask > 0) {
            result.sessionsCleaned += sessionsCleanedForTask;
            console.log(
              `[archiver] Cleaned ${sessionsCleanedForTask} agent session(s) for task "${task.title}"`,
            );
          }
        }

        // Delete from VK unless dry-run
        if (!dryRun) {
          const deleteSuccess = await deleteTaskFromVK(fetchVk, task.id);
          if (deleteSuccess) {
            result.deleted++;
          } else {
            console.warn(
              `[archiver] Failed to delete task "${task.title}" (${task.id.substring(0, 8)}) from VK`,
            );
          }
        }
      }
    }

    // Prune old archives beyond retention period
    if (shouldPrune) {
      result.pruned = await pruneOldArchives({ archiveDir });
    }

    return result;
  } catch (err) {
    console.error(`[archiver] Archive sweep failed: ${err.message}`);
    result.errors++;
    return result;
  }
}

/**
 * Load archived tasks for sprint review.
 * Reads both daily grouped files (v3) and legacy per-task files (v2).
 *
 * @param {object} [options]
 * @param {string|Date} [options.since] - include archives after this date
 * @param {string|Date} [options.until] - include archives before this date
 * @param {string} [options.status] - filter by task status
 * @param {string} [options.archiveDir] - override archive directory
 * @returns {Promise<object[]>}
 */
export async function loadArchivedTasks(options = {}) {
  const since = options.since ? new Date(options.since) : null;
  const until = options.until ? new Date(options.until) : null;
  const statusFilter = options.status ?? null;
  const archiveDir = options.archiveDir ?? ARCHIVE_DIR;

  try {
    if (!existsSync(archiveDir)) {
      return [];
    }

    const files = await readdir(archiveDir);
    const jsonFiles = files.filter(
      (f) => f.endsWith(".json") && !f.startsWith(".tmp-"),
    );
    const archivedTasks = [];

    for (const file of jsonFiles) {
      try {
        const filePath = resolve(archiveDir, file);
        const content = await readFile(filePath, "utf8");
        const data = JSON.parse(content);

        // Daily grouped file: array of entries
        if (Array.isArray(data)) {
          for (const entry of data) {
            if (matchesFilters(entry, since, until, statusFilter)) {
              archivedTasks.push(entry);
            }
          }
          continue;
        }

        // Legacy single-task file: object with { task, archived_at, ... }
        if (data && typeof data === "object" && data.task) {
          if (matchesFilters(data, since, until, statusFilter)) {
            archivedTasks.push(data);
          }
        }
      } catch {
        // Skip corrupted files silently
      }
    }

    return archivedTasks.sort(
      (a, b) => new Date(b.archived_at) - new Date(a.archived_at),
    );
  } catch (err) {
    console.error(`[archiver] Failed to load archived tasks: ${err.message}`);
    return [];
  }
}

/**
 * Check if an archive entry matches the given filters.
 */
function matchesFilters(entry, since, until, statusFilter) {
  const archivedAt = new Date(entry.archived_at);
  if (since && archivedAt < since) return false;
  if (until && archivedAt > until) return false;
  if (statusFilter && entry.task?.status !== statusFilter) return false;
  return true;
}

/**
 * Generate sprint review report from archived tasks.
 * @param {object[]} archivedTasks
 * @returns {object}
 */
export function generateSprintReport(archivedTasks) {
  if (!Array.isArray(archivedTasks))
    return { total: 0, by_status: {}, by_priority: {}, by_date: {}, tasks: [] };

  const report = {
    total: archivedTasks.length,
    by_status: {},
    by_priority: {},
    by_date: {},
    tasks: [],
  };

  for (const item of archivedTasks) {
    const task = item.task;
    if (!task) continue;

    const completedAt = new Date(task.completed_at || task.updated_at);
    const dateStr = isNaN(completedAt.getTime())
      ? "unknown"
      : completedAt.toISOString().split("T")[0];

    // Group by status
    report.by_status[task.status] = (report.by_status[task.status] || 0) + 1;

    // Group by priority
    const priority = task.priority || "unknown";
    report.by_priority[priority] = (report.by_priority[priority] || 0) + 1;

    // Group by date
    report.by_date[dateStr] = (report.by_date[dateStr] || 0) + 1;

    // Add task summary
    report.tasks.push({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      completed_at: task.completed_at,
      archived_at: item.archived_at,
    });
  }

  return report;
}

/**
 * Format sprint report as text for Telegram/console.
 * @param {object} report
 * @returns {string}
 */
export function formatSprintReport(report) {
  if (!report || typeof report !== "object") return "No report data.";

  const lines = [];
  lines.push("=== Sprint Review Report ===");
  lines.push(`Total Tasks Completed: ${report.total ?? 0}`);
  lines.push("");

  if (report.by_status && Object.keys(report.by_status).length > 0) {
    lines.push("By Status:");
    for (const [status, count] of Object.entries(report.by_status)) {
      lines.push(`  ${status}: ${count}`);
    }
    lines.push("");
  }

  if (report.by_priority && Object.keys(report.by_priority).length > 0) {
    lines.push("By Priority:");
    for (const [priority, count] of Object.entries(report.by_priority)) {
      lines.push(`  ${priority}: ${count}`);
    }
    lines.push("");
  }

  if (report.by_date && Object.keys(report.by_date).length > 0) {
    lines.push("By Date:");
    for (const [date, count] of Object.entries(report.by_date)) {
      lines.push(`  ${date}: ${count} tasks`);
    }
    lines.push("");
  }

  if (Array.isArray(report.tasks) && report.tasks.length > 0) {
    lines.push("Recent Tasks:");
    for (const task of report.tasks.slice(0, 10)) {
      const title = (task.title || "untitled").substring(0, 60);
      const shortId = (task.id || "?").substring(0, 8);
      lines.push(`  [${task.status || "?"}] ${title} (${shortId})`);
    }
  }

  return lines.join("\n");
}
