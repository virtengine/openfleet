/**
 * sdk-conflict-resolver.mjs — Launch a proper SDK agent (Codex/Copilot) to
 * resolve merge conflicts in a worktree with full file access.
 *
 * The key insight: mechanical `git checkout --theirs/--ours` can only handle
 * lockfiles and generated files.  Semantic conflicts (code logic, imports,
 * config merges) need an agent that can READ both sides, UNDERSTAND the
 * intent, and WRITE the correct resolution.
 *
 * This module:
 *  1. Detects or sets up a merge state in the worktree
 *  2. Gathers rich context (conflict diffs, branch purposes, file types)
 *  3. Launches an SDK agent with the worktree as cwd
 *  4. Verifies the resolution (no markers, clean commit, successful push)
 *  5. Reports back with actionable diagnostics
 */

import { spawn } from "node:child_process";
import { resolve, basename } from "node:path";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { launchEphemeralThread } from "./agent-pool.mjs";
import { resolvePromptTemplate } from "./agent-prompts.mjs";
import { resolveCodexProfileRuntime } from "./codex-model-profiles.mjs";
import {
  evaluateBranchSafetyForPush,
  normalizeBaseBranch,
} from "./git-safety.mjs";

// ── Configuration ────────────────────────────────────────────────────────────

const SDK_CONFLICT_TIMEOUT_MS = parseInt(
  process.env.SDK_CONFLICT_TIMEOUT_MS || "600000",
  10,
); // 10 min default
const SDK_CONFLICT_COOLDOWN_MS = parseInt(
  process.env.SDK_CONFLICT_COOLDOWN_MS || "1800000",
  10,
); // 30 min cooldown
const SDK_CONFLICT_MAX_ATTEMPTS = parseInt(
  process.env.SDK_CONFLICT_MAX_ATTEMPTS || "4",
  10,
);

// In-memory tracking (supplements the persistent orchestrator cooldowns)
const _sdkResolutionState = new Map();

// ── Auto-resolve strategies (same as conflict-resolver.mjs) ──────────────────

const AUTO_THEIRS = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "go.sum",
]);
const AUTO_OURS = new Set(["CHANGELOG.md", "coverage.txt", "results.txt"]);
const AUTO_LOCK_EXTENSIONS = [".lock"];

function classifyFile(filePath) {
  const name = basename(filePath);
  if (AUTO_THEIRS.has(name)) return "theirs";
  if (AUTO_OURS.has(name)) return "ours";
  if (AUTO_LOCK_EXTENSIONS.some((ext) => name.endsWith(ext))) return "theirs";
  return "manual"; // needs SDK agent
}

// ── Git helpers ──────────────────────────────────────────────────────────────

function gitExec(args, cwd, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) =>
      resolve({ success: false, stdout, stderr: err.message }),
    );
    child.on("exit", (code) =>
      resolve({
        success: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code,
      }),
    );
  });
}

async function pushBranchSafely(worktreePath, branch, baseBranch) {
  const safety = evaluateBranchSafetyForPush(worktreePath, {
    baseBranch,
    remote: "origin",
  });
  if (!safety.safe) {
    return {
      success: false,
      stderr: safety.reason || "safety check failed",
      stdout: "",
      code: 1,
    };
  }
  return gitExec(["push", "origin", `HEAD:${branch}`], worktreePath, 60_000);
}

/**
 * Get list of conflicted files (unmerged) in the worktree.
 */
async function getConflictedFiles(worktreePath) {
  const result = await gitExec(
    ["diff", "--name-only", "--diff-filter=U"],
    worktreePath,
  );
  if (!result.success) return [];
  return result.stdout
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Check if a merge is in progress in the worktree.
 */
async function isMergeInProgress(worktreePath) {
  // For worktrees, .git is a file pointing to the real git dir
  const dotGit = resolve(worktreePath, ".git");
  let gitDir = worktreePath;

  if (existsSync(dotGit)) {
    try {
      const content = await readFile(dotGit, "utf8");
      const match = content.match(/gitdir:\s*(.+)/);
      if (match) {
        gitDir = resolve(worktreePath, match[1].trim());
      }
    } catch {
      /* fall through */
    }
  }

  return existsSync(resolve(gitDir, "MERGE_HEAD"));
}

/**
 * Get the conflict diff for each file (shows both sides).
 */
async function getConflictDiffs(worktreePath, files) {
  const diffs = {};
  for (const file of files.slice(0, 10)) {
    // Cap at 10 files to avoid prompt explosion
    const result = await gitExec(["diff", "--", file], worktreePath, 15_000);
    if (result.stdout) {
      // Truncate very large diffs
      diffs[file] =
        result.stdout.length > 4000
          ? result.stdout.slice(0, 4000) + "\n... (truncated)"
          : result.stdout;
    }
  }
  return diffs;
}

/**
 * Check if any conflict markers remain in the worktree.
 */
async function hasConflictMarkers(worktreePath) {
  const result = await gitExec(
    ["grep", "-rl", "^<<<<<<<\\|^=======\\|^>>>>>>>", "--", "."],
    worktreePath,
    15_000,
  );
  // git grep exits with 1 when no matches — that's what we want
  return result.success;
}

// ── State tracking ───────────────────────────────────────────────────────────

/**
 * Check if SDK resolution is on cooldown for this branch.
 */
export function isSDKResolutionOnCooldown(branchOrTaskId) {
  const state = _sdkResolutionState.get(branchOrTaskId);
  if (!state) return false;
  return Date.now() - state.lastAttempt < SDK_CONFLICT_COOLDOWN_MS;
}

/**
 * Check if SDK resolution has exceeded max attempts for this branch.
 */
export function isSDKResolutionExhausted(branchOrTaskId) {
  const state = _sdkResolutionState.get(branchOrTaskId);
  if (!state) return false;
  return state.attempts >= SDK_CONFLICT_MAX_ATTEMPTS;
}

/**
 * Record an SDK resolution attempt.
 */
function recordSDKAttempt(branchOrTaskId, result) {
  const prev = _sdkResolutionState.get(branchOrTaskId) || {
    attempts: 0,
    successes: 0,
    failures: 0,
  };
  _sdkResolutionState.set(branchOrTaskId, {
    ...prev,
    attempts: prev.attempts + 1,
    successes: prev.successes + (result ? 1 : 0),
    failures: prev.failures + (result ? 0 : 1),
    lastAttempt: Date.now(),
    lastResult: result ? "success" : "failure",
  });
}

/**
 * Clear SDK resolution state (e.g., after successful merge).
 */
export function clearSDKResolutionState(branchOrTaskId) {
  _sdkResolutionState.delete(branchOrTaskId);
}

/**
 * Get a summary of SDK resolution state for diagnostics.
 */
export function getSDKResolutionSummary() {
  const entries = [..._sdkResolutionState.entries()].map(([key, state]) => ({
    key,
    ...state,
    cooldownRemaining: Math.max(
      0,
      SDK_CONFLICT_COOLDOWN_MS - (Date.now() - state.lastAttempt),
    ),
  }));
  return {
    total: entries.length,
    entries,
  };
}

function resolveGitDir(worktreePath) {
  const dotGit = resolve(worktreePath, ".git");
  if (!existsSync(dotGit)) return null;
  try {
    const content = readFileSync(dotGit, "utf8");
    const match = content.match(/gitdir:\\s*(.+)/);
    if (!match) return null;
    return resolve(worktreePath, match[1].trim());
  } catch {
    return null;
  }
}

// ── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Build a rich, actionable prompt for the SDK agent to resolve merge conflicts.
 * This is the core differentiator — instead of "git checkout --theirs", we give
 * the agent full context to make intelligent merge decisions.
 */
export function buildSDKConflictPrompt({
  worktreePath,
  branch,
  baseBranch = "main",
  prNumber,
  taskTitle = "",
  taskDescription = "",
  conflictedFiles = [],
  conflictDiffs = {},
  promptTemplate = "",
} = {}) {
  const autoFiles = [];
  const manualFiles = [];

  for (const file of conflictedFiles) {
    const strategy = classifyFile(file);
    if (strategy !== "manual") {
      autoFiles.push({ file, strategy });
    } else {
      manualFiles.push(file);
    }
  }

  const lines = [
    `# Merge Conflict Resolution`,
    ``,
    `You are resolving merge conflicts in a git worktree.`,
    ``,
    `## Context`,
    `- **Working directory**: \`${worktreePath}\``,
    `- **PR branch** (HEAD): \`${branch}\` — this is the feature branch with new work`,
    `- **Base branch** (incoming): \`origin/${baseBranch}\` — this is the upstream branch being merged in`,
    prNumber ? `- **PR**: #${prNumber}` : null,
    taskTitle ? `- **Task**: ${taskTitle}` : null,
    taskDescription
      ? `- **Description**: ${taskDescription.slice(0, 500)}`
      : null,
    ``,
    `## Merge State`,
    `A \`git merge origin/${baseBranch}\` has been started but has conflicts.`,
    `The merge is IN PROGRESS — do NOT run \`git merge\` again.`,
    ``,
  ].filter(Boolean);

  let autoFilesSection = "No auto-resolvable files.";
  // Auto-resolvable files
  if (autoFiles.length > 0) {
    const autoLines = [];
    lines.push(`## Auto-Resolvable Files (handle these first)`);
    lines.push(`These files can be resolved mechanically. Run these commands:`);
    lines.push("```bash");
    lines.push(`cd "${worktreePath}"`);
    autoLines.push(`cd "${worktreePath}"`);
    for (const { file, strategy } of autoFiles) {
      lines.push(
        `git checkout --${strategy} -- "${file}" && git add "${file}"`,
      );
      autoLines.push(`git checkout --${strategy} -- "${file}" && git add "${file}"`);
    }
    lines.push("```");
    lines.push("");
    autoFilesSection = autoLines.join("\n");
  }

  let manualFilesSection = "No manual conflict files.";
  // Manual files — these need intelligent resolution
  if (manualFiles.length > 0) {
    const manualLines = [];
    lines.push(`## Files Requiring Intelligent Resolution`);
    lines.push(
      `These files have semantic conflicts that need careful merging.`,
    );
    lines.push(`For each file:`);
    lines.push(
      `1. Read the file to see the conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`)`,
    );
    lines.push(
      `2. The \`<<<<<<< HEAD\` side is the **PR branch's** version (the feature work)`,
    );
    lines.push(
      `3. The \`>>>>>>> origin/${baseBranch}\` side is the **base branch's** version`,
    );
    lines.push(
      `4. Merge both sides intelligently — keep BOTH features when possible`,
    );
    lines.push(
      `5. Remove ALL conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`)`,
    );
    lines.push(`6. Run \`git add <file>\` after resolving each file`);
    lines.push(``);
    manualLines.push(`Manual files: ${manualFiles.join(", ")}`);

    for (const file of manualFiles) {
      lines.push(`### \`${file}\``);
      manualLines.push(`- ${file}`);
      if (conflictDiffs[file]) {
        lines.push("Conflict diff preview:");
        lines.push("```diff");
        lines.push(conflictDiffs[file]);
        lines.push("```");
        manualLines.push(conflictDiffs[file]);
      } else {
        lines.push(`Read this file to see the conflicts.`);
        manualLines.push("(read file to inspect markers)");
      }
      lines.push("");
    }
    manualFilesSection = manualLines.join("\n");
  }

  // Resolution instructions
  lines.push(`## After Resolving All Files`);
  lines.push(`1. Verify NO conflict markers remain:`);
  lines.push("   ```bash");
  lines.push(
    `   git grep -n "^<<<<<<<\\|^=======\\|^>>>>>>>" -- . || echo "Clean"`,
  );
  lines.push("   ```");
  lines.push(`2. Commit the merge:`);
  lines.push("   ```bash");
  lines.push(`   git commit --no-edit`);
  lines.push("   ```");
  lines.push(`3. Push the result:`);
  lines.push("   ```bash");
  lines.push(`   git push origin HEAD:${branch}`);
  lines.push("   ```");
  lines.push(``);
  lines.push(`## CRITICAL RULES`);
  lines.push(
    `- Do NOT abort the merge. Resolve the conflicts and complete it.`,
  );
  lines.push(`- Do NOT run \`git merge\` again — one is already in progress.`);
  lines.push(`- Do NOT use \`git rebase\` — we use merge-based updates.`);
  lines.push(
    `- When in doubt about conflicting code, keep BOTH sides and deduplicate imports/declarations.`,
  );
  lines.push(
    `- For import conflicts: combine both sets of imports, remove exact duplicates.`,
  );
  lines.push(
    `- After resolution, verify the code parses correctly (e.g., \`node --check\` for .mjs files).`,
  );

  const fallback = lines.join("\n");
  return resolvePromptTemplate(
    promptTemplate,
    {
      WORKTREE_PATH: worktreePath || "",
      BRANCH: branch || "",
      BASE_BRANCH: baseBranch || "main",
      PR_LINE: prNumber ? `- PR: #${prNumber}` : "",
      TASK_TITLE_LINE: taskTitle ? `- Task: ${taskTitle}` : "",
      TASK_DESCRIPTION_LINE: taskDescription
        ? `- Description: ${taskDescription.slice(0, 500)}`
        : "",
      AUTO_FILES_SECTION: autoFilesSection,
      MANUAL_FILES_SECTION: manualFilesSection,
    },
    fallback,
  );
}

// ── Core SDK launcher ────────────────────────────────────────────────────────

/**
 * Launch a Codex exec process in the worktree to resolve conflicts.
 * Uses `codex exec --full-auto` with the worktree as cwd so it has
 * full read/write access to the conflicted files.
 *
 * @param {object} opts
 * @param {string} opts.worktreePath - Path to the git worktree with conflicts
 * @param {string} opts.branch - The PR branch name
 * @param {string} opts.baseBranch - The base branch being merged
 * @param {number} [opts.prNumber] - PR number
 * @param {string} [opts.taskTitle] - Task title for context
 * @param {string} [opts.taskDescription] - Task description for context
 * @param {string} [opts.logDir] - Directory for resolution logs
 * @param {number} [opts.timeoutMs] - Timeout in ms
 * @param {string} [opts.promptTemplate] - Optional custom prompt template
 * @returns {Promise<{success: boolean, resolvedFiles: string[], log: string, error?: string}>}
 */
export async function resolveConflictsWithSDK({
  worktreePath,
  branch,
  baseBranch = "main",
  prNumber = null,
  taskTitle = "",
  taskDescription = "",
  logDir = null,
  timeoutMs = SDK_CONFLICT_TIMEOUT_MS,
  promptTemplate = "",
} = {}) {
  const tag = `[sdk-resolve(${branch?.slice(0, 20) || "?"})]`;
  const { branch: normalizedBaseBranch, remoteRef: normalizedBaseRef } =
    normalizeBaseBranch(baseBranch, "origin");

  // ── Guard: cooldown ─────────────────────────────────────────────
  if (isSDKResolutionOnCooldown(branch)) {
    const state = _sdkResolutionState.get(branch);
    const remaining = Math.round(
      (SDK_CONFLICT_COOLDOWN_MS - (Date.now() - state.lastAttempt)) / 1000,
    );
    console.log(`${tag} on cooldown (${remaining}s remaining) — skipping`);
    return {
      success: false,
      resolvedFiles: [],
      log: "",
      error: `SDK resolution on cooldown (${remaining}s remaining)`,
    };
  }

  // ── Guard: max attempts ─────────────────────────────────────────
  if (isSDKResolutionExhausted(branch)) {
    console.log(
      `${tag} max attempts (${SDK_CONFLICT_MAX_ATTEMPTS}) reached — manual intervention needed`,
    );
    return {
      success: false,
      resolvedFiles: [],
      log: "",
      error: `Max SDK resolution attempts (${SDK_CONFLICT_MAX_ATTEMPTS}) exhausted`,
    };
  }

  // ── Guard: worktree exists ──────────────────────────────────────
  if (!worktreePath || !existsSync(worktreePath)) {
    console.warn(`${tag} worktree not found: ${worktreePath}`);
    return {
      success: false,
      resolvedFiles: [],
      log: "",
      error: `Worktree not found: ${worktreePath}`,
    };
  }

  // ── Step 1: Check merge state ───────────────────────────────────
  const mergeActive = await isMergeInProgress(worktreePath);
  let mergeAttemptError = "";
  if (!mergeActive) {
    console.log(
      `${tag} no merge in progress — starting merge of ${normalizedBaseRef}`,
    );
    // Fetch and start the merge
    await gitExec(["fetch", "origin", normalizedBaseBranch], worktreePath);
    const mergeResult = await gitExec(
      ["merge", normalizedBaseRef, "--no-edit"],
      worktreePath,
      60_000,
    );
    mergeAttemptError = mergeResult.stderr || mergeResult.stdout || "";
    if (mergeResult.success) {
      console.log(`${tag} merge completed cleanly — no conflicts`);
      const pushResult = await pushBranchSafely(
        worktreePath,
        branch,
        normalizedBaseBranch,
      );
      if (!pushResult.success) {
        recordSDKAttempt(branch, false);
        return {
          success: false,
          resolvedFiles: [],
          log: "Merge completed cleanly, but push was blocked",
          error: pushResult.stderr || "push failed",
        };
      }
      recordSDKAttempt(branch, true);
      return {
        success: true,
        resolvedFiles: [],
        log: "Merge completed cleanly",
      };
    }
    // Merge failed due to conflicts — continue to resolution
  }

  // ── Step 2: Get conflicted files ────────────────────────────────
  const conflictedFiles = await getConflictedFiles(worktreePath);
  if (conflictedFiles.length === 0) {
    // If merge isn't active and there are no conflicted files, we should not
    // blindly commit. This means merge failed before entering a merge state.
    const mergeStillActive = await isMergeInProgress(worktreePath);
    if (!mergeStillActive) {
      recordSDKAttempt(branch, false);
      return {
        success: false,
        resolvedFiles: [],
        log: "",
        error: `Merge did not enter conflict state: ${mergeAttemptError || "unknown merge error"}`,
      };
    }

    console.log(`${tag} no conflicted files found — committing merge`);
    const commitResult = await gitExec(["commit", "--no-edit"], worktreePath);
    if (!commitResult.success) {
      recordSDKAttempt(branch, false);
      return {
        success: false,
        resolvedFiles: [],
        log: "",
        error: commitResult.stderr || "merge commit failed",
      };
    }
    const pushResult = await pushBranchSafely(
      worktreePath,
      branch,
      normalizedBaseBranch,
    );
    if (!pushResult.success) {
      recordSDKAttempt(branch, false);
      return {
        success: false,
        resolvedFiles: [],
        log: "Merge committed, but push was blocked",
        error: pushResult.stderr || "push failed",
      };
    }
    recordSDKAttempt(branch, true);
    return { success: true, resolvedFiles: [], log: "No conflicts to resolve" };
  }

  console.log(
    `${tag} ${conflictedFiles.length} conflicted files: ${conflictedFiles.join(", ")}`,
  );

  // ── Step 3: Auto-resolve trivial files first ────────────────────
  const autoResolved = [];
  const needsSDK = [];
  for (const file of conflictedFiles) {
    const strategy = classifyFile(file);
    if (strategy !== "manual") {
      const result = await gitExec(
        ["checkout", `--${strategy}`, "--", file],
        worktreePath,
      );
      if (result.success) {
        await gitExec(["add", file], worktreePath);
        autoResolved.push(file);
        console.log(`${tag} auto-resolved (${strategy}): ${file}`);
      } else {
        needsSDK.push(file); // fallback to SDK even for "easy" files
      }
    } else {
      needsSDK.push(file);
    }
  }

  // If all files were auto-resolved, commit and push
  if (needsSDK.length === 0) {
    console.log(`${tag} all ${autoResolved.length} files auto-resolved`);
    const commitResult = await gitExec(["commit", "--no-edit"], worktreePath);
    if (commitResult.success) {
      const pushResult = await pushBranchSafely(
        worktreePath,
        branch,
        normalizedBaseBranch,
      );
      if (!pushResult.success) {
        recordSDKAttempt(branch, false);
        return {
          success: false,
          resolvedFiles: autoResolved,
          log: `Auto-resolved ${autoResolved.length} files, but push was blocked`,
          error: pushResult.stderr || "push failed",
        };
      }
      recordSDKAttempt(branch, true);
      return {
        success: true,
        resolvedFiles: autoResolved,
        log: `Auto-resolved ${autoResolved.length} files`,
      };
    }
  }

  // ── Step 4: Get conflict diffs for SDK prompt context ───────────
  const conflictDiffs = await getConflictDiffs(worktreePath, needsSDK);

  // ── Step 5: Build the rich prompt ───────────────────────────────
  const prompt = buildSDKConflictPrompt({
    worktreePath,
    branch,
    baseBranch: normalizedBaseBranch,
    prNumber,
    taskTitle,
    taskDescription,
    conflictedFiles: needsSDK,
    conflictDiffs,
    promptTemplate,
  });

  // ── Step 6: Launch SDK agent ────────────────────────────────────
  console.log(
    `${tag} launching SDK agent for ${needsSDK.length} files (timeout: ${timeoutMs / 1000}s)`,
  );

  const sdkResult = await launchSDKAgent(prompt, worktreePath, timeoutMs);

  // ── Step 7: Log the result ──────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const effectiveLogDir =
    logDir ||
    resolve(worktreePath, "..", "..", "logs") ||
    resolve(worktreePath, "logs");
  try {
    await mkdir(effectiveLogDir, { recursive: true });
    const logPath = resolve(
      effectiveLogDir,
      `sdk-conflict-${branch?.replace(/\//g, "_") || "unknown"}-${timestamp}.log`,
    );
    await writeFile(
      logPath,
      [
        `SDK Conflict Resolution Log`,
        `Branch: ${branch}`,
        `Base: ${normalizedBaseBranch}`,
        `PR: #${prNumber || "?"}`,
        `Files: ${needsSDK.join(", ")}`,
        `Auto-resolved: ${autoResolved.join(", ") || "none"}`,
        `Timeout: ${timeoutMs}ms`,
        `Result: ${sdkResult.success ? "SUCCESS" : "FAILURE"}`,
        `---`,
        sdkResult.output || sdkResult.error || "(no output)",
      ].join("\n"),
      "utf8",
    );
    console.log(`${tag} log saved: ${logPath}`);
  } catch (err) {
    console.warn(`${tag} failed to save log: ${err.message}`);
  }

  // ── Step 8: Verify resolution ───────────────────────────────────
  if (sdkResult.success) {
    const markersRemain = await hasConflictMarkers(worktreePath);
    if (markersRemain) {
      console.warn(
        `${tag} SDK agent exited 0 but conflict markers remain — marking as failure`,
      );
      recordSDKAttempt(branch, false);
      return {
        success: false,
        resolvedFiles: autoResolved,
        log: sdkResult.output,
        error: "Conflict markers remain after SDK resolution",
      };
    }
    console.log(`${tag} SDK resolution succeeded — conflict-free`);
    recordSDKAttempt(branch, true);
    return {
      success: true,
      resolvedFiles: [...autoResolved, ...needsSDK],
      log: sdkResult.output,
    };
  }

  console.warn(`${tag} SDK resolution failed: ${sdkResult.error}`);
  recordSDKAttempt(branch, false);
  return {
    success: false,
    resolvedFiles: autoResolved,
    log: sdkResult.output,
    error: sdkResult.error,
  };
}

// ── SDK Agent Launcher ───────────────────────────────────────────────────────

/**
 * Launch an SDK agent with FULL ACCESS to resolve conflicts.
 *
 * CRITICAL: Always creates a FRESH, DEDICATED Codex SDK thread for each
 * conflict resolution. NEVER reuses the primary agent's session or the
 * Telegram bot's thread. This prevents:
 *  - Context contamination from ongoing workspace conversations
 *  - Collisions with active /background or Telegram agent turns
 *  - Token overflow from accumulated unrelated context
 *
 * Priority order:
 *  1. Fresh Codex SDK thread — same capabilities as /background but isolated.
 *  2. Codex CLI fallback — `codex exec` with configurable sandbox.
 *  3. Copilot CLI fallback.
 */
async function launchSDKAgent(prompt, cwd, timeoutMs) {
  // ── Primary: Fresh Codex SDK thread (NEVER reuse existing session) ──────
  // Creates a brand new Thread with danger-full-access sandbox, same config
  // as the /background command, but completely independent from the primary
  // agent. This guarantees clean context for conflict resolution.
  try {
    const sdkResult = await launchEphemeralThread(prompt, cwd, timeoutMs);
    if (sdkResult.success || sdkResult.output) {
      return sdkResult;
    }
    console.warn(
      `[sdk-resolve] fresh SDK thread returned no actionable output — trying CLI fallback`,
    );
  } catch (err) {
    console.warn(
      `[sdk-resolve] fresh SDK thread failed: ${err.message} — trying CLI fallback`,
    );
  }

  // ── Fallback: Codex CLI with configurable sandbox ───────────────────────
  const codexAvailable = await isCommandAvailable("codex");
  if (codexAvailable) {
    return launchCodexExec(prompt, cwd, timeoutMs);
  }

  // ── Fallback: Copilot CLI ───────────────────────────────────────────────
  const copilotAvailable = await isCommandAvailable("github-copilot-cli");
  if (copilotAvailable) {
    return launchCopilotExec(prompt, cwd, timeoutMs);
  }

  return {
    success: false,
    output: "",
    error:
      "No SDK agent available (fresh thread, codex CLI, and copilot CLI all failed)",
  };
}

function isCommandAvailable(cmd) {
  return new Promise((resolve) => {
    const which = process.platform === "win32" ? "where" : "which";
    const child = spawn(which, [cmd], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      timeout: 5000,
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function launchCodexExec(prompt, cwd, timeoutMs) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      const args = [
        "exec",
        "--ask-for-approval",
        "never",
        "--sandbox",
        process.env.CODEX_SANDBOX || "workspace-write",
        "-C",
        cwd,
      ];

      const gitDir = resolveGitDir(cwd);
      if (gitDir) {
        args.push("--add-dir", gitDir);
      }

      // Auto-detect Azure: configure Codex CLI for Azure via -c overrides,
      // or strip OPENAI_BASE_URL so it uses ChatGPT OAuth for non-Azure.
      const { env: codexEnv } = resolveCodexProfileRuntime(process.env);
      const baseUrl = codexEnv.OPENAI_BASE_URL || "";
      const isAzure = baseUrl.includes(".openai.azure.com");
      if (isAzure) {
        if (codexEnv.OPENAI_API_KEY && !codexEnv.AZURE_OPENAI_API_KEY) {
          codexEnv.AZURE_OPENAI_API_KEY = codexEnv.OPENAI_API_KEY;
        }
        args.push(
          "-c", 'model_provider="azure"',
          "-c", 'model_providers.azure.name="Azure OpenAI"',
          "-c", `model_providers.azure.base_url="${baseUrl}"`,
          "-c", 'model_providers.azure.env_key="AZURE_OPENAI_API_KEY"',
          "-c", 'model_providers.azure.wire_api="responses"',
        );
        const azureModel = codexEnv.CODEX_MODEL;
        if (azureModel) {
          args.push("-m", azureModel);
        }
      }
      delete codexEnv.OPENAI_BASE_URL;

      if (process.platform === "win32") {
        const shellQuote = (value) =>
          /\s/.test(value) ? `"${String(value).replace(/"/g, '\\"')}"` : value;
        const fullCommand = ["codex", ...args].map(shellQuote).join(" ");
        child = spawn(fullCommand, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          shell: true,
          timeout: timeoutMs,
          env: codexEnv,
        });
      } else {
        child = spawn("codex", args, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          timeout: timeoutMs,
          env: codexEnv,
        });
      }
    } catch (err) {
      return resolvePromise({
        success: false,
        output: "",
        error: `spawn codex failed: ${err.message}`,
      });
    }

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch {
      /* stdin may already be closed */
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* best effort */
      }
      resolvePromise({
        success: false,
        output: stdout,
        error: `timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        success: false,
        output: stdout,
        error: err.message,
      });
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({
        success: code === 0,
        output: stdout + (stderr ? "\n" + stderr : ""),
        error: code !== 0 ? `exit code ${code}` : null,
      });
    });
  });
}

function launchCopilotExec(prompt, cwd, timeoutMs) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn("github-copilot-cli", ["--prompt", prompt], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        timeout: timeoutMs,
        env: { ...process.env },
      });
    } catch (err) {
      return resolvePromise({
        success: false,
        output: "",
        error: `spawn copilot-cli failed: ${err.message}`,
      });
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* best effort */
      }
      resolvePromise({
        success: false,
        output: stdout,
        error: `timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        success: false,
        output: stdout,
        error: err.message,
      });
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({
        success: code === 0,
        output: stdout + (stderr ? "\n" + stderr : ""),
        error: code !== 0 ? `exit code ${code}` : null,
      });
    });
  });
}
