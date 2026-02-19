/**
 * diff-stats.mjs — Collects git diff statistics for review handoff.
 *
 * Produces a tree of file changes with +/- line counts, like:
 *   monitor.mjs            +890  -750
 *   task-executor.mjs      +320  -180
 *   review-agent.mjs       +680  -528
 *
 * @module diff-stats
 */

import { spawnSync } from "node:child_process";

const TAG = "[diff-stats]";

/**
 * @typedef {Object} FileChangeStats
 * @property {string}  file       - Relative file path
 * @property {number}  additions  - Lines added
 * @property {number}  deletions  - Lines deleted
 * @property {boolean} binary     - True if binary file
 */

/**
 * @typedef {Object} DiffStats
 * @property {FileChangeStats[]} files
 * @property {number} totalFiles
 * @property {number} totalAdditions
 * @property {number} totalDeletions
 * @property {string} formatted       - Human-readable summary string
 */

// ── Main Collectors ─────────────────────────────────────────────────────────

/**
 * Collect diff stats for a worktree (vs origin/main or the upstream branch).
 *
 * Tries three strategies in order:
 *   1. `git diff --numstat origin/main...HEAD`
 *   2. `git diff --numstat HEAD~10...HEAD` (last 10 commits)
 *   3. `git diff --stat origin/main...HEAD` (parsed stat output)
 *
 * @param {string} worktreePath - Path to the git worktree
 * @param {Object} [options]
 * @param {string} [options.baseBranch="origin/main"] - Branch to diff against
 * @param {number} [options.timeoutMs=30000]
 * @returns {DiffStats}
 */
export function collectDiffStats(worktreePath, options = {}) {
  const {
    baseBranch = "origin/main",
    timeoutMs = 30_000,
  } = options;

  // Strategy 1: --numstat (most reliable)
  const numstat = tryNumstat(worktreePath, `${baseBranch}...HEAD`, timeoutMs);
  if (numstat) return buildResult(numstat);

  // Strategy 2: last N commits
  const recent = tryNumstat(worktreePath, "HEAD~10...HEAD", timeoutMs);
  if (recent) return buildResult(recent);

  // Strategy 3: --stat fallback
  const stat = tryStat(worktreePath, `${baseBranch}...HEAD`, timeoutMs);
  if (stat) return buildResult(stat);

  // Strategy 4: staged + unstaged changes
  const working = tryNumstat(worktreePath, "HEAD", timeoutMs);
  if (working) return buildResult(working);

  // Nothing worked
  return {
    files: [],
    totalFiles: 0,
    totalAdditions: 0,
    totalDeletions: 0,
    formatted: "(no diff stats available)",
  };
}

/**
 * Get a compact string summary of diff stats.
 *
 * Example output:
 * ```
 * 5 files changed, +1250 -890
 *   review-agent.mjs   +680 -528
 *   task-executor.mjs   +320 -180
 *   monitor.mjs          +150  -82
 *   session-tracker.mjs  +370   -0
 *   diff-stats.mjs       +380   -0
 * ```
 *
 * @param {string} worktreePath
 * @param {Object} [options]
 * @returns {string}
 */
export function getCompactDiffSummary(worktreePath, options = {}) {
  const stats = collectDiffStats(worktreePath, options);
  return stats.formatted;
}

/**
 * Get the recent commits on the current branch (vs origin/main).
 *
 * @param {string} worktreePath
 * @param {number} [maxCommits=10]
 * @returns {string[]} - Array of one-line commit messages
 */
export function getRecentCommits(worktreePath, maxCommits = 10) {
  try {
    // Try vs origin/main first
    const result = spawnSync(
      "git",
      ["log", "--oneline", `--max-count=${maxCommits}`, "origin/main..HEAD"],
      { cwd: worktreePath, encoding: "utf8", timeout: 10_000 },
    );

    if (result.status === 0 && (result.stdout || "").trim()) {
      return result.stdout.trim().split("\n").filter(Boolean);
    }

    // Fallback: last N commits on current branch
    const fallback = spawnSync(
      "git",
      ["log", "--oneline", `--max-count=${maxCommits}`],
      { cwd: worktreePath, encoding: "utf8", timeout: 10_000 },
    );

    if (fallback.status === 0 && (fallback.stdout || "").trim()) {
      return fallback.stdout.trim().split("\n").filter(Boolean);
    }
  } catch (err) {
    console.warn(`${TAG} getRecentCommits error: ${err.message}`);
  }

  return [];
}

// ── Internal Strategies ─────────────────────────────────────────────────────

/**
 * Try `git diff --numstat` and parse the output.
 * @param {string} cwd
 * @param {string} range - e.g., "origin/main...HEAD"
 * @param {number} timeoutMs
 * @returns {FileChangeStats[]|null}
 */
function tryNumstat(cwd, range, timeoutMs) {
  try {
    const result = spawnSync(
      "git",
      ["diff", "--numstat", range],
      { cwd, encoding: "utf8", timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] },
    );

    if (result.status !== 0 || !(result.stdout || "").trim()) return null;

    const files = [];
    for (const line of result.stdout.trim().split("\n")) {
      if (!line.trim()) continue;

      const parts = line.split("\t");
      if (parts.length < 3) continue;

      const [addStr, delStr, ...fileParts] = parts;
      const file = fileParts.join("\t"); // Handle filenames with tabs

      if (addStr === "-" && delStr === "-") {
        // Binary file
        files.push({ file, additions: 0, deletions: 0, binary: true });
      } else {
        files.push({
          file,
          additions: parseInt(addStr, 10) || 0,
          deletions: parseInt(delStr, 10) || 0,
          binary: false,
        });
      }
    }

    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

/**
 * Try `git diff --stat` and parse the output.
 * Fallback when --numstat fails.
 *
 * @param {string} cwd
 * @param {string} range
 * @param {number} timeoutMs
 * @returns {FileChangeStats[]|null}
 */
function tryStat(cwd, range, timeoutMs) {
  try {
    const result = spawnSync(
      "git",
      ["diff", "--stat", range],
      { cwd, encoding: "utf8", timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] },
    );

    if (result.status !== 0 || !(result.stdout || "").trim()) return null;

    const files = [];
    const lines = result.stdout.trim().split("\n");

    // Last line is the summary — skip it
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Format: " filename | 123 +++---" or " filename | Bin 0 -> 1234 bytes"
      const pipeIdx = line.lastIndexOf("|");
      if (pipeIdx === -1) continue;

      const file = line.slice(0, pipeIdx).trim();
      const statsStr = line.slice(pipeIdx + 1).trim();

      if (statsStr.startsWith("Bin")) {
        files.push({ file, additions: 0, deletions: 0, binary: true });
      } else {
        // Count '+' and '-' chars
        const additions = (statsStr.match(/\+/g) || []).length;
        const deletions = (statsStr.match(/-/g) || []).length;
        files.push({ file, additions, deletions, binary: false });
      }
    }

    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

// ── Result Builder ──────────────────────────────────────────────────────────

/**
 * Build a DiffStats result from parsed file changes.
 * @param {FileChangeStats[]} files
 * @returns {DiffStats}
 */
function buildResult(files) {
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const f of files) {
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
  }

  // Sort by total changes (largest first)
  const sorted = [...files].sort(
    (a, b) => (b.additions + b.deletions) - (a.additions + a.deletions),
  );

  // Find max filename length for alignment
  const maxNameLen = Math.max(...sorted.map((f) => f.file.length), 10);

  const lines = sorted.map((f) => {
    const name = f.file.padEnd(maxNameLen);
    if (f.binary) {
      return `  ${name}  (binary)`;
    }
    const add = `+${f.additions}`.padStart(6);
    const del = `-${f.deletions}`.padStart(6);
    return `  ${name} ${add} ${del}`;
  });

  const header = `${files.length} file(s) changed, +${totalAdditions} -${totalDeletions}`;
  const formatted = `${header}\n${lines.join("\n")}`;

  return {
    files: sorted,
    totalFiles: files.length,
    totalAdditions,
    totalDeletions,
    formatted,
  };
}
