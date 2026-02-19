/**
 * error-detector.mjs — Detects common agent failure patterns and provides recovery actions.
 *
 * Classifies errors into: plan_stuck, rate_limit, token_overflow, api_error,
 * session_expired, build_failure, git_conflict, unknown.
 * Returns recommended recovery actions so the orchestrator can respond automatically.
 */

import { readdirSync, readFileSync } from "node:fs";

const TAG = "[error-detector]";

// ── Detection patterns ──────────────────────────────────────────────────────

export const PLAN_STUCK_PATTERNS = [
  /ready to (start|begin|implement)/i,
  /would you like me to (proceed|start|implement|continue)/i,
  /shall i (start|begin|implement|proceed)/i,
  /here'?s the plan/i,
  /created plan at/i,
  /plan\.md$/m,
  /I'?ve (?:created|outlined|prepared) a plan/i,
  /Let me know (?:if|when|how) you'?d like/i,
  /awaiting (?:your|further) (?:input|instructions|confirmation)/i,
];

export const RATE_LIMIT_PATTERNS = [
  /429|rate.?limit|too many requests/i,
  /quota exceeded|billing.*limit/i,
  /tokens per minute|TPM.*limit/i,
  /resource exhausted|capacity/i,
  /please try again later/i,
  /Request too large|max.*tokens/i,
];

export const TOKEN_OVERFLOW_PATTERNS = [
  /context.*(too long|exceeded|overflow|maximum)/i,
  /max.*(context|token|length).*exceeded/i,
  /conversation.*too.*long/i,
  /input.*too.*large/i,
  /reduce.*(context|input|message)/i,
  /maximum.*context.*length/i,
];

const API_ERROR_PATTERNS = [
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i,
  /500 Internal Server Error/i,
  /502 Bad Gateway|503 Service Unavailable/i,
  /network.*(error|failure|unreachable)/i,
  /fetch failed|request failed/i,
];

const SESSION_EXPIRED_PATTERNS = [
  /session.*expired|invalid.*session/i,
  /thread.*not.*found|conversation.*not.*found/i,
  /authentication.*failed|unauthorized/i,
  /token.*expired|invalid.*token/i,
];

const BUILD_FAILURE_PATTERNS = [
  /go build.*failed|compilation error/i,
  /FAIL\s+\S+/m,
  /golangci-lint.*error/i,
  /pre-push hook.*failed/i,
  /npm ERR|pnpm.*error/i,
];

const GIT_CONFLICT_PATTERNS = [
  /merge conflict|CONFLICT.*Merge/i,
  /rebase.*conflict/i,
  /cannot.*merge|unable to merge/i,
  /both modified/i,
];

/**
 * Ordered list of pattern groups to check. Earlier entries win on ties.
 * Each entry: [patternName, regexArray, baseConfidence]
 */
const PATTERN_GROUPS = [
  ["plan_stuck", PLAN_STUCK_PATTERNS, 0.85],
  ["rate_limit", RATE_LIMIT_PATTERNS, 0.95],
  ["token_overflow", TOKEN_OVERFLOW_PATTERNS, 0.9],
  ["api_error", API_ERROR_PATTERNS, 0.9],
  ["session_expired", SESSION_EXPIRED_PATTERNS, 0.9],
  ["build_failure", BUILD_FAILURE_PATTERNS, 0.8],
  ["git_conflict", GIT_CONFLICT_PATTERNS, 0.85],
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Safely truncate a string for logging / details. */
function truncate(str, max = 200) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

/** Return the first regex match from `patterns` against `text`, or null. */
function firstMatch(text, patterns) {
  if (!text) return null;
  for (const rx of patterns) {
    const m = rx.exec(text);
    if (m) return m;
  }
  return null;
}

/** Description strings for each pattern type. */
const PATTERN_DESCRIPTIONS = {
  plan_stuck: "Agent created a plan but did not implement it",
  rate_limit: "API rate limit or quota exceeded",
  token_overflow: "Context or token limit exceeded",
  api_error: "API connection or server error",
  session_expired: "Agent session or thread expired",
  build_failure: "Build, test, or lint failure",
  git_conflict: "Git merge conflict detected",
  unknown: "Unclassified error",
};

// ── ErrorDetector ───────────────────────────────────────────────────────────

export class ErrorDetector {
  /**
   * @param {object} [options]
   * @param {number} [options.maxConsecutiveErrors=5]
   * @param {number} [options.cooldownMs=300000]          5 min default
   * @param {number} [options.rateLimitCooldownMs=60000]  1 min default
   * @param {Function} [options.onErrorDetected]
   * @param {Function} [options.sendTelegram]
   */
  constructor(options = {}) {
    this.maxConsecutiveErrors = options.maxConsecutiveErrors ?? 5;
    this.cooldownMs = options.cooldownMs ?? 5 * 60 * 1000;
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? 60 * 1000;
    this.onErrorDetected = options.onErrorDetected ?? null;
    this.sendTelegram = options.sendTelegram ?? null;

    /** @type {Map<string, { errors: Array<{pattern:string, timestamp:number, details:string}>, consecutiveErrors: number, lastErrorAt: number }>} */
    this._tasks = new Map();

    /** Global stats */
    this._global = {
      rateLimitHits: [], // timestamps
      totalErrors: 0,
      totalRecoveries: 0,
    };
  }

  // ── classify ────────────────────────────────────────────────────────────

  /**
   * Analyse agent output (and optional stderr) to classify the failure.
   *
   * @param {string} output  Agent stdout / response text
   * @param {string} [error] Agent stderr or error message
   * @returns {{ pattern: string, confidence: number, details: string, rawMatch: string|null }}
   */
  classify(output, error) {
    const combined = [output, error].filter(Boolean).join("\n");
    if (!combined) {
      return {
        pattern: "unknown",
        confidence: 0,
        details: "No output to analyse",
        rawMatch: null,
      };
    }

    let best = null;

    for (const [pattern, regexes, baseConfidence] of PATTERN_GROUPS) {
      const m = firstMatch(combined, regexes);
      if (m) {
        // Boost confidence when multiple patterns in the same group match.
        let hits = 0;
        for (const rx of regexes) {
          if (rx.test(combined)) hits++;
        }
        const confidence = Math.min(1, baseConfidence + (hits - 1) * 0.05);

        if (!best || confidence > best.confidence) {
          best = {
            pattern,
            confidence,
            details: PATTERN_DESCRIPTIONS[pattern],
            rawMatch: truncate(m[0]),
          };
        }
      }
    }

    return (
      best || {
        pattern: "unknown",
        confidence: 0.3,
        details: PATTERN_DESCRIPTIONS.unknown,
        rawMatch: null,
      }
    );
  }

  // ── recordError ─────────────────────────────────────────────────────────

  /**
   * Record an error for a task and return the recommended recovery action.
   *
   * @param {string} taskId
   * @param {{ pattern: string, confidence: number, details: string, rawMatch: string|null }} classification
   * @returns {{ action: string, prompt?: string, cooldownMs?: number, reason: string, errorCount: number }}
   */
  recordError(taskId, classification) {
    if (!taskId || !classification) {
      return {
        action: "manual",
        reason: "Missing taskId or classification",
        errorCount: 0,
      };
    }

    // Ensure task record exists.
    if (!this._tasks.has(taskId)) {
      this._tasks.set(taskId, {
        errors: [],
        consecutiveErrors: 0,
        lastErrorAt: 0,
      });
    }
    const rec = this._tasks.get(taskId);
    const now = Date.now();

    rec.errors.push({
      pattern: classification.pattern,
      timestamp: now,
      details: classification.details,
    });
    rec.consecutiveErrors += 1;
    rec.lastErrorAt = now;
    this._global.totalErrors += 1;

    // Track global rate-limit hits.
    if (classification.pattern === "rate_limit") {
      this._global.rateLimitHits.push(now);
      // Prune old entries (> 5 minutes).
      const cutoff = now - this.cooldownMs;
      this._global.rateLimitHits = this._global.rateLimitHits.filter(
        (t) => t > cutoff,
      );
    }

    // Fire callback.
    if (typeof this.onErrorDetected === "function") {
      try {
        this.onErrorDetected({
          taskId,
          classification,
          errorCount: rec.consecutiveErrors,
        });
      } catch {
        /* swallow */
      }
    }

    // Determine recovery action.
    const errorCount = rec.consecutiveErrors;

    // Block after too many consecutive errors.
    if (errorCount >= this.maxConsecutiveErrors) {
      const reason = `Task has ${errorCount} consecutive errors (max ${this.maxConsecutiveErrors}) — blocking`;
      this._notifyTelegram(`🛑 Task ${taskId} blocked: ${reason}`);
      return { action: "block", reason, errorCount };
    }

    switch (classification.pattern) {
      case "plan_stuck":
        return {
          action: "retry_with_prompt",
          prompt: this.getPlanStuckRecoveryPrompt("(unknown)", ""),
          reason:
            "Agent stuck in planning mode — sending implementation prompt",
          errorCount,
        };

      case "rate_limit":
        if (this.shouldPauseExecutor()) {
          return {
            action: "pause_executor",
            cooldownMs: this.cooldownMs,
            reason: `>${this._rateLimitThreshold()} rate limits in 5 min window — pausing executor`,
            errorCount,
          };
        }
        return {
          action: "cooldown",
          cooldownMs: this.rateLimitCooldownMs,
          reason: "Rate limited — cooling down before retry",
          errorCount,
        };

      case "token_overflow":
        return {
          action: "new_session",
          prompt: this.getTokenOverflowRecoveryPrompt("(unknown)"),
          reason:
            "Token/context overflow — starting fresh session on same worktree",
          errorCount,
        };

      case "api_error":
        if (errorCount >= 3) {
          return {
            action: "block",
            reason: "API errors persist after 3 retries — blocking",
            errorCount,
          };
        }
        return {
          action: "cooldown",
          cooldownMs: this.rateLimitCooldownMs,
          reason: `API error (attempt ${errorCount}/3) — retry after cooldown`,
          errorCount,
        };

      case "session_expired":
        return {
          action: "new_session",
          reason: "Session/thread expired — creating new session",
          errorCount,
        };

      case "build_failure":
        if (errorCount >= 3) {
          return {
            action: "manual",
            reason:
              "Build failures persist after 3 retries — needs manual review",
            errorCount,
          };
        }
        return {
          action: "retry_with_prompt",
          prompt:
            "The previous build/test/lint step failed. Carefully read the error output, fix the root cause, and try again. Do NOT skip tests.",
          reason: `Build failure (attempt ${errorCount}/3) — retry with fix prompt`,
          errorCount,
        };

      case "git_conflict":
        if (errorCount >= 2) {
          return {
            action: "manual",
            reason:
              "Git conflicts persist after 2 retries — needs manual resolution",
            errorCount,
          };
        }
        return {
          action: "retry_with_prompt",
          prompt:
            "There are git merge conflicts. Run `git status` to find conflicting files, resolve each conflict by choosing the correct code, then `git add` and `git commit`. Do NOT leave conflict markers in the code.",
          reason: "Git conflict detected — retry with resolution prompt",
          errorCount,
        };

      default:
        if (errorCount >= 3) {
          return {
            action: "manual",
            reason: `Unknown error repeated ${errorCount} times — needs manual review`,
            errorCount,
          };
        }
        return {
          action: "cooldown",
          cooldownMs: this.rateLimitCooldownMs,
          reason: "Unknown error — retry after cooldown",
          errorCount,
        };
    }
  }

  // ── Recovery prompts ────────────────────────────────────────────────────

  /**
   * Get recovery prompt for plan-stuck errors.
   *
   * @param {string} taskTitle
   * @param {string} lastOutput
   * @returns {string}
   */
  getPlanStuckRecoveryPrompt(taskTitle, lastOutput) {
    const outputSummary = (lastOutput || "").slice(-1500);
    return `You previously created a plan for task "${taskTitle}" but did not implement it.

CRITICAL: Do NOT create another plan. Do NOT ask for permission. Implement the changes NOW.

Your previous output ended with planning but no code changes were made. This is a Vibe-Kanban autonomous task — you must implement, test, commit, and push without any human interaction.

Previous output summary:
${outputSummary}

IMPLEMENT NOW. Start by making the actual code changes, then test, commit, and push.`;
  }

  /**
   * Get recovery prompt for token overflow.
   *
   * @param {string} taskTitle
   * @returns {string}
   */
  getTokenOverflowRecoveryPrompt(taskTitle) {
    return `Continue working on task "${taskTitle}". Your previous session exceeded context limits.

This is a fresh session on the same worktree. Check what was already done:
1. Run \`git log --oneline -10\` to see recent commits
2. Run \`git diff --stat\` to see uncommitted changes
3. Review the task requirements and continue from where the previous session left off

Do NOT restart from scratch — build on existing progress.`;
  }

  // ── Executor kill-switch ────────────────────────────────────────────────

  /**
   * Returns true if the executor should pause due to excessive rate limiting.
   * Triggers when >3 rate-limit errors hit within the cooldown window (5 min).
   *
   * @returns {boolean}
   */
  shouldPauseExecutor() {
    const now = Date.now();
    const cutoff = now - this.cooldownMs;
    this._global.rateLimitHits = this._global.rateLimitHits.filter(
      (t) => t > cutoff,
    );
    return this._global.rateLimitHits.length > this._rateLimitThreshold();
  }

  /** @private */
  _rateLimitThreshold() {
    return 3;
  }

  // ── Task lifecycle ──────────────────────────────────────────────────────

  /**
   * Reset error tracking for a task (call on success).
   *
   * @param {string} taskId
   */
  resetTask(taskId) {
    if (this._tasks.has(taskId)) {
      this._global.totalRecoveries += this._tasks.get(taskId).consecutiveErrors;
      this._tasks.delete(taskId);
    }
  }

  // ── Stats ───────────────────────────────────────────────────────────────

  /**
   * Get error statistics.
   *
   * @returns {{ totalErrors: number, totalRecoveries: number, activeTaskErrors: number, rateLimitHitsLast5m: number, taskBreakdown: Record<string, number> }}
   */
  getStats() {
    const now = Date.now();
    const cutoff = now - this.cooldownMs;
    const rateLimitHitsLast5m = this._global.rateLimitHits.filter(
      (t) => t > cutoff,
    ).length;

    const taskBreakdown = {};
    for (const [taskId, rec] of this._tasks) {
      taskBreakdown[taskId] = rec.consecutiveErrors;
    }

    return {
      totalErrors: this._global.totalErrors,
      totalRecoveries: this._global.totalRecoveries,
      activeTaskErrors: this._tasks.size,
      rateLimitHitsLast5m,
      taskBreakdown,
    };
  }

  // ── Session-Aware Analysis ────────────────────────────────────────────────

  /**
   * Analyze a sequence of session messages (from SessionTracker) to detect
   * behavioral patterns that single-event classification would miss.
   *
   * Detects:
   * - tool_loop:           Same tools repeated 5+ times without progress
   * - analysis_paralysis:  Only reading files, never editing (after 10+ tool calls)
   * - plan_stuck:          Agent wrote a plan but stopped (plan keywords + no edits)
   * - needs_clarification: Agent explicitly says it needs input/clarification
   * - false_completion:    Agent claims done but there are no commits
   * - rate_limited:        Multiple rate limit errors in sequence
   *
   * @param {Array<{type: string, content: string, meta?: {toolName?: string}}>} messages
   * @returns {{ patterns: string[], primary: string|null, details: Record<string, string> }}
   */
  analyzeMessageSequence(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return { patterns: [], primary: null, details: {} };
    }

    const patterns = [];
    const details = {};

    // ── Tool loop detection ──
    const toolCalls = messages.filter((m) => m.type === "tool_call");
    if (toolCalls.length >= 5) {
      const toolNames = toolCalls.map((m) => m.meta?.toolName || "unknown");
      const lastFive = toolNames.slice(-5);
      const uniqueInLastFive = new Set(lastFive).size;
      if (uniqueInLastFive <= 2) {
        patterns.push("tool_loop");
        details.tool_loop = `Repeated tools: ${[...new Set(lastFive)].join(", ")} (${lastFive.length}x in last 5)`;
      }
    }

    // ── Analysis paralysis ──
    if (toolCalls.length >= 10) {
      const readTools = toolCalls.filter((m) => {
        const name = (m.meta?.toolName || m.content || "").toLowerCase();
        return (
          name.includes("read") ||
          name.includes("search") ||
          name.includes("grep") ||
          name.includes("list") ||
          name.includes("find") ||
          name.includes("cat")
        );
      });
      const editTools = toolCalls.filter((m) => {
        const name = (m.meta?.toolName || m.content || "").toLowerCase();
        return (
          name.includes("write") ||
          name.includes("edit") ||
          name.includes("create") ||
          name.includes("replace") ||
          name.includes("patch") ||
          name.includes("append")
        );
      });

      if (readTools.length >= 8 && editTools.length === 0) {
        patterns.push("analysis_paralysis");
        details.analysis_paralysis = `${readTools.length} read ops, 0 write ops in ${toolCalls.length} tool calls`;
      }
    }

    // ── Plan stuck ──
    const agentMessages = messages.filter((m) => m.type === "agent_message");
    const allAgentText = agentMessages
      .map((m) => m.content)
      .join(" ")
      .toLowerCase();
    const planPhrases = [
      "here's the plan",
      "here is my plan",
      "i'll create a plan",
      "plan.md",
      "ready to start implementing",
      "ready to begin",
      "would you like me to proceed",
      "shall i start",
      "would you like me to implement",
    ];
    const hasPlanPhrase = planPhrases.some((p) => allAgentText.includes(p));
    const editToolCalls = toolCalls.filter((m) => {
      const name = (m.meta?.toolName || m.content || "").toLowerCase();
      return (
        name.includes("write") ||
        name.includes("edit") ||
        name.includes("create") ||
        name.includes("replace")
      );
    });
    if (hasPlanPhrase && editToolCalls.length <= 1) {
      patterns.push("plan_stuck");
      details.plan_stuck = "Agent created a plan but did not implement it";
    }

    // ── Needs clarification ──
    const clarificationPhrases = [
      "need clarification",
      "need more information",
      "could you clarify",
      "unclear",
      "ambiguous",
      "which approach",
      "please specify",
      "i need to know",
      "can you provide",
      "what should i",
    ];
    if (clarificationPhrases.some((p) => allAgentText.includes(p))) {
      patterns.push("needs_clarification");
      details.needs_clarification =
        "Agent expressed uncertainty or asked for input";
    }

    // ── False completion ──
    const completionPhrases = [
      "task complete",
      "task is complete",
      "i've completed",
      "all done",
      "successfully completed",
      "changes have been committed",
      "pushed to",
      "pr created",
      "pull request created",
    ];
    const claimsDone = completionPhrases.some((p) => allAgentText.includes(p));
    const hasGitCommit = toolCalls.some((m) => {
      const content = (m.content || "").toLowerCase();
      return content.includes("git commit") || content.includes("git push");
    });
    if (claimsDone && !hasGitCommit) {
      patterns.push("false_completion");
      details.false_completion =
        "Agent claims completion but no git commit/push detected in tool calls";
    }

    // ── Rate limited ──
    const errors = messages.filter((m) => m.type === "error");
    const rateLimitErrors = errors.filter((m) =>
      /rate.?limit|429|too many requests|quota/i.test(m.content || ""),
    );
    if (rateLimitErrors.length >= 2) {
      patterns.push("rate_limited");
      details.rate_limited = `${rateLimitErrors.length} rate limit errors detected`;
    }

    // Determine primary pattern (most actionable)
    const priority = [
      "rate_limited",
      "plan_stuck",
      "false_completion",
      "needs_clarification",
      "tool_loop",
      "analysis_paralysis",
    ];
    const primary = priority.find((p) => patterns.includes(p)) || null;

    return { patterns, primary, details };
  }

  /**
   * Analyze agent log files for historical error patterns.
   * Reads log files from the agent logs directory and returns frequency data.
   *
   * @param {string} logsDir - Path to the agent logs directory
   * @returns {{ patterns: Record<string, number>, recommendations: string[] }}
   */
  analyzeHistoricalErrors(logsDir) {
    const patterns = {};
    const recommendations = [];

    try {
      const files = readdirSync(logsDir).filter((f) => f.endsWith(".log"));

      for (const file of files.slice(-20)) {
        // Only last 20 logs
        try {
          const content = readFileSync(`${logsDir}/${file}`, "utf8");
          const classification = this.classify(content);
          const pattern = classification.pattern;
          patterns[pattern] = (patterns[pattern] || 0) + 1;
        } catch {
          /* skip unreadable files */
        }
      }

      // Generate recommendations
      if ((patterns.rate_limit || 0) > 3) {
        recommendations.push(
          "Frequent rate limiting — consider reducing parallelism or adding delays",
        );
      }
      if ((patterns.plan_stuck || 0) > 3) {
        recommendations.push(
          "Agents frequently get stuck in planning mode — ensure instructions explicitly say 'implement immediately'",
        );
      }
      if ((patterns.token_overflow || 0) > 2) {
        recommendations.push(
          "Token overflow occurring — consider splitting large tasks or using summarization",
        );
      }
    } catch {
      /* logsDir might not exist */
    }

    return { patterns, recommendations };
  }

  /**
   * Generate a recovery prompt based on session analysis results.
   * Used by task-executor when a behavioral pattern is detected mid-session.
   *
   * @param {string} taskTitle
   * @param {{ primary: string|null, details: Record<string, string> }} analysis
   * @param {string} [lastOutput] - Last agent output for additional context
   * @returns {string}
   */
  getRecoveryPromptForAnalysis(taskTitle, analysis, lastOutput = "") {
    if (!analysis?.primary) {
      return `Continue working on task "${taskTitle}". Focus on implementation.`;
    }

    switch (analysis.primary) {
      case "plan_stuck":
        return [
          `# CONTINUE IMPLEMENTATION — Do Not Plan`,
          ``,
          `You wrote a plan for "${taskTitle}" but stopped before implementing it.`,
          ``,
          `DO NOT create another plan. DO NOT ask for permission.`,
          `Implement the changes NOW:`,
          `1. Edit the necessary files`,
          `2. Run tests to verify`,
          `3. Commit with conventional commit message`,
          `4. Push to the branch`,
          ``,
          `This is autonomous execution — implement immediately.`,
        ].join("\n");

      case "tool_loop":
        return [
          `# BREAK THE LOOP — Change Approach`,
          ``,
          `You've been repeating the same tools without making progress on "${taskTitle}".`,
          analysis.details?.tool_loop
            ? `Detail: ${analysis.details.tool_loop}`
            : "",
          ``,
          `STOP and take a different approach:`,
          `1. Summarize what you've learned so far`,
          `2. Identify what's blocking you`,
          `3. Try a completely different strategy`,
          `4. Make incremental progress — edit files, commit, push`,
        ]
          .filter(Boolean)
          .join("\n");

      case "analysis_paralysis":
        return [
          `# START EDITING — Stop Just Reading`,
          ``,
          `You've been reading files but not making any changes for "${taskTitle}".`,
          analysis.details?.analysis_paralysis
            ? `Detail: ${analysis.details.analysis_paralysis}`
            : "",
          ``,
          `You have enough context. Start implementing:`,
          `1. Create or edit the files needed`,
          `2. Don't try to understand everything first — work incrementally`,
          `3. Commit and push after each meaningful change`,
        ]
          .filter(Boolean)
          .join("\n");

      case "needs_clarification":
        return [
          `# MAKE A DECISION — Do Not Wait for Input`,
          ``,
          `You expressed uncertainty about "${taskTitle}" but this is autonomous execution.`,
          `No one will respond to your questions.`,
          ``,
          `Choose the most reasonable approach and proceed:`,
          `1. Pick the simplest correct implementation`,
          `2. Document any assumptions in code comments`,
          `3. Implement, test, commit, and push`,
        ].join("\n");

      case "false_completion":
        return [
          `# ACTUALLY COMPLETE THE TASK`,
          ``,
          `You claimed "${taskTitle}" was complete, but no git commit or push was detected.`,
          ``,
          `The task is NOT complete until changes are committed and pushed:`,
          `1. Stage your changes: git add -A`,
          `2. Commit: git commit -m "feat(scope): description"`,
          `3. Push: git push origin <branch>`,
          `4. Verify the push succeeded`,
        ].join("\n");

      case "rate_limited":
        return [
          `# RATE LIMITED — Wait and Retry`,
          ``,
          `You hit rate limits while working on "${taskTitle}".`,
          `Wait 30 seconds, then continue with smaller, focused operations.`,
          `Avoid large file reads or many parallel tool calls.`,
        ].join("\n");

      default:
        return `Continue working on task "${taskTitle}". Focus on making concrete progress.`;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /** @private */
  _notifyTelegram(message) {
    if (typeof this.sendTelegram === "function") {
      try {
        this.sendTelegram(message);
      } catch {
        /* swallow */
      }
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Convenience factory for creating an ErrorDetector.
 *
 * @param {object} [options] Same options as ErrorDetector constructor.
 * @returns {ErrorDetector}
 */
export function createErrorDetector(options) {
  return new ErrorDetector(options);
}
