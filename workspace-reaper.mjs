import { execSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  loadSharedWorkspaceRegistry,
  saveSharedWorkspaceRegistry,
  sweepExpiredLeases,
} from "./shared-workspace-registry.mjs";

/**
 * workspace-reaper.mjs
 *
 * Cleans up expired workspace leases and orphaned git worktrees after crashes.
 * Implements safety checks to avoid deleting active workspaces.
 */

const DEFAULT_ORPHAN_THRESHOLD_HOURS = 24;
const DEFAULT_AGGRESSIVE_THRESHOLD_HOURS = 1; // For completed task cleanup
const DEFAULT_PROCESS_CHECK_RETRIES = 3;
const IS_WINDOWS = process.platform === "win32";

function buildGitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function ensureIso(date) {
  return new Date(date).toISOString();
}

/**
 * Check if a process is running by PID
 */
function isProcessRunning(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract PIDs from common lock files or process indicators
 */
function extractPidsFromPath(worktreePath) {
  const pids = new Set();
  const lockPaths = [
    resolve(worktreePath, ".git", "index.lock"),
    resolve(worktreePath, ".openfleet.pid"),
    resolve(worktreePath, ".vk-executor.pid"),
  ];
  for (const lockPath of lockPaths) {
    if (!existsSync(lockPath)) continue;
    try {
      const content = readFileSync(lockPath, "utf8").trim();
      const pidMatch = /^\d+$/.test(content) ? Number(content) : null;
      if (pidMatch && pidMatch > 0) {
        pids.add(pidMatch);
      }
    } catch {
      // Ignore errors reading lock files
    }
  }
  return Array.from(pids);
}

/**
 * Cross-platform sleep
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if a worktree path has any active processes
 */
async function hasActiveProcesses(worktreePath, options = {}) {
  const retries = options.retries || DEFAULT_PROCESS_CHECK_RETRIES;
  const pids = extractPidsFromPath(worktreePath);
  if (pids.length === 0) return false;
  
  for (let i = 0; i < retries; i++) {
    for (const pid of pids) {
      if (isProcessRunning(pid)) {
        return true;
      }
    }
    if (i < retries - 1) {
      // Wait a bit before retry
      await sleep(1000);
    }
  }
  return false;
}

/**
 * Get last modified time of most recently modified file in directory
 */
async function getLastModifiedTime(dirPath) {
  try {
    if (!existsSync(dirPath)) return null;
    let latestMtime = null;
    const entries = await readdir(dirPath, { withFileTypes: true, recursive: false });
    for (const entry of entries) {
      if (entry.name === ".git") {
        continue;
      }
      const fullPath = resolve(dirPath, entry.name);
      try {
        const stats = await stat(fullPath);
        if (!latestMtime || stats.mtime > latestMtime) {
          latestMtime = stats.mtime;
        }
      } catch {
        // Ignore errors on individual files
      }
    }
    return latestMtime;
  } catch {
    return null;
  }
}

/**
 * Check if a worktree is truly orphaned (safe to delete)
 */
async function isWorktreeOrphaned(worktreePath, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const thresholdHours = options.orphanThresholdHours || DEFAULT_ORPHAN_THRESHOLD_HOURS;
  
  // Safety check 1: Path must exist
  if (!existsSync(worktreePath)) {
    return { orphaned: false, reason: "path_not_found" };
  }
  
  // Safety check 2: No active processes
  if (await hasActiveProcesses(worktreePath, options)) {
    return { orphaned: false, reason: "active_process" };
  }
  
  // Safety check 3: Check last modified time
  const lastModified = await getLastModifiedTime(worktreePath);
  if (lastModified) {
    const ageHours = (now.getTime() - lastModified.getTime()) / (1000 * 60 * 60);
    if (ageHours < thresholdHours) {
      return { orphaned: false, reason: "recently_modified", ageHours };
    }
  }
  
  // Safety check 4: Check git status for uncommitted work
  // Only check git status if .git is a FILE (proper worktree), not a directory
  const gitPath = resolve(worktreePath, ".git");
  const isProperWorktree = existsSync(gitPath) && !statSync(gitPath).isDirectory();

  if (isProperWorktree) {
    try {
      const cmd = IS_WINDOWS
        ? `cd /d "${worktreePath}" && git status --porcelain`
        : `cd "${worktreePath}" && git status --porcelain`;
      const gitStatus = execSync(cmd, {
        encoding: "utf8",
        env: buildGitEnv(),
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      if (gitStatus.length > 0) {
        return { orphaned: false, reason: "uncommitted_changes" };
      }
    } catch {
      // If git command fails, worktree might be corrupted - consider orphaned
    }
  }

  return { orphaned: true, lastModified, ageHours: lastModified ? (now.getTime() - lastModified.getTime()) / (1000 * 60 * 60) : null };
}

/**
 * Find git worktrees in a given directory
 */
async function findGitWorktrees(searchPath) {
  const worktrees = [];
  try {
    if (!existsSync(searchPath)) return worktrees;
    const entries = await readdir(searchPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = resolve(searchPath, entry.name);
      const gitPath = resolve(fullPath, ".git");
      if (existsSync(gitPath)) {
        worktrees.push({
          path: fullPath,
          name: entry.name,
        });
      }
    }
  } catch (err) {
    console.warn(`[workspace-reaper] failed to scan ${searchPath}: ${err.message || err}`);
  }
  return worktrees;
}

/**
 * Clean orphaned worktrees with safety checks
 */
export async function cleanOrphanedWorktrees(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const searchPaths = Array.isArray(options.searchPaths)
    ? options.searchPaths
    : [process.env.VK_WORKTREE_BASE || "/tmp/vibe-kanban/worktrees"];
  
  const results = {
    scanned: 0,
    cleaned: 0,
    skipped: 0,
    errors: [],
    cleaned_paths: [],
    skipped_reasons: {},
  };
  
  for (const searchPath of searchPaths) {
    const worktrees = await findGitWorktrees(searchPath);
    for (const worktree of worktrees) {
      results.scanned++;
      const orphanCheck = await isWorktreeOrphaned(worktree.path, options);
      
      if (!orphanCheck.orphaned) {
        results.skipped++;
        const reason = orphanCheck.reason || "unknown";
        results.skipped_reasons[reason] = (results.skipped_reasons[reason] || 0) + 1;
        continue;
      }
      
      // Safe to delete
      if (options.dryRun) {
        results.cleaned_paths.push({
          path: worktree.path,
          dryRun: true,
          ageHours: orphanCheck.ageHours,
        });
        results.cleaned++;
        continue;
      }
      
      try {
        await rm(worktree.path, { recursive: true, force: true });
        results.cleaned++;
        results.cleaned_paths.push({
          path: worktree.path,
          ageHours: orphanCheck.ageHours,
          cleanedAt: ensureIso(now),
        });
      } catch (err) {
        results.errors.push({
          path: worktree.path,
          error: err.message || String(err),
        });
      }
    }
  }
  
  return results;
}

/**
 * Prune git worktree metadata
 * Removes stale entries from .git/worktrees/
 */
export async function pruneWorktreeMetadata(repoPath, options = {}) {
  const results = {
    pruned: 0,
    errors: [],
  };

  try {
    const gitEnv = buildGitEnv();
    execSync('git worktree prune', {
      cwd: repoPath,
      stdio: options.verbose ? 'inherit' : 'pipe',
      env: { ...gitEnv, GIT_EDITOR: ':', GIT_MERGE_AUTOEDIT: 'no' },
    });
    results.pruned++;
  } catch (err) {
    results.errors.push(err.message || String(err));
  }

  return results;
}

/**
 * Get worktree count for monitoring
 */
export async function getWorktreeCount(repoPath) {
  try {
    const gitEnv = buildGitEnv();
    const output = execSync('git worktree list --porcelain', {
      cwd: repoPath,
      encoding: 'utf8',
      env: gitEnv,
    });
    // Count "worktree" lines (one per worktree including main)
    const count = (output.match(/^worktree /gm) || []).length;
    return count - 1; // Subtract 1 for main worktree
  } catch {
    return 0;
  }
}

/**
 * Run full reaper sweep: expired leases + orphaned worktrees
 */
export async function runReaperSweep(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const results = {
    timestamp: ensureIso(now),
    leases: {
      expired: 0,
      cleaned: 0,
      errors: [],
    },
    worktrees: {
      scanned: 0,
      cleaned: 0,
      skipped: 0,
      errors: [],
    },
  };
  
  // Step 1: Sweep expired leases
  try {
    const leaseResult = await sweepExpiredLeases({ ...options, now });
    results.leases.expired = leaseResult.expired?.length || 0;
    results.leases.cleaned = leaseResult.expired?.length || 0;
  } catch (err) {
    results.leases.errors.push(err.message || String(err));
  }
  
  // Step 2: Clean orphaned worktrees
  try {
    const worktreeResult = await cleanOrphanedWorktrees({ ...options, now });
    results.worktrees.scanned = worktreeResult.scanned;
    results.worktrees.cleaned = worktreeResult.cleaned;
    results.worktrees.skipped = worktreeResult.skipped;
    results.worktrees.errors = worktreeResult.errors || [];
    results.worktrees.skipped_reasons = worktreeResult.skipped_reasons || {};
    results.worktrees.cleaned_paths = worktreeResult.cleaned_paths || [];
  } catch (err) {
    results.worktrees.errors.push({ error: err.message || String(err) });
  }
  
  return results;
}

/**
 * Format reaper results for logging
 */
export function formatReaperResults(results) {
  const lines = [];
  lines.push(`[workspace-reaper] Sweep completed at ${results.timestamp}`);
  
  if (results.leases) {
    lines.push(`  Leases: ${results.leases.expired} expired, ${results.leases.cleaned} cleaned`);
    if (results.leases.errors.length > 0) {
      lines.push(`  Lease errors: ${results.leases.errors.length}`);
    }
  }
  
  if (results.worktrees) {
    lines.push(
      `  Worktrees: ${results.worktrees.scanned} scanned, ${results.worktrees.cleaned} cleaned, ${results.worktrees.skipped} skipped`,
    );
    if (results.worktrees.skipped_reasons) {
      for (const [reason, count] of Object.entries(results.worktrees.skipped_reasons)) {
        lines.push(`    - ${reason}: ${count}`);
      }
    }
    if (results.worktrees.errors.length > 0) {
      lines.push(`  Worktree errors: ${results.worktrees.errors.length}`);
    }
  }
  
  return lines.join("\n");
}

/**
 * Calculate reaper metrics for monitoring
 */
export function calculateReaperMetrics(results) {
  return {
    timestamp: results.timestamp,
    leases_expired: results.leases?.expired || 0,
    leases_cleaned: results.leases?.cleaned || 0,
    lease_errors: results.leases?.errors?.length || 0,
    worktrees_scanned: results.worktrees?.scanned || 0,
    worktrees_cleaned: results.worktrees?.cleaned || 0,
    worktrees_skipped: results.worktrees?.skipped || 0,
    worktree_errors: results.worktrees?.errors?.length || 0,
    total_cleaned: (results.leases?.cleaned || 0) + (results.worktrees?.cleaned || 0),
    total_errors: (results.leases?.errors?.length || 0) + (results.worktrees?.errors?.length || 0),
  };
}
