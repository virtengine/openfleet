#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_BASE = "origin/main";
const DEFAULT_MAX = 20;
const TAG = "[workflow-orphan-recovery]";

function parseArgs(argv) {
  const parsed = {
    repoRoot: process.cwd(),
    base: DEFAULT_BASE,
    max: DEFAULT_MAX,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "").trim();
    const next = String(argv[i + 1] || "").trim();
    if (!arg.startsWith("--")) continue;
    if (arg === "--repo-root" && next) {
      parsed.repoRoot = next;
      i += 1;
      continue;
    }
    if (arg === "--base" && next) {
      parsed.base = next;
      i += 1;
      continue;
    }
    if (arg === "--max" && next) {
      const max = Number.parseInt(next, 10);
      if (Number.isFinite(max) && max > 0) parsed.max = max;
      i += 1;
    }
  }

  return parsed;
}

function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_ASKPASS: "",
  };
}

function runCommand(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd || process.cwd(),
    env: opts.env || process.env,
    encoding: "utf8",
    timeout: opts.timeoutMs || 120000,
    stdio: "pipe",
  });

  return {
    ok: result.status === 0,
    status: Number(result.status ?? 1),
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

function branchFromWorktree(worktreePath) {
  const res = runCommand("git", ["branch", "--show-current"], {
    cwd: worktreePath,
    env: gitEnv(),
    timeoutMs: 10000,
  });
  if (!res.ok) return "";
  return res.stdout;
}

function hasWorktreeChanges(worktreePath) {
  const res = runCommand("git", ["status", "--porcelain"], {
    cwd: worktreePath,
    env: gitEnv(),
    timeoutMs: 10000,
  });
  if (!res.ok) return { ok: false, hasChanges: false };
  return { ok: true, hasChanges: res.stdout.length > 0 };
}

function hasUnpushedCommits(worktreePath, remoteRef) {
  const res = runCommand(
    "git",
    ["log", `${remoteRef}..HEAD`, "--oneline"],
    {
      cwd: worktreePath,
      env: gitEnv(),
      timeoutMs: 15000,
    },
  );
  if (!res.ok) {
    return false;
  }
  return res.stdout.length > 0;
}

function hasMeaningfulDiff(worktreePath, remoteRef) {
  const res = runCommand(
    "git",
    ["diff", "--name-only", `${remoteRef}...HEAD`],
    {
      cwd: worktreePath,
      env: gitEnv(),
      timeoutMs: 15000,
    },
  );
  if (!res.ok) return { ok: false, fileCount: 0 };
  const fileCount = res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
  return { ok: true, fileCount };
}

function autoCommit(worktreePath, taskIdPrefix) {
  const addRes = runCommand("git", ["add", "-A"], {
    cwd: worktreePath,
    env: gitEnv(),
    timeoutMs: 15000,
  });
  if (!addRes.ok) {
    return { ok: false, reason: addRes.stderr || addRes.stdout || "git add failed" };
  }

  const commitMessage = `chore: recover orphaned agent work (${taskIdPrefix})`;
  const commitRes = runCommand(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", commitMessage],
    {
      cwd: worktreePath,
      env: gitEnv(),
      timeoutMs: 20000,
    },
  );

  if (commitRes.ok) {
    return { ok: true };
  }

  const errorText = `${commitRes.stderr}\n${commitRes.stdout}`.toLowerCase();
  if (errorText.includes("nothing to commit")) {
    return { ok: true, reason: "nothing_to_commit" };
  }

  return {
    ok: false,
    reason: commitRes.stderr || commitRes.stdout || "git commit failed",
  };
}

function pushBranch(worktreePath, branch) {
  const firstPush = runCommand("git", ["push", "-u", "origin", branch], {
    cwd: worktreePath,
    env: gitEnv(),
    timeoutMs: 30000,
  });
  if (firstPush.ok) return { ok: true };

  const fallback = runCommand("git", ["push", "origin", branch], {
    cwd: worktreePath,
    env: gitEnv(),
    timeoutMs: 30000,
  });
  if (fallback.ok) return { ok: true };

  return {
    ok: false,
    reason:
      fallback.stderr ||
      fallback.stdout ||
      firstPush.stderr ||
      firstPush.stdout ||
      "git push failed",
  };
}

function parsePrReference(text) {
  const normalized = String(text || "").trim();
  const urlMatch = normalized.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/i);
  if (!urlMatch) return { prUrl: null, prNumber: null };
  return {
    prUrl: urlMatch[0],
    prNumber: Number.parseInt(urlMatch[1], 10),
  };
}

function createOrReusePr(worktreePath, { branch, baseBranch, taskIdPrefix }) {
  const title = `chore: recover orphaned worktree ${taskIdPrefix}`;
  const body =
    "Recovered by workflow-owned orphan worktree sweep. " +
    "This PR resumes lifecycle handoff after an interrupted local task run.";

  const createRes = runCommand(
    "gh",
    [
      "pr",
      "create",
      "--title",
      title,
      "--body",
      body,
      "--base",
      baseBranch,
      "--head",
      branch,
    ],
    {
      cwd: worktreePath,
      env: gitEnv(),
      timeoutMs: 60000,
    },
  );

  if (createRes.ok) {
    const ref = parsePrReference(createRes.stdout || createRes.stderr);
    return { ok: true, ...ref };
  }

  const errText = `${createRes.stderr}\n${createRes.stdout}`;
  if (!/already exists|existing pull request/i.test(errText)) {
    return {
      ok: false,
      reason: createRes.stderr || createRes.stdout || "gh pr create failed",
    };
  }

  const listRes = runCommand(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      "number,url",
    ],
    {
      cwd: worktreePath,
      env: gitEnv(),
      timeoutMs: 60000,
    },
  );

  if (!listRes.ok) {
    return {
      ok: false,
      reason: listRes.stderr || listRes.stdout || "gh pr list failed",
    };
  }

  try {
    const parsed = JSON.parse(listRes.stdout || "[]");
    const first = Array.isArray(parsed) ? parsed[0] : null;
    if (!first?.url) {
      return { ok: false, reason: "existing PR not found after create conflict" };
    }
    return {
      ok: true,
      prUrl: String(first.url),
      prNumber: Number.parseInt(String(first.number || "0"), 10) || null,
    };
  } catch {
    return { ok: false, reason: "failed to parse gh pr list output" };
  }
}

function taskTitleFromBranch(branch, taskIdPrefix) {
  const raw = String(branch || "").replace(/^ve\//, "");
  const stripped = raw.replace(new RegExp(`^${taskIdPrefix}-`), "");
  const title = stripped.replace(/-/g, " ").trim();
  return title || `Recovered task ${taskIdPrefix}`;
}

async function loadStatusUpdater() {
  try {
    const mod = await import("../kanban-adapter.mjs");
    if (typeof mod.updateTaskStatus === "function") return mod.updateTaskStatus;
  } catch {
    // Optional in recovery mode.
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(args.repoRoot || process.cwd());
  const worktreeDir = resolve(repoRoot, ".cache", "worktrees");
  const remoteRef = String(args.base || DEFAULT_BASE).trim() || DEFAULT_BASE;
  const baseBranch = remoteRef.replace(/^origin\//, "");
  const maxRecover = Math.max(1, Number(args.max || DEFAULT_MAX));
  const updateTaskStatus = await loadStatusUpdater();

  const summary = {
    success: true,
    scanned: 0,
    recovered: 0,
    skipped: 0,
    failed: 0,
    items: [],
    errors: [],
  };

  if (!existsSync(worktreeDir)) {
    console.log(JSON.stringify(summary));
    return;
  }

  let dirs = [];
  try {
    dirs = readdirSync(worktreeDir);
  } catch (err) {
    summary.success = false;
    summary.errors.push(`read_worktree_dir_failed:${err?.message || err}`);
    console.log(JSON.stringify(summary));
    return;
  }

  for (const dirName of dirs) {
    if (summary.scanned >= maxRecover) break;

    const match = String(dirName || "").match(/^ve-([a-f0-9]{8})-/i);
    if (!match) continue;

    const taskIdPrefix = match[1];
    const worktreePath = resolve(worktreeDir, dirName);
    try {
      const stat = statSync(worktreePath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    summary.scanned += 1;

    const branch = branchFromWorktree(worktreePath);
    if (!branch || !branch.startsWith("ve/")) {
      summary.skipped += 1;
      continue;
    }

    const changeInfo = hasWorktreeChanges(worktreePath);
    if (!changeInfo.ok) {
      summary.failed += 1;
      summary.errors.push(`status_failed:${dirName}`);
      continue;
    }

    const hasChanges = changeInfo.hasChanges;
    const hasUnpushed = hasUnpushedCommits(worktreePath, remoteRef);
    if (!hasChanges && !hasUnpushed) {
      summary.skipped += 1;
      continue;
    }

    if (hasChanges) {
      const commit = autoCommit(worktreePath, taskIdPrefix);
      if (!commit.ok) {
        summary.failed += 1;
        summary.errors.push(`commit_failed:${dirName}:${commit.reason}`);
        continue;
      }
    }

    const diff = hasMeaningfulDiff(worktreePath, remoteRef);
    if (!diff.ok) {
      summary.failed += 1;
      summary.errors.push(`diff_failed:${dirName}`);
      continue;
    }
    if (diff.fileCount <= 0) {
      summary.skipped += 1;
      continue;
    }

    const push = pushBranch(worktreePath, branch);
    if (!push.ok) {
      summary.failed += 1;
      summary.errors.push(`push_failed:${dirName}:${push.reason}`);
      continue;
    }

    const pr = createOrReusePr(worktreePath, {
      branch,
      baseBranch,
      taskIdPrefix,
    });
    if (!pr.ok) {
      summary.failed += 1;
      summary.errors.push(`pr_failed:${dirName}:${pr.reason}`);
      continue;
    }

    let statusUpdated = false;
    if (typeof updateTaskStatus === "function") {
      try {
        await updateTaskStatus(taskIdPrefix, "inreview", {
          source: "workflow-orphan-worktree-recovery",
          branch,
          prNumber: pr.prNumber,
          prUrl: pr.prUrl,
          worktreePath,
        });
        statusUpdated = true;
      } catch (err) {
        summary.errors.push(`status_update_failed:${dirName}:${err?.message || err}`);
      }
    }

    summary.recovered += 1;
    summary.items.push({
      taskId: taskIdPrefix,
      taskTitle: taskTitleFromBranch(branch, taskIdPrefix),
      branch,
      baseBranch,
      worktreePath,
      prUrl: pr.prUrl,
      prNumber: pr.prNumber,
      statusUpdated,
    });
  }

  if (summary.failed > 0) {
    summary.success = summary.recovered > 0;
  }

  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  const summary = {
    success: false,
    scanned: 0,
    recovered: 0,
    skipped: 0,
    failed: 1,
    items: [],
    errors: [`fatal:${err?.message || err}`],
  };
  console.error(`${TAG} fatal: ${err?.message || err}`);
  console.log(JSON.stringify(summary));
});
