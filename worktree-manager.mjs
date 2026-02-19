/**
 * worktree-manager.mjs — Centralized git worktree lifecycle management.
 *
 * Replaces scattered worktree operations across monitor.mjs, vk-error-resolver.mjs,
 * maintenance.mjs, and git-editor-fix.mjs with a single, consistent API.
 *
 * Features:
 *   - acquire/release worktrees linked to task keys
 *   - find existing worktrees by branch name
 *   - automatic cleanup of stale/orphaned worktrees
 *   - consistent git env (GIT_EDITOR, GIT_MERGE_AUTOEDIT)
 *   - in-memory registry with disk persistence
 *   - thread registry integration for agent <-> worktree linkage
 */

import { spawnSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  statSync,
  readdirSync,
} from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Path Setup ──────────────────────────────────────────────────────────────

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} WorktreeRecord
 * @property {string}      path       Absolute path to the worktree directory
 * @property {string}      branch     Branch checked out in the worktree
 * @property {string}      taskKey    Task key linking to thread registry (optional)
 * @property {number}      createdAt  Unix ms timestamp
 * @property {number}      lastUsedAt Unix ms timestamp
 * @property {string}      status     "active" | "releasing" | "stale"
 * @property {string|null} owner      Who created it: "monitor", "error-resolver", "merge-strategy", "manual"
 */

// ── Constants ───────────────────────────────────────────────────────────────

const TAG = "[worktree-manager]";
const DEFAULT_BASE_DIR = ".cache/worktrees";
const REGISTRY_FILE = resolve(__dirname, "logs", "worktree-registry.json");
const MAX_WORKTREE_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours
const COPILOT_WORKTREE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (existing policy)
const GIT_ENV = {
  GIT_EDITOR: ":",
  GIT_MERGE_AUTOEDIT: "no",
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * Guard against git config corruption caused by worktree operations.
 * Some git versions on Windows set core.bare=true on the main repo when
 * adding worktrees, which conflicts with core.worktree and breaks git.
 * This function cleans up those settings after every worktree operation.
 * @param {string} repoRoot - Path to the main repository root
 */
function fixGitConfigCorruption(repoRoot) {
  try {
    const bareResult = spawnSync("git", ["config", "--local", "core.bare"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, ...GIT_ENV },
    });
    if (bareResult.stdout?.trim() === "true") {
      console.warn(
        `${TAG} ⚠️ Detected core.bare=true on main repo — fixing git config corruption`,
      );
      spawnSync("git", ["config", "--unset", "core.bare"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, ...GIT_ENV },
      });
    }
  } catch {
    /* best-effort — don't crash on config repair */
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get age in milliseconds from filesystem mtime.
 * Used as fallback when no registry entry exists for a worktree.
 * @param {string} dirPath
 * @returns {number} Age in ms, or Infinity if path cannot be stat'd
 */
function _getFilesystemAgeMs(dirPath) {
  try {
    const stat = statSync(dirPath);
    return Date.now() - stat.mtimeMs;
  } catch {
    return Infinity;
  }
}

/**
 * Sanitize a branch name into a filesystem-safe directory name.
 * Replaces `/` with `-`, strips characters that are unsafe on Windows or Unix.
 * @param {string} branch
 * @returns {string}
 */
function sanitizeBranchName(branch) {
  return branch
    .replace(/^refs\/heads\//, "")
    .replace(/\//g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .replace(/^\.+/, "") // no leading dots
    .replace(/\.+$/, "") // no trailing dots
    .slice(0, 60); // Windows MAX_PATH is 260, worktree base path ~60, leaves ~140 for this + git overhead
}

/**
 * Build the env object for all git subprocess calls.
 * @returns {NodeJS.ProcessEnv}
 */
function gitEnv() {
  return { ...process.env, ...GIT_ENV };
}

/**
 * Run a git command synchronously with consistent options.
 * @param {string[]} args  git arguments
 * @param {string}   cwd   working directory
 * @param {object}   [opts]
 * @param {number}   [opts.timeout=30000]
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function gitSync(args, cwd, opts = {}) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: opts.timeout ?? 30_000,
    windowsHide: true,
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    // Avoid shell invocation to prevent Node DEP0190 warnings and argument
    // concatenation risks.
    shell: false,
  });
}

/**
 * Resolve the Git top-level directory for a candidate path.
 * Returns null when the candidate is not inside a git worktree.
 *
 * @param {string} candidatePath
 * @returns {string|null}
 */
function detectGitTopLevel(candidatePath) {
  if (!candidatePath) return null;
  try {
    const result = gitSync(
      ["rev-parse", "--show-toplevel"],
      resolve(candidatePath),
      { timeout: 5000 },
    );
    if (result.status !== 0) return null;
    const topLevel = String(result.stdout || "").trim();
    return topLevel ? resolve(topLevel) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the best repository root for singleton initialization.
 * Priority:
 *   1) explicit repoRoot arg
 *   2) VE_REPO_ROOT / OPENFLEET_REPO_ROOT env
 *   3) current working directory's git top-level
 *   4) module-relative git top-level (useful for local dev)
 *   5) process.cwd() fallback
 *
 * @param {string|undefined} repoRoot
 * @returns {string}
 */
function resolveDefaultRepoRoot(repoRoot) {
  if (repoRoot) return resolve(repoRoot);

  const envRoot =
    process.env.VE_REPO_ROOT || process.env.OPENFLEET_REPO_ROOT || "";
  const fromEnv = detectGitTopLevel(envRoot) || (envRoot ? resolve(envRoot) : null);
  if (fromEnv) return fromEnv;

  const fromCwd = detectGitTopLevel(process.cwd());
  if (fromCwd) return fromCwd;

  const moduleRelativeCandidate = resolve(__dirname, "..", "..");
  const fromModule = detectGitTopLevel(moduleRelativeCandidate);
  if (fromModule) return fromModule;

  return resolve(process.cwd());
}

/**
 * Convert a Windows path to an extended-length path so long paths delete cleanly.
 * @param {string} pathValue
 * @returns {string}
 */
function toWindowsExtendedPath(pathValue) {
  if (process.platform !== "win32") return pathValue;
  if (pathValue.startsWith("\\\\?\\")) return pathValue;
  if (pathValue.startsWith("\\\\")) {
    return `\\\\?\\UNC\\${pathValue.slice(2)}`;
  }
  return `\\\\?\\${pathValue}`;
}

/**
 * Escape a string for use as a PowerShell single-quoted literal.
 * @param {string} value
 * @returns {string}
 */
function escapePowerShellLiteral(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Remove a path on Windows using PowerShell, with optional attribute cleanup.
 * Uses extended-length paths to avoid MAX_PATH errors.
 * @param {string} targetPath
 * @param {object} [opts]
 * @param {boolean} [opts.clearAttributes=false]
 * @param {number} [opts.timeoutMs=60000]
 */
function removePathWithPowerShell(targetPath, opts = {}) {
  const pwsh = process.env.PWSH_PATH || "powershell.exe";
  const extendedPath = toWindowsExtendedPath(targetPath);
  const escapedPath = escapePowerShellLiteral(extendedPath);
  const clearAttributes = opts.clearAttributes === true;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 60_000;
  const preface = clearAttributes
    ? "Get-ChildItem -LiteralPath '" +
      escapedPath +
      "' -Recurse -Force | ForEach-Object { $_.Attributes = 'Normal' } -ErrorAction SilentlyContinue; "
    : "";
  execSync(
    `${pwsh} -NoProfile -Command "${preface}Remove-Item -LiteralPath '${escapedPath}' -Recurse -Force -ErrorAction Stop"`,
    { timeout: timeoutMs, stdio: "pipe" },
  );
}

/**
 * Remove a path synchronously, using PowerShell on Windows for long paths.
 * @param {string} targetPath
 * @param {object} [opts]
 * @param {boolean} [opts.clearAttributes=false]
 * @param {number} [opts.timeoutMs=60000]
 */
function removePathSync(targetPath, opts = {}) {
  if (!existsSync(targetPath)) return;
  if (process.platform === "win32") {
    removePathWithPowerShell(targetPath, opts);
    return;
  }
  rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 1000,
  });
}

// ── WorktreeManager Class ───────────────────────────────────────────────────

class WorktreeManager {
  /**
   * @param {string} repoRoot  Absolute path to the repository root
   * @param {object} [opts]
   * @param {string} [opts.baseDir]  Custom base directory for worktrees
   */
  constructor(repoRoot, opts = {}) {
    this.repoRoot = resolve(repoRoot);
    this.baseDir = resolve(repoRoot, opts.baseDir ?? DEFAULT_BASE_DIR);
    /** @type {Map<string, WorktreeRecord>} keyed by taskKey (or auto-generated key) */
    this.registry = new Map();
    this._loaded = false;
  }

  // ── Registry Persistence ────────────────────────────────────────────────

  /**
   * Load the registry from disk, filtering out expired / missing entries.
   */
  async loadRegistry() {
    if (this._loaded) return;
    try {
      const raw = await readFile(REGISTRY_FILE, "utf8");
      const entries = JSON.parse(raw);
      for (const [key, record] of Object.entries(entries)) {
        // Skip entries that are far beyond max age
        if (Date.now() - record.lastUsedAt > MAX_WORKTREE_AGE_MS * 2) continue;
        // Verify path still exists on disk
        if (!existsSync(record.path)) continue;
        this.registry.set(key, record);
      }
    } catch {
      // No registry yet or corrupt — start fresh
    }
    this._loaded = true;
  }

  /**
   * Persist the current registry to disk.
   */
  async saveRegistry() {
    try {
      await mkdir(resolve(__dirname, "logs"), { recursive: true });
      const obj = Object.fromEntries(this.registry);
      await writeFile(REGISTRY_FILE, JSON.stringify(obj, null, 2), "utf8");
    } catch {
      // Non-critical — log dir may not be writable
    }
  }

  /**
   * Synchronous variant of saveRegistry for use in cleanup paths.
   */
  saveRegistrySync() {
    try {
      mkdirSync(resolve(__dirname, "logs"), { recursive: true });
      const obj = Object.fromEntries(this.registry);
      writeFileSync(REGISTRY_FILE, JSON.stringify(obj, null, 2), "utf8");
    } catch {
      // Non-critical
    }
  }

  // ── Core Operations ─────────────────────────────────────────────────────

  /**
   * Acquire a worktree for the given branch, creating it if needed.
   *
   * @param {string} branch    Branch name (e.g. "ve/abc-fix-auth")
   * @param {string} taskKey   Task key for registry linkage
   * @param {object} [opts]
   * @param {string} [opts.owner]      Who is acquiring ("monitor" | "error-resolver" | etc.)
   * @param {string} [opts.baseBranch] Create the worktree from this base branch
   * @returns {Promise<{ path: string, created: boolean, existing: boolean }>}
   */
  async acquireWorktree(branch, taskKey, opts = {}) {
    await this.loadRegistry();

    // 1. Check if a worktree already exists for this branch
    const existingPath = this.findWorktreeForBranch(branch);
    if (existingPath) {
      // Update registry with the (possibly new) taskKey
      const existingKey = this._findKeyByPath(existingPath);
      if (existingKey && existingKey !== taskKey) {
        // Transfer ownership
        const record = this.registry.get(existingKey);
        this.registry.delete(existingKey);
        if (record) {
          record.taskKey = taskKey;
          record.lastUsedAt = Date.now();
          record.owner = opts.owner ?? record.owner;
          this.registry.set(taskKey, record);
        }
      } else if (!existingKey) {
        // Not tracked — register it now
        this.registry.set(taskKey, {
          path: existingPath,
          branch,
          taskKey,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          status: "active",
          owner: opts.owner ?? "manual",
        });
      } else {
        // Same key — just update timestamp
        const record = this.registry.get(taskKey);
        if (record) {
          record.lastUsedAt = Date.now();
        }
      }
      await this.saveRegistry();
      return { path: existingPath, created: false, existing: true };
    }

    // 2. Create a new worktree
    const dirName = sanitizeBranchName(branch);
    const worktreePath = resolve(this.baseDir, dirName);

    // Ensure base directory exists
    try {
      mkdirSync(this.baseDir, { recursive: true });
    } catch {
      // May already exist
    }

    // Build git worktree add command
    const args = ["worktree", "add", worktreePath];
    if (opts.baseBranch) {
      args.push("-b", branch, opts.baseBranch);
    } else {
      args.push(branch);
    }

    // Use extended timeout for large repos (7000+ files can take >120s on Windows)
    const WT_TIMEOUT = 300_000;
    let result = gitSync(args, this.repoRoot, { timeout: WT_TIMEOUT });

    if (result.status !== 0) {
      const stderr = (result.stderr || "").trim();
      console.error(
        `${TAG} Failed to create worktree for ${branch}: ${stderr}`,
      );

      // ── Branch or path already exists (from a prior run) ──
      // `-b` fails because the branch ref already exists, OR
      // the worktree directory itself already exists on disk.
      if (stderr.includes("already exists")) {
        console.warn(
          `${TAG} branch/path "${branch}" already exists, attempting recovery`,
        );
        // Prune stale worktree refs first so the branch isn't considered "checked out"
        gitSync(["worktree", "prune"], this.repoRoot, { timeout: 15_000 });

        // Remove stale worktree directory if it exists but isn't tracked by git
        if (existsSync(worktreePath)) {
          console.warn(
            `${TAG} removing stale worktree directory: ${worktreePath}`,
          );
          try {
            rmSync(worktreePath, { recursive: true, force: true });
          } catch (rmErr) {
            console.error(
              `${TAG} failed to remove stale worktree dir: ${rmErr.message}`,
            );
          }
        }

        // Try checking out the existing branch into the new worktree (no -b)
        // Use extended timeout for large repos (7000+ files can take >120s on Windows)
        const existingResult = gitSync(
          ["worktree", "add", worktreePath, branch],
          this.repoRoot,
          { timeout: WT_TIMEOUT },
        );

        if (existingResult.status !== 0) {
          const stderr2 = (existingResult.stderr || "").trim();
          if (
            stderr2.includes("already checked out") ||
            stderr2.includes("is already checked out") ||
            stderr2.includes("is already used")
          ) {
            // Branch is checked out in another worktree — force-reset with -B
            console.warn(
              `${TAG} branch "${branch}" already checked out elsewhere, using -B to force-reset`,
            );
            const forceArgs = ["worktree", "add", worktreePath, "-B", branch];
            if (opts.baseBranch) forceArgs.push(opts.baseBranch);
            result = gitSync(forceArgs, this.repoRoot, { timeout: WT_TIMEOUT });
            if (result.status !== 0) {
              console.error(
                `${TAG} Force-reset worktree also failed: ${(result.stderr || "").trim()}`,
              );
              // Clean up partial worktree directory to prevent repeat failures
              this._cleanupPartialWorktree(worktreePath);
              return { path: worktreePath, created: false, existing: false };
            }
          } else {
            console.error(
              `${TAG} Checkout of existing branch also failed: ${stderr2}`,
            );
            // Clean up partial worktree directory to prevent repeat failures
            this._cleanupPartialWorktree(worktreePath);
            return { path: worktreePath, created: false, existing: false };
          }
        }
        // ── Branch already checked out in another worktree ──
      } else if (
        stderr.includes("already checked out") ||
        stderr.includes("is already used")
      ) {
        const detachArgs = [
          "worktree",
          "add",
          "--detach",
          worktreePath,
          branch,
        ];
        const retryResult = gitSync(detachArgs, this.repoRoot, {
          timeout: WT_TIMEOUT,
        });
        if (retryResult.status !== 0) {
          console.error(
            `${TAG} Detached worktree also failed: ${(retryResult.stderr || "").trim()}`,
          );
          // Clean up partial worktree directory to prevent repeat failures
          this._cleanupPartialWorktree(worktreePath);
          return { path: worktreePath, created: false, existing: false };
        }
      } else {
        // Unknown error — clean up any partial worktree directory
        this._cleanupPartialWorktree(worktreePath);
        return { path: worktreePath, created: false, existing: false };
      }
    }

    // 2b. Guard against git config corruption after worktree operations.
    // Some git versions on Windows set core.bare=true on the main repo
    // when adding worktrees, which conflicts with core.worktree and breaks git.
    fixGitConfigCorruption(this.repoRoot);

    // 3. Register the new worktree
    /** @type {WorktreeRecord} */
    const record = {
      path: worktreePath,
      branch,
      taskKey,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      status: "active",
      owner: opts.owner ?? "manual",
    };
    this.registry.set(taskKey, record);
    await this.saveRegistry();

    console.log(`${TAG} Created worktree for ${branch} at ${worktreePath}`);
    return { path: worktreePath, created: true, existing: false };
  }

  /**
   * Release (remove) a worktree by its taskKey.
   * @param {string} taskKey
   * @returns {Promise<{ success: boolean, path: string|null }>}
   */
  async releaseWorktree(taskKey) {
    await this.loadRegistry();
    const record = this.registry.get(taskKey);
    if (!record) {
      return { success: false, path: null };
    }
    return this._removeWorktree(taskKey, record);
  }

  /**
   * Release (remove) a worktree by its filesystem path.
   * @param {string} path
   * @returns {Promise<{ success: boolean, path: string|null }>}
   */
  async releaseWorktreeByPath(path) {
    await this.loadRegistry();
    const normalizedPath = resolve(path);
    const key = this._findKeyByPath(normalizedPath);
    if (!key) {
      // Not in registry — try to remove directly
      return this._forceRemoveWorktree(normalizedPath);
    }
    const record = this.registry.get(key);
    return this._removeWorktree(key, record);
  }

  /**
   * Release (remove) a worktree by its branch name.
   * @param {string} branch
   * @returns {Promise<{ success: boolean, path: string|null }>}
   */
  async releaseWorktreeByBranch(branch) {
    await this.loadRegistry();
    const key = this._findKeyByBranch(branch);
    if (key) {
      const record = this.registry.get(key);
      return this._removeWorktree(key, record);
    }
    // Fallback: find via git and remove directly
    const path = this.findWorktreeForBranch(branch);
    if (path) {
      return this._forceRemoveWorktree(path);
    }
    return { success: false, path: null };
  }

  // ── Discovery ───────────────────────────────────────────────────────────

  /**
   * Find the worktree path for a given branch by parsing `git worktree list --porcelain`.
   * This replaces the scattered implementations in monitor.mjs and git-editor-fix.mjs.
   *
   * @param {string} branch  Branch name (with or without refs/heads/ prefix)
   * @returns {string|null}  Absolute path to the worktree, or null
   */
  findWorktreeForBranch(branch) {
    if (!branch) return null;
    const normalizedBranch = branch.replace(/^refs\/heads\//, "");

    try {
      const result = gitSync(
        ["worktree", "list", "--porcelain"],
        this.repoRoot,
        { timeout: 10_000 },
      );
      if (result.status !== 0 || !result.stdout) return null;

      const lines = result.stdout.split("\n");
      let currentPath = null;

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          currentPath = line.slice(9).trim();
        } else if (line.startsWith("branch ") && currentPath) {
          const branchRef = line.slice(7).trim();
          const branchName = branchRef.replace(/^refs\/heads\//, "");
          if (branchName === normalizedBranch) {
            return currentPath;
          }
        } else if (line.trim() === "") {
          currentPath = null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * List all worktrees known to git, enriched with registry metadata.
   * @returns {Array<{ path: string, branch: string|null, taskKey: string|null, age: number, status: string, owner: string|null, isMainWorktree: boolean }>}
   */
  listAllWorktrees() {
    /** @type {Array<{ path: string, branch: string|null, taskKey: string|null, age: number, status: string, owner: string|null, isMainWorktree: boolean }>} */
    const worktrees = [];

    try {
      const result = gitSync(
        ["worktree", "list", "--porcelain"],
        this.repoRoot,
        { timeout: 10_000 },
      );
      if (result.status !== 0 || !result.stdout) return worktrees;

      // Parse porcelain output — blocks separated by blank lines
      const blocks = result.stdout.split(/\n\n/).filter(Boolean);

      for (const block of blocks) {
        const pathMatch = block.match(/^worktree\s+(.+)/m);
        if (!pathMatch) continue;
        const wtPath = pathMatch[1].trim();

        const branchMatch = block.match(/^branch\s+(.+)/m);
        const branchRef = branchMatch ? branchMatch[1].trim() : null;
        const branchName = branchRef
          ? branchRef.replace(/^refs\/heads\//, "")
          : null;

        const isBare = /^bare$/m.test(block);
        const isMainWorktree = wtPath === this.repoRoot || isBare;

        // Look up in registry
        const registryKey = this._findKeyByPath(resolve(wtPath));
        const record = registryKey ? this.registry.get(registryKey) : null;

        worktrees.push({
          path: wtPath,
          branch: branchName,
          taskKey: record?.taskKey ?? null,
          age: record ? Date.now() - record.createdAt : -1,
          status: record?.status ?? (isMainWorktree ? "main" : "untracked"),
          owner: record?.owner ?? null,
          isMainWorktree,
        });
      }
    } catch {
      // Best effort
    }

    return worktrees;
  }

  /**
   * List only worktrees that are tracked in the registry with "active" status.
   * @returns {Array<{ path: string, branch: string|null, taskKey: string|null, age: number, status: string, owner: string|null, isMainWorktree: boolean }>}
   */
  listActiveWorktrees() {
    const all = this.listAllWorktrees();
    return all.filter((wt) => wt.status === "active" || wt.taskKey !== null);
  }

  // ── Maintenance ─────────────────────────────────────────────────────────

  /**
   * Prune stale and orphaned worktrees.
   * This replaces `cleanupWorktrees()` from maintenance.mjs.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.dryRun=false]  If true, log actions but don't delete
   * @returns {Promise<{ pruned: number, evicted: number }>}
   */
  async pruneStaleWorktrees(opts = {}) {
    await this.loadRegistry();
    const dryRun = opts.dryRun ?? false;
    let pruned = 0;
    let evicted = 0;

    // Step 1: git worktree prune (cleans up refs for deleted worktree dirs)
    try {
      if (!dryRun) {
        gitSync(["worktree", "prune"], this.repoRoot, { timeout: 15_000 });
      }
      console.log(
        `${TAG} git worktree prune completed${dryRun ? " (dry-run)" : ""}`,
      );
    } catch (e) {
      console.warn(`${TAG} git worktree prune failed: ${e.message}`);
    }

    // Step 2: Find VK / vibe-kanban worktrees older than MAX_WORKTREE_AGE_MS → remove
    const allWorktrees = this.listAllWorktrees();

    for (const wt of allWorktrees) {
      if (wt.isMainWorktree) continue;

      // Check vibe-kanban temp worktrees
      const isVK =
        wt.path.includes("vibe-kanban") ||
        (wt.branch && wt.branch.startsWith("ve/"));

      if (isVK) {
        const registryKey = this._findKeyByPath(resolve(wt.path));
        const record = registryKey ? this.registry.get(registryKey) : null;
        const ageMs = record
          ? Date.now() - record.lastUsedAt
          : _getFilesystemAgeMs(wt.path);

        // Prune if age exceeds threshold or path doesn't exist
        if (ageMs > MAX_WORKTREE_AGE_MS || !existsSync(wt.path)) {
          console.log(
            `${TAG} ${dryRun ? "[dry-run] would remove" : "removing"} stale VK worktree: ${wt.path}`,
          );
          if (!dryRun) {
            this._forceRemoveWorktreeSync(wt.path);
            if (registryKey) {
              this.registry.delete(registryKey);
              evicted++;
            }
            pruned++;
          }
        }
      }

      // Step 3: copilot-worktree-YYYY-MM-DD entries older than 7 days
      const dateMatch = wt.path.match(/copilot-worktree-(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        const wtDate = new Date(dateMatch[1]);
        const ageMs = Date.now() - wtDate.getTime();
        if (ageMs > COPILOT_WORKTREE_MAX_AGE_MS) {
          console.log(
            `${TAG} ${dryRun ? "[dry-run] would remove" : "removing"} old copilot worktree: ${wt.path}`,
          );
          if (!dryRun) {
            this._forceRemoveWorktreeSync(wt.path);
            const key = this._findKeyByPath(resolve(wt.path));
            if (key) {
              this.registry.delete(key);
              evicted++;
            }
            pruned++;
          }
        }
      }
    }

    // Step 3b: pr-cleanup temp worktrees (left by pr-cleanup-daemon)
    for (const wt of allWorktrees) {
      if (wt.isMainWorktree) continue;
      if (wt.path.includes("pr-cleanup-")) {
        const ageMs = _getFilesystemAgeMs(wt.path);
        if (ageMs > MAX_WORKTREE_AGE_MS || !existsSync(wt.path)) {
          console.log(
            `${TAG} ${dryRun ? "[dry-run] would remove" : "removing"} stale pr-cleanup worktree: ${wt.path}`,
          );
          if (!dryRun) {
            this._forceRemoveWorktreeSync(wt.path);
            pruned++;
          }
        }
      }
    }

    // Step 3c: catch-all — any other non-main worktree older than 7 days
    for (const wt of allWorktrees) {
      if (wt.isMainWorktree) continue;
      const isVK =
        wt.path.includes("vibe-kanban") ||
        (wt.branch && wt.branch.startsWith("ve/"));
      const isCopilot = /copilot-worktree-\d{4}-\d{2}-\d{2}/.test(wt.path);
      const isPrCleanup = wt.path.includes("pr-cleanup-");
      if (isVK || isCopilot || isPrCleanup) continue;

      const registryKey = this._findKeyByPath(resolve(wt.path));
      const record = registryKey ? this.registry.get(registryKey) : null;
      const ageMs = record
        ? Date.now() - record.lastUsedAt
        : _getFilesystemAgeMs(wt.path);
      if (ageMs > COPILOT_WORKTREE_MAX_AGE_MS) {
        console.log(
          `${TAG} ${dryRun ? "[dry-run] would remove" : "removing"} old untracked worktree: ${wt.path} (age=${(ageMs / 3600000).toFixed(1)}h)`,
        );
        if (!dryRun) {
          this._forceRemoveWorktreeSync(wt.path);
          if (registryKey) {
            this.registry.delete(registryKey);
            evicted++;
          }
          pruned++;
        }
      }
    }

    // Step 3d: scan .cache/worktrees/ for orphan dirs not tracked by git
    try {
      const cacheDir = resolve(this.repoRoot, DEFAULT_BASE_DIR);
      if (existsSync(cacheDir)) {
        const gitPaths = new Set(allWorktrees.map((wt) => resolve(wt.path)));
        const entries = readdirSync(cacheDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const dirPath = resolve(cacheDir, entry.name);
          if (gitPaths.has(dirPath)) continue;
          const ageMs = _getFilesystemAgeMs(dirPath);
          if (ageMs > MAX_WORKTREE_AGE_MS) {
            console.log(
              `${TAG} ${dryRun ? "[dry-run] would remove" : "removing"} orphan cache dir: ${dirPath} (age=${(ageMs / 3600000).toFixed(1)}h)`,
            );
            if (!dryRun) {
              try {
                rmSync(dirPath, { recursive: true, force: true });
              } catch (e) {
                console.warn(
                  `${TAG} rmSync failed for ${dirPath}: ${e.message}`,
                );
              }
              pruned++;
            }
          }
        }
      }
    } catch (e) {
      console.warn(`${TAG} cache dir scan failed: ${e.message}`);
    }

    // Step 4: Evict registry entries whose paths no longer exist on disk
    for (const [key, record] of this.registry.entries()) {
      if (!existsSync(record.path)) {
        console.log(
          `${TAG} ${dryRun ? "[dry-run] would evict" : "evicting"} orphaned registry entry: ${key} → ${record.path}`,
        );
        if (!dryRun) {
          this.registry.delete(key);
          evicted++;
        }
      }
    }

    if (!dryRun) {
      await this.saveRegistry();
    }

    return { pruned, evicted };
  }

  // ── Registry Lookups ────────────────────────────────────────────────────

  /**
   * Get the WorktreeRecord for a given taskKey.
   * @param {string} taskKey
   * @returns {WorktreeRecord|null}
   */
  getWorktreeForTask(taskKey) {
    return this.registry.get(taskKey) ?? null;
  }

  /**
   * Refresh the lastUsedAt timestamp for a task's worktree.
   * Call this periodically for long-running tasks to prevent premature cleanup.
   * @param {string} taskKey
   */
  async updateWorktreeUsage(taskKey) {
    const record = this.registry.get(taskKey);
    if (record) {
      record.lastUsedAt = Date.now();
      await this.saveRegistry();
    }
  }

  /**
   * Get aggregate statistics about tracked worktrees.
   * @returns {{ total: number, active: number, stale: number, byOwner: Record<string, number> }}
   */
  getStats() {
    let total = 0;
    let active = 0;
    let stale = 0;
    /** @type {Record<string, number>} */
    const byOwner = {};

    for (const record of this.registry.values()) {
      total++;
      if (record.status === "active") active++;
      if (
        record.status === "stale" ||
        Date.now() - record.lastUsedAt > MAX_WORKTREE_AGE_MS
      ) {
        stale++;
      }
      const owner = record.owner ?? "unknown";
      byOwner[owner] = (byOwner[owner] ?? 0) + 1;
    }

    return { total, active, stale, byOwner };
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Find a registry key by the worktree's filesystem path.
   * @param {string} normalizedPath
   * @returns {string|null}
   */
  _findKeyByPath(normalizedPath) {
    for (const [key, record] of this.registry.entries()) {
      if (resolve(record.path) === normalizedPath) return key;
    }
    return null;
  }

  /**
   * Find a registry key by branch name.
   * @param {string} branch
   * @returns {string|null}
   */
  _findKeyByBranch(branch) {
    const normalized = branch.replace(/^refs\/heads\//, "");
    for (const [key, record] of this.registry.entries()) {
      if (record.branch === normalized) return key;
    }
    return null;
  }

  /**
   * Clean up a partially-created worktree directory left behind by a failed
   * `git worktree add` (e.g. timeout mid-checkout). If the directory remains,
   * subsequent attempts will fail with "already exists" in an infinite loop.
   * @param {string} wtPath  Absolute path to the worktree directory
   */
  _cleanupPartialWorktree(wtPath) {
    if (!existsSync(wtPath)) return;
    try {
      removePathSync(wtPath, { clearAttributes: true });
      console.log(`${TAG} cleaned up partial worktree directory: ${wtPath}`);
    } catch (err) {
      console.warn(
        `${TAG} failed to clean up partial worktree at ${wtPath}: ${err.message}`,
      );
    }
    // Prune stale worktree refs that may reference the removed directory
    try {
      gitSync(["worktree", "prune"], this.repoRoot, { timeout: 15_000 });
    } catch {
      /* best effort */
    }
  }

  /**
   * Remove a worktree tracked in the registry.
   * @param {string} key   Registry key
   * @param {WorktreeRecord} record
   * @returns {Promise<{ success: boolean, path: string|null }>}
   */
  async _removeWorktree(key, record) {
    if (!record) return { success: false, path: null };
    const wtPath = record.path;

    // Mark as releasing
    record.status = "releasing";

    const result = gitSync(
      ["worktree", "remove", "--force", wtPath],
      this.repoRoot,
      { timeout: 60_000 },
    );

    if (result.status !== 0) {
      const stderr = (result.stderr || "").trim();
      console.warn(`${TAG} Failed to remove worktree at ${wtPath}: ${stderr}`);
      // If git fails (e.g. "Directory not empty"), fall back to filesystem removal
      if (existsSync(wtPath)) {
        try {
          // Attempt 1: On Windows, use PowerShell first (most reliable for locked files + long paths)
          if (process.platform === "win32") {
            removePathWithPowerShell(wtPath, {
              clearAttributes: true,
              timeoutMs: 60_000,
            });
            console.log(`${TAG} PowerShell cleanup succeeded for ${wtPath}`);
            gitSync(["worktree", "prune"], this.repoRoot, { timeout: 15_000 });
          } else {
            // Unix: Use rmSync with retries
            removePathSync(wtPath);
            console.log(`${TAG} Filesystem cleanup succeeded for ${wtPath}`);
            gitSync(["worktree", "prune"], this.repoRoot, { timeout: 15_000 });
          }
        } catch (cleanupErr) {
          // Last resort: try basic Node.js rmSync (may partially succeed)
          try {
            rmSync(wtPath, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 1000,
            });
            console.log(`${TAG} Fallback cleanup succeeded for ${wtPath}`);
            gitSync(["worktree", "prune"], this.repoRoot, { timeout: 15_000 });
          } catch (finalErr) {
            console.warn(`${TAG} All cleanup attempts failed for ${wtPath}: ${cleanupErr.message || cleanupErr}`);
            // Don't throw — mark as zombie and continue. Background cleanup will retry later.
            this.registry.set(key, { ...record, status: "zombie", error: cleanupErr.message });
            return { success: false, path: wtPath };
          }
        }
      }
    }

    this.registry.delete(key);
    await this.saveRegistry();

    console.log(`${TAG} Released worktree: ${wtPath}`);
    // Report command outcome, not filesystem state. We still clean registry/path
    // best-effort on failure to avoid stale worktree loops.
    return { success: result.status === 0, path: wtPath };
  }

  /**
   * Force-remove a worktree that may or may not be in the registry.
   * @param {string} wtPath  Absolute path
   * @returns {Promise<{ success: boolean, path: string|null }>}
   */
  async _forceRemoveWorktree(wtPath) {
    const result = gitSync(
      ["worktree", "remove", "--force", wtPath],
      this.repoRoot,
      { timeout: 60_000 },
    );

    let success = result.status === 0;
    if (!success) {
      console.warn(
        `${TAG} Failed to force-remove worktree at ${wtPath}: ${(result.stderr || "").trim()}`,
      );
      // Fall back to filesystem removal (handles "Directory not empty" on Windows)
      if (existsSync(wtPath)) {
        try {
          // Attempt 1: On Windows, use PowerShell first (handles long paths better)
          if (process.platform === "win32") {
            removePathWithPowerShell(wtPath, { timeoutMs: 30_000 });
          } else {
            rmSync(wtPath, {
              recursive: true,
              force: true,
              maxRetries: 3,
              retryDelay: 500,
            });
          }
          gitSync(["worktree", "prune"], this.repoRoot, { timeout: 15_000 });
          success = true;
          console.log(`${TAG} Filesystem cleanup succeeded for ${wtPath}`);
        } catch (rmErr) {
          // Attempt 2: On Windows, retry with attribute cleanup
          if (process.platform === "win32") {
            try {
              removePathWithPowerShell(wtPath, {
                clearAttributes: true,
                timeoutMs: 30_000,
              });
              gitSync(["worktree", "prune"], this.repoRoot, { timeout: 15_000 });
              success = true;
              console.log(`${TAG} PowerShell cleanup succeeded for ${wtPath}`);
            } catch (pwshErr) {
              console.warn(`${TAG} All cleanup attempts failed for ${wtPath}: ${rmErr.message}`);
            }
          } else {
            console.warn(`${TAG} Filesystem cleanup failed: ${rmErr.message}`);
          }
        }
      } else {
        // Directory already gone, just needs prune
        gitSync(["worktree", "prune"], this.repoRoot, { timeout: 15_000 });
        success = true;
      }
    } else {
      console.log(`${TAG} Force-removed worktree: ${wtPath}`);
    }

    // Also clean from registry if present
    const key = this._findKeyByPath(resolve(wtPath));
    if (key) {
      this.registry.delete(key);
      await this.saveRegistry();
    }

    return { success, path: wtPath };
  }

  /**
   * Synchronous force-remove for use in prune loops.
   * @param {string} wtPath
   */
  _forceRemoveWorktreeSync(wtPath) {
    try {
      gitSync(["worktree", "remove", "--force", wtPath], this.repoRoot, {
        timeout: 30_000,
      });
    } catch {
      // Best effort
    }
    if (existsSync(wtPath)) {
      try {
        removePathSync(wtPath, { clearAttributes: true, timeoutMs: 30_000 });
      } catch {
        // Best effort
      }
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

/** @type {WorktreeManager|null} */
let _instance = null;

/**
 * Get or create the singleton WorktreeManager.
 * @param {string} [repoRoot] - Repository root (required on first call)
 * @param {object} [opts] - Options (only used on first call)
 * @returns {WorktreeManager}
 */
function getWorktreeManager(repoRoot, opts) {
  const resolvedRoot = resolveDefaultRepoRoot(repoRoot);
  if (!_instance) {
    _instance = new WorktreeManager(resolvedRoot, opts);
    return _instance;
  }

  // Allow explicit repoRoot to rebind singleton for the current process.
  if (repoRoot && _instance.repoRoot !== resolvedRoot) {
    _instance = new WorktreeManager(resolvedRoot, opts);
  }
  return _instance;
}

/**
 * Reset the singleton (for testing).
 */
function resetWorktreeManager() {
  _instance = null;
}

// ── Convenience Wrappers ────────────────────────────────────────────────────
// These use the singleton internally so callers don't need to manage it.

/**
 * Acquire a worktree for the given branch.
 * @param {string} branch
 * @param {string} taskKey
 * @param {object} [opts]
 * @returns {Promise<{ path: string, created: boolean, existing: boolean }>}
 */
function acquireWorktree(branch, taskKey, opts) {
  return getWorktreeManager().acquireWorktree(branch, taskKey, opts);
}

/**
 * Release a worktree by its taskKey.
 * @param {string} taskKey
 * @returns {Promise<{ success: boolean, path: string|null }>}
 */
function releaseWorktree(taskKey) {
  return getWorktreeManager().releaseWorktree(taskKey);
}

/**
 * Release a worktree by its branch name.
 * @param {string} branch
 * @returns {Promise<{ success: boolean, path: string|null }>}
 */
function releaseWorktreeByBranch(branch) {
  return getWorktreeManager().releaseWorktreeByBranch(branch);
}

/**
 * Find the worktree path for a given branch.
 * @param {string} branch
 * @returns {string|null}
 */
function findWorktreeForBranch(branch) {
  return getWorktreeManager().findWorktreeForBranch(branch);
}

/**
 * List all worktrees that are actively tracked.
 * @returns {Array<{ path: string, branch: string|null, taskKey: string|null, age: number, status: string, owner: string|null, isMainWorktree: boolean }>}
 */
function listActiveWorktrees() {
  return getWorktreeManager().listActiveWorktrees();
}

/**
 * Prune stale and orphaned worktrees.
 * @param {object} [opts]
 * @returns {Promise<{ pruned: number, evicted: number }>}
 */
function pruneStaleWorktrees(opts) {
  return getWorktreeManager().pruneStaleWorktrees(opts);
}

/**
 * Get aggregate statistics about tracked worktrees.
 * @returns {{ total: number, active: number, stale: number, byOwner: Record<string, number> }}
 */
function getWorktreeStats() {
  return getWorktreeManager().getStats();
}

// ── Exports ─────────────────────────────────────────────────────────────────

export {
  // Class
  WorktreeManager,
  // Singleton
  getWorktreeManager,
  resetWorktreeManager,
  // Convenience wrappers
  acquireWorktree,
  releaseWorktree,
  releaseWorktreeByBranch,
  findWorktreeForBranch,
  listActiveWorktrees,
  pruneStaleWorktrees,
  getWorktreeStats,
  // Helpers (useful for consumers that build their own paths)
  sanitizeBranchName,
  gitEnv,
  fixGitConfigCorruption,
  // Constants (allow consumers to reference)
  TAG,
  DEFAULT_BASE_DIR,
  REGISTRY_FILE,
  MAX_WORKTREE_AGE_MS,
  COPILOT_WORKTREE_MAX_AGE_MS,
  GIT_ENV,
};
