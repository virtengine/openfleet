/**
 * vk-error-resolver.mjs — Background agent for auto-resolving VK log errors
 *
 * Monitors VK log stream for error patterns and spawns resolution agents
 * in isolated worktrees. Each resolution operates independently to avoid
 * blocking the main orchestration loop.
 *
 * Supported error patterns:
 * 1. Uncommitted changes: `has uncommitted changes: <files>`
 * 2. Push failures: `Failed to push branch to remote`
 * 3. CI re-trigger failures: `Failed to re-trigger CI on PR`
 *
 * Resolution strategy:
 * - Each resolution runs in a fresh worktree
 * - Maximum 3 attempts per error signature
 * - 5-minute cooldown between attempts
 * - Only resolves for successfully completed tasks
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "url";
import { getWorktreeManager } from "./worktree-manager.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));

// ── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  maxAttempts: 3,
  cooldownMinutes: 5,
  worktreePrefix: "openfleet-resolver",
  stateFile: resolve(__dirname, "logs", "vk-error-resolver-state.json"),
};

// ── Error Pattern Detection ─────────────────────────────────────────────────

const ERROR_PATTERNS = [
  {
    name: "uncommitted-changes",
    pattern: /has uncommitted changes: (.+)$/,
    extract: (match, logLine) => ({
      branch: extractBranch(logLine),
      files: match[1].split(",").map((f) => f.trim()),
    }),
  },
  {
    name: "push-failure",
    pattern: /Failed to push branch to remote: (\S+)/,
    extract: (match, logLine) => ({
      branch: match[1],
    }),
  },
  {
    name: "ci-retrigger-failure",
    pattern: /Failed to re-trigger CI on PR #(\d+)/,
    extract: (match, logLine) => ({
      prNumber: match[1],
    }),
  },
];

function extractBranch(logLine) {
  const branchMatch = logLine.match(/ve\/[\w-]+/);
  return branchMatch ? branchMatch[0] : null;
}

// ── State Management ─────────────────────────────────────────────────────────

class ResolutionState {
  constructor(stateFile) {
    this.stateFile = stateFile;
    this.state = this.load();
  }

  load() {
    if (!existsSync(this.stateFile)) {
      return { attempts: {}, cooldowns: {} };
    }
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch {
      return { attempts: {}, cooldowns: {} };
    }
  }

  save() {
    const dir = resolve(this.stateFile, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  getSignature(errorType, context) {
    return `${errorType}:${context.branch || context.prNumber}`;
  }

  canAttempt(signature) {
    const attempts = this.state.attempts[signature] || 0;
    if (attempts >= CONFIG.maxAttempts) {
      return { allowed: false, reason: "max-attempts-reached" };
    }

    const cooldownUntil = this.state.cooldowns[signature];
    if (cooldownUntil && new Date() < new Date(cooldownUntil)) {
      return { allowed: false, reason: "cooldown-active" };
    }

    return { allowed: true };
  }

  recordAttempt(signature) {
    this.state.attempts[signature] = (this.state.attempts[signature] || 0) + 1;
    const cooldownUntil = new Date(
      Date.now() + CONFIG.cooldownMinutes * 60 * 1000,
    );
    this.state.cooldowns[signature] = cooldownUntil.toISOString();
    this.save();
  }

  clearSignature(signature) {
    delete this.state.attempts[signature];
    delete this.state.cooldowns[signature];
    this.save();
  }
}

// ── Task Status Verification ─────────────────────────────────────────────────

/**
 * Check if a task attempt completed successfully
 * Only auto-resolve errors for successful completions
 */
async function isTaskSuccessful(branch, vkBaseUrl) {
  try {
    // Extract task ID from branch name (ve/<id>-<slug>)
    const taskIdMatch = branch.match(/ve\/([a-f0-9]+)-/);
    if (!taskIdMatch) return false;

    const taskId = taskIdMatch[1];

    // Query VK API for task status
    const response = await fetch(
      `${vkBaseUrl}/api/task-attempts?task_id=${taskId}`,
      {
        headers: { Accept: "application/json" },
      },
    );

    if (!response.ok) return false;

    const attempts = await response.json();
    const latest = attempts.sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at),
    )[0];

    return latest?.status === "COMPLETED" && latest?.result === "SUCCESS";
  } catch (err) {
    console.error(
      `[vk-error-resolver] Failed to check task status: ${err.message}`,
    );
    return false;
  }
}

// ── Resolution Handlers ──────────────────────────────────────────────────────

class UncommittedChangesResolver {
  constructor(repoPath, stateManager) {
    this.repoPath = repoPath;
    this.stateManager = stateManager;
  }

  async resolve(context) {
    const { branch, files } = context;
    const signature = this.stateManager.getSignature(
      "uncommitted-changes",
      context,
    );

    console.log(
      `[vk-error-resolver] Resolving uncommitted changes on ${branch}`,
    );

    // Acquire worktree via centralized manager
    const wm = getWorktreeManager(this.repoPath);
    const acquired = await wm.acquireWorktree(
      branch,
      `err-uncommitted-${branch}`,
      { owner: "error-resolver" },
    );
    const worktreePath = acquired?.path || null;
    if (!worktreePath) {
      return { success: false, reason: "worktree-creation-failed" };
    }

    try {
      // Add uncommitted files
      execSync("git add .", {
        cwd: worktreePath,
        stdio: "pipe",
        env: { ...process.env, GIT_EDITOR: ":", GIT_MERGE_AUTOEDIT: "no" },
      });

      // Commit changes
      const commitMsg = "chore(openfleet): add uncommitted changes";
      execSync(`git commit -m "${commitMsg}" --no-edit`, {
        cwd: worktreePath,
        stdio: "pipe",
        env: { ...process.env, GIT_EDITOR: ":", GIT_MERGE_AUTOEDIT: "no" },
      });

      // Push to remote
      execSync(`git push origin ${branch}`, {
        cwd: worktreePath,
        stdio: "pipe",
      });

      console.log(
        `[vk-error-resolver] ✓ Resolved uncommitted changes on ${branch}`,
      );
      this.stateManager.clearSignature(signature);
      return { success: true };
    } catch (err) {
      console.error(`[vk-error-resolver] Resolution failed: ${err.message}`);
      return { success: false, reason: err.message };
    } finally {
      wm.releaseWorktreeByPath(worktreePath);
    }
  }
}

class PushFailureResolver {
  constructor(repoPath, stateManager) {
    this.repoPath = repoPath;
    this.stateManager = stateManager;
  }

  async resolve(context) {
    const { branch } = context;
    const signature = this.stateManager.getSignature("push-failure", context);

    console.log(`[vk-error-resolver] Resolving push failure on ${branch}`);

    // Acquire worktree via centralized manager
    const wm = getWorktreeManager(this.repoPath);
    const acquired = await wm.acquireWorktree(branch, `err-push-${branch}`, {
      owner: "error-resolver",
    });
    const worktreePath = acquired?.path || null;
    if (!worktreePath) {
      return { success: false, reason: "worktree-creation-failed" };
    }

    try {
      // Fetch latest from remote
      execSync(`git fetch origin ${branch}`, {
        cwd: worktreePath,
        stdio: "pipe",
      });

      // Check if behind
      const behind = execSync(`git rev-list --count HEAD..origin/${branch}`, {
        cwd: worktreePath,
        encoding: "utf8",
      }).trim();

      if (parseInt(behind) > 0) {
        // Rebase and retry push
        execSync(`git rebase origin/${branch}`, {
          cwd: worktreePath,
          stdio: "pipe",
          env: { ...process.env, GIT_EDITOR: ":", GIT_MERGE_AUTOEDIT: "no" },
        });
        execSync(`git push origin ${branch} --force-with-lease`, {
          cwd: worktreePath,
          stdio: "pipe",
        });

        console.log(
          `[vk-error-resolver] ✓ Resolved push failure on ${branch} (rebased)`,
        );
        this.stateManager.clearSignature(signature);
        return { success: true };
      }

      // Try force push as last resort
      execSync(`git push origin ${branch} --force-with-lease`, {
        cwd: worktreePath,
        stdio: "pipe",
      });

      console.log(
        `[vk-error-resolver] ✓ Resolved push failure on ${branch} (force-pushed)`,
      );
      this.stateManager.clearSignature(signature);
      return { success: true };
    } catch (err) {
      console.error(`[vk-error-resolver] Resolution failed: ${err.message}`);
      return { success: false, reason: err.message };
    } finally {
      wm.releaseWorktreeByPath(worktreePath);
    }
  }
}

class CIRetriggerResolver {
  constructor(repoPath, stateManager) {
    this.repoPath = repoPath;
    this.stateManager = stateManager;
  }

  async resolve(context) {
    const { prNumber } = context;
    const signature = this.stateManager.getSignature("ci-retrigger", context);

    console.log(
      `[vk-error-resolver] Resolving CI re-trigger for PR #${prNumber}`,
    );

    try {
      // Check PR status
      const status = execSync(
        `gh pr view ${prNumber} --json mergeable,mergeStateStatus`,
        { cwd: this.repoPath, encoding: "utf8" },
      );
      const prStatus = JSON.parse(status);

      if (prStatus.mergeable === "MERGEABLE") {
        // Create empty commit to trigger CI
        const branch = execSync(
          `gh pr view ${prNumber} --json headRefName --jq .headRefName`,
          { cwd: this.repoPath, encoding: "utf8" },
        ).trim();

        // Acquire worktree via centralized manager
        const wm = getWorktreeManager(this.repoPath);
        const acquired = await wm.acquireWorktree(branch, `err-ci-${branch}`, {
          owner: "error-resolver",
        });
        const worktreePath = acquired?.path || null;
        if (!worktreePath) {
          return { success: false, reason: "worktree-creation-failed" };
        }

        try {
          execSync(
            'git commit --allow-empty -m "chore: trigger CI" --no-edit',
            {
              cwd: worktreePath,
              stdio: "pipe",
              env: {
                ...process.env,
                GIT_EDITOR: ":",
                GIT_MERGE_AUTOEDIT: "no",
              },
            },
          );
          execSync(`git push origin ${branch}`, {
            cwd: worktreePath,
            stdio: "pipe",
          });

          console.log(`[vk-error-resolver] ✓ Triggered CI for PR #${prNumber}`);
          this.stateManager.clearSignature(signature);
          return { success: true };
        } finally {
          wm.releaseWorktreeByPath(worktreePath);
        }
      } else {
        console.log(
          `[vk-error-resolver] PR #${prNumber} not mergeable, escalating`,
        );
        return { success: false, reason: "pr-not-mergeable", escalate: true };
      }
    } catch (err) {
      console.error(`[vk-error-resolver] Resolution failed: ${err.message}`);
      return { success: false, reason: err.message };
    }
  }
}

// ── Main Error Resolver ──────────────────────────────────────────────────────

export class VKErrorResolver {
  constructor(repoPath, vkBaseUrl, options = {}) {
    this.repoPath = repoPath;
    this.vkBaseUrl = vkBaseUrl;
    this.stateManager = new ResolutionState(CONFIG.stateFile);
    this.enabled = options.enabled ?? true;
    this.onResolve = options.onResolve || null;

    this.resolvers = {
      "uncommitted-changes": new UncommittedChangesResolver(
        repoPath,
        this.stateManager,
      ),
      "push-failure": new PushFailureResolver(repoPath, this.stateManager),
      "ci-retrigger": new CIRetriggerResolver(repoPath, this.stateManager),
    };
  }

  async handleLogLine(line) {
    if (!this.enabled) return;

    for (const pattern of ERROR_PATTERNS) {
      const match = line.match(pattern.pattern);
      if (!match) continue;

      const context = pattern.extract(match, line);
      const signature = this.stateManager.getSignature(pattern.name, context);

      // Check if can attempt resolution
      const canAttempt = this.stateManager.canAttempt(signature);
      if (!canAttempt.allowed) {
        console.log(
          `[vk-error-resolver] Skipping ${pattern.name} on ${context.branch || context.prNumber}: ${canAttempt.reason}`,
        );
        continue;
      }

      // Verify task completed successfully
      if (
        context.branch &&
        !(await isTaskSuccessful(context.branch, this.vkBaseUrl))
      ) {
        console.log(
          `[vk-error-resolver] Skipping ${pattern.name}: task not successful`,
        );
        continue;
      }

      // Attempt resolution
      console.log(
        `[vk-error-resolver] Attempting resolution for ${pattern.name}`,
      );
      this.stateManager.recordAttempt(signature);

      const resolver = this.resolvers[pattern.name];
      const result = await resolver.resolve(context);

      if (this.onResolve) {
        this.onResolve({
          errorType: pattern.name,
          context,
          result,
          signature,
        });
      }

      if (result.escalate) {
        console.warn(
          `[vk-error-resolver] Escalation required for ${pattern.name}`,
        );
      }
    }
  }

  getStats() {
    return {
      attempts: Object.keys(this.stateManager.state.attempts).length,
      activeCooldowns: Object.keys(this.stateManager.state.cooldowns).filter(
        (sig) => new Date() < new Date(this.stateManager.state.cooldowns[sig]),
      ).length,
    };
  }
}

export default VKErrorResolver;
