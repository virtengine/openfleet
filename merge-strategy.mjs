/**
 * merge-strategy.mjs — Codex-powered merge decision engine.
 *
 * When a task completes (agent goes idle, PR exists or is missing, commits
 * detected upstream), this module hands context to Codex SDK and receives a
 * structured action:
 *
 *   { action: "merge_after_ci_pass" }
 *   { action: "prompt", message: "Fix the lint error in foo.ts" }
 *   { action: "close_pr", reason: "Duplicate of #123" }
 *   { action: "re_attempt", reason: "Agent didn't implement the feature" }
 *   { action: "manual_review", reason: "Big PR needs human eyes" }
 *   { action: "wait", seconds: 300, reason: "CI still running" }
 *
 * Enhanced with thread-aware execution:
 *   - "prompt" resumes the original agent thread (full context preserved)
 *   - "re_attempt" uses execWithRetry for automatic error recovery
 *   - "merge_after_ci_pass" enables gh auto-merge
 *   - "close_pr" closes the PR with a comment
 *   - Self-contained: can use agent-pool directly without injected execCodex
 *
 * Safety:
 *  - 10 minute timeout (configurable via MERGE_STRATEGY_TIMEOUT_MS)
 *  - Structured JSON parsing with fallback
 *  - Audit logs for every decision
 *  - Dedup: won't re-analyze the same attempt within cooldown
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import {
  execPooledPrompt,
  launchOrResumeThread,
  execWithRetry,
  getThreadRecord,
  invalidateThread,
} from "./agent-pool.mjs";
import { resolvePromptTemplate } from "./agent-prompts.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));

// ── Valid actions ────────────────────────────────────────────────────────────

const VALID_ACTIONS = new Set([
  "merge_after_ci_pass",
  "prompt",
  "close_pr",
  "re_attempt",
  "manual_review",
  "wait",
  "noop",
]);

// ── Dedup / rate limiting ───────────────────────────────────────────────────

/** @type {Map<string, number>} attemptId → last analysis timestamp */
const analysisDedup = new Map();
const ANALYSIS_COOLDOWN_MS = 10 * 60 * 1000; // 10 min per attempt

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {object} MergeContext
 * @property {string}   attemptId         - Full attempt UUID
 * @property {string}   shortId           - Short ID for logging
 * @property {string}   status            - Attempt status (completed, failed, etc.)
 * @property {string}   [agentLastMessage] - Last message from the agent
 * @property {string}   [prTitle]         - PR title (if created)
 * @property {number}   [prNumber]        - PR number (if created)
 * @property {string}   [prUrl]           - PR URL (if created)
 * @property {string}   [prState]         - PR state (open, closed, merged)
 * @property {string}   [branch]          - Branch name
 * @property {number}   [commitsAhead]    - Commits ahead of main
 * @property {number}   [commitsBehind]   - Commits behind main
 * @property {number}   [filesChanged]    - Number of files changed
 * @property {string}   [diffStat]        - Git diff --stat output
 * @property {string[]} [changedFiles]    - List of changed file paths
 * @property {string}   [taskTitle]       - Original task title
 * @property {string}   [taskDescription] - Original task description
 * @property {string}   [worktreeDir]     - Local worktree directory
 * @property {string}   [ciStatus]        - CI status if known (pending, passing, failing)
 * @property {string}   [taskKey]         - Task key for thread registry lookup (links to original agent thread)
 * @property {string}   [baseBranch]      - Base branch for diff comparison (default: "origin/main")
 */

/**
 * @typedef {object} MergeDecision
 * @property {string}  action   - One of VALID_ACTIONS
 * @property {string}  [message] - For "prompt" action
 * @property {string}  [reason]  - Explanation for the decision
 * @property {number}  [seconds] - For "wait" action
 * @property {boolean} success   - Whether analysis completed
 * @property {string}  rawOutput - Raw Codex output for audit
 */

/**
 * @typedef {object} ExecutionResult
 * @property {boolean}  executed    Whether the action was executed
 * @property {string}   action      The action that was taken
 * @property {boolean}  success     Whether execution succeeded
 * @property {string}   [output]    Agent output (for prompt/re_attempt)
 * @property {string}   [error]     Error message if failed
 * @property {boolean}  [resumed]   Whether an existing thread was resumed
 * @property {number}   [attempts]  Number of attempts (for re_attempt)
 */

// ── Prompt builder ──────────────────────────────────────────────────────────

/**
 * Build the analysis prompt for Codex SDK.
 */
function buildMergeStrategyPrompt(ctx, promptTemplate = "") {
  const parts = [];

  parts.push(`# Merge Strategy Decision

You are a senior engineering reviewer. An AI agent has completed (or attempted) a task.
Review the context below and decide the NEXT ACTION.

## Task Context`);

  if (ctx.taskTitle) parts.push(`**Task:** ${ctx.taskTitle}`);
  if (ctx.taskDescription) {
    parts.push(`**Description:** ${ctx.taskDescription.slice(0, 2000)}`);
  }
  parts.push(`**Status:** ${ctx.status}`);
  if (ctx.branch) parts.push(`**Branch:** ${ctx.branch}`);

  // Agent's last message — this is the key signal
  if (ctx.agentLastMessage) {
    parts.push(`
## Agent's Last Message
\`\`\`
${ctx.agentLastMessage.slice(0, 8000)}
\`\`\``);
  }

  // PR details
  if (ctx.prNumber) {
    parts.push(`
## Pull Request
- PR #${ctx.prNumber}: ${ctx.prTitle || "(no title)"}
- State: ${ctx.prState || "unknown"}
- URL: ${ctx.prUrl || "N/A"}
- CI: ${ctx.ciStatus || "unknown"}`);
  } else {
    parts.push(`
## Pull Request
No PR has been created yet.`);
  }

  // Diff / files
  if (ctx.filesChanged != null || ctx.changedFiles?.length) {
    parts.push(`
## Changes
- Files changed: ${ctx.filesChanged ?? ctx.changedFiles?.length ?? "unknown"}
- Commits ahead: ${ctx.commitsAhead ?? "unknown"}
- Commits behind: ${ctx.commitsBehind ?? "unknown"}`);
  }

  if (ctx.changedFiles?.length) {
    const fileList = ctx.changedFiles.slice(0, 50).join("\n");
    parts.push(`
### Changed Files
\`\`\`
${fileList}${ctx.changedFiles.length > 50 ? `\n... and ${ctx.changedFiles.length - 50} more` : ""}
\`\`\``);
  }

  if (ctx.diffStat) {
    parts.push(`
### Diff Stats
\`\`\`
${ctx.diffStat.slice(0, 3000)}
\`\`\``);
  }

  if (ctx.worktreeDir) {
    parts.push(`
## Worktree
Directory: ${ctx.worktreeDir}`);
  }

  // Decision framework
  parts.push(`
## Decision Rules

Based on the above context, choose ONE action:

1. **merge_after_ci_pass** — Agent completed the task successfully, PR looks good, merge when CI passes.
   Use when: Agent reports success ("✅ Task Complete"), changes match the task description, no obvious issues.

2. **prompt** — Agent needs to do more work. Provide a specific message telling the agent what to fix.
   Use when: Task partially done, lint/test failures mentioned, missing files, incomplete implementation.
   IMPORTANT: Include SPECIFIC instructions (file names, error messages, what to change).

3. **close_pr** — PR should be closed (bad implementation, wrong approach, duplicate).
   Use when: Agent went off-track, made destructive changes, or the PR is fundamentally broken.

4. **re_attempt** — Start the task over with a fresh agent.
   Use when: Agent crashed without useful work, context window exhausted, or approach was wrong.

5. **manual_review** — Escalate to human reviewer.
   Use when: Large/risky changes, security-sensitive code, or you're unsure about the approach.

6. **wait** — CI is still running, wait before deciding.
   Use when: CI status is "pending" and the changes look reasonable.

7. **noop** — No action needed (informational only, or task was already handled).

## Response Format

Respond with ONLY a JSON object (no markdown, no explanation outside the JSON):

\`\`\`json
{
  "action": "merge_after_ci_pass",
  "reason": "Agent completed all acceptance criteria. 3 files changed, tests added."
}
\`\`\`

Or for prompt:

\`\`\`json
{
  "action": "prompt",
  "message": "The ESLint check failed on src/handler.ts:42. Please fix the unused variable warning and push again.",
  "reason": "Agent's last message mentions lint errors but didn't fix them."
}
\`\`\`

Or for wait:

\`\`\`json
{
  "action": "wait",
  "seconds": 300,
  "reason": "CI is still running. Wait 5 minutes before re-checking."
}
\`\`\`

RESPOND WITH ONLY THE JSON OBJECT.`);

  const fallback = parts.join("\n");
  const taskContextBlock = [
    ctx.taskTitle ? `**Task:** ${ctx.taskTitle}` : "",
    ctx.taskDescription
      ? `**Description:** ${ctx.taskDescription.slice(0, 2000)}`
      : "",
    `**Status:** ${ctx.status}`,
    ctx.branch ? `**Branch:** ${ctx.branch}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return resolvePromptTemplate(
    promptTemplate,
    {
      TASK_CONTEXT_BLOCK: taskContextBlock,
      AGENT_LAST_MESSAGE_BLOCK: ctx.agentLastMessage
        ? `## Agent's Last Message\n\`\`\`\n${ctx.agentLastMessage.slice(0, 8000)}\n\`\`\``
        : "",
      PULL_REQUEST_BLOCK: ctx.prNumber
        ? `## Pull Request\n- PR #${ctx.prNumber}: ${ctx.prTitle || "(no title)"}\n- State: ${ctx.prState || "unknown"}\n- URL: ${ctx.prUrl || "N/A"}\n- CI: ${ctx.ciStatus || "unknown"}`
        : "## Pull Request\nNo PR has been created yet.",
      CHANGES_BLOCK:
        ctx.filesChanged != null || ctx.changedFiles?.length
          ? `## Changes\n- Files changed: ${ctx.filesChanged ?? ctx.changedFiles?.length ?? "unknown"}\n- Commits ahead: ${ctx.commitsAhead ?? "unknown"}\n- Commits behind: ${ctx.commitsBehind ?? "unknown"}`
          : "",
      CHANGED_FILES_BLOCK: ctx.changedFiles?.length
        ? `### Changed Files\n\`\`\`\n${ctx.changedFiles.slice(0, 50).join("\n")}${ctx.changedFiles.length > 50 ? `\n... and ${ctx.changedFiles.length - 50} more` : ""}\n\`\`\``
        : "",
      DIFF_STATS_BLOCK: ctx.diffStat
        ? `### Diff Stats\n\`\`\`\n${ctx.diffStat.slice(0, 3000)}\n\`\`\``
        : "",
      WORKTREE_BLOCK: ctx.worktreeDir ? `## Worktree\nDirectory: ${ctx.worktreeDir}` : "",
    },
    fallback,
  );
}

// ── JSON extraction ─────────────────────────────────────────────────────────

/**
 * Extract a JSON action from Codex output, which may contain markdown
 * fences or surrounding text.
 */
function extractActionJson(raw) {
  if (!raw || typeof raw !== "string") return null;

  // Try direct parse
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed.action === "string") return parsed;
  } catch {
    /* not pure JSON */
  }

  // Try extracting from markdown fences
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && typeof parsed.action === "string") return parsed;
    } catch {
      /* bad JSON in fence */
    }
  }

  // Try finding {..."action":...} anywhere
  const braceMatch = raw.match(/\{[\s\S]*?"action"\s*:\s*"[^"]+?"[\s\S]*?\}/);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0]);
      if (parsed && typeof parsed.action === "string") return parsed;
    } catch {
      /* partial match */
    }
  }

  return null;
}

// ── Git helpers ─────────────────────────────────────────────────────────────

/**
 * Read the last agent message from the worktree's git log or status file.
 */
function readLastAgentMessage(worktreeDir) {
  if (!worktreeDir) return null;
  try {
    // Get the last commit message (agent typically commits with a summary)
    const msg = execSync("git log -1 --pretty=format:%B", {
      cwd: worktreeDir,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return msg || null;
  } catch {
    return null;
  }
}

/**
 * Get diff stats for the branch vs its upstream/base.
 * @param {string} worktreeDir
 * @param {string} [baseBranch] - upstream branch to diff against, defaults to origin/main
 */
function getDiffDetails(worktreeDir, baseBranch) {
  if (!worktreeDir)
    return { diffStat: null, changedFiles: [], filesChanged: 0 };
  const base = baseBranch || "origin/main";
  try {
    const stat = execSync(`git diff --stat ${base}...HEAD`, {
      cwd: worktreeDir,
      encoding: "utf8",
      timeout: 10000,
    }).trim();

    const files = execSync(`git diff --name-only ${base}...HEAD`, {
      cwd: worktreeDir,
      encoding: "utf8",
      timeout: 10000,
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);

    return { diffStat: stat, changedFiles: files, filesChanged: files.length };
  } catch {
    return { diffStat: null, changedFiles: [], filesChanged: 0 };
  }
}

// ── Main analysis function ──────────────────────────────────────────────────

/**
 * Analyze a completed task and return a merge strategy decision.
 *
 * Uses the Codex SDK (persistent shell) via execCodexPrompt to review
 * the agent's work and decide what to do next.
 *
 * @param {MergeContext} ctx - Context about the completed task
 * @param {object} opts
 * @param {function} [opts.execCodex] - execCodexPrompt function from codex-shell (legacy; optional if agent-pool available)
 * @param {number}   [opts.timeoutMs=600000] - Analysis timeout (default: 10 min)
 * @param {string}   opts.logDir - Directory for audit logs
 * @param {function} [opts.onTelegram] - Telegram notification callback
 * @param {boolean}  [opts.useAgentPool=true] - When true and no execCodex, use agent-pool's execPooledPrompt
 * @param {object}   [opts.promptTemplates] - Optional prompt template overrides
 * @returns {Promise<MergeDecision>}
 */
export async function analyzeMergeStrategy(ctx, opts = {}) {
  const {
    execCodex,
    timeoutMs = 10 * 60 * 1000,
    logDir,
    onTelegram,
    useAgentPool = true,
    promptTemplates = {},
  } = opts;

  const tag = `merge-strategy(${ctx.shortId})`;

  // ── Dedup check ────────────────────────────────────────────
  const lastAnalysis = analysisDedup.get(ctx.attemptId);
  if (lastAnalysis && Date.now() - lastAnalysis < ANALYSIS_COOLDOWN_MS) {
    const waitSec = Math.round(
      (ANALYSIS_COOLDOWN_MS - (Date.now() - lastAnalysis)) / 1000,
    );
    console.log(`[${tag}] skipping — analyzed ${waitSec}s ago (cooldown)`);
    return {
      action: "noop",
      reason: `Already analyzed recently (${waitSec}s ago)`,
      success: true,
      rawOutput: "",
    };
  }
  analysisDedup.set(ctx.attemptId, Date.now());

  // ── Enrich context with git data if worktree available ─────
  if (ctx.worktreeDir) {
    if (!ctx.agentLastMessage) {
      ctx.agentLastMessage = readLastAgentMessage(ctx.worktreeDir);
    }
    if (!ctx.diffStat || !ctx.changedFiles?.length) {
      const diff = getDiffDetails(ctx.worktreeDir, ctx.baseBranch);
      ctx.diffStat = ctx.diffStat || diff.diffStat;
      ctx.changedFiles = ctx.changedFiles?.length
        ? ctx.changedFiles
        : diff.changedFiles;
      ctx.filesChanged = ctx.filesChanged ?? diff.filesChanged;
    }
  }

  // ── Build prompt ───────────────────────────────────────────
  const prompt = buildMergeStrategyPrompt(ctx, promptTemplates.mergeStrategy);

  console.log(
    `[${tag}] starting Codex merge analysis (timeout: ${timeoutMs / 1000}s)...`,
  );

  if (onTelegram) {
    onTelegram(
      `🔍 Merge strategy analysis started for ${ctx.shortId}` +
        (ctx.taskTitle ? ` — "${ctx.taskTitle}"` : "") +
        (ctx.prNumber ? ` (PR #${ctx.prNumber})` : ""),
    );
  }

  // ── Run Codex ──────────────────────────────────────────────
  const startMs = Date.now();
  let rawOutput = "";
  let codexError = null;

  try {
    let result;
    if (execCodex) {
      // Legacy path: injected function (backward compat)
      result = await execCodex(prompt, { timeoutMs });
    } else if (useAgentPool) {
      // New path: use agent-pool's execPooledPrompt (self-contained)
      result = await execPooledPrompt(prompt, { timeoutMs });
    } else {
      throw new Error(
        "No execution backend: provide opts.execCodex or enable useAgentPool",
      );
    }
    rawOutput = result?.finalResponse || "";
  } catch (err) {
    codexError = err?.message || String(err);
    console.warn(`[${tag}] Codex analysis failed: ${codexError}`);
  }

  const elapsed = Date.now() - startMs;

  // ── Parse decision ─────────────────────────────────────────
  let decision = extractActionJson(rawOutput);

  if (!decision) {
    // Codex didn't return valid JSON — build a fallback
    console.warn(
      `[${tag}] Codex returned non-JSON output (${rawOutput.length} chars)`,
    );
    decision = {
      action: "manual_review",
      reason: codexError
        ? `Codex error: ${codexError}`
        : `Could not parse Codex response (${rawOutput.slice(0, 200)})`,
    };
  }

  // Validate action
  if (!VALID_ACTIONS.has(decision.action)) {
    console.warn(
      `[${tag}] invalid action "${decision.action}" — defaulting to manual_review`,
    );
    decision.action = "manual_review";
    decision.reason = `Invalid action "${decision.action}" — ${decision.reason || "unknown"}`;
  }

  // ── Audit log ──────────────────────────────────────────────
  if (logDir) {
    try {
      await mkdir(resolve(logDir), { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const auditPath = resolve(
        logDir,
        `merge-strategy-${ctx.shortId}-${stamp}.log`,
      );
      await writeFile(
        auditPath,
        [
          `# Merge Strategy Analysis`,
          `# Attempt: ${ctx.attemptId}`,
          `# Task: ${ctx.taskTitle || "unknown"}`,
          `# Status: ${ctx.status}`,
          `# Elapsed: ${elapsed}ms`,
          `# Timestamp: ${new Date().toISOString()}`,
          "",
          "## Prompt:",
          prompt,
          "",
          "## Raw Codex Output:",
          rawOutput || "(empty)",
          codexError ? `\n## Error: ${codexError}` : "",
          "",
          "## Parsed Decision:",
          JSON.stringify(decision, null, 2),
        ].join("\n"),
        "utf8",
      );
    } catch {
      /* audit write failed — non-critical */
    }
  }

  // ── Notify ─────────────────────────────────────────────────
  const actionEmoji = {
    merge_after_ci_pass: "✅",
    prompt: "💬",
    close_pr: "🚫",
    re_attempt: "🔄",
    manual_review: "👀",
    wait: "⏳",
    noop: "➖",
  };

  const emoji = actionEmoji[decision.action] || "❓";
  console.log(
    `[${tag}] decision: ${emoji} ${decision.action}` +
      (decision.reason ? ` — ${decision.reason.slice(0, 120)}` : "") +
      ` (${elapsed}ms)`,
  );

  if (onTelegram) {
    const lines = [
      `${emoji} Merge Strategy: **${decision.action}**`,
      `Task: ${ctx.taskTitle || ctx.shortId}`,
    ];
    if (decision.reason) lines.push(`Reason: ${decision.reason.slice(0, 300)}`);
    if (decision.message)
      lines.push(`Message: ${decision.message.slice(0, 300)}`);
    if (ctx.prNumber) lines.push(`PR: #${ctx.prNumber}`);
    lines.push(`Analysis: ${Math.round(elapsed / 1000)}s`);
    onTelegram(lines.join("\n"));
  }

  return {
    ...decision,
    success: !codexError,
    rawOutput,
  };
}

/**
 * Reset the dedup cache (useful when clearing state).
 */
export function resetMergeStrategyDedup() {
  analysisDedup.clear();
}

// ── Decision execution ──────────────────────────────────────────────────────

/**
 * Execute a merge strategy decision by acting on the chosen action.
 *
 * Key behaviors:
 * - "prompt": Resumes the ORIGINAL agent thread (via taskKey) with the fix instruction,
 *   so the agent has full context from the initial work. Falls back to fresh thread
 *   if no existing thread found.
 * - "re_attempt": Uses execWithRetry to launch a fresh attempt with error recovery.
 *   The original thread is invalidated first.
 * - "merge_after_ci_pass": Enables auto-merge on the PR via `gh pr merge --auto`.
 * - "close_pr": Closes the PR via `gh pr close`.
 * - "wait": Returns with the wait duration (caller handles scheduling).
 * - "manual_review": Sends notification (caller handles telegram).
 * - "noop": Does nothing.
 *
 * @param {MergeDecision} decision    The decision from analyzeMergeStrategy
 * @param {MergeContext}  ctx         The context used for the analysis
 * @param {object}        opts
 * @param {string}        [opts.logDir]     Audit log directory
 * @param {function}      [opts.onTelegram] Telegram notification callback
 * @param {number}        [opts.timeoutMs]  Timeout for agent operations (default: 15 min)
 * @param {number}        [opts.maxRetries] Max retries for re_attempt (default: 2)
 * @param {object}        [opts.promptTemplates] Optional prompt template overrides
 * @returns {Promise<ExecutionResult>}
 */
export async function executeDecision(decision, ctx, opts = {}) {
  const {
    logDir,
    onTelegram,
    timeoutMs = 15 * 60 * 1000,
    maxRetries = 2,
    promptTemplates = {},
  } = opts;

  const tag = `merge-exec(${ctx.shortId})`;
  const taskKey = ctx.taskKey || ctx.attemptId;
  const cwd = ctx.worktreeDir || undefined;

  try {
    switch (decision.action) {
      case "prompt":
        return await executePromptAction(decision, ctx, {
          tag,
          taskKey,
          cwd,
          timeoutMs,
          logDir,
          onTelegram,
          promptTemplate: promptTemplates.mergeStrategyFix,
        });

      case "re_attempt":
        return await executeReAttemptAction(decision, ctx, {
          tag,
          taskKey,
          cwd,
          timeoutMs,
          maxRetries,
          logDir,
          onTelegram,
          promptTemplate: promptTemplates.mergeStrategyReAttempt,
        });

      case "merge_after_ci_pass":
        return await executeMergeAction(decision, ctx, { tag, onTelegram });

      case "close_pr":
        return await executeCloseAction(decision, ctx, { tag, onTelegram });

      case "wait":
        return {
          executed: true,
          action: "wait",
          success: true,
          waitSeconds: decision.seconds || 300,
        };

      case "manual_review":
        if (onTelegram) {
          onTelegram(
            `👀 Manual review needed for ${ctx.taskTitle || ctx.shortId}: ${decision.reason || "no reason"}`,
          );
        }
        return { executed: true, action: "manual_review", success: true };

      case "noop":
        return { executed: true, action: "noop", success: true };

      default:
        return {
          executed: false,
          action: decision.action,
          success: false,
          error: `Unknown action: ${decision.action}`,
        };
    }
  } catch (err) {
    console.error(
      `[${tag}] executeDecision threw unexpectedly: ${err.message}`,
    );
    return {
      executed: false,
      action: decision.action,
      success: false,
      error: err.message,
    };
  }
}

// ── Prompt (resume) action ──────────────────────────────────────────────────

/**
 * Execute a "prompt" action: resume the original agent thread with the fix instruction.
 *
 * Flow:
 * 1. Look up the original thread via taskKey in thread registry
 * 2. If found and alive → resume that thread with the fix message (full context preserved)
 * 3. If not found → launch a fresh thread with context-carrying preamble
 * 4. Return the agent's response
 */
async function executePromptAction(decision, ctx, execOpts) {
  const { tag, taskKey, cwd, timeoutMs, logDir, onTelegram, promptTemplate } =
    execOpts;

  const fixMessage =
    decision.message ||
    decision.reason ||
    "Please review and fix the remaining issues.";

  // Check if original thread exists
  const existingThread = getThreadRecord(taskKey);
  const hasLiveThread = !!(
    existingThread &&
    existingThread.alive &&
    existingThread.threadId
  );

  if (hasLiveThread) {
    console.log(
      `[${tag}] resuming original agent thread (${existingThread.sdk}, turn ${existingThread.turnCount + 1}) with fix: "${fixMessage.slice(0, 100)}..."`,
    );
  } else {
    console.log(
      `[${tag}] no existing thread for task "${taskKey}" — launching fresh with context`,
    );
  }

  if (onTelegram) {
    onTelegram(
      `💬 ${hasLiveThread ? "Resuming" : "Starting"} agent for ${ctx.taskTitle || ctx.shortId}: ${fixMessage.slice(0, 200)}`,
    );
  }

  // Build a rich prompt for the fix action
  const fixPrompt = buildFixPrompt(
    fixMessage,
    ctx,
    hasLiveThread,
    promptTemplate,
  );

  try {
    const result = await launchOrResumeThread(fixPrompt, cwd, timeoutMs, {
      taskKey,
    });

    // Audit log
    await auditDecisionExecution(logDir, ctx, decision, result);

    if (result.success) {
      console.log(
        `[${tag}] ✅ agent ${result.resumed ? "resumed" : "launched"} successfully for fix`,
      );
      if (onTelegram) {
        onTelegram(
          `✅ Agent ${result.resumed ? "resumed" : "completed"} fix for ${ctx.taskTitle || ctx.shortId}`,
        );
      }
    } else {
      console.warn(`[${tag}] ❌ agent fix failed: ${result.error}`);
      if (onTelegram) {
        onTelegram(
          `❌ Agent fix failed for ${ctx.taskTitle || ctx.shortId}: ${result.error?.slice(0, 200)}`,
        );
      }
    }

    return {
      executed: true,
      action: "prompt",
      success: result.success,
      output: result.output,
      error: result.error,
      resumed: result.resumed || false,
    };
  } catch (err) {
    console.error(`[${tag}] executePromptAction threw: ${err.message}`);
    return {
      executed: true,
      action: "prompt",
      success: false,
      error: err.message,
      resumed: false,
    };
  }
}

/**
 * Build a rich prompt for the agent to fix issues.
 * If the thread is being resumed, the prompt is shorter (agent has context).
 * If starting fresh, includes full task context.
 */
function buildFixPrompt(fixMessage, ctx, isResume, promptTemplate = "") {
  const parts = [];

  if (isResume) {
    // Resuming — agent already knows the task
    parts.push(`# Fix Required\n`);
    parts.push(`Your previous work on this task needs some fixes:\n`);
    parts.push(fixMessage);
    if (ctx.ciStatus === "failing") {
      parts.push(
        `\n\n**CI is currently failing.** Please fix CI issues before pushing.`,
      );
    }
    parts.push(`\n\nAfter fixing, commit and push the changes.`);
  } else {
    // Fresh start — include full context
    parts.push(`# Fix Required — Task Context\n`);
    if (ctx.taskTitle) parts.push(`**Task:** ${ctx.taskTitle}`);
    if (ctx.taskDescription)
      parts.push(`**Description:** ${ctx.taskDescription.slice(0, 2000)}`);
    if (ctx.branch) parts.push(`**Branch:** ${ctx.branch}`);
    if (ctx.prNumber) parts.push(`**PR:** #${ctx.prNumber}`);
    parts.push(`\n## What Needs Fixing\n`);
    parts.push(fixMessage);
    if (ctx.changedFiles?.length) {
      parts.push(
        `\n## Files Already Changed\n\`\`\`\n${ctx.changedFiles.slice(0, 30).join("\n")}\n\`\`\``,
      );
    }
    if (ctx.ciStatus === "failing") {
      parts.push(`\n**CI is currently failing.** Please fix CI issues.`);
    }
    parts.push(`\n\nFix the issues, then commit and push.`);
  }

  const fallback = parts.join("\n");
  return resolvePromptTemplate(
    promptTemplate,
    {
      FIX_MESSAGE: fixMessage,
      TASK_CONTEXT_BLOCK: [
        ctx.taskTitle ? `Task: ${ctx.taskTitle}` : "",
        ctx.taskDescription
          ? `Description: ${ctx.taskDescription.slice(0, 2000)}`
          : "",
        ctx.branch ? `Branch: ${ctx.branch}` : "",
        ctx.prNumber ? `PR: #${ctx.prNumber}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      CI_STATUS_LINE:
        ctx.ciStatus === "failing"
          ? "CI is currently failing. Fix CI issues before pushing."
          : "",
    },
    fallback,
  );
}

// ── Re-attempt action ───────────────────────────────────────────────────────

/**
 * Execute a "re_attempt" action: invalidate the old thread and start fresh with error recovery.
 */
async function executeReAttemptAction(decision, ctx, execOpts) {
  const {
    tag,
    taskKey,
    cwd,
    timeoutMs,
    maxRetries,
    logDir,
    onTelegram,
    promptTemplate,
  } = execOpts;

  const reason = decision.reason || "Previous attempt failed";

  console.log(
    `[${tag}] re-attempting task "${ctx.taskTitle || taskKey}" (max ${maxRetries} retries). Reason: ${reason}`,
  );

  // Invalidate the old thread so we start completely fresh
  invalidateThread(taskKey);

  if (onTelegram) {
    onTelegram(
      `🔄 Re-attempting task "${ctx.taskTitle || ctx.shortId}": ${reason.slice(0, 200)}`,
    );
  }

  // Build the re-attempt prompt with full context
  const reAttemptPrompt = buildReAttemptPrompt(ctx, reason, promptTemplate);

  try {
    const result = await execWithRetry(reAttemptPrompt, {
      taskKey: `${taskKey}-reattempt`, // New key so it doesn't conflict with old thread
      cwd,
      timeoutMs,
      maxRetries,
      shouldRetry: (res) => !res.success, // Retry on any failure
      buildRetryPrompt: (lastResult, attempt) =>
        `# Retry ${attempt} — Previous Error\n\n\`\`\`\n${lastResult?.error || lastResult?.output?.slice(0, 500) || "unknown"}\n\`\`\`\n\nPlease fix the error and complete the task.\n\nOriginal task: ${ctx.taskTitle || "unknown"}\nBranch: ${ctx.branch || "unknown"}`,
    });

    await auditDecisionExecution(logDir, ctx, decision, result);

    if (result.success) {
      console.log(
        `[${tag}] ✅ re-attempt succeeded after ${result.attempts} attempt(s)`,
      );
      if (onTelegram) {
        onTelegram(
          `✅ Re-attempt succeeded for "${ctx.taskTitle || ctx.shortId}" (${result.attempts} attempt(s))`,
        );
      }
    } else {
      console.warn(
        `[${tag}] ❌ re-attempt failed after ${result.attempts} attempt(s): ${result.error}`,
      );
      if (onTelegram) {
        onTelegram(
          `❌ Re-attempt failed for "${ctx.taskTitle || ctx.shortId}" after ${result.attempts} attempt(s): ${result.error?.slice(0, 200)}`,
        );
      }
    }

    return {
      executed: true,
      action: "re_attempt",
      success: result.success,
      output: result.output,
      error: result.error,
      attempts: result.attempts,
      resumed: false,
    };
  } catch (err) {
    console.error(`[${tag}] executeReAttemptAction threw: ${err.message}`);
    return {
      executed: true,
      action: "re_attempt",
      success: false,
      error: err.message,
      attempts: 0,
      resumed: false,
    };
  }
}

/**
 * Build a full-context prompt for re-attempting a task from scratch.
 */
function buildReAttemptPrompt(ctx, reason, promptTemplate = "") {
  const parts = [];
  parts.push(`# Task Re-Attempt\n`);
  parts.push(
    `A previous agent attempt at this task failed. Start fresh and complete the task.\n`,
  );
  parts.push(`**Failure reason:** ${reason}\n`);
  if (ctx.taskTitle) parts.push(`**Task:** ${ctx.taskTitle}`);
  if (ctx.taskDescription)
    parts.push(`**Description:** ${ctx.taskDescription.slice(0, 3000)}`);
  if (ctx.branch) parts.push(`**Branch:** ${ctx.branch}`);
  if (ctx.prNumber)
    parts.push(`**Existing PR:** #${ctx.prNumber} (may need amendment)`);
  parts.push(`\nPlease implement the task fully, run tests, commit, and push.`);
  const fallback = parts.join("\n");
  return resolvePromptTemplate(
    promptTemplate,
    {
      FAILURE_REASON: reason,
      TASK_CONTEXT_BLOCK: [
        ctx.taskTitle ? `Task: ${ctx.taskTitle}` : "",
        ctx.taskDescription
          ? `Description: ${ctx.taskDescription.slice(0, 3000)}`
          : "",
        ctx.branch ? `Branch: ${ctx.branch}` : "",
        ctx.prNumber ? `Existing PR: #${ctx.prNumber}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    fallback,
  );
}

// ── Merge action ────────────────────────────────────────────────────────────

/**
 * Enable auto-merge for the PR via `gh pr merge --auto --squash`.
 */
async function executeMergeAction(decision, ctx, execOpts) {
  const { tag, onTelegram } = execOpts;

  if (!ctx.prNumber) {
    console.warn(`[${tag}] merge_after_ci_pass but no PR number`);
    return {
      executed: false,
      action: "merge_after_ci_pass",
      success: false,
      error: "No PR number",
    };
  }

  console.log(`[${tag}] enabling auto-merge for PR #${ctx.prNumber}`);

  try {
    const result = execSync(`gh pr merge ${ctx.prNumber} --auto --squash`, {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (onTelegram) {
      onTelegram(
        `✅ Auto-merge enabled for PR #${ctx.prNumber} "${ctx.prTitle || ctx.taskTitle || ""}"`,
      );
    }

    return {
      executed: true,
      action: "merge_after_ci_pass",
      success: true,
      output: result,
    };
  } catch (err) {
    // Auto-merge might already be enabled, or repo doesn't support it
    console.warn(`[${tag}] gh pr merge --auto failed: ${err.message}`);

    if (onTelegram) {
      onTelegram(
        `⚠️ Auto-merge failed for PR #${ctx.prNumber}: ${err.message?.slice(0, 200)}. Will retry on next cycle.`,
      );
    }

    return {
      executed: true,
      action: "merge_after_ci_pass",
      success: false,
      error: err.message,
    };
  }
}

// ── Close PR action ─────────────────────────────────────────────────────────

/**
 * Close the PR via `gh pr close` with an explanatory comment.
 */
async function executeCloseAction(decision, ctx, execOpts) {
  const { tag, onTelegram } = execOpts;

  if (!ctx.prNumber) {
    return {
      executed: false,
      action: "close_pr",
      success: false,
      error: "No PR number",
    };
  }

  console.log(
    `[${tag}] closing PR #${ctx.prNumber}: ${decision.reason || "no reason"}`,
  );

  try {
    const comment = decision.reason
      ? `Closing: ${decision.reason}`
      : "Closing PR based on merge strategy analysis.";

    execSync(
      `gh pr close ${ctx.prNumber} --comment "${comment.replace(/"/g, '\\"')}"`,
      {
        encoding: "utf8",
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    if (onTelegram) {
      onTelegram(
        `🚫 Closed PR #${ctx.prNumber}: ${decision.reason || "strategy decision"}`,
      );
    }

    return { executed: true, action: "close_pr", success: true };
  } catch (err) {
    console.warn(`[${tag}] close_pr failed: ${err.message}`);
    return {
      executed: true,
      action: "close_pr",
      success: false,
      error: err.message,
    };
  }
}

// ── Audit helper ────────────────────────────────────────────────────────────

/**
 * Write an audit log for decision execution.
 */
async function auditDecisionExecution(logDir, ctx, decision, result) {
  if (!logDir) return;
  try {
    await mkdir(resolve(logDir), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const auditPath = resolve(logDir, `merge-exec-${ctx.shortId}-${stamp}.log`);
    await writeFile(
      auditPath,
      [
        `# Merge Decision Execution`,
        `# Attempt: ${ctx.attemptId}`,
        `# Action: ${decision.action}`,
        `# Task: ${ctx.taskTitle || "unknown"}`,
        `# Timestamp: ${new Date().toISOString()}`,
        "",
        "## Decision:",
        JSON.stringify(decision, null, 2),
        "",
        "## Execution Result:",
        JSON.stringify(
          {
            success: result?.success,
            resumed: result?.resumed,
            attempts: result?.attempts,
            error: result?.error,
            outputLength: result?.output?.length || 0,
          },
          null,
          2,
        ),
        "",
        result?.output
          ? `## Agent Output:\n${result.output.slice(0, 5000)}`
          : "",
      ].join("\n"),
      "utf8",
    );
  } catch {
    /* audit best-effort */
  }
}

// ── Convenience pipeline ────────────────────────────────────────────────────

/**
 * One-shot convenience: analyze + execute in a single call.
 * Useful for callers who want the full pipeline without manual orchestration.
 *
 * @param {MergeContext}  ctx    Task context
 * @param {object}        opts   Options passed to both analyze and execute
 * @returns {Promise<{ decision: MergeDecision, execution: ExecutionResult }>}
 */
export async function analyzeAndExecute(ctx, opts = {}) {
  const decision = await analyzeMergeStrategy(ctx, opts);

  // Skip execution for noop
  if (decision.action === "noop") {
    return {
      decision,
      execution: { executed: false, action: "noop", success: true },
    };
  }

  const execution = await executeDecision(decision, ctx, opts);

  return { decision, execution };
}

// ── Exports ─────────────────────────────────────────────────────────────────

export { VALID_ACTIONS, extractActionJson, buildMergeStrategyPrompt };
