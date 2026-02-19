/**
 * maintenance.mjs - Process hygiene and cleanup for openfleet.
 *
 * Handles:
 *  - Killing stale orchestrator processes from previous runs
 *  - Reaping stuck git push processes (>5 min)
 *  - Pruning broken/orphaned git worktrees
 *  - Monitor singleton enforcement via PID file
 *  - Periodic maintenance sweeps
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  pruneStaleWorktrees,
  getWorktreeStats,
  fixGitConfigCorruption,
} from "./worktree-manager.mjs";

const isWindows = process.platform === "win32";

/**
 * Get all running processes matching a filter.
 * Returns [{pid, commandLine, creationDate}].
 */
function getProcesses(filter) {
  if (!isWindows) {
    // Linux/macOS: use ps
    try {
      const out = execSync(`ps -eo pid,lstart,args 2>/dev/null`, {
        encoding: "utf8",
        timeout: 10000,
      });
      const lines = out.trim().split("\n").slice(1);
      return lines
        .map((line) => {
          const m = line.trim().match(/^(\d+)\s+(.+?\d{4})\s+(.+)$/);
          if (!m) return null;
          return {
            pid: Number(m[1]),
            creationDate: new Date(m[2]),
            commandLine: m[3],
          };
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // Windows: use PowerShell to get process info (WMI is more reliable for CommandLine)
  try {
    const cmd = `Get-CimInstance Win32_Process ${filter ? `-Filter "${filter}"` : ""} | Select-Object ProcessId, CommandLine, CreationDate | ConvertTo-Json -Compress`;
    const out = spawnSync("powershell", ["-NoProfile", "-Command", cmd], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    if (out.status !== 0 || !out.stdout.trim()) return [];
    const parsed = JSON.parse(out.stdout);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter((p) => p && p.ProcessId)
      .map((p) => ({
        pid: p.ProcessId,
        commandLine: p.CommandLine || "",
        creationDate: p.CreationDate
          ? new Date(p.CreationDate.replace(/\/Date\((\d+)\)\//, "$1") * 1)
          : null,
      }));
  } catch {
    return [];
  }
}

/**
 * Kill a process by PID with force.
 */
function killPid(pid, label) {
  try {
    if (isWindows) {
      spawnSync("taskkill", ["/F", "/PID", String(pid)], {
        timeout: 5000,
        windowsHide: true,
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
    console.log(`[maintenance] killed ${label || "process"} (PID ${pid})`);
    return true;
  } catch (e) {
    // Process may already be gone
    if (e.code !== "ESRCH") {
      console.warn(`[maintenance] failed to kill PID ${pid}: ${e.message}`);
    }
    return false;
  }
}

/**
 * Kill stale orchestrator processes (pwsh running ve-orchestrator.ps1).
 * Skips our own child if childPid is provided.
 */
export function killStaleOrchestrators(childPid) {
  const myPid = process.pid;
  const procs = getProcesses("Name='pwsh.exe'");
  let killed = 0;

  for (const p of procs) {
    if (p.pid === myPid || p.pid === childPid) continue;
    if (p.commandLine && p.commandLine.includes("ve-orchestrator.ps1")) {
      killPid(p.pid, "stale orchestrator");
      killed++;
    }
  }

  if (killed > 0) {
    console.log(
      `[maintenance] killed ${killed} stale orchestrator process(es)`,
    );
  }
  return killed;
}

/**
 * Kill git push processes that have been running longer than maxAgeMs.
 * Default: 5 minutes. These get stuck on network issues or lock contention.
 */
export function reapStuckGitPushes(maxAgeMs = 15 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  const filterName = isWindows
    ? "Name='pwsh.exe' OR Name='git.exe' OR Name='bash.exe'"
    : null;
  const procs = getProcesses(filterName);
  let killed = 0;

  for (const p of procs) {
    if (!p.commandLine) continue;
    // Match git push commands (direct or via pwsh/bash wrappers)
    const isGitPush =
      p.commandLine.includes("git push") ||
      p.commandLine.includes("git.exe push");
    if (!isGitPush) continue;

    // Check age
    if (p.creationDate && p.creationDate.getTime() < cutoff) {
      killPid(
        p.pid,
        `stuck git push (age ${Math.round((Date.now() - p.creationDate.getTime()) / 60000)}min)`,
      );
      killed++;
    }
  }

  if (killed > 0) {
    console.log(`[maintenance] reaped ${killed} stuck git push process(es)`);
  }
  return killed;
}

/**
 * Prune broken git worktrees and remove orphaned temp directories.
 */
export function cleanupWorktrees(repoRoot) {
  let pruned = 0;

  // 1. `git worktree prune` removes entries whose directories no longer exist
  try {
    spawnSync("git", ["worktree", "prune"], {
      cwd: repoRoot,
      timeout: 15000,
      windowsHide: true,
    });
    console.log("[maintenance] git worktree prune completed");
    pruned++;
  } catch (e) {
    console.warn(`[maintenance] git worktree prune failed: ${e.message}`);
  }

  // 2. List remaining worktrees and check for stale VK temp ones
  try {
    const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    if (result.stdout) {
      const entries = result.stdout.split(/\n\n/).filter(Boolean);
      for (const entry of entries) {
        const pathMatch = entry.match(/^worktree\s+(.+)/m);
        if (!pathMatch) continue;
        const wtPath = pathMatch[1].trim();
        // Only touch vibe-kanban temp worktrees
        if (!wtPath.includes("vibe-kanban") || wtPath === repoRoot) continue;
        // Check if the path exists on disk
        if (!existsSync(wtPath)) {
          console.log(
            `[maintenance] removing orphaned worktree entry: ${wtPath}`,
          );
          try {
            spawnSync("git", ["worktree", "remove", "--force", wtPath], {
              cwd: repoRoot,
              timeout: 10000,
              windowsHide: true,
            });
            pruned++;
          } catch {
            /* best effort */
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[maintenance] worktree list check failed: ${e.message}`);
  }

  // 3. Clean up old copilot-worktree entries (older than 7 days)
  try {
    const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    if (result.stdout) {
      const entries = result.stdout.split(/\n\n/).filter(Boolean);
      for (const entry of entries) {
        const pathMatch = entry.match(/^worktree\s+(.+)/m);
        if (!pathMatch) continue;
        const wtPath = pathMatch[1].trim();
        if (wtPath === repoRoot) continue;
        // copilot-worktree-YYYY-MM-DD format
        const dateMatch = wtPath.match(/copilot-worktree-(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) continue;
        const wtDate = new Date(dateMatch[1]);
        const ageMs = Date.now() - wtDate.getTime();
        if (ageMs > 7 * 24 * 60 * 60 * 1000) {
          console.log(`[maintenance] removing old copilot worktree: ${wtPath}`);
          try {
            spawnSync("git", ["worktree", "remove", "--force", wtPath], {
              cwd: repoRoot,
              timeout: 15000,
              windowsHide: true,
            });
            pruned++;
          } catch {
            /* best effort */
          }
        }
      }
    }
  } catch {
    /* best effort */
  }

  return pruned;
}

// ── Stale Branch Cleanup ────────────────────────────────────────────────

/**
 * Clean up old local branches created by codex/vibe-kanban automation.
 *
 * Targets branches matching `ve/*` and `copilot-worktree-*` patterns.
 *
 * Safety checks before deleting a branch:
 *  1. Not the currently checked-out branch
 *  2. Not checked out in any active worktree
 *  3. Has a corresponding remote branch (was pushed) OR has been merged
 *  4. Local and remote refs match (no unpushed local commits)
 *  5. Last commit is older than `minAgeMs` (default 24 hours)
 *
 * @param {string} repoRoot - repository root path
 * @param {object} [opts]
 * @param {number}  [opts.minAgeMs=86400000] - minimum age in ms (default 24h)
 * @param {boolean} [opts.dryRun=false] - if true, log but don't delete
 * @param {string[]} [opts.protectedBranches] - branches to never delete (default: ["main","mainnet/main"])
 * @param {string[]} [opts.patterns] - branch glob prefixes to target (default: ["ve/","copilot-worktree-"])
 * @returns {{ deleted: string[], skipped: { branch: string, reason: string }[], errors: string[] }}
 */
export function cleanupStaleBranches(repoRoot, opts = {}) {
  const {
    minAgeMs = 24 * 60 * 60 * 1000,
    dryRun = false,
    protectedBranches = ["main", "mainnet/main"],
    patterns = ["ve/", "copilot-worktree-"],
  } = opts;

  const result = { deleted: [], skipped: [], errors: [] };
  if (!repoRoot) return result;

  // 1. Get currently checked-out branch
  let currentBranch = null;
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (r.status === 0) currentBranch = r.stdout.trim();
  } catch {
    /* best effort */
  }

  // 2. Get branches checked out in worktrees (cannot delete these)
  const worktreeBranches = new Set();
  try {
    const r = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    if (r.status === 0 && r.stdout) {
      for (const entry of r.stdout.split(/\n\n/).filter(Boolean)) {
        const branchMatch = entry.match(/^branch\s+refs\/heads\/(.+)/m);
        if (branchMatch) worktreeBranches.add(branchMatch[1]);
      }
    }
  } catch {
    /* best effort */
  }

  // 3. List all local branches
  let localBranches;
  try {
    const r = spawnSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
      { cwd: repoRoot, encoding: "utf8", timeout: 10000, windowsHide: true },
    );
    if (r.status !== 0 || !r.stdout) return result;
    localBranches = r.stdout.trim().split("\n").filter(Boolean);
  } catch (e) {
    result.errors.push(`Failed to list branches: ${e.message}`);
    return result;
  }

  // 4. Filter to target patterns only
  const targetBranches = localBranches.filter((b) =>
    patterns.some((p) => b.startsWith(p)),
  );

  if (targetBranches.length === 0) return result;

  const cutoff = Date.now() - minAgeMs;

  for (const branch of targetBranches) {
    // Skip protected branches
    if (protectedBranches.includes(branch)) {
      result.skipped.push({ branch, reason: "protected" });
      continue;
    }

    // Skip currently checked-out branch
    if (branch === currentBranch) {
      result.skipped.push({ branch, reason: "checked-out" });
      continue;
    }

    // Skip branches checked out in worktrees
    if (worktreeBranches.has(branch)) {
      result.skipped.push({ branch, reason: "active-worktree" });
      continue;
    }

    // Check last commit date
    try {
      const dateResult = spawnSync(
        "git",
        ["log", "-1", "--format=%ct", branch],
        { cwd: repoRoot, encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      if (dateResult.status !== 0 || !dateResult.stdout.trim()) {
        result.skipped.push({ branch, reason: "no-commit-date" });
        continue;
      }
      const commitEpoch = parseInt(dateResult.stdout.trim(), 10) * 1000;
      if (commitEpoch > cutoff) {
        result.skipped.push({ branch, reason: "too-recent" });
        continue;
      }
    } catch {
      result.skipped.push({ branch, reason: "date-check-failed" });
      continue;
    }

    // Check if remote tracking branch exists and is in sync
    const remoteRef = `origin/${branch}`;
    const remoteExists = spawnSync(
      "git",
      ["rev-parse", "--verify", `refs/remotes/${remoteRef}`],
      { cwd: repoRoot, timeout: 5000, windowsHide: true },
    );

    if (remoteExists.status === 0) {
      // Remote exists — check if local is ahead (unpushed commits)
      const aheadCheck = spawnSync(
        "git",
        ["rev-list", "--count", `${remoteRef}..${branch}`],
        { cwd: repoRoot, encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      const ahead = parseInt(aheadCheck.stdout?.trim(), 10) || 0;
      if (ahead > 0) {
        result.skipped.push({ branch, reason: "unpushed-commits" });
        continue;
      }
    } else {
      // No remote — check if merged into main (safe to delete if merged)
      const mergedCheck = spawnSync(
        "git",
        ["branch", "--merged", "main", "--list", branch],
        { cwd: repoRoot, encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      const isMerged = mergedCheck.stdout?.trim() === branch;
      if (!isMerged) {
        result.skipped.push({ branch, reason: "not-pushed-not-merged" });
        continue;
      }
    }

    // All checks passed — delete the branch
    if (dryRun) {
      console.log(`[maintenance] would delete stale branch: ${branch}`);
      result.deleted.push(branch);
    } else {
      try {
        const del = spawnSync("git", ["branch", "-D", branch], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 10000,
          windowsHide: true,
        });
        if (del.status === 0) {
          console.log(`[maintenance] deleted stale branch: ${branch}`);
          result.deleted.push(branch);
        } else {
          const err = (del.stderr || del.stdout || "").trim();
          result.errors.push(`${branch}: ${err}`);
        }
      } catch (e) {
        result.errors.push(`${branch}: ${e.message}`);
      }
    }
  }

  if (result.deleted.length > 0) {
    console.log(
      `[maintenance] branch cleanup: ${result.deleted.length} deleted, ${result.skipped.length} skipped, ${result.errors.length} errors`,
    );
  }

  return result;
}

// ── Monitor Singleton via PID file ──────────────────────────────────────

const PID_FILE_NAME = "openfleet.pid";
const MONITOR_MARKER = "openfleet/monitor.mjs";

function parsePidFile(raw) {
  const text = String(raw || "").trim();
  if (!text) return { pid: null, raw: text };
  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      return { pid: Number(data?.pid), raw: text, data };
    } catch {
      return { pid: Number(text), raw: text };
    }
  }
  return { pid: Number(text), raw: text };
}

function getProcessCommandLine(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return "";
  const processes = getProcesses();
  const entry = processes.find((p) => Number(p.pid) === Number(pid));
  return entry?.commandLine || "";
}

function isMonitorProcess(pid) {
  const cmd = getProcessCommandLine(pid);
  if (!cmd) return false;
  const normalized = cmd.toLowerCase();
  if (normalized.includes(MONITOR_MARKER)) return true;
  return normalized.includes("openfleet") && normalized.includes("monitor.mjs");
}

/**
 * Acquire a singleton lock by writing our PID file.
 * If a stale monitor is detected (PID file exists but process dead), clean up and take over.
 * Returns true if we acquired the lock, false if another monitor is actually running.
 */
export function acquireMonitorLock(lockDir) {
  const pidFile = resolve(lockDir, PID_FILE_NAME);

  if (existsSync(pidFile)) {
    try {
      const raw = readFileSync(pidFile, "utf8");
      const parsed = parsePidFile(raw);
      const existingPid = parsed.pid;
      if (
        existingPid &&
        existingPid !== process.pid &&
        isProcessAlive(existingPid)
      ) {
        if (isMonitorProcess(existingPid)) {
          console.error(
            `[maintenance] another openfleet is already running (PID ${existingPid}). Exiting.`,
          );
          return false;
        }
        console.warn(
          `[maintenance] PID file points to non-monitor process (PID ${existingPid}); replacing lock`,
        );
      }
      // Stale PID file — previous monitor crashed without cleanup
      console.warn(
        `[maintenance] removing stale PID file (PID ${parsed.raw || "unknown"} no longer alive)`,
      );
    } catch {
      // Can't read PID file — just overwrite
    }
  }

  try {
    const payload = {
      pid: process.pid,
      started_at: new Date().toISOString(),
      argv: process.argv,
    };
    writeFileSync(pidFile, JSON.stringify(payload, null, 2), "utf8");
    // Clean up on exit
    const cleanup = () => {
      try {
        const current = parsePidFile(readFileSync(pidFile, "utf8")).pid;
        if (Number(current) === process.pid) {
          unlinkSync(pidFile);
        }
      } catch {
        /* best effort */
      }
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
    console.log(`[maintenance] monitor PID file written: ${pidFile}`);
    return true;
  } catch (e) {
    console.warn(`[maintenance] failed to write PID file: ${e.message}`);
    return true; // Don't block startup on PID file failure
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // Signal 0 = check existence, don't actually kill
    return true;
  } catch {
    return false;
  }
}

// ── Full Maintenance Sweep ──────────────────────────────────────────────

/**
 * Fast-forward local tracking branches (e.g. main) to match origin.
 *
 * When local `main` falls behind `origin/main`, new worktrees and task
 * branches spawned from it start stale, causing avoidable rebase conflicts.
 * This function periodically pulls so the local ref stays current.
 *
 * Safe: only does `--ff-only` — never creates merge commits. If the local
 * branch has diverged (someone committed directly), it logs a warning and
 * skips.  Also skips if the branch is currently checked out with uncommitted
 * work (git will refuse the checkout anyway).
 *
 * @param {string} repoRoot
 * @param {string[]} [branches] - branches to sync (default: ["main"])
 * @returns {number} count of branches successfully synced
 */
export function syncLocalTrackingBranches(repoRoot, branches) {
  if (!repoRoot) return 0;
  const toSync = branches && branches.length ? branches : ["main"];
  let synced = 0;

  // 1. Fetch all remotes first (single network call)
  try {
    spawnSync("git", ["fetch", "--all", "--prune", "--quiet"], {
      cwd: repoRoot,
      timeout: 60_000,
      windowsHide: true,
    });
  } catch (e) {
    console.warn(`[maintenance] git fetch --all failed: ${e.message}`);
    return 0;
  }

  // 2. Determine which branch is currently checked out (so we can handle it)
  let currentBranch = null;
  try {
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status === 0) currentBranch = result.stdout.trim();
  } catch {
    /* best effort */
  }

  for (const branch of toSync) {
    try {
      // Check if local branch exists
      const refCheck = spawnSync(
        "git",
        ["rev-parse", "--verify", `refs/heads/${branch}`],
        { cwd: repoRoot, timeout: 5000, windowsHide: true },
      );
      if (refCheck.status !== 0) {
        // Local branch doesn't exist — nothing to sync
        continue;
      }

      // Check if remote tracking ref exists
      const remoteRef = `origin/${branch}`;
      const remoteCheck = spawnSync(
        "git",
        ["rev-parse", "--verify", `refs/remotes/${remoteRef}`],
        { cwd: repoRoot, timeout: 5000, windowsHide: true },
      );
      if (remoteCheck.status !== 0) continue;

      // Compare: is local behind?
      const behindCheck = spawnSync(
        "git",
        ["rev-list", "--count", `${branch}..${remoteRef}`],
        { cwd: repoRoot, encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      const behind = parseInt(behindCheck.stdout?.trim(), 10) || 0;
      if (behind === 0) continue; // Already up to date

      // Check if local has commits not in remote (diverged)
      const aheadCheck = spawnSync(
        "git",
        ["rev-list", "--count", `${remoteRef}..${branch}`],
        { cwd: repoRoot, encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      const ahead = parseInt(aheadCheck.stdout?.trim(), 10) || 0;
      if (ahead > 0) {
        console.warn(
          `[maintenance] local '${branch}' has ${ahead} commit(s) ahead of ${remoteRef} — skipping (diverged)`,
        );
        continue;
      }

      // If this is the currently checked-out branch, use git pull --ff-only
      if (branch === currentBranch) {
        // Check for uncommitted changes — skip if dirty
        const statusCheck = spawnSync("git", ["status", "--porcelain"], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        });
        if (statusCheck.stdout?.trim()) {
          console.warn(
            `[maintenance] '${branch}' is checked out with uncommitted changes — skipping pull`,
          );
          continue;
        }

        const pull = spawnSync("git", ["pull", "--ff-only", "--quiet"], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        });
        if (pull.status === 0) {
          console.log(
            `[maintenance] fast-forwarded checked-out '${branch}' (was ${behind} behind)`,
          );
          synced++;
        } else {
          console.warn(
            `[maintenance] git pull --ff-only on '${branch}' failed: ${(pull.stderr || pull.stdout || "").toString().trim()}`,
          );
        }
      } else {
        // Not checked out — use git fetch to update the local ref directly
        // This is safe because no worktree has it checked out
        const update = spawnSync(
          "git",
          ["update-ref", `refs/heads/${branch}`, `refs/remotes/${remoteRef}`],
          { cwd: repoRoot, timeout: 5000, windowsHide: true },
        );
        if (update.status === 0) {
          console.log(
            `[maintenance] fast-forwarded '${branch}' → ${remoteRef} (was ${behind} behind)`,
          );
          synced++;
        } else {
          console.warn(`[maintenance] update-ref failed for '${branch}'`);
        }
      }
    } catch (e) {
      console.warn(`[maintenance] error syncing '${branch}': ${e.message}`);
    }
  }

  if (synced > 0) {
    console.log(
      `[maintenance] synced ${synced}/${toSync.length} local tracking branch(es)`,
    );
  }
  return synced;
}

/**
 * Run full maintenance sweep: stale kill, git push reap, worktree cleanup,
 * local tracking branch sync, and optionally VK task archiving.
 * @param {object} opts
 * @param {string} opts.repoRoot - repository root path
 * @param {number} [opts.childPid] - current orchestrator child PID to skip
 * @param {number} [opts.gitPushMaxAgeMs] - max age for git push before kill (default 5min)
 * @param {string[]} [opts.syncBranches] - local branches to fast-forward (default: ["main"])
 * @param {function} [opts.archiveCompletedTasks] - optional async function to archive VK tasks
 * @param {object} [opts.branchCleanup] - branch cleanup options (passed to cleanupStaleBranches)
 * @param {boolean} [opts.branchCleanup.enabled=true] - enable/disable branch cleanup
 * @param {number} [opts.branchCleanup.minAgeMs] - minimum branch age before cleanup (default 24h)
 * @param {boolean} [opts.branchCleanup.dryRun] - if true, log only without deleting
 */
export async function runMaintenanceSweep(opts = {}) {
  const {
    repoRoot,
    childPid,
    gitPushMaxAgeMs,
    syncBranches,
    archiveCompletedTasks,
    branchCleanup,
  } = opts;
  console.log("[maintenance] starting sweep...");

  const staleKilled = killStaleOrchestrators(childPid);
  const pushesReaped = reapStuckGitPushes(gitPushMaxAgeMs);
  const worktreesPruned = repoRoot ? cleanupWorktrees(repoRoot) : 0;

  // Also prune via centralized WorktreeManager
  try {
    const pruneResult = await pruneStaleWorktrees();
    if (pruneResult.pruned > 0) {
      console.log(
        `[maintenance] WorktreeManager pruned ${pruneResult.pruned} stale worktrees`,
      );
    }
  } catch (wtErr) {
    console.warn(
      `[maintenance] WorktreeManager prune failed: ${wtErr.message}`,
    );
  }

  const branchesSynced = repoRoot
    ? syncLocalTrackingBranches(repoRoot, syncBranches)
    : 0;

  // Branch cleanup: delete old ve/* and copilot-worktree-* branches
  let branchesDeleted = 0;
  const branchCleanupEnabled = branchCleanup?.enabled !== false;
  if (repoRoot && branchCleanupEnabled) {
    try {
      const branchResult = cleanupStaleBranches(repoRoot, {
        minAgeMs: branchCleanup?.minAgeMs,
        dryRun: branchCleanup?.dryRun,
      });
      branchesDeleted = branchResult.deleted.length;
    } catch (err) {
      console.warn(`[maintenance] branch cleanup failed: ${err.message}`);
    }
  }

  // Optional: Archive old completed VK tasks (if provided)
  let tasksArchived = 0;
  if (archiveCompletedTasks && typeof archiveCompletedTasks === "function") {
    try {
      const result = await archiveCompletedTasks();
      tasksArchived = result?.archived || 0;
      if (tasksArchived > 0) {
        console.log(
          `[maintenance] archived ${tasksArchived} old completed tasks`,
        );
      }
    } catch (err) {
      console.warn(`[maintenance] task archiving failed: ${err.message}`);
    }
  }

  // Guard against core.bare=true corruption that accumulates from worktree ops
  try {
    const repoRoot = resolve(import.meta.dirname || ".", "..", "..");
    fixGitConfigCorruption(repoRoot);
  } catch {
    /* best-effort */
  }

  console.log(
    `[maintenance] sweep complete: ${staleKilled} stale orchestrators, ${pushesReaped} stuck pushes, ${worktreesPruned} worktrees pruned, ${branchesSynced} branches synced, ${branchesDeleted} stale branches deleted`,
  );

  return {
    staleKilled,
    pushesReaped,
    worktreesPruned,
    branchesSynced,
    tasksArchived,
    branchesDeleted,
  };
}
