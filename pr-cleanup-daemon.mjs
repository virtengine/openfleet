/**
 * pr-cleanup-daemon.mjs — Automated PR conflict resolution and CI cleanup
 *
 * Runs every 30 minutes to:
 * 1. Find PRs with conflicts or failing CI
 * 2. Spawn codex-sdk agents to resolve issues
 * 3. Auto-merge when green
 *
 * Prevents merge queue bottlenecks by handling conflicts automatically.
 */

import { spawn } from "child_process";
import { promisify } from "util";
import { exec as execCallback } from "child_process";
import { fileURLToPath } from "url";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const exec = promisify(execCallback);

/**
 * Check if a branch is already checked out in an existing git worktree.
 * Returns the worktree path if claimed, or null if free.
 */
async function getWorktreeForBranch(branch) {
  try {
    const { stdout } = await exec(`git worktree list --porcelain`);
    // Each worktree block is separated by a blank line.
    // Look for a line like: branch refs/heads/<branch>
    const blocks = stdout.split(/\n\n/);
    for (const block of blocks) {
      if (block.includes(`branch refs/heads/${branch}`)) {
        const wtMatch = block.match(/^worktree\s+(.+)$/m);
        return wtMatch ? wtMatch[1] : "unknown";
      }
    }
    return null;
  } catch {
    // If git worktree list itself fails, assume branch is free
    return null;
  }
}

// ── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  intervalMs: 10 * 60 * 1000, // 10 minutes — fast turnaround for agent PRs
  maxConcurrentCleanups: 3, // Don't overwhelm system
  conflictStrategy: "ours-with-review", // Prefer incoming changes, flag risky merges
  autoMerge: true, // Auto-merge if CI green after cleanup
  dryRun: false, // Set true to log actions without executing
  excludeLabels: ["do-not-merge", "wip", "draft"], // Skip PRs with these labels
  maxConflictSize: 500, // Max lines of conflict to auto-resolve (escalate if larger)
  postConflictRecheckAttempts: 6, // GitHub mergeability can lag after force-push
  postConflictRecheckDelayMs: 10_000,
};

// ── PR Cleanup Daemon ────────────────────────────────────────────────────────

class PRCleanupDaemon {
  constructor(config = CONFIG) {
    this.config = {
      ...CONFIG,
      ...(config && typeof config === "object" ? config : {}),
    };
    this.cleanupQueue = [];
    this.activeCleanups = new Map(); // pr# → cleanup state
    this.lastRunStartedAt = 0;
    this.lastRunFinishedAt = 0;
    this.stats = {
      totalRuns: 0,
      prsProcessed: 0,
      conflictsResolved: 0,
      ciRetriggers: 0,
      autoMerges: 0,
      escalations: 0,
      errors: 0,
    };
  }

  /**
   * Extract base branch from PR metadata, stripping origin/ prefix.
   * Falls back to "main" if baseRefName is missing.
   * @param {Object} pr - PR object with optional baseRefName
   * @returns {string}
   */
  getBaseBranch(pr) {
    const base = pr?.baseRefName || "main";
    return base.replace(/^origin\//, "");
  }

  /**
   * Main daemon loop — fetch PRs and process cleanup queue
   */
  async run() {
    this.stats.totalRuns++;
    this.lastRunStartedAt = Date.now();
    console.log(`[pr-cleanup-daemon] Run #${this.stats.totalRuns} starting...`);

    try {
      // 1. Fetch PRs needing attention
      const prs = await this.fetchProblematicPRs();
      console.log(
        `[pr-cleanup-daemon] Found ${prs.length} PRs needing cleanup`,
      );

      // 2. Add to queue (dedup by PR number)
      for (const pr of prs) {
        if (
          !this.cleanupQueue.some((p) => p.number === pr.number) &&
          !this.activeCleanups.has(pr.number)
        ) {
          this.cleanupQueue.push(pr);
        }
      }

      // 3. Process queue (up to max concurrent)
      while (
        this.cleanupQueue.length > 0 &&
        this.activeCleanups.size < this.config.maxConcurrentCleanups
      ) {
        const pr = this.cleanupQueue.shift();
        void this.processPR(pr); // Don't await — run in parallel
      }

      // 4. Also scan for green PRs ready to merge (not just problematic ones)
      try {
        await this.mergeGreenPRs();
      } catch (e) {
        console.warn(
          `[pr-cleanup-daemon] Green PR scan failed: ${e?.message ?? String(e)}`,
        );
      }

      // 5. Log stats
      console.log(`[pr-cleanup-daemon] Stats:`, this.stats);
      console.log(
        `[pr-cleanup-daemon] Active cleanups: ${this.activeCleanups.size}, Queued: ${this.cleanupQueue.length}`,
      );
    } catch (err) {
      this.stats.errors++;
      console.error(
        `[pr-cleanup-daemon] Run failed:`,
        err?.message ?? String(err),
      );
    } finally {
      this.lastRunFinishedAt = Date.now();
    }
  }

  /**
   * Fetch PRs with conflicts or failing CI
   * @returns {Promise<Array>} PRs needing cleanup
   */
  async fetchProblematicPRs() {
    try {
      const { stdout } = await exec(
        `gh pr list --json number,title,mergeable,labels,statusCheckRollup,headRefName --limit 50`,
      );
      const allPRs = JSON.parse(stdout);

      const problematicPRs = [];

      for (const pr of allPRs) {
        // Skip excluded labels (guard against missing labels or config)
        const excludeLabels = this.config.excludeLabels || [];
        if (
          Array.isArray(pr.labels) &&
          pr.labels.some((l) => l?.name && excludeLabels.includes(l.name))
        ) {
          continue;
        }

        // Check for conflicts
        if (pr.mergeable === "CONFLICTING") {
          problematicPRs.push({
            ...pr,
            issue: "conflict",
            priority: 1, // High priority
          });
          continue;
        }

        // Check for failing CI
        if (
          Array.isArray(pr.statusCheckRollup) &&
          pr.statusCheckRollup.some((check) => check?.conclusion === "FAILURE")
        ) {
          problematicPRs.push({
            ...pr,
            issue: "ci_failure",
            priority: 2, // Medium priority
          });
          continue;
        }
      }

      // Sort by priority (conflicts first)
      return problematicPRs.sort((a, b) => a.priority - b.priority);
    } catch (err) {
      // Handle rate limiting gracefully
      const errMsg =
        typeof err?.message === "string" ? err.message : String(err);
      if (errMsg.includes("HTTP 429") || errMsg.includes("rate limit")) {
        console.warn(
          `[pr-cleanup-daemon] GitHub API rate limited - will retry next cycle`,
        );
        return [];
      }

      console.error(`[pr-cleanup-daemon] Failed to fetch PRs:`, errMsg);
      return [];
    }
  }

  /**
   * Process a single PR — resolve conflicts or fix CI
   * @param {object} pr - PR metadata
   */
  async processPR(pr) {
    this.stats.prsProcessed++;
    this.activeCleanups.set(pr.number, { startedAt: Date.now(), pr });

    console.log(
      `[pr-cleanup-daemon] Processing PR #${pr.number}: ${pr.title} (${pr.issue})`,
    );

    try {
      let cleanupAttempted = false;
      if (pr.issue === "conflict") {
        cleanupAttempted = await this.resolveConflicts(pr);
      } else if (pr.issue === "ci_failure") {
        await this.fixCI(pr);
        cleanupAttempted = true;
      }

      // After cleanup, check if ready to merge
      if (this.config.autoMerge && cleanupAttempted) {
        await this.attemptAutoMerge(pr);
      }
    } catch (err) {
      this.stats.errors++;
      console.error(
        `[pr-cleanup-daemon] Failed to process PR #${pr.number}:`,
        err?.message ?? String(err),
      );
    } finally {
      this.activeCleanups.delete(pr.number);
    }
  }

  /**
   * Resolve conflicts on a PR — tries codex agent first, falls back to local merge
   * @param {object} pr - PR metadata
   */
  async resolveConflicts(pr) {
    console.log(`[pr-cleanup-daemon] Resolving conflicts on PR #${pr.number}`);

    // 1. Check conflict size (escalate if too large)
    const conflictSize = await this.getConflictSize(pr);
    if (conflictSize > this.config.maxConflictSize) {
      console.warn(
        `[pr-cleanup-daemon] PR #${pr.number} has ${conflictSize} lines of conflicts — escalating to human`,
      );
      await this.escalate(pr, "large_conflict", { lines: conflictSize });
      this.stats.escalations++;
      return false;
    }

    // 2. Try codex-sdk agent first, fall back to local merge
    if (this.config.dryRun) {
      console.log(
        `[pr-cleanup-daemon] [DRY RUN] Would resolve conflicts for PR #${pr.number}`,
      );
      return true;
    }

    let resolvedVia = null;

    try {
      await this.spawnCodexAgent({
        task: `resolve-pr-conflicts`,
        pr: pr.number,
        branch: pr.headRefName,
        strategy: this.config.conflictStrategy,
        ciWait: true,
      });
      resolvedVia = "agent";
      console.log(`[pr-cleanup-daemon] ✓ Agent resolved PR #${pr.number}`);
    } catch (agentErr) {
      console.warn(
        `[pr-cleanup-daemon] Codex agent failed for PR #${pr.number}, trying local merge: ${agentErr.message}`,
      );

      // Fallback: resolve locally using temporary worktree
      try {
        await this.resolveConflictsLocally(pr);
        resolvedVia = "local";
        console.log(`[pr-cleanup-daemon] ✓ Local merge resolved PR #${pr.number}`);
      } catch (localErr) {
        console.error(
          `[pr-cleanup-daemon] Failed to resolve conflicts on PR #${pr.number}:`,
          localErr.message,
        );
        await this.escalate(pr, "conflict_resolution_failed", {
          error: localErr.message,
        });
        this.stats.escalations++;
        return false;
      }
    }

    if (!resolvedVia) return false;

    const verified = await this.waitForMergeableState(pr.number, {
      attempts: this.config.postConflictRecheckAttempts,
      delayMs: this.config.postConflictRecheckDelayMs,
      context: `post-${resolvedVia}-resolution`,
    });

    if (verified.mergeable === "MERGEABLE") {
      this.stats.conflictsResolved++;
      console.log(
        `[pr-cleanup-daemon] ✅ Verified conflict resolution on PR #${pr.number} (mergeable=${verified.mergeable})`,
      );
      return true;
    }

    // A successful agent run can still leave GitHub in CONFLICTING state (stale
    // merge base or partial resolution). Give one deterministic local pass.
    if (resolvedVia !== "local") {
      console.warn(
        `[pr-cleanup-daemon] PR #${pr.number} still ${verified.mergeable || "UNMERGEABLE"} after agent resolution — attempting local fallback`,
      );
      try {
        await this.resolveConflictsLocally(pr);
        const verifiedLocal = await this.waitForMergeableState(pr.number, {
          attempts: this.config.postConflictRecheckAttempts,
          delayMs: this.config.postConflictRecheckDelayMs,
          context: "post-local-fallback",
        });
        if (verifiedLocal.mergeable === "MERGEABLE") {
          this.stats.conflictsResolved++;
          console.log(
            `[pr-cleanup-daemon] ✅ Verified conflict resolution on PR #${pr.number} after local fallback`,
          );
          return true;
        }
        console.warn(
          `[pr-cleanup-daemon] PR #${pr.number} still not mergeable after local fallback: ${verifiedLocal.mergeable}`,
        );
      } catch (localFallbackErr) {
        console.warn(
          `[pr-cleanup-daemon] Local fallback failed for PR #${pr.number}: ${localFallbackErr.message}`,
        );
      }
    }

    await this.escalate(pr, "conflict_still_present_after_resolution", {
      mergeable: verified.mergeable || "UNKNOWN",
      strategy: this.config.conflictStrategy,
      resolvedVia,
    });
    this.stats.escalations++;
    return false;
  }

  /**
   * Resolve conflicts locally using a temporary worktree and merge
   * Only handles auto-resolvable conflicts (lockfiles, generated files)
   * @param {object} pr - PR metadata
   */
  async resolveConflictsLocally(pr) {
    let tmpDir;
    try {
      tmpDir = await mkdtemp(join(tmpdir(), "pr-merge-"));

      // Fetch all relevant refs
      await exec(`git fetch origin ${pr.headRefName} main`);

      // Guard: skip if the branch is already claimed by another worktree
      const existingWt = await getWorktreeForBranch(pr.headRefName);
      if (existingWt) {
        console.warn(
          `[pr-cleanup-daemon] WARN: Branch "${pr.headRefName}" is in an active worktree at ${existingWt} — skipping conflict resolution`,
        );
        return;
      }

      // Create worktree on the PR branch
      await exec(
        `git worktree add "${tmpDir}" "origin/${pr.headRefName}" --detach`,
      );
      await exec(
        `git checkout -B "${pr.headRefName}" "origin/${pr.headRefName}"`,
        { cwd: tmpDir },
      );

      // Attempt merge with main
      try {
        await exec(`git merge origin/main --no-edit`, { cwd: tmpDir });
      } catch {
        // Merge has conflicts — try auto-resolving known file types
        const { stdout: conflictFiles } = await exec(
          `git diff --name-only --diff-filter=U`,
          { cwd: tmpDir },
        ).catch(() => ({ stdout: "" }));

        const files = conflictFiles.trim().split("\n").filter(Boolean);
        const autoResolvable = [
          "pnpm-lock.yaml",
          "package-lock.json",
          "yarn.lock",
          "go.sum",
          "coverage.txt",
          "results.txt",
          "package.json",
        ];

        let allResolved = true;
        for (const file of files) {
          const basename = file.split("/").pop();
          if (autoResolvable.includes(basename) || basename.endsWith(".lock")) {
            // Accept theirs (main) for lockfiles, ours for coverage/results
            const strategy = [
              "coverage.txt",
              "results.txt",
              "CHANGELOG.md",
            ].includes(basename)
              ? "--ours"
              : "--theirs";
            await exec(`git checkout ${strategy} -- "${file}"`, {
              cwd: tmpDir,
            });
            await exec(`git add "${file}"`, { cwd: tmpDir });
          } else {
            allResolved = false;
          }
        }

        if (!allResolved) {
          await exec(`git merge --abort`, { cwd: tmpDir }).catch(() => {});
          throw new Error(
            `Cannot auto-resolve all conflicts: ${files.join(", ")}`,
          );
        }

        // Commit the resolved merge
        await exec(`git commit --no-edit`, { cwd: tmpDir });
      }

      // Push the merged branch
      await exec(`git push origin "${pr.headRefName}"`, { cwd: tmpDir });
    } finally {
      if (tmpDir) {
        try {
          await exec(`git worktree remove "${tmpDir}" --force`);
        } catch {
          try {
            await rm(tmpDir, { recursive: true, force: true });
          } catch {}
          try {
            await exec(`git worktree prune`);
          } catch {}
        }
      }
    }
  }

  /**
   * Fix failing CI on a PR
   * @param {object} pr - PR metadata
   */
  async fixCI(pr) {
    console.log(`[pr-cleanup-daemon] Fixing CI on PR #${pr.number}`);

    // Get failing checks
    const checks = Array.isArray(pr.statusCheckRollup)
      ? pr.statusCheckRollup
      : [];
    const failedChecks = checks.filter((c) => c?.conclusion === "FAILURE");
    console.log(
      `[pr-cleanup-daemon] PR #${pr.number} has ${failedChecks.length} failed checks:`,
      failedChecks.map((c) => c?.name).join(", "),
    );

    // For now, just re-trigger CI (future: spawn agent to fix specific failures)
    if (this.config.dryRun) {
      console.log(
        `[pr-cleanup-daemon] [DRY RUN] Would re-trigger CI for PR #${pr.number}`,
      );
      return;
    }

    let tmpDir;
    try {
      // Use a temporary worktree to avoid conflicts with existing checkouts
      tmpDir = await mkdtemp(join(tmpdir(), "pr-cleanup-"));

      // Fetch latest refs first
      await exec(`git fetch origin ${pr.headRefName}`);

      // Guard: skip if the branch is already claimed by another worktree
      const existingWt = await getWorktreeForBranch(pr.headRefName);
      if (existingWt) {
        console.warn(
          `[pr-cleanup-daemon] WARN: Branch "${pr.headRefName}" is in an active worktree at ${existingWt} — skipping CI re-trigger`,
        );
        return;
      }

      // Create a temporary worktree for the PR branch
      await exec(
        `git worktree add "${tmpDir}" "origin/${pr.headRefName}" --detach`,
      );

      // Checkout the branch properly inside the worktree
      await exec(
        `git checkout -B "${pr.headRefName}" "origin/${pr.headRefName}"`,
        { cwd: tmpDir },
      );

      // Push empty commit to re-trigger CI
      await exec(`git commit --allow-empty -m "chore: re-trigger CI"`, {
        cwd: tmpDir,
      });
      await exec(`git push origin "${pr.headRefName}"`, { cwd: tmpDir });

      this.stats.ciRetriggers++;
      console.log(`[pr-cleanup-daemon] ✓ Re-triggered CI on PR #${pr.number}`);
    } catch (err) {
      console.error(
        `[pr-cleanup-daemon] Failed to re-trigger CI on PR #${pr.number}:`,
        err.message,
      );
    } finally {
      // Clean up the temporary worktree
      if (tmpDir) {
        try {
          await exec(`git worktree remove "${tmpDir}" --force`);
        } catch {
          // If worktree remove fails, try manual cleanup
          try {
            await rm(tmpDir, { recursive: true, force: true });
          } catch {}
          try {
            await exec(`git worktree prune`);
          } catch {}
        }
      }
    }
  }

  /**
   * Attempt to auto-merge PR if all checks pass
   * @param {object} pr - PR metadata
   */
  async attemptAutoMerge(pr) {
    let latest = await this.fetchPrMergeability(pr.number);
    if (!latest) {
      console.error(
        `[pr-cleanup-daemon] Failed to fetch PR #${pr.number} status for auto-merge`,
      );
      return;
    }

    if (latest.mergeable !== "MERGEABLE") {
      // Mergeability can be UNKNOWN briefly after pushes/rebases.
      if (latest.mergeable === "UNKNOWN") {
        const retry = await this.waitForMergeableState(pr.number, {
          attempts: 3,
          delayMs: 5000,
          context: "auto-merge",
        });
        latest = retry.raw || latest;
      }
    }

    if (latest.mergeable !== "MERGEABLE") {
      console.log(
        `[pr-cleanup-daemon] PR #${pr.number} not mergeable: ${latest.mergeable}`,
      );
      return;
    }

    const latestChecks = Array.isArray(latest.statusCheckRollup)
      ? latest.statusCheckRollup
      : [];
    const allGreen =
      latestChecks.length > 0 &&
      latestChecks.every((c) => c?.conclusion === "SUCCESS");
    if (!allGreen) {
      console.log(
        `[pr-cleanup-daemon] PR #${pr.number} has non-green checks, skipping auto-merge`,
      );
      return;
    }

    if (this.config.dryRun) {
      console.log(
        `[pr-cleanup-daemon] [DRY RUN] Would auto-merge PR #${pr.number}`,
      );
      return;
    }

    try {
      await exec(`gh pr merge ${pr.number} --auto --squash --delete-branch`);
      this.stats.autoMerges++;
      console.log(`[pr-cleanup-daemon] ✓ Auto-merged PR #${pr.number}`);
    } catch (err) {
      console.error(
        `[pr-cleanup-daemon] Failed to auto-merge PR #${pr.number}:`,
        err?.message ?? String(err),
      );
    }
  }

  /**
   * Get conflict size (number of conflicting files) using GitHub API
   * Avoids local checkout entirely to prevent worktree/divergence issues
   * @param {object} pr - PR metadata
   * @returns {Promise<number>} Number of conflict lines (estimated)
   */
  async getConflictSize(pr) {
    try {
      // Use GitHub API to get the list of changed files and estimate conflict scope
      // This avoids the need for local checkout entirely
      const { stdout } = await exec(`gh pr diff ${pr.number} --name-only`);
      const changedFiles = stdout.trim().split("\n").filter(Boolean);

      // Estimate: each changed file could have ~10 lines of conflicts on average
      // This is a rough heuristic — the real conflict size can only be known after merge attempt
      const estimatedConflictLines = changedFiles.length * 10;
      console.log(
        `[pr-cleanup-daemon] PR #${pr.number}: ${changedFiles.length} files changed (est. ~${estimatedConflictLines} conflict lines)`,
      );
      return estimatedConflictLines;
    } catch {
      // If we can't even get the diff (e.g., too diverged), try merge in temp worktree
      let tmpDir;
      try {
        tmpDir = await mkdtemp(join(tmpdir(), "pr-conflict-"));
        await exec(`git fetch origin ${pr.headRefName} main`);
        await exec(`git worktree add "${tmpDir}" "origin/main" --detach`);

        // Attempt merge to count conflicts
        try {
          await exec(
            `git merge --no-commit --no-ff "origin/${pr.headRefName}"`,
            { cwd: tmpDir },
          );
          // If merge succeeds, no conflicts
          await exec(`git merge --abort`, { cwd: tmpDir }).catch(() => {});
          return 0;
        } catch {
          // Count conflicting files
          const { stdout: conflictOutput } = await exec(
            `git diff --name-only --diff-filter=U`,
            { cwd: tmpDir },
          ).catch(() => ({ stdout: "" }));
          const conflictFiles = conflictOutput
            .trim()
            .split("\n")
            .filter(Boolean);
          await exec(`git merge --abort`, { cwd: tmpDir }).catch(() => {});
          return conflictFiles.length * 15; // ~15 lines per conflicting file
        }
      } catch (innerErr) {
        console.warn(
          `[pr-cleanup-daemon] Could not determine conflict size for PR #${pr.number}:`,
          innerErr.message,
        );
        return 0; // Assume small if can't determine
      } finally {
        if (tmpDir) {
          try {
            await exec(`git worktree remove "${tmpDir}" --force`);
          } catch {
            try {
              await rm(tmpDir, { recursive: true, force: true });
            } catch {}
            try {
              await exec(`git worktree prune`);
            } catch {}
          }
        }
      }
    }
  }

  /**
   * Spawn a codex-sdk agent to handle complex cleanup
   * @param {object} opts - Agent options
   */
  async spawnCodexAgent(opts) {
    return new Promise((resolve, reject) => {
      const scriptPath = new URL(
        "./codex-shell.mjs",
        import.meta.url,
      ).pathname.replace(/^\/([A-Z]:)/, "$1");
      const args = [scriptPath, "spawn-agent", JSON.stringify(opts)];

      const child = spawn("node", args, {
        stdio: "inherit",
        env: process.env,
      });

      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Codex agent exited with code ${code}`));
        }
      });

      child.on("error", reject);
    });
  }

  /**
   * Scan all open PRs and auto-merge any that are green + mergeable.
   * This catches PRs that were created by agents but never had auto-merge enabled.
   */
  async mergeGreenPRs() {
    try {
      const { stdout } = await exec(
        `gh pr list --json number,title,mergeable,statusCheckRollup,headRefName,autoMergeRequest --limit 30`,
      );
      const allPRs = JSON.parse(stdout);

      for (const pr of allPRs) {
        // Skip if already has auto-merge enabled
        if (pr.autoMergeRequest) continue;

        // Skip excluded labels
        const excludeLabels = this.config.excludeLabels || [];
        if (
          Array.isArray(pr.labels) &&
          pr.labels.some((l) => l?.name && excludeLabels.includes(l.name))
        )
          continue;

        // Only process MERGEABLE PRs
        if (pr.mergeable !== "MERGEABLE") continue;

        // Check if all CI checks are green
        const checks = Array.isArray(pr.statusCheckRollup)
          ? pr.statusCheckRollup
          : [];
        const hasChecks = checks.length > 0;
        const allGreen =
          hasChecks &&
          checks.every(
            (c) =>
              c?.conclusion === "SUCCESS" ||
              c?.conclusion === "SKIPPED" ||
              c?.conclusion === "NEUTRAL",
          );

        if (!allGreen) {
          // Still pending? Enable auto-merge so it merges when CI passes
          const hasPending = checks.some(
            (c) => !c?.conclusion || c?.conclusion === "PENDING",
          );
          if (hasPending && pr.mergeable === "MERGEABLE") {
            try {
              await exec(
                `gh pr merge ${pr.number} --auto --squash --delete-branch`,
              );
              console.log(
                `[pr-cleanup-daemon] ⏳ Auto-merge queued for PR #${pr.number} (CI pending)`,
              );
            } catch {
              /* auto-merge may not be available */
            }
          }
          continue;
        }

        if (this.config.dryRun) {
          console.log(
            `[pr-cleanup-daemon] [DRY RUN] Would merge green PR #${pr.number}`,
          );
          continue;
        }

        // All green + mergeable → merge now
        try {
          await exec(`gh pr merge ${pr.number} --squash --delete-branch`);
          this.stats.autoMerges++;
          console.log(
            `[pr-cleanup-daemon] ✅ Auto-merged green PR #${pr.number}: ${pr.title}`,
          );
        } catch (err) {
          // Fallback: enable auto-merge
          try {
            await exec(
              `gh pr merge ${pr.number} --auto --squash --delete-branch`,
            );
            console.log(
              `[pr-cleanup-daemon] ⏳ Auto-merge enabled for PR #${pr.number}`,
            );
          } catch {
            console.warn(
              `[pr-cleanup-daemon] Failed to merge/auto-merge PR #${pr.number}: ${err?.message}`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(
        `[pr-cleanup-daemon] Green PR scan error: ${err?.message ?? String(err)}`,
      );
    }
  }

  /**
   * Escalate PR to human for manual intervention
   * @param {object} pr - PR metadata
   * @param {string} reason - Escalation reason
   * @param {object} context - Additional context
   */
  async escalate(pr, reason, context = {}) {
    const message =
      `⚠️ PR #${pr.number} escalated: ${reason}\n\n` +
      `Title: ${pr.title}\n` +
      `Context: ${JSON.stringify(context, null, 2)}\n\n` +
      `Manual intervention required.`;

    console.warn(`[pr-cleanup-daemon] ESCALATION:`, message);

    // Send Telegram notification if configured
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      try {
        await exec(
          `curl -s -X POST "https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage" -d chat_id="${process.env.TELEGRAM_CHAT_ID}" -d text="${encodeURIComponent(message)}"`,
        );
      } catch (err) {
        console.error(
          `[pr-cleanup-daemon] Failed to send Telegram alert:`,
          err?.message ?? String(err),
        );
      }
    }
  }

  /**
   * Fetch current mergeability/check status for a PR.
   * @param {number|string} prNumber
   * @returns {Promise<object|null>}
   */
  async fetchPrMergeability(prNumber) {
    try {
      const { stdout } = await exec(
        `gh pr view ${prNumber} --json mergeable,statusCheckRollup`,
      );
      return JSON.parse(stdout);
    } catch (err) {
      console.warn(
        `[pr-cleanup-daemon] Failed to fetch PR #${prNumber} mergeability: ${err?.message ?? String(err)}`,
      );
      return null;
    }
  }

  /**
   * Wait for GitHub mergeability state to settle after conflict resolution.
   * @param {number|string} prNumber
   * @param {{ attempts?: number, delayMs?: number, context?: string }} [opts]
   * @returns {Promise<{ mergeable: string, raw: object|null }>}
   */
  async waitForMergeableState(prNumber, opts = {}) {
    const attempts = Math.max(1, Number(opts.attempts || 1));
    const delayMs = Math.max(1000, Number(opts.delayMs || 5000));
    const context = opts.context || "mergeability-check";

    let last = null;
    for (let i = 1; i <= attempts; i++) {
      last = await this.fetchPrMergeability(prNumber);
      const mergeable = String(last?.mergeable || "UNKNOWN").toUpperCase();
      if (mergeable === "MERGEABLE") {
        if (i > 1) {
          console.log(
            `[pr-cleanup-daemon] PR #${prNumber} mergeability settled (${mergeable}) after ${i}/${attempts} checks (${context})`,
          );
        }
        return { mergeable, raw: last };
      }
      if (mergeable === "CONFLICTING" && i === attempts) {
        return { mergeable, raw: last };
      }
      if (i < attempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      }
    }
    return {
      mergeable: String(last?.mergeable || "UNKNOWN").toUpperCase(),
      raw: last,
    };
  }

  /**
   * Lightweight status payload for /agents and health diagnostics.
   */
  getStatus() {
    return {
      running: !!this.interval,
      intervalMs: this.config.intervalMs,
      activeCleanups: this.activeCleanups.size,
      queuedCleanups: this.cleanupQueue.length,
      lastRunStartedAt: this.lastRunStartedAt || 0,
      lastRunFinishedAt: this.lastRunFinishedAt || 0,
      stats: { ...this.stats },
    };
  }

  /**
   * Start the daemon (run on interval)
   */
  start() {
    console.log(
      `[pr-cleanup-daemon] Starting with interval ${this.config.intervalMs}ms`,
    );

    // Run immediately on start
    void this.run();

    // Then run on interval
    this.interval = setInterval(() => {
      void this.run();
    }, this.config.intervalMs);

    this.interval.unref?.(); // Allow process to exit if this is the only thing running
  }

  /**
   * Stop the daemon
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log(`[pr-cleanup-daemon] Stopped`);
    }
  }
}

// ── CLI Entry Point ──────────────────────────────────────────────────────────

const isMainModule = () => {
  try {
    const modulePath = fileURLToPath(import.meta.url);
    return process.argv[1] === modulePath;
  } catch {
    return false;
  }
};

if (isMainModule()) {
  const daemon = new PRCleanupDaemon();
  daemon.start();

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[pr-cleanup-daemon] Received SIGINT, shutting down...");
    daemon.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("\n[pr-cleanup-daemon] Received SIGTERM, shutting down...");
    daemon.stop();
    process.exit(0);
  });
}

export { PRCleanupDaemon, CONFIG };
