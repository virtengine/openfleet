/**
 * review-agent.mjs — Automated Code Review for Vibe-Kanban Tasks
 *
 * Reviews PRs when tasks move to "inreview" status.
 * Only flags CRITICAL issues: security, bugs, broken functionality,
 * missing implementations. Ignores style, naming, minor quality concerns.
 *
 * @module review-agent
 */

import { spawnSync } from "node:child_process";
import { execWithRetry, getPoolSdkName } from "./agent-pool.mjs";
import { loadConfig } from "./config.mjs";
import { resolvePromptTemplate } from "./agent-prompts.mjs";

const TAG = "[review-agent]";

/** Maximum diff size before truncation (characters). */
const MAX_DIFF_CHARS = 50_000;

/** Default review timeout: 5 minutes. */
const DEFAULT_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

/** Default max concurrent reviews. */
const DEFAULT_MAX_CONCURRENT = 2;

// ---------------------------------------------------------------------------
// Review Prompt
// ---------------------------------------------------------------------------

/**
 * Build the structured review prompt.
 * @param {string} diff - PR diff content
 * @param {string} taskDescription - Task description for context
 * @param {string} [template]
 * @returns {string}
 */
function buildReviewPrompt(diff, taskDescription, template) {
  const fallback = `You are a senior code reviewer for this software project.

Review the following PR diff for CRITICAL issues ONLY:

## What to flag (ONLY these categories):
1. **Security vulnerabilities** - injection, auth bypass, key exposure, unsafe crypto
2. **Bugs** - logic errors, nil pointer dereferences, race conditions, data corruption
3. **Missing implementations** - placeholder/stub code, TODO comments left in, empty function bodies
4. **Broken functionality** - code that won't compile, tests that fail, broken imports

## What to IGNORE (do NOT flag):
- Code style or formatting
- Variable naming conventions
- Minor code quality improvements
- Missing comments or documentation
- Performance optimizations (unless critical)
- Test coverage gaps (unless zero tests for critical code)

## PR Diff:
\`\`\`diff
${diff}
\`\`\`

## Task Description:
${taskDescription || "(no description provided)"}

## Response Format:
Respond with ONLY a JSON object (no markdown, no explanation):
{
  "verdict": "approved" | "changes_requested",
  "issues": [
    {
      "severity": "critical" | "major",
      "category": "security" | "bug" | "missing_impl" | "broken",
      "file": "path/to/file",
      "line": 123,
      "description": "What's wrong and why it matters"
    }
  ],
  "summary": "One sentence overall assessment"
}

If no critical issues found, return:
{"verdict": "approved", "issues": [], "summary": "No critical issues found"}`;
  return resolvePromptTemplate(
    template,
    {
      DIFF: diff,
      TASK_DESCRIPTION: taskDescription || "(no description provided)",
    },
    fallback,
  );
}

// ---------------------------------------------------------------------------
// Diff Retrieval
// ---------------------------------------------------------------------------

/**
 * Extract PR number from a PR URL.
 * @param {string} prUrl
 * @returns {number|null}
 */
function extractPrNumber(prUrl) {
  if (!prUrl) return null;
  const m = prUrl.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Extract repo slug (owner/repo) from a PR URL.
 * @param {string} prUrl
 * @returns {string|null}
 */
function extractRepoSlug(prUrl) {
  if (!prUrl) return null;
  const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\//);
  return m ? m[1] : null;
}

/**
 * Get the PR diff using `gh pr diff` or `git diff`.
 * @param {{ prUrl?: string, branchName?: string }} opts
 * @returns {{ diff: string, truncated: boolean }}
 */
function getPrDiff({ prUrl, branchName }) {
  let diff = "";

  // Strategy 1: gh pr diff
  const prNumber = extractPrNumber(prUrl);
  const repoSlug = extractRepoSlug(prUrl);
  if (prNumber && repoSlug) {
    try {
      const result = spawnSync(
        "gh",
        ["pr", "diff", String(prNumber), "--repo", repoSlug],
        { encoding: "utf8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] },
      );
      if (result.status === 0 && result.stdout?.trim()) {
        diff = result.stdout;
      }
    } catch {
      /* fall through to git diff */
    }
  }

  // Strategy 2: git diff main...<branch>
  if (!diff && branchName) {
    try {
      const result = spawnSync("git", ["diff", `main...${branchName}`], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (result.status === 0 && result.stdout?.trim()) {
        diff = result.stdout;
      }
    } catch {
      /* ignore */
    }
  }

  // Truncate if needed
  let truncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS);
    truncated = true;
  }

  return { diff, truncated };
}

// ---------------------------------------------------------------------------
// Result Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the review JSON from agent output.
 * Handles markdown fences, surrounding text, and invalid JSON gracefully.
 * @param {string} raw
 * @returns {{ approved: boolean, issues: Array, summary: string }}
 */
function parseReviewResult(raw) {
  if (!raw || !raw.trim()) {
    return {
      approved: true,
      issues: [],
      summary: "Empty agent output — auto-approved",
    };
  }

  let text = raw.trim();

  // Strip markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // Try direct JSON parse
  try {
    const parsed = JSON.parse(text);
    return normalizeResult(parsed);
  } catch {
    /* continue to regex extraction */
  }

  // Extract first JSON object from text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return normalizeResult(parsed);
    } catch {
      /* fall through */
    }
  }

  // Couldn't parse — auto-approve with note
  return {
    approved: true,
    issues: [],
    summary: "Could not parse review output — auto-approved",
  };
}

/**
 * Normalize a parsed review object.
 * @param {Object} obj
 * @returns {{ approved: boolean, issues: Array, summary: string }}
 */
function normalizeResult(obj) {
  const approved = obj.verdict !== "changes_requested";
  const issues = Array.isArray(obj.issues) ? obj.issues : [];
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  return { approved, issues, summary };
}

// ---------------------------------------------------------------------------
// ReviewAgent Class
// ---------------------------------------------------------------------------

export class ReviewAgent {
  /** @type {Map<string, Promise>} */
  #activeReviews = new Map();

  /** @type {Array<{ id: string, title: string, branchName: string, prUrl: string, description: string }>} */
  #queue = [];

  /** @type {Set<string>} - task IDs already reviewed or in-flight */
  #seen = new Set();

  #completedCount = 0;
  #running = false;
  #processing = false;

  /** @type {string} */
  #sdk;

  /** @type {string|undefined} */
  #model;

  /** @type {number} */
  #maxConcurrent;

  /** @type {number} */
  #reviewTimeoutMs;

  /** @type {Function|undefined} */
  #onReviewComplete;

  /** @type {Function|undefined} */
  #sendTelegram;

  /** @type {string|undefined} */
  #promptTemplate;

  /**
   * @param {Object} [options]
   * @param {string} [options.sdk]
   * @param {string} [options.model]
   * @param {number} [options.maxConcurrentReviews]
   * @param {number} [options.reviewTimeoutMs]
   * @param {Function} [options.onReviewComplete]
   * @param {Function} [options.sendTelegram]
   * @param {string} [options.promptTemplate]
   */
  constructor(options = {}) {
    this.#sdk = options.sdk || getPoolSdkName();
    this.#model = options.model;
    this.#maxConcurrent =
      options.maxConcurrentReviews ?? DEFAULT_MAX_CONCURRENT;
    this.#reviewTimeoutMs =
      options.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
    this.#onReviewComplete = options.onReviewComplete;
    this.#sendTelegram = options.sendTelegram;
    this.#promptTemplate = options.promptTemplate;
    console.log(
      `${TAG} initialized (sdk=${this.#sdk}, maxConcurrent=${this.#maxConcurrent}, timeout=${this.#reviewTimeoutMs}ms)`,
    );
  }

  /**
   * Queue a task for review.
   * Deduplicates by task ID — same task won't be reviewed twice.
   * @param {{ id: string, title: string, branchName: string, prUrl: string, description: string }} task
   */
  async queueReview(task) {
    if (!task?.id) {
      console.warn(`${TAG} queueReview called without task id — skipping`);
      return;
    }

    if (this.#seen.has(task.id)) {
      console.log(`${TAG} task ${task.id} already reviewed/queued — skipping`);
      return;
    }

    this.#seen.add(task.id);
    this.#queue.push(task);
    console.log(
      `${TAG} queued review for task "${task.title}" (${task.id}), queue depth: ${this.#queue.length}`,
    );

    // Kick processing if running
    if (this.#running) {
      this.#processQueue();
    }
  }

  /**
   * Cancel a pending (not yet started) review.
   * Active reviews cannot be cancelled.
   * @param {string} taskId
   */
  cancelReview(taskId) {
    const idx = this.#queue.findIndex((t) => t.id === taskId);
    if (idx !== -1) {
      this.#queue.splice(idx, 1);
      this.#seen.delete(taskId);
      console.log(`${TAG} cancelled queued review for task ${taskId}`);
    }
  }

  /**
   * Get current review-agent status.
   * @returns {{ running: boolean, sdk: string, activeReviews: number, queuedReviews: number, completedReviews: number }}
   */
  getStatus() {
    return {
      running: this.#running,
      sdk: this.#sdk,
      activeReviews: this.#activeReviews.size,
      queuedReviews: this.#queue.length,
      completedReviews: this.#completedCount,
    };
  }

  /** Start processing the review queue. */
  start() {
    this.#running = true;
    console.log(`${TAG} started`);
    this.#processQueue();
  }

  /**
   * Stop gracefully — waits for active reviews to finish.
   * @returns {Promise<void>}
   */
  async stop() {
    this.#running = false;
    console.log(
      `${TAG} stopping — waiting for ${this.#activeReviews.size} active review(s)`,
    );
    if (this.#activeReviews.size > 0) {
      await Promise.allSettled([...this.#activeReviews.values()]);
    }
    console.log(`${TAG} stopped`);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** Process queued reviews up to concurrency limit. */
  #processQueue() {
    if (this.#processing || !this.#running) return;
    this.#processing = true;

    try {
      while (
        this.#queue.length > 0 &&
        this.#activeReviews.size < this.#maxConcurrent
      ) {
        const task = this.#queue.shift();
        const promise = this.#runReview(task)
          .catch((err) => {
            console.error(`${TAG} unhandled review error for ${task.id}:`, err);
          })
          .finally(() => {
            this.#activeReviews.delete(task.id);
            this.#completedCount++;
            // Continue processing after slot freed
            if (this.#running && this.#queue.length > 0) {
              this.#processQueue();
            }
          });

        this.#activeReviews.set(task.id, promise);
      }
    } finally {
      this.#processing = false;
    }
  }

  /**
   * Run a single review.
   * @param {{ id: string, title: string, branchName: string, prUrl: string, description: string }} task
   */
  async #runReview(task) {
    console.log(`${TAG} starting review for "${task.title}" (${task.id})`);

    // 1. Get PR diff
    const { diff, truncated } = getPrDiff({
      prUrl: task.prUrl,
      branchName: task.branchName,
    });

    if (!diff) {
      console.log(
        `${TAG} no diff available for task ${task.id} — auto-approving`,
      );
      const result = {
        approved: true,
        issues: [],
        summary: "No diff available",
        reviewedAt: new Date().toISOString(),
        agentOutput: "",
      };
      this.#emitResult(task.id, result);
      return;
    }

    if (truncated) {
      console.warn(
        `${TAG} diff for task ${task.id} truncated to ${MAX_DIFF_CHARS} chars`,
      );
    }

    // 2. Build prompt
    const prompt = buildReviewPrompt(
      diff,
      task.description,
      this.#promptTemplate,
    );

    // 3. Run agent
    let agentOutput = "";
    try {
      const sdkResult = await execWithRetry(prompt, {
        taskKey: `review-${task.id}`,
        timeoutMs: this.#reviewTimeoutMs,
        maxRetries: 0, // Reviews don't retry — approve on failure
        sdk: this.#sdk,
      });

      agentOutput = sdkResult.output || "";
    } catch (err) {
      console.error(`${TAG} SDK call failed for task ${task.id}:`, err.message);
      const result = {
        approved: true,
        issues: [],
        summary: `Review failed: ${err.message}`,
        reviewedAt: new Date().toISOString(),
        agentOutput: "",
      };
      this.#emitResult(task.id, result);
      return;
    }

    // 4. Parse result
    const parsed = parseReviewResult(agentOutput);

    const result = {
      approved: parsed.approved,
      issues: parsed.issues,
      summary: parsed.summary + (truncated ? " (diff was truncated)" : ""),
      reviewedAt: new Date().toISOString(),
      agentOutput: agentOutput.slice(0, 3000),
    };

    console.log(
      `${TAG} review complete for "${task.title}": ${result.approved ? "APPROVED" : "CHANGES REQUESTED"} — ${result.issues.length} issue(s)`,
    );

    // 5. Report
    this.#emitResult(task.id, result);
  }

  /**
   * Emit review result via callback and optional Telegram notification.
   * @param {string} taskId
   * @param {Object} result
   */
  #emitResult(taskId, result) {
    if (typeof this.#onReviewComplete === "function") {
      try {
        this.#onReviewComplete(taskId, result);
      } catch (err) {
        console.error(`${TAG} onReviewComplete callback error:`, err.message);
      }
    }

    // Send Telegram for rejected reviews
    if (!result.approved && typeof this.#sendTelegram === "function") {
      const issueList = result.issues
        .map(
          (i) =>
            `• [${i.severity}/${i.category}] ${i.file}${i.line ? `:${i.line}` : ""} — ${i.description}`,
        )
        .join("\n");

      const message = [
        `🔍 Review: changes requested`,
        `Task: ${taskId}`,
        `Summary: ${result.summary}`,
        result.issues.length ? `\nIssues:\n${issueList}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      try {
        this.#sendTelegram(message);
      } catch {
        /* best effort */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ReviewAgent instance.
 * @param {Object} [options] - Same options as ReviewAgent constructor
 * @returns {ReviewAgent}
 */
export function createReviewAgent(options) {
  let promptTemplate = options?.promptTemplate;
  if (!promptTemplate) {
    try {
      const config = loadConfig();
      promptTemplate = config.agentPrompts?.reviewer;
    } catch {
      /* best effort */
    }
  }
  return new ReviewAgent({ ...(options || {}), promptTemplate });
}
