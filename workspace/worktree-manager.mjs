/**
 * worktree-manager.mjs — Centralized git worktree lifecycle management.
 *
 * Replaces scattered worktree operations across monitor.mjs,
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

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/config.mjs";
import { sanitizeGitEnv } from "../git/git-safety.mjs";
import { detectProjectStack } from "../workflow/project-detection.mjs";
import { resolvePwshRuntime } from "../shell/pwsh-runtime.mjs";
import { ensureWorktreeRuntimeSetup, inspectWorktreeRuntimeSetup } from "./worktree-setup.mjs";

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
const DEFAULT_MANAGED_TASK_BASE_DIR = ".bosun/worktrees";
const REGISTRY_FILE = resolve(__dirname, "..", "logs", "worktree-registry.json");
const MAX_WORKTREE_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours
const COPILOT_WORKTREE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (existing policy)
const GIT_ENV = {
  GIT_EDITOR: ":",
  GIT_MERGE_AUTOEDIT: "no",
  GIT_TERMINAL_PROMPT: "0",
};
const DEFAULT_WORKTREE_BOOTSTRAP = Object.freeze({
  enabled: true,
  linkSharedPaths: true,
  commandTimeoutMs: 10 * 60 * 1000,
  setupScript: "",
  commandsByStack: Object.freeze({}),
  sharedPathsByStack: Object.freeze({}),
});
const DEFAULT_SHARED_PATHS_BY_STACK = Object.freeze({
  node: Object.freeze(["node_modules"]),
  php: Object.freeze(["vendor"]),
  ruby: Object.freeze(["vendor/bundle"]),
});

function shouldEnforceWorktreeRuntimeReady(repoRoot) {
  const resolvedRepoRoot = resolve(repoRoot);
  return existsSync(resolve(resolvedRepoRoot, ".githooks", "pre-commit"))
    && existsSync(resolve(resolvedRepoRoot, ".githooks", "pre-push"));
}

function ensureWorktreeRuntimeReady(repoRoot, worktreePath) {
  const resolvedRepoRoot = resolve(repoRoot);
  const resolvedWorktreePath = resolve(worktreePath);
  ensureWorktreeRuntimeSetup(resolvedRepoRoot, resolvedWorktreePath);
  if (!shouldEnforceWorktreeRuntimeReady(resolvedRepoRoot)) {
    return null;
  }
  const inspection = inspectWorktreeRuntimeSetup(resolvedRepoRoot, resolvedWorktreePath);
  if (!inspection.ok) {
    throw new Error(
      `Worktree runtime setup incomplete for ${resolvedWorktreePath}: ${inspection.issues.join("; ")}`,
    );
  }
  return inspection;
}

/**
 * Guard against git config corruption caused by worktree operations.
 * Some git versions on Windows set core.bare=true on the main repo when
 * adding worktrees, which conflicts with core.worktree and breaks git.
 * This function cleans up those settings after every worktree operation.
 * @param {string} repoRoot - Path to the main repository root
 */
function fixGitConfigCorruption(repoRoot) {
  try {
    repairMainRepoGitMetadata(repoRoot);
    repairBrokenCoreWorktreeConfig(repoRoot);
    const bareResult = spawnSync("git", ["config", "--bool", "--get", "core.bare"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      env: gitEnv(),
    });
    if (bareResult.stdout?.trim() === "true") {
      console.warn(
        `${TAG} :alert: Detected core.bare=true on main repo — fixing git config corruption`,
      );
      spawnSync("git", ["config", "--local", "core.bare", "false"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 5000,
        env: gitEnv(),
      });
      spawnSync("git", ["config", "--local", "--unset-all", "core.worktree"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 5000,
        env: gitEnv(),
      });
    }
  } catch {
    /* best-effort — don't crash on config repair */
  }
}

function resolveRecoveredHeadRef(repoRoot) {
  const gitDir = resolve(repoRoot, ".git");
  const directCandidates = [
    "main",
    "master",
    "guardrails",
  ];
  for (const branchName of directCandidates) {
    if (existsSync(resolve(gitDir, "refs", "heads", branchName))) {
      return `refs/heads/${branchName}`;
    }
  }

  const originHeadPath = resolve(gitDir, "refs", "remotes", "origin", "HEAD");
  if (existsSync(originHeadPath)) {
    try {
      const raw = readFileSync(originHeadPath, "utf8").trim();
      const match = raw.match(/^ref:\s*refs\/remotes\/[^/]+\/(.+)$/i);
      if (match?.[1]) return `refs/heads/${match[1].trim()}`;
    } catch {
      // Fall through to packed refs.
    }
  }

  const packedRefsPath = resolve(gitDir, "packed-refs");
  if (existsSync(packedRefsPath)) {
    try {
      const lines = String(readFileSync(packedRefsPath, "utf8") || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.startsWith("#") && !line.startsWith("^"));
      const localBranches = [];
      for (const line of lines) {
        const match = line.match(/^[0-9a-f]{40}\s+refs\/heads\/(.+)$/i);
        if (match?.[1]) localBranches.push(match[1].trim());
      }
      for (const preferred of directCandidates) {
        if (localBranches.includes(preferred)) return `refs/heads/${preferred}`;
      }
      if (localBranches.length > 0) return `refs/heads/${localBranches[0]}`;
    } catch {
      // Fall through to default.
    }
  }

  return "refs/heads/main";
}

function resolveRecoveredOriginUrl(repoRoot) {
  const packageJsonPath = resolve(repoRoot, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      const rawUrl = String(pkg?.repository?.url || "").trim();
      if (rawUrl) return rawUrl.replace(/^git\+/, "");
    } catch {
      // Fall back to inferred URL.
    }
  }
  return `https://github.com/virtengine/${basename(resolve(repoRoot))}.git`;
}

function buildRecoveredGitConfig(repoRoot) {
  const originUrl = resolveRecoveredOriginUrl(repoRoot);
  return [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = false",
    "\tbare = false",
    "\tlogallrefupdates = true",
    "\tsymlinks = false",
    "\tignorecase = true",
    "\tlongpaths = true",
    "[extensions]",
    "\tworktreeConfig = true",
    "[remote \"origin\"]",
    `\turl = ${originUrl}`,
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    "[branch \"main\"]",
    "\tremote = origin",
    "\tmerge = refs/heads/main",
    "",
  ].join("\n");
}

function repairBrokenCoreWorktreeConfig(repoRoot) {
  const configPath = resolve(repoRoot, ".git", "config");
  if (!existsSync(configPath)) return false;

  try {
    const raw = String(readFileSync(configPath, "utf8") || "");
    if (!raw) return false;

    let inCore = false;
    let changed = false;
    const rewritten = [];

    for (const line of raw.split(/\r?\n/)) {
      const sectionMatch = line.match(/^\s*\[(.+?)\]\s*$/);
      if (sectionMatch) {
        const sectionName = String(sectionMatch[1] || "").trim().replace(/^"|"$/g, "");
        inCore = /^core$/i.test(sectionName);
        rewritten.push(line);
        continue;
      }

      if (inCore && /^\s*bare\s*=\s*true\s*$/i.test(line)) {
        rewritten.push("\tbare = false");
        changed = true;
        continue;
      }

      if (inCore && /^\s*worktree\s*=.+$/i.test(line)) {
        changed = true;
        continue;
      }

      rewritten.push(line);
    }

    if (!changed) return false;
    writeFileSync(configPath, `${rewritten.join("\n").replace(/\n+$/, "")}\n`, "utf8");
    console.warn(`${TAG} :alert: Repaired invalid core.bare/core.worktree settings in ${configPath}`);
    return true;
  } catch {
    return false;
  }
}

function repairMainRepoGitMetadata(repoRoot) {
  const gitDir = resolve(repoRoot, ".git");
  try {
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return false;
  } catch {
    return false;
  }

  let repaired = false;
  const headPath = resolve(gitDir, "HEAD");
  if (!existsSync(headPath)) {
    writeFileSync(headPath, `ref: ${resolveRecoveredHeadRef(repoRoot)}\n`, "utf8");
    repaired = true;
  }

  const configPath = resolve(gitDir, "config");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, buildRecoveredGitConfig(repoRoot), "utf8");
    repaired = true;
  }

  if (repaired) {
    console.warn(`${TAG} :alert: Repaired missing main-repo git metadata in ${gitDir}`);
  }
  return repaired;
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
  let safe = String(branch || "");
  if (safe.startsWith("refs/heads/")) safe = safe.slice(11);
  safe = safe.split("/").join("-");
  safe = safe.replace(/[^a-zA-Z0-9._-]/g, "");
  while (safe.startsWith(".")) safe = safe.slice(1);
  while (safe.endsWith(".")) safe = safe.slice(0, -1);
  return safe.slice(0, 60); // Windows MAX_PATH is 260, worktree base path ~60, leaves ~140 for this + git overhead
}

function deriveManagedTaskToken(taskKey) {
  return String(taskKey || "task")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 12)
    || "task";
}

function normalizeStringList(value) {
  const source = Array.isArray(value) ? value : [value];
  const values = [];
  for (const entry of source) {
    const normalized = String(entry || "").trim();
    if (!normalized || values.includes(normalized)) continue;
    values.push(normalized);
  }
  return values;
}

function freezePlainObject(value) {
  return Object.freeze({ ...(value && typeof value === "object" ? value : {}) });
}

function withIsolatedEnv(callback) {
  const originalEnv = { ...process.env };
  try {
    return callback();
  } finally {
    // Remove any keys that were added during callback execution.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    // Restore original keys and their values, including any that were deleted.
   for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  }
}

function readWorktreeBootstrapConfig(repoRoot) {
  try {
    const config = withIsolatedEnv(() =>
      loadConfig(["node", "bosun", "--repo-root", repoRoot]),
    );
    if (config?.worktreeBootstrap && typeof config.worktreeBootstrap === "object") {
      return config.worktreeBootstrap;
    }
  } catch (error) {
    console.warn(
      `${TAG} failed to load worktree bootstrap config: ${error?.message || error}`,
    );
  }
  return DEFAULT_WORKTREE_BOOTSTRAP;
}

function readRepoEnvironmentConfig(repoRoot) {
  try {
    const config = withIsolatedEnv(() =>
      loadConfig(["node", "bosun", "--repo-root", repoRoot]),
    );
    const repos = Array.isArray(config?.repositories)
      ? config.repositories
      : Array.isArray(config?.repositories?.items)
        ? config.repositories.items
        : [];
    // Match by path/repoRoot or by primary flag
    const match = repos.find(
      (r) => {
        if (r.path && r.path === repoRoot) return true;
        if (r.repoRoot && r.repoRoot === repoRoot) return true;
        return false;
      },
    ) || repos.find((r) => r.primary === true);
    if (match?.environment && typeof match.environment === "object") {
      return match.environment;
    }
  } catch { /* ignore */ }
  return null;
}

function resolveWorktreeSharedPaths(policy, stackId) {
  const override = policy?.sharedPathsByStack?.[stackId];
  if (Array.isArray(override) && override.length > 0) return override;
  return DEFAULT_SHARED_PATHS_BY_STACK[stackId] || [];
}

function resolveDefaultBootstrapCommand(stack, worktreePath) {
  const packageManager = String(stack?.packageManager || "").trim().toLowerCase();
  switch (stack?.id) {
    case "node":
      if (packageManager === "pnpm") return "pnpm install";
      if (packageManager === "yarn") return "yarn install";
      if (packageManager === "bun") return "bun install";
      return "npm install";
    case "python":
      if (packageManager === "poetry") return "poetry install --no-interaction";
      if (packageManager === "uv") return "uv sync";
      if (packageManager === "pipenv") return "pipenv install --dev";
      if (packageManager === "pdm") return "pdm install";
      return existsSync(resolve(worktreePath, "requirements.txt"))
        ? "python -m pip install -r requirements.txt"
        : "python -m pip install -e .";
    case "go":
      return "go mod download";
    case "rust":
      return "cargo fetch";
    case "java":
      if (packageManager === "gradle") {
        if (process.platform === "win32" && existsSync(resolve(worktreePath, "gradlew.bat"))) {
          return "gradlew.bat dependencies";
        }
        return existsSync(resolve(worktreePath, "gradlew"))
          ? "./gradlew dependencies"
          : "gradle dependencies";
      }
      return "mvn -q -DskipTests dependency:go-offline";
    case "dotnet":
      return "dotnet restore";
    case "ruby":
      return "bundle install";
    case "php":
      return "composer install";
    default:
      return "";
  }
}

function buildBootstrapPlan(worktreePath, policy, detection, repoRoot, repoEnvironment) {
  const sharedPaths = [];
  const commands = [];

  // Per-repo environment worktreeSetupScript takes precedence over global setupScript
  const setupScript = String(repoEnvironment?.worktreeSetupScript || policy?.setupScript || "").trim();
  if (setupScript) {
    commands.push(setupScript);
  }

  // Per-repo environment installCommands override stack detection
  if (repoEnvironment?.installCommands?.length) {
    for (const cmd of repoEnvironment.installCommands) {
      const c = String(cmd || "").trim();
      if (c && !commands.includes(c)) commands.push(c);
    }
    // Per-repo shared paths
    const envSharedPaths = Array.isArray(repoEnvironment.sharedPaths) ? repoEnvironment.sharedPaths : [];
    for (const p of envSharedPaths) {
      if (p && !sharedPaths.includes(p)) sharedPaths.push(p);
    }
    return {
      sharedPaths,
      commands,
      stacks: (detection?.stacks || []).map((stack) => stack.id),
    };
  }

  for (const stack of detection?.stacks || []) {
    const stackSharedPaths = policy?.linkSharedPaths
      ? resolveWorktreeSharedPaths(policy, stack.id)
      : [];
    for (const relativePath of stackSharedPaths) {
      if (!sharedPaths.includes(relativePath)) sharedPaths.push(relativePath);
    }
    const overrideCommands = normalizeStringList(policy?.commandsByStack?.[stack.id]);
    const stackCommands = overrideCommands.length > 0
      ? overrideCommands
      : normalizeStringList(resolveDefaultBootstrapCommand(stack, worktreePath));
    const hasReadySharedPathsInWorktree =
      stackSharedPaths.length > 0 &&
      stackSharedPaths.every((relativePath) =>
        existsSync(resolve(worktreePath, relativePath)),
      );
    let willLinkSharedPathsFromRepoRoot = false;
    if (!hasReadySharedPathsInWorktree && policy?.linkSharedPaths && repoRoot) {
      willLinkSharedPathsFromRepoRoot =
        stackSharedPaths.length > 0 &&
        stackSharedPaths.every((relativePath) => {
          const sourcePath = resolve(repoRoot, relativePath);
          const targetPath = resolve(worktreePath, relativePath);
          return existsSync(sourcePath) && !existsSync(targetPath);
        });
    }
    const hasReadySharedPaths =
      hasReadySharedPathsInWorktree || willLinkSharedPathsFromRepoRoot;
    if (hasReadySharedPaths) continue;
    for (const command of stackCommands) {
      if (!commands.includes(command)) commands.push(command);
    }
  }
  return {
    sharedPaths,
    commands,
    stacks: (detection?.stacks || []).map((stack) => stack.id),
  };
}

function ensureWorktreeSharedPath(repoRoot, worktreePath, relativePath) {
  const sourcePath = resolve(repoRoot, relativePath);
  const targetPath = resolve(worktreePath, relativePath);
  if (!existsSync(sourcePath) || existsSync(targetPath)) {
    return false;
  }

  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    let linkType = process.platform === "win32" ? "junction" : "dir";
    try {
      const sourceStats = statSync(sourcePath);
      linkType = sourceStats.isDirectory()
        ? process.platform === "win32" ? "junction" : "dir"
        : "file";
    } catch {
      // In tests or partial checkouts the path may be mocked/exist logically without a stat-able inode.
    }
    symlinkSync(
      sourcePath,
      targetPath,
      linkType,
    );
    return true;
  } catch (error) {
    console.warn(
      `${TAG} failed to link ${relativePath} into worktree ${worktreePath}: ${error?.message || error}`,
    );
    return false;
  }
}

function ensureWorktreeSharedPaths(repoRoot, worktreePath, relativePaths = []) {
  const linkedPaths = [];
  for (const relativePath of relativePaths) {
    if (ensureWorktreeSharedPath(repoRoot, worktreePath, relativePath)) {
      linkedPaths.push(relativePath);
    }
  }
  return linkedPaths;
}

function executeWorktreeBootstrapCommand(command, worktreePath, timeoutMs) {
  const result = spawnSync(command, {
    cwd: worktreePath,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  if (result.status === 0) return true;
  const stderr = String(result.stderr || result.stdout || "").trim();
  console.warn(
    `${TAG} bootstrap command failed in ${worktreePath}: ${command}${stderr ? ` :: ${stderr}` : ""}`,
  );
  return false;
}

function buildBootstrapSignature(plan) {
  return JSON.stringify({
    stacks: plan.stacks || [],
    sharedPaths: plan.sharedPaths || [],
    commands: plan.commands || [],
  });
}

function ensureWorktreeNodeModules(repoRoot, worktreePath) {
  ensureWorktreeSharedPath(repoRoot, worktreePath, "node_modules");
}

/**
 * Build the env object for all git subprocess calls.
 * @returns {NodeJS.ProcessEnv}
 */
function gitEnv() {
  return sanitizeGitEnv(process.env, GIT_ENV);
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

function isLocalFilesystemGitRemote(url) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  const normalized = raw.replace(/\\/g, "/");
  if (/^(https?|ssh|git):\/\//i.test(normalized)) return false;
  if (/^[^@]+@[^:]+:/i.test(normalized)) return false;
  return /^[a-z]:\//i.test(normalized)
    || normalized.startsWith("//")
    || normalized.startsWith("../")
    || normalized.startsWith("./")
    || normalized.startsWith("/");
}

function listGitRemotes(repoPath) {
  const remoteNames = gitSync(["remote"], repoPath, { timeout: 5_000 });
  if (remoteNames.status !== 0) return [];
  return String(remoteNames.stdout || "")
    .split(/\r?\n/)
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((name) => {
      const urlResult = gitSync(["remote", "get-url", name], repoPath, { timeout: 5_000 });
      if (urlResult.status !== 0) return null;
      return { name, url: String(urlResult.stdout || "").trim() };
    })
    .filter(Boolean);
}

function pickPreferredNetworkRemote(remotes) {
  const remoteList = Array.isArray(remotes) ? remotes : [];
  return remoteList.find((remote) => /github\.com[:/]/i.test(remote.url))
    || remoteList.find((remote) => !isLocalFilesystemGitRemote(remote.url))
    || null;
}

function alignManagedWorktreePushRemote(repoRoot, worktreePath) {
  const mainRemotes = listGitRemotes(repoRoot);
  const worktreeRemotes = listGitRemotes(worktreePath);
  const preferredRemote = pickPreferredNetworkRemote(worktreeRemotes)
    || pickPreferredNetworkRemote(mainRemotes);
  if (!preferredRemote?.url) return;

  const originRemote = worktreeRemotes.find((remote) => remote.name === "origin");
  if (!originRemote) return;
  if (!isLocalFilesystemGitRemote(originRemote.url)) return;
  if (originRemote.url === preferredRemote.url) return;

  const setUrlResult = gitSync(
    ["remote", "set-url", "origin", preferredRemote.url],
    worktreePath,
    { timeout: 10_000 },
  );
  if (setUrlResult.status !== 0) {
    throw new Error((setUrlResult.stderr || setUrlResult.stdout || "failed to set origin").trim());
  }

  const hasPreferredNamedRemote = worktreeRemotes.some(
    (remote) => remote.name === preferredRemote.name && remote.url === preferredRemote.url,
  );
  if (!hasPreferredNamedRemote && preferredRemote.name !== "origin") {
    const addRemoteResult = gitSync(
      ["remote", "add", preferredRemote.name, preferredRemote.url],
      worktreePath,
      { timeout: 10_000 },
    );
    if (addRemoteResult.status !== 0 && !String(addRemoteResult.stderr || "").includes("already exists")) {
      throw new Error((addRemoteResult.stderr || addRemoteResult.stdout || "failed to add remote").trim());
    }
  }

  console.log(
    `${TAG} aligned worktree origin remote for ${worktreePath} -> ${preferredRemote.name} (${preferredRemote.url})`,
  );
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
 *   2) VE_REPO_ROOT / BOSUN_REPO_ROOT env
 *   3) current working directory's git top-level
 *   4) module-relative git top-level (useful for local dev)
 *   5) process.cwd() fallback
 *
 * @param {string|undefined} repoRoot
 * @returns {string}
 */
function resolveDefaultRepoRoot(repoRoot) {
  if (repoRoot) return resolve(repoRoot);

  // Check workspace-aware agent repo root first
  const agentRoot = process.env.BOSUN_AGENT_REPO_ROOT || "";
  if (agentRoot) {
    const resolved = resolve(agentRoot);
    const fromAgent = detectGitTopLevel(resolved) || resolved;
    if (fromAgent) return fromAgent;
  }

  const envRoot =
    process.env.VE_REPO_ROOT || process.env.BOSUN_REPO_ROOT || "";
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
  const pwsh = resolvePwshRuntime({ preferBundled: true }).command;
  const extendedPath = toWindowsExtendedPath(targetPath);
  const escapedPath = escapePowerShellLiteral(extendedPath);
  const clearAttributes = opts.clearAttributes === true;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 60_000;
  const preface = clearAttributes
    ? "Get-ChildItem -LiteralPath '" +
      escapedPath +
      "' -Recurse -Force | ForEach-Object { $_.Attributes = 'Normal' } -ErrorAction SilentlyContinue; "
    : "";
    const script = preface + "Remove-Item -LiteralPath '" + escapedPath + "' -Recurse -Force -ErrorAction Stop";
  const res = spawnSync(pwsh, ["-NoProfile", "-Command", script], {
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(String(res.stderr || res.stdout || "PowerShell remove path failed").trim());
  }
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
    this._worktreeBootstrapConfig = null;
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
      await mkdir(resolve(__dirname, "..", "logs"), { recursive: true });
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
      mkdirSync(resolve(__dirname, "..", "logs"), { recursive: true });
      const obj = Object.fromEntries(this.registry);
      writeFileSync(REGISTRY_FILE, JSON.stringify(obj, null, 2), "utf8");
    } catch {
      // Non-critical
    }
  }

  getWorktreeBootstrapConfig() {
    if (!this._worktreeBootstrapConfig) {
      this._worktreeBootstrapConfig = readWorktreeBootstrapConfig(this.repoRoot);
    }
    return this._worktreeBootstrapConfig;
  }

  bootstrapWorktree(worktreePath, record = null) {
    ensureWorktreeRuntimeReady(this.repoRoot, worktreePath);

    const policy = this.getWorktreeBootstrapConfig();
    if (!policy?.enabled) return;
    const detection = detectProjectStack(worktreePath);
    if (!detection?.primary) return;

    const plan = buildBootstrapPlan(worktreePath, policy, detection, this.repoRoot, readRepoEnvironmentConfig(this.repoRoot));
    ensureWorktreeSharedPaths(this.repoRoot, worktreePath, plan.sharedPaths);

    const signature = buildBootstrapSignature(plan);
    if (record?.bootstrapState?.signature === signature) {
      return;
    }

    let bootstrapSucceeded = true;
    for (const command of plan.commands) {
      if (!executeWorktreeBootstrapCommand(command, worktreePath, policy.commandTimeoutMs)) {
        bootstrapSucceeded = false;
        break;
      }
    }
    if (!bootstrapSucceeded || !record) return;

    record.bootstrapState = freezePlainObject({
      signature,
      completedAt: new Date().toISOString(),
      stacks: plan.stacks,
      commands: plan.commands,
    });
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
    const normalizedBranch = branch.replace(/^refs\/heads\//, "");

    // 1. Check if a worktree already exists for this branch
    const existingPath = this.findWorktreeForBranch(normalizedBranch);
    if (existingPath) {
      let recordForBootstrap = null;
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
          recordForBootstrap = record;
        }
      } else if (!existingKey) {
        // Not tracked — register it now
        const record = {
          path: existingPath,
          normalizedBranch,
          taskKey,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          status: "active",
          owner: opts.owner ?? "manual",
        };
        this.registry.set(taskKey, record);
        recordForBootstrap = record;
      } else {
        // Same key — just update timestamp
        const record = this.registry.get(taskKey);
        if (record) {
          record.lastUsedAt = Date.now();
          recordForBootstrap = record;
        }
      }
      alignManagedWorktreePushRemote(this.repoRoot, existingPath);
      ensureWorktreeNodeModules(this.repoRoot, existingPath);
      this.bootstrapWorktree(existingPath, recordForBootstrap);
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
    // Avoid a guaranteed "branch already exists" failure when rerunning tasks:
    // if the local branch already exists, reuse it instead of creating with -b.
    const localBranchExists = this._localBranchExists(normalizedBranch);
    if (opts.baseBranch && !localBranchExists) {
      args.push("-b", normalizedBranch, opts.baseBranch);
    } else {
      args.push(normalizedBranch);
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
          ["worktree", "add", worktreePath, normalizedBranch],
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
            const forceArgs = [
                "worktree",
                "add",
                worktreePath,
                "-B",
                normalizedBranch,
              ];
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
          normalizedBranch,
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
    alignManagedWorktreePushRemote(this.repoRoot, worktreePath);
    ensureWorktreeNodeModules(this.repoRoot, worktreePath);

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
    this.bootstrapWorktree(worktreePath, record);
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

    // Step 2: Prune stale worktrees older than MAX_WORKTREE_AGE_MS
    const allWorktrees = this.listAllWorktrees();

    for (const wt of allWorktrees) {
      if (wt.isMainWorktree) continue;

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
      const isCopilot = /copilot-worktree-\d{4}-\d{2}-\d{2}/.test(wt.path);
      const isPrCleanup = wt.path.includes("pr-cleanup-");
      if (isCopilot || isPrCleanup) continue;

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

    // Step 3d: scan managed worktree roots for orphan dirs not tracked by git
    try {
      const gitPaths = new Set(allWorktrees.map((wt) => resolve(wt.path)));
      for (const { relativeDir, label } of [
        { relativeDir: DEFAULT_BASE_DIR, label: "cache" },
        { relativeDir: DEFAULT_MANAGED_TASK_BASE_DIR, label: "managed task" },
      ]) {
        const baseDir = resolve(this.repoRoot, relativeDir);
        if (!existsSync(baseDir)) continue;
        const entries = readdirSync(baseDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const dirPath = resolve(baseDir, entry.name);
          if (gitPaths.has(dirPath)) continue;
          const ageMs = _getFilesystemAgeMs(dirPath);
          if (ageMs > MAX_WORKTREE_AGE_MS) {
            console.log(
              `${TAG} ${dryRun ? "[dry-run] would remove" : "removing"} orphan ${label} dir: ${dirPath} (age=${(ageMs / 3600000).toFixed(1)}h)`,
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
      console.warn(`${TAG} managed worktree dir scan failed: ${e.message}`);
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
   * Check whether a local branch ref exists.
   * @param {string} branch
   * @returns {boolean}
   */
  _localBranchExists(branch) {
    const normalized = (branch || "").replace(/^refs\/heads\//, "");
    if (!normalized) return false;
    const result = gitSync(
      ["show-ref", "--verify", "--quiet", `refs/heads/${normalized}`],
      this.repoRoot,
      { timeout: 5000 },
    );
    return result.status === 0;
  }

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

/** @type {Map<string, WorktreeManager>} */
const _instances = new Map();

/**
 * Get or create the WorktreeManager for a specific repository.
 * @param {string} [repoRoot] - Repository root (required on first call)
 * @param {object} [opts] - Options (only used on first call)
 * @returns {WorktreeManager}
 */
function getWorktreeManager(repoRoot, opts) {
  const resolvedRoot = resolveDefaultRepoRoot(repoRoot);
  if (!_instances.has(resolvedRoot)) {
    _instances.set(resolvedRoot, new WorktreeManager(resolvedRoot, opts));
  }
  return _instances.get(resolvedRoot);
}

/**
 * Reset the instances (for testing).
 */
function resetWorktreeManager() {
  _instances.clear();
}

// ── Convenience Wrappers ────────────────────────────────────────────────────
// These use the singleton internally so callers don't need to manage it.

/**
 * Acquire a worktree for the given branch.
 * @param {string} repoRoot
 * @param {string} branch
 * @param {string} taskKey
 * @param {object} [opts]
 * @returns {Promise<{ path: string, created: boolean, existing: boolean }>}
 */
function acquireWorktree(repoRoot, branch, taskKey, opts) {
  return getWorktreeManager(repoRoot).acquireWorktree(branch, taskKey, opts);
}

/**
 * Release a worktree by its taskKey.
 * @param {string} repoRoot
 * @param {string} taskKey
 * @returns {Promise<{ success: boolean, path: string|null }>}
 */
function releaseWorktree(repoRoot, taskKey) {
  return getWorktreeManager(repoRoot).releaseWorktree(taskKey);
}

/**
 * Release a worktree by its branch name.
 * @param {string} repoRoot
 * @param {string} branch
 * @returns {Promise<{ success: boolean, path: string|null }>}
 */
function releaseWorktreeByBranch(repoRoot, branch) {
  return getWorktreeManager(repoRoot).releaseWorktreeByBranch(branch);
}

/**
 * Find the worktree path for a given branch.
 * @param {string} repoRoot
 * @param {string} branch
 * @returns {string|null}
 */
function findWorktreeForBranch(repoRoot, branch) {
  return getWorktreeManager(repoRoot).findWorktreeForBranch(branch);
}

/**
 * List all worktrees that are actively tracked.
 * @param {string} repoRoot
 * @returns {Array<{ path: string, branch: string|null, taskKey: string|null, age: number, status: string, owner: string|null, isMainWorktree: boolean }>}
 */
function listActiveWorktrees(repoRoot) {
  return getWorktreeManager(repoRoot).listActiveWorktrees();
}

/**
 * Prune stale and orphaned worktrees.
 * @param {string} repoRoot
 * @param {object} [opts]
 * @returns {Promise<{ pruned: number, evicted: number }>}
 */
function pruneStaleWorktrees(repoRoot, opts) {
  return getWorktreeManager(repoRoot).pruneStaleWorktrees(opts);
}

/**
 * Get aggregate statistics about tracked worktrees.
 * @param {string} repoRoot
 * @returns {{ total: number, active: number, stale: number, byOwner: Record<string, number> }}
 */
function getWorktreeStats(repoRoot) {
  return getWorktreeManager(repoRoot).getStats();
}

/**
 * Apply standard bootstrap/readiness handling to an existing worktree path.
 * Reuses the same shared dependency linking and ecosystem bootstrap commands
 * used for manager-created worktrees.
 *
 * @param {string} repoRoot
 * @param {string} worktreePath
 */
function bootstrapWorktreeForPath(repoRoot, worktreePath) {
  if (!worktreePath) return;
  const resolvedRepoRoot = resolve(repoRoot);
  const resolvedWorktreePath = resolve(worktreePath);
  ensureWorktreeRuntimeReady(resolvedRepoRoot, resolvedWorktreePath);
  const detection = detectProjectStack(resolvedWorktreePath);
  if (!detection?.primary) return;

  const policy = {
    ...readWorktreeBootstrapConfig(resolvedRepoRoot),
    enabled: true,
  };
  const plan = buildBootstrapPlan(
    resolvedWorktreePath,
    policy,
    detection,
    resolvedRepoRoot,
    readRepoEnvironmentConfig(resolvedRepoRoot),
  );
  ensureWorktreeSharedPaths(resolvedRepoRoot, resolvedWorktreePath, plan.sharedPaths);
  for (const command of plan.commands) {
    if (!executeWorktreeBootstrapCommand(command, resolvedWorktreePath, policy.commandTimeoutMs)) {
      break;
    }
  }
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
  bootstrapWorktreeForPath,
  // Helpers (useful for consumers that build their own paths)
  sanitizeBranchName,
  deriveManagedTaskToken,
  gitEnv,
  fixGitConfigCorruption,
  // Constants (allow consumers to reference)
  TAG,
  DEFAULT_BASE_DIR,
  DEFAULT_MANAGED_TASK_BASE_DIR,
  REGISTRY_FILE,
  MAX_WORKTREE_AGE_MS,
  COPILOT_WORKTREE_MAX_AGE_MS,
  GIT_ENV,
};
