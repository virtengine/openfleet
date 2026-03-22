import { spawnSync } from "node:child_process";

const STRIPPED_GIT_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_SUPER_PREFIX",
];

const BLOCKED_TEST_GIT_IDENTITIES = new Set([
  "test@example.com",
  "bosun-tests@example.com",
  "bot@example.com",
  "test@test.com",
]);

const TEST_FIXTURE_SENTINEL_PATHS = new Set([
  ".github/agents/TaskPlanner.agent.md",
]);

function runGit(args, cwd, timeout = 15_000) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout,
    shell: false,
    env: sanitizeGitEnv(),
  });
}

export function sanitizeGitEnv(baseEnv = process.env, extraEnv = {}) {
  const env = { ...baseEnv };
  for (const key of STRIPPED_GIT_ENV_KEYS) {
    delete env[key];
  }
  return { ...env, ...extraEnv };
}

function getGitConfig(cwd, key) {
  const result = runGit(["config", "--get", key], cwd, 5_000);
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

function listTrackedFiles(cwd, ref = "HEAD") {
  const result = runGit(["ls-tree", "-r", "--name-only", ref], cwd, 30_000);
  if (result.status !== 0) return null;
  const out = String(result.stdout || "").trim();
  return out ? out.split("\n").filter(Boolean) : [];
}

function collectBlockedIdentitySignals(cwd) {
  const signals = [];
  const envChecks = [
    ["GIT_AUTHOR_EMAIL", process.env.GIT_AUTHOR_EMAIL],
    ["GIT_COMMITTER_EMAIL", process.env.GIT_COMMITTER_EMAIL],
    ["VE_GIT_AUTHOR_EMAIL", process.env.VE_GIT_AUTHOR_EMAIL],
  ];
  for (const [key, value] of envChecks) {
    const email = String(value || "").trim().toLowerCase();
    if (BLOCKED_TEST_GIT_IDENTITIES.has(email)) {
      signals.push(`${key}=${email}`);
    }
  }

  const configChecks = [
    ["git config user.email", getGitConfig(cwd, "user.email")],
    ["git config author.email", getGitConfig(cwd, "author.email")],
    ["git config committer.email", getGitConfig(cwd, "committer.email")],
  ];
  for (const [label, value] of configChecks) {
    const email = String(value || "").trim().toLowerCase();
    if (BLOCKED_TEST_GIT_IDENTITIES.has(email)) {
      signals.push(`${label}=${email}`);
    }
  }

  return signals;
}

function detectKnownFixtureSignature(cwd) {
  const trackedFiles = listTrackedFiles(cwd, "HEAD");
  if (!trackedFiles) return null;
  const sentinelHits = trackedFiles.filter((file) => TEST_FIXTURE_SENTINEL_PATHS.has(file));
  if (sentinelHits.length === 0) return null;
  if (trackedFiles.length > 10) return null;
  return {
    trackedFiles: trackedFiles.length,
    sentinels: sentinelHits,
  };
}

function countTrackedFiles(cwd, ref) {
  const result = runGit(["ls-tree", "-r", "--name-only", ref], cwd, 30_000);
  if (result.status !== 0) return null;
  const out = (result.stdout || "").trim();
  if (!out) return 0;
  return out.split("\n").filter(Boolean).length;
}

function getNumstat(cwd, rangeSpec) {
  const result = runGit(["diff", "--numstat", rangeSpec], cwd, 30_000);
  if (result.status !== 0) return null;
  const out = (result.stdout || "").trim();
  if (!out) {
    return { files: 0, inserted: 0, deleted: 0 };
  }

  let files = 0;
  let inserted = 0;
  let deleted = 0;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [addRaw, delRaw] = line.split("\t");
    files += 1;
    const add = Number.parseInt(addRaw, 10);
    const del = Number.parseInt(delRaw, 10);
    if (Number.isFinite(add)) inserted += add;
    if (Number.isFinite(del)) deleted += del;
  }
  return { files, inserted, deleted };
}

export function isSafeGitBranchName(rawBranch) {
  const branch = String(rawBranch || "").trim();
  if (!branch) return false;

  // Disallow anything that looks like a git option
  if (branch.startsWith("-")) return false;

  // Disallow whitespace and obvious ref/metacharacters that can change semantics
  if (
    /[\s]/.test(branch) ||
    branch.includes("..") ||
    branch.includes(":") ||
    branch.includes("~") ||
    branch.includes("^") ||
    branch.includes("?") ||
    branch.includes("*") ||
    branch.includes("[") ||
    branch.includes("\\")
  ) {
    return false;
  }

  // Disallow URL-like or SSH-style prefixes to avoid transport/URL interpretation
  const lower = branch.toLowerCase();
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("ssh://") ||
    lower.startsWith("git@") ||
    lower.startsWith("file://")
  ) {
    return false;
  }

  return true;
}

export function normalizeBaseBranch(baseBranch = "main", remote = "origin") {
  let branch = String(baseBranch || "main").trim();
  if (!branch) branch = "main";

  branch = branch.replace(/^refs\/heads\//, "");
  branch = branch.replace(/^refs\/remotes\//, "");

  while (branch.startsWith(`${remote}/`)) {
    branch = branch.slice(remote.length + 1);
  }

  if (!branch) branch = "main";

  if (!isSafeGitBranchName(branch)) {
    throw new Error(`Invalid base branch name: ${branch}`);
  }

  return { branch, remoteRef: `${remote}/${branch}` };
}

/**
 * Prevent catastrophic pushes when a worktree is in a corrupted state
 * (for example, a branch that suddenly tracks only README and would
 * delete the whole repo on push).
 */
export function evaluateBranchSafetyForPush(worktreePath, opts = {}) {
  const { baseBranch = "main", remote = "origin" } = opts;

  if (process.env.VE_ALLOW_DESTRUCTIVE_PUSH === "1") {
    return {
      safe: true,
      bypassed: true,
      reason: "VE_ALLOW_DESTRUCTIVE_PUSH=1",
    };
  }

  const { remoteRef } = normalizeBaseBranch(baseBranch, remote);
  const baseFiles = countTrackedFiles(worktreePath, remoteRef);
  const headFiles = countTrackedFiles(worktreePath, "HEAD");
  const diff = getNumstat(worktreePath, `${remoteRef}...HEAD`);

  // If we can't assess reliably, do not block the push.
  if (baseFiles == null || headFiles == null || diff == null) {
    return {
      safe: true,
      bypassed: true,
      reason: "safety assessment unavailable",
      stats: { baseFiles, headFiles, ...diff },
    };
  }

  const reasons = [];
  const blockedIdentitySignals = collectBlockedIdentitySignals(worktreePath);
  if (blockedIdentitySignals.length > 0) {
    reasons.push(`blocked test git identity detected (${blockedIdentitySignals.join(", ")})`);
  }

  const fixtureSignature = detectKnownFixtureSignature(worktreePath);
  if (fixtureSignature) {
    reasons.push(
      `HEAD matches known test fixture signature (${fixtureSignature.sentinels.join(", ")} in ${fixtureSignature.trackedFiles} tracked files)`,
    );
  }

  if (baseFiles >= 500 && headFiles <= Math.max(25, Math.floor(baseFiles * 0.15))) {
    reasons.push(`HEAD tracks only ${headFiles}/${baseFiles} files vs ${remoteRef}`);
  }

  // Zero-diff guard: refuse to push if HEAD is identical to base (would wipe PR)
  try {
    const headRes = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath, encoding: "utf8", timeout: 5_000, stdio: ["pipe", "pipe", "pipe"],
    });
    const baseRes = spawnSync("git", ["rev-parse", remoteRef], {
      cwd: worktreePath, encoding: "utf8", timeout: 5_000, stdio: ["pipe", "pipe", "pipe"],
    });
    const headSha = headRes.stdout?.trim();
    const baseSha = baseRes.stdout?.trim();
    if (headSha && baseSha && headSha === baseSha) {
      reasons.push(`HEAD (${headSha.slice(0, 8)}) is identical to ${remoteRef} — push would create zero-diff PR`);
    }
  } catch { /* best-effort */ }

  const deletedToInserted =
    diff.inserted > 0 ? diff.deleted / diff.inserted : diff.deleted > 0 ? Infinity : 0;
  const manyFilesChanged = diff.files >= Math.max(2_000, Math.floor(baseFiles * 0.5));
  const deletionHeavy = diff.deleted >= 200_000 && deletedToInserted > 50;
  if (manyFilesChanged && deletionHeavy) {
    reasons.push(
      `diff vs ${remoteRef} is deletion-heavy (${diff.deleted} deleted, ${diff.inserted} inserted across ${diff.files} files)`,
    );
  }

  if (reasons.length > 0) {
    return {
      safe: false,
      reason: reasons.join("; "),
      stats: {
        baseFiles,
        headFiles,
        filesChanged: diff.files,
        inserted: diff.inserted,
        deleted: diff.deleted,
      },
    };
  }

  return {
    safe: true,
    stats: {
      baseFiles,
      headFiles,
      filesChanged: diff.files,
      inserted: diff.inserted,
      deleted: diff.deleted,
    },
  };
}

/**
 * Clear any blocked test git identity from a worktree's local config.
 * Worktrees inherit the parent repo's config, so if a test ever set
 * user.name/email there it will poison all task commits until cleared.
 * Call this after acquiring any worktree.
 */
export function clearBlockedWorktreeIdentity(worktreePath) {
  const email = getGitConfig(worktreePath, "user.email").toLowerCase();
  if (!BLOCKED_TEST_GIT_IDENTITIES.has(email)) return false;

  runGit(["config", "--local", "--unset", "user.email"], worktreePath, 5_000);
  runGit(["config", "--local", "--unset", "user.name"], worktreePath, 5_000);
  return true;
}
