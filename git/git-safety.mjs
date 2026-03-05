import { spawnSync } from "node:child_process";

function runGit(args, cwd, timeout = 15_000) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout,
    shell: false,
  });
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

function isSafeGitBranchName(rawBranch) {
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
  if (baseFiles >= 500 && headFiles <= Math.max(25, Math.floor(baseFiles * 0.15))) {
    reasons.push(`HEAD tracks only ${headFiles}/${baseFiles} files vs ${remoteRef}`);
  }

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
