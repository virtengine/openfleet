/**
 * agent-supervisor.mjs — Unified Agent Health Scoring & Intervention Engine
 *
 * This module is the "brain" that unifies ALL detection signals from:
 *   - session-tracker (event counts, idle time, progress)
 *   - error-detector (error classification, behavioral patterns)
 *   - agent-event-bus (heartbeats, liveness, error trends)
 *   - anomaly-detector (log-based anomalies)
 *   - workspace-monitor (git state, stuck detection)
 *   - agent-endpoint (self-reports)
 *
 * It computes a composite HEALTH SCORE per agent/task, detects 30+ edge-case
 * situations, and dispatches the MOST cost-effective intervention without
 * requiring additional AI inference when possible.
 *
 * INTERVENTION LADDER (cheapest → most expensive):
 *   0. No-op (agent is healthy)
 *   1. Continue signal (abort + re-enter — 0 tokens)
 *   2. Targeted prompt injection (focused recovery prompt — minimal tokens)
 *   3. Force new thread (same worktree, fresh context — medium tokens)
 *   4. Full task re-dispatch (new worktree — expensive)
 *   5. Block + human escalation (give up — 0 tokens)
 *
 * REVIEW ENFORCEMENT:
 *   - Tracks review verdicts and blocks merge/completion on rejection
 *   - Auto-dispatches fix tasks when review finds critical issues
 *   - Tracks quality score per task across attempts
 *
 * @module agent-supervisor
 */

const TAG = "[agent-supervisor]";

// ── Situation Types (30+ edge cases) ────────────────────────────────────────

/**
 * All situations the supervisor can detect. Each maps to an intervention.
 * @enum {string}
 */
export const SITUATION = Object.freeze({
  // ── Agent Not Working ──
  HEALTHY: "healthy",
  IDLE_SOFT: "idle_soft",               // Silent 2-3min — maybe thinking
  IDLE_HARD: "idle_hard",               // Silent 5+min — definitely stuck
  NO_HEARTBEAT: "no_heartbeat",         // No heartbeat from agent-endpoint
  AGENT_DEAD: "agent_dead",             // Process completely gone
  NO_RESPONSE_AT_ALL: "no_response",    // Agent started but 0 events

  // ── Agent Stuck in Loop ──
  PLAN_STUCK: "plan_stuck",             // Created plan, asked permission
  TOOL_LOOP: "tool_loop",              // Same tool calls repeating
  ERROR_LOOP: "error_loop",            // Same error repeating 3+ times
  ANALYSIS_PARALYSIS: "analysis_paralysis", // Only reading, never editing
  REBASE_SPIRAL: "rebase_spiral",       // Stuck in rebase/merge loop
  THOUGHT_SPINNING: "thought_spinning", // Agent talking to itself, no actions
  SELF_DEBUG_LOOP: "self_debug_loop",   // Agent debugging its own reasoning

  // ── Agent Failed ──
  BUILD_FAILURE: "build_failure",
  TEST_FAILURE: "test_failure",
  LINT_FAILURE: "lint_failure",
  GIT_CONFLICT: "git_conflict",
  PUSH_FAILURE: "push_failure",
  PRE_PUSH_FAILURE: "pre_push_failure",

  // ── External Errors ──
  RATE_LIMITED: "rate_limited",
  API_ERROR: "api_error",
  TOKEN_OVERFLOW: "token_overflow",
  SESSION_EXPIRED: "session_expired",
  MODEL_ERROR: "model_error",
  AUTH_FAILURE: "auth_failure",           // Invalid/expired/missing API key
  CONTENT_POLICY: "content_policy",       // Safety filter blocked
  CODEX_SANDBOX: "codex_sandbox",         // Codex CLI sandbox/permission
  INVALID_CONFIG: "invalid_config",       // Misconfigured agent settings

  // ── Completion Issues ──
  FALSE_COMPLETION: "false_completion",     // Claims done, no commits
  NO_COMMITS: "no_commits",                // "Completed" with 0 commits
  COMMITS_NOT_PUSHED: "commits_not_pushed", // Has commits, never pushed
  PR_NOT_CREATED: "pr_not_created",         // Pushed but no PR
  POOR_QUALITY: "poor_quality",             // Review rejected

  // ── Clarification Needed ──
  NEEDS_CLARIFICATION: "needs_clarification",
  WAITING_FOR_INPUT: "waiting_for_input",   // Generic "waiting" state

  // ── Resource Issues ──
  EXECUTOR_OVERLOADED: "executor_overloaded",
  RATE_LIMIT_FLOOD: "rate_limit_flood",     // 3+ rate limits in 5min
});

// ── Intervention Actions ────────────────────────────────────────────────────

/**
 * Ordered by cost (tokens + time). Lower = cheaper.
 * @enum {string}
 */
export const INTERVENTION = Object.freeze({
  NONE: "none",                           // Cost: 0
  CONTINUE_SIGNAL: "continue_signal",     // Cost: 0 (re-enter loop)
  INJECT_PROMPT: "inject_prompt",         // Cost: low (targeted text)
  FORCE_NEW_THREAD: "force_new_thread",   // Cost: medium (fresh session)
  REDISPATCH_TASK: "redispatch_task",     // Cost: high (full restart)
  BLOCK_AND_NOTIFY: "block_and_notify",   // Cost: 0 (give up)
  COOLDOWN: "cooldown",                   // Cost: 0 (wait)
  PAUSE_EXECUTOR: "pause_executor",       // Cost: 0 (global pause)
  DISPATCH_FIX: "dispatch_fix",           // Cost: high (review fix task)
});

// ── Situation → Intervention Mapping ────────────────────────────────────────

/**
 * Decision matrix: each situation maps to a sequence of interventions
 * that escalate as retry count increases.
 *
 * Format: [intervention_attempt_1, attempt_2, attempt_3, final_fallback]
 */
const INTERVENTION_LADDER = {
  [SITUATION.HEALTHY]:            [INTERVENTION.NONE],
  [SITUATION.IDLE_SOFT]:          [INTERVENTION.NONE, INTERVENTION.CONTINUE_SIGNAL],
  [SITUATION.IDLE_HARD]:          [INTERVENTION.CONTINUE_SIGNAL, INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.NO_HEARTBEAT]:       [INTERVENTION.CONTINUE_SIGNAL, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.REDISPATCH_TASK],
  [SITUATION.AGENT_DEAD]:         [INTERVENTION.REDISPATCH_TASK, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.NO_RESPONSE_AT_ALL]: [INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.REDISPATCH_TASK, INTERVENTION.BLOCK_AND_NOTIFY],

  [SITUATION.PLAN_STUCK]:         [INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.REDISPATCH_TASK, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.TOOL_LOOP]:          [INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.ERROR_LOOP]:         [INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.ANALYSIS_PARALYSIS]: [INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.REBASE_SPIRAL]:      [INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.THOUGHT_SPINNING]:   [INTERVENTION.CONTINUE_SIGNAL, INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD],
  [SITUATION.SELF_DEBUG_LOOP]:    [INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD],

  [SITUATION.BUILD_FAILURE]:      [INTERVENTION.INJECT_PROMPT, INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.TEST_FAILURE]:       [INTERVENTION.INJECT_PROMPT, INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.LINT_FAILURE]:       [INTERVENTION.INJECT_PROMPT, INTERVENTION.INJECT_PROMPT, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.GIT_CONFLICT]:       [INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.PUSH_FAILURE]:       [INTERVENTION.INJECT_PROMPT, INTERVENTION.INJECT_PROMPT, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.PRE_PUSH_FAILURE]:   [INTERVENTION.INJECT_PROMPT, INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.BLOCK_AND_NOTIFY],

  [SITUATION.RATE_LIMITED]:       [INTERVENTION.COOLDOWN, INTERVENTION.COOLDOWN, INTERVENTION.PAUSE_EXECUTOR],
  [SITUATION.API_ERROR]:          [INTERVENTION.COOLDOWN, INTERVENTION.COOLDOWN, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.TOKEN_OVERFLOW]:     [INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.SESSION_EXPIRED]:    [INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.MODEL_ERROR]:        [INTERVENTION.BLOCK_AND_NOTIFY],       // Not retryable — wrong model name
  [SITUATION.AUTH_FAILURE]:        [INTERVENTION.BLOCK_AND_NOTIFY],       // Not retryable — bad API key
  [SITUATION.CONTENT_POLICY]:      [INTERVENTION.BLOCK_AND_NOTIFY],       // Not retryable — safety filter
  [SITUATION.CODEX_SANDBOX]:       [INTERVENTION.INJECT_PROMPT, INTERVENTION.BLOCK_AND_NOTIFY], // Fix config, then block
  [SITUATION.INVALID_CONFIG]:      [INTERVENTION.BLOCK_AND_NOTIFY],       // Not retryable — fix config

  [SITUATION.FALSE_COMPLETION]:       [INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.NO_COMMITS]:             [INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.REDISPATCH_TASK, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.COMMITS_NOT_PUSHED]:     [INTERVENTION.INJECT_PROMPT, INTERVENTION.INJECT_PROMPT, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.PR_NOT_CREATED]:         [INTERVENTION.INJECT_PROMPT, INTERVENTION.INJECT_PROMPT, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.POOR_QUALITY]:           [INTERVENTION.DISPATCH_FIX, INTERVENTION.DISPATCH_FIX, INTERVENTION.BLOCK_AND_NOTIFY],

  [SITUATION.NEEDS_CLARIFICATION]:    [INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.BLOCK_AND_NOTIFY],
  [SITUATION.WAITING_FOR_INPUT]:      [INTERVENTION.INJECT_PROMPT, INTERVENTION.FORCE_NEW_THREAD, INTERVENTION.BLOCK_AND_NOTIFY],

  [SITUATION.EXECUTOR_OVERLOADED]:    [INTERVENTION.COOLDOWN],
  [SITUATION.RATE_LIMIT_FLOOD]:       [INTERVENTION.PAUSE_EXECUTOR],
};

// ── Recovery Prompts (zero AI inference needed) ─────────────────────────────

const RECOVERY_PROMPTS = {
  [SITUATION.PLAN_STUCK]: (ctx) =>
    `CRITICAL: You created a plan for "${ctx.taskTitle}" but stopped before implementing. ` +
    `This is autonomous execution — NO ONE will respond to "ready to implement?" questions. ` +
    `IMPLEMENT NOW: edit files, run tests, commit with conventional commits, and push. ` +
    `Do NOT create another plan. Do NOT ask for permission. Start coding immediately.`,

  [SITUATION.FALSE_COMPLETION]: (ctx) =>
    `Your previous attempt on "${ctx.taskTitle}" claimed completion but NO git commits were detected. ` +
    `The task is NOT complete. You must:\n` +
    `1. Make the actual code changes (edit files)\n` +
    `2. Run tests: go test ./...\n` +
    `3. Commit: git add -A && git commit -s -m "feat(scope): description"\n` +
    `4. Push: git push --set-upstream origin ${ctx.branch || "<branch>"}\n` +
    `Verify each step succeeded before claiming completion.`,

  [SITUATION.NO_COMMITS]: (ctx) =>
    `Task "${ctx.taskTitle}" completed ${ctx.attemptCount || 0} time(s) with zero commits. ` +
    `Check existing progress: git log --oneline -5 && git status\n` +
    `If changes exist but aren't committed, commit and push them.\n` +
    `If no changes exist, implement the task requirements fully before completing.`,

  [SITUATION.COMMITS_NOT_PUSHED]: (ctx) =>
    `You made commits for "${ctx.taskTitle}" but never pushed them. Run:\n` +
    `git push --set-upstream origin ${ctx.branch || "$(git branch --show-current)"}\n` +
    `If push fails due to pre-push hooks, fix the issues and push again.`,

  [SITUATION.PR_NOT_CREATED]: (ctx) =>
    `You pushed commits for "${ctx.taskTitle}" but no PR is visible yet.\n` +
    `Direct PR commands are disabled. Confirm the branch is pushed, then mark this run as ready for Bosun-managed PR lifecycle handoff.\n` +
    `Do not run direct PR-create commands.`,

  [SITUATION.TOOL_LOOP]: (ctx) =>
    `You've been repeating the same tools (${ctx.loopedTools || "unknown"}) without progress. ` +
    `STOP the current approach. Take a completely different strategy:\n` +
    `1. Summarize what you know\n2. Identify the actual blocker\n3. Try a different approach\n` +
    `4. Make incremental progress — edit one file, test it, commit it.`,

  [SITUATION.ERROR_LOOP]: (ctx) =>
    `You've hit the same error ${ctx.errorCount || 3}+ times: "${ctx.errorPattern || "unknown"}"\n` +
    `The current approach is NOT working. Do NOT retry the same thing.\n` +
    `1. Read the error carefully\n2. Identify the ROOT CAUSE (not just the symptom)\n` +
    `3. Fix the underlying issue, not just the error message\n4. Verify the fix before continuing.`,

  [SITUATION.ANALYSIS_PARALYSIS]: (ctx) =>
    `You've been reading ${ctx.readCount || "many"} files but haven't edited anything for "${ctx.taskTitle}". ` +
    `You have ENOUGH context — start implementing NOW:\n` +
    `1. Open the first file that needs changes\n2. Make the edit\n3. Test it\n` +
    `Don't try to understand everything first. Work incrementally.`,

  [SITUATION.NEEDS_CLARIFICATION]: () =>
    `This is AUTONOMOUS execution. Nobody will answer your questions. ` +
    `Make the best engineering judgment and proceed:\n` +
    `1. Choose the simplest correct approach\n2. Document assumptions in code comments\n` +
    `3. Implement, test, commit, push.`,

  [SITUATION.WAITING_FOR_INPUT]: () =>
    `You appear to be waiting for user input. This is a fully autonomous task. ` +
    `No human will respond. Make a decision and continue implementation immediately.`,

  [SITUATION.BUILD_FAILURE]: (ctx) =>
    `Build failed. Read the EXACT error output below and fix the root cause:\n` +
    `${(ctx.errorOutput || "").slice(0, 2000)}\n` +
    `Common fixes: missing imports, type mismatches, undefined references. ` +
    `Fix the error, then re-run the build to verify.`,

  [SITUATION.TEST_FAILURE]: (ctx) =>
    `Tests failed. Fix the IMPLEMENTATION (not the tests unless they have obvious bugs):\n` +
    `${(ctx.errorOutput || "").slice(0, 2000)}\n` +
    `Run the specific failing test to verify your fix before proceeding.`,

  [SITUATION.LINT_FAILURE]: (ctx) =>
    `Linting failed. Fix these specific issues:\n` +
    `${(ctx.errorOutput || "").slice(0, 2000)}\n` +
    `Common: unused variables, unchecked error returns, formatting. Apply minimal targeted fixes.`,

  [SITUATION.GIT_CONFLICT]: () =>
    `Git merge conflict detected. Resolve it:\n` +
    `1. git status — find conflicting files\n` +
    `2. Open each conflicting file, choose the correct code\n` +
    `3. Remove ALL conflict markers (<<<<<<, ======, >>>>>>)\n` +
    `4. git add <resolved-files> && git commit\n` +
    `Do NOT leave any conflict markers in the code.`,

  [SITUATION.PUSH_FAILURE]: (ctx) =>
    `git push failed. Common causes:\n` +
    `1. Pre-push hooks failed → fix lint/test/build errors and push again\n` +
    `2. Remote rejected → git pull --rebase origin main && resolve conflicts && push\n` +
    `3. Authentication → check git credentials\n` +
    `Error: ${(ctx.errorOutput || "").slice(0, 1000)}`,

  [SITUATION.PRE_PUSH_FAILURE]: (ctx) =>
    `Pre-push hook failed. This means your code has issues:\n` +
    `${(ctx.errorOutput || "").slice(0, 2000)}\n` +
    `Fix ALL errors (lint, vet, build, test), then push again. Do NOT use --no-verify.`,

  [SITUATION.REBASE_SPIRAL]: () =>
    `You're stuck in a rebase loop. STOP rebasing and try:\n` +
    `1. git rebase --abort\n` +
    `2. git checkout -B <your-branch> origin/main\n` +
    `3. Re-apply your changes manually\n` +
    `4. Commit and push`,

  [SITUATION.THOUGHT_SPINNING]: () =>
    `You've been reasoning without taking action. STOP thinking and START doing:\n` +
    `Open a file, make an edit, run a test. Action > Analysis.`,

  [SITUATION.SELF_DEBUG_LOOP]: () =>
    `You're debugging your own reasoning process. This is not productive.\n` +
    `Reset: What file needs to change? Make that change NOW.`,

  [SITUATION.TOKEN_OVERFLOW]: (ctx) =>
    `Context overflow on "${ctx.taskTitle}". Starting fresh session.\n\n` +
    `This happens when the conversation accumulates too much context (large files, ` +
    `many tool calls, long outputs). The previous session's work is preserved in git.\n\n` +
    `Recovery steps:\n` +
    `1. Run: git log --oneline -10 && git diff --stat\n` +
    `2. Check what's already been implemented\n` +
    `3. Continue from where the last session left off\n` +
    `4. Be more targeted — read only what you need, avoid dumping entire files\n\n` +
    `Do NOT restart from scratch. Do NOT re-read files you already processed.`,

  [SITUATION.POOR_QUALITY]: (ctx) =>
    `Review found critical issues in your implementation of "${ctx.taskTitle}":\n` +
    `${(ctx.reviewIssues || []).map(i => `• [${i.severity}] ${i.file}${i.line ? `:${i.line}` : ""} — ${i.description}`).join("\n")}\n\n` +
    `Fix ALL issues listed above. Do not introduce new problems. Test thoroughly before committing.`,

  [SITUATION.AUTH_FAILURE]: (ctx) =>
    `BLOCKED: API authentication failed for "${ctx.taskTitle}".\n` +
    `The API key is invalid, expired, or missing. This error will NOT resolve by retrying.\n\n` +
    `Check these environment variables:\n` +
    `• OPENAI_API_KEY — for Codex/OpenAI agents\n` +
    `• ANTHROPIC_API_KEY — for Claude agents\n` +
    `• GITHUB_TOKEN — for Copilot agents\n\n` +
    `Fix the configuration, then redispatch this task.`,

  [SITUATION.CONTENT_POLICY]: () =>
    `BLOCKED: Content policy or safety filter violation.\n` +
    `The request was rejected by the AI provider's safety system.\n` +
    `This is NOT retryable — the content must be reformulated.\n` +
    `A human needs to review and modify the task description or instructions.`,

  [SITUATION.CODEX_SANDBOX]: (ctx) =>
    `Codex sandbox/permission error on "${ctx.taskTitle}".\n` +
    `Check the following:\n` +
    `1. ~/.codex/config.toml has writable_roots for the workspace\n` +
    `2. If using bwrap, verify unprivileged user namespaces are enabled\n` +
    `3. Run: sysctl kernel.unprivileged_userns_clone (should be 1)\n` +
    `4. Or disable bwrap: CODEX_FEATURES_BWRAP=false in .env\n` +
    `Error: ${(ctx.errorOutput || "").slice(0, 1000)}`,

  [SITUATION.INVALID_CONFIG]: (ctx) =>
    `BLOCKED: Agent configuration is invalid for "${ctx.taskTitle}".\n` +
    `Run \`bosun --doctor\` to diagnose configuration issues.\n` +
    `Common problems: missing API keys, invalid model names, wrong endpoints.\n` +
    `Error: ${(ctx.errorOutput || "").slice(0, 500)}`,

  [SITUATION.MODEL_ERROR]: (ctx) =>
    `BLOCKED: Model not found or unavailable for "${ctx.taskTitle}".\n` +
    `The configured model name is invalid or deprecated.\n\n` +
    `Check these settings:\n` +
    `• COPILOT_MODEL, CLAUDE_MODEL, OPENAI_MODEL in .env\n` +
    `• Verify the model exists on the provider's dashboard\n` +
    `Error: ${(ctx.errorOutput || "").slice(0, 500)}`,
};

// ── Health Score Computation ────────────────────────────────────────────────

/**
 * Weights for each health signal. Higher = more important.
 * Score range: 0 (dead) to 100 (perfectly healthy).
 */
const HEALTH_WEIGHTS = {
  hasRecentEvents: 25,       // Agent produced events recently
  hasEditsOrCommits: 20,     // Agent made meaningful changes
  noErrorLoop: 15,           // Not repeating same error
  heartbeatAlive: 15,        // Heartbeat within threshold
  notInBadPattern: 15,       // Not in plan_stuck/tool_loop/etc
  progressIncreasing: 10,    // Event count growing over time
};

// ── AgentSupervisor Class ───────────────────────────────────────────────────

export class AgentSupervisor {
  /**
   * @param {object} opts
   * @param {object} [opts.sessionTracker]
   * @param {object} [opts.errorDetector]
   * @param {object} [opts.eventBus]
   * @param {object} [opts.anomalyDetector]
   * @param {object} [opts.workspaceMonitor]
   * @param {Function} [opts.sendTelegram]
   * @param {Function} [opts.getTask]
   * @param {Function} [opts.setTaskStatus]
   * @param {Function} [opts.sendContinueSignal]   — (taskId) => void
   * @param {Function} [opts.injectPrompt]          — (taskId, prompt) => void
   * @param {Function} [opts.forceNewThread]         — (taskId, reason) => void
   * @param {Function} [opts.redispatchTask]         — (taskId) => void
   * @param {Function} [opts.pauseExecutor]          — (durationMs, reason) => void
   * @param {Function} [opts.dispatchFixTask]        — (taskId, issues) => void
   * @param {object}   [opts.reviewAgent]
   */
  constructor(opts = {}) {
    this._sessionTracker = opts.sessionTracker || null;
    this._errorDetector = opts.errorDetector || null;
    this._eventBus = opts.eventBus || null;
    this._anomalyDetector = opts.anomalyDetector || null;
    this._workspaceMonitor = opts.workspaceMonitor || null;
    this._sendTelegram = opts.sendTelegram || null;
    this._getTask = opts.getTask || null;
    this._setTaskStatus = opts.setTaskStatus || null;
    this._reviewAgent = opts.reviewAgent || null;

    // ── Dispatch functions ──
    this._sendContinueSignal = opts.sendContinueSignal || null;
    this._injectPrompt = opts.injectPrompt || null;
    this._forceNewThread = opts.forceNewThread || null;
    this._redispatchTask = opts.redispatchTask || null;
    this._pauseExecutor = opts.pauseExecutor || null;
    this._dispatchFixTask = opts.dispatchFixTask || null;

    // ── Per-task state ──
    /** @type {Map<string, {situationHistory: Array<{situation:string,ts:number}>, interventionCount:number, lastIntervention:number, healthScores:number[], qualityScore:number|null, reviewVerdict:string|null, reviewIssues:Array|null}>} */
    this._taskState = new Map();

    /** @type {Map<string, {situation:string, intervention:string, ts:number}>} */
    this._lastDecision = new Map();

    /** @type {ReturnType<typeof setInterval>|null} */
    this._assessTimer = null;

    /** @type {number} assessment interval ms */
    this._assessIntervalMs = opts.assessIntervalMs || 30_000;

    /** @type {boolean} */
    this._started = false;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  start() {
    if (this._started) return;
    this._started = true;
    this._assessTimer = setInterval(
      () => this._assessAllAgents(),
      this._assessIntervalMs,
    );
    console.log(
      `${TAG} started (assess every ${this._assessIntervalMs / 1000}s)`,
    );
  }

  stop() {
    this._started = false;
    if (this._assessTimer) {
      clearInterval(this._assessTimer);
      this._assessTimer = null;
    }
    console.log(`${TAG} stopped`);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Assess a single task/agent and return the diagnosis + recommended action.
   * This is the main entry point — called periodically and on events.
   *
   * @param {string} taskId
   * @param {object} [context] — additional context (output, error, etc.)
   * @returns {{ situation: string, healthScore: number, intervention: string, prompt: string|null, reason: string }}
   */
  assess(taskId, context = {}) {
    const state = this._ensureTaskState(taskId);
    const signals = this._gatherSignals(taskId, context);
    const situation = this._diagnose(signals, context);
    const healthScore = this._computeHealthScore(signals);
    const attemptIndex = Math.min(
      state.interventionCount,
      (INTERVENTION_LADDER[situation] || [INTERVENTION.NONE]).length - 1,
    );
    const intervention = (INTERVENTION_LADDER[situation] || [INTERVENTION.NONE])[attemptIndex];
    const prompt = this._buildPrompt(situation, taskId, context);
    const reason = this._buildReason(situation, signals, context);

    // Record
    state.situationHistory.push({ situation, ts: Date.now() });
    if (state.situationHistory.length > 50) state.situationHistory.shift();
    state.healthScores.push(healthScore);
    if (state.healthScores.length > 20) state.healthScores.shift();

    // Only count as intervention if we're actually doing something
    if (intervention !== INTERVENTION.NONE) {
      state.interventionCount++;
      state.lastIntervention = Date.now();
    }

    this._lastDecision.set(taskId, { situation, intervention, ts: Date.now() });

    return { situation, healthScore, intervention, prompt, reason };
  }

  /**
   * Execute the intervention decided by assess().
   * @param {string} taskId
   * @param {{ intervention: string, prompt: string|null, reason: string, situation: string }} decision
   */
  async intervene(taskId, decision) {
    const { intervention, prompt, reason, situation } = decision;
    console.log(
      `${TAG} intervening on ${taskId}: ${situation} → ${intervention} (reason: ${reason})`,
    );

    try {
      switch (intervention) {
        case INTERVENTION.NONE:
          break;

        case INTERVENTION.CONTINUE_SIGNAL:
          if (this._sendContinueSignal) {
            this._sendContinueSignal(taskId);
          }
          break;

        case INTERVENTION.INJECT_PROMPT:
          if (this._injectPrompt && prompt) {
            this._injectPrompt(taskId, prompt);
          }
          break;

        case INTERVENTION.FORCE_NEW_THREAD:
          if (this._forceNewThread) {
            this._forceNewThread(taskId, reason);
          }
          break;

        case INTERVENTION.REDISPATCH_TASK:
          if (this._redispatchTask) {
            this._redispatchTask(taskId);
          }
          break;

        case INTERVENTION.BLOCK_AND_NOTIFY: {
          if (this._setTaskStatus) {
            try {
              this._setTaskStatus(taskId, "blocked", "supervisor");
            } catch { /* best-effort */ }
          }
          const task = this._resolveTask(taskId);
          const title = task?.title || taskId;
          const state = this._ensureTaskState(taskId);
          if (this._sendTelegram) {
            this._sendTelegram(
              `🛑 Supervisor blocked "${title}": ${reason}\n` +
              `Situation: ${situation}, Interventions attempted: ${state.interventionCount}`,
            );
          }
          break;
        }

        case INTERVENTION.COOLDOWN: {
          // Cooldown is handled by the event bus / executor;
          // we just log it here
          console.log(`${TAG} cooldown requested for ${taskId}: ${reason}`);
          break;
        }

        case INTERVENTION.PAUSE_EXECUTOR:
          if (this._pauseExecutor) {
            this._pauseExecutor(5 * 60_000, reason);
          }
          if (this._sendTelegram) {
            this._sendTelegram(`⏸️ Executor paused by supervisor: ${reason}`);
          }
          break;

        case INTERVENTION.DISPATCH_FIX: {
          const state = this._getTaskState(taskId);
          if (this._dispatchFixTask && state?.reviewIssues?.length) {
            this._dispatchFixTask(taskId, state.reviewIssues);
          } else if (this._injectPrompt && prompt) {
            // Fallback: inject fix prompt into current session
            this._injectPrompt(taskId, prompt);
          }
          break;
        }
      }
    } catch (err) {
      console.error(`${TAG} intervention failed for ${taskId}:`, err.message || err);
    }

    // Broadcast decision to event bus
    if (this._eventBus) {
      this._eventBus.emit("agent:supervisor-intervention", taskId, {
        situation,
        intervention,
        reason,
        hasPrompt: !!prompt,
      });
    }
  }

  /**
   * Assess and immediately intervene.
   * @param {string} taskId
   * @param {object} [context]
   */
  async assessAndIntervene(taskId, context = {}) {
    const decision = this.assess(taskId, context);
    if (decision.intervention !== INTERVENTION.NONE) {
      await this.intervene(taskId, decision);
    }
    return decision;
  }

  // ── Review Enforcement ──────────────────────────────────────────────────

  /**
   * Record a review verdict for a task.
   * If rejected, auto-dispatches a fix task or blocks.
   *
   * @param {string} taskId
   * @param {{ approved: boolean, issues: Array, summary: string }} result
   */
  async onReviewComplete(taskId, result) {
    const state = this._ensureTaskState(taskId);
    state.reviewVerdict = result.approved ? "approved" : "changes_requested";
    state.reviewIssues = result.issues || [];

    if (result.approved) {
      state.qualityScore = Math.max(state.qualityScore || 0, 80);
      console.log(`${TAG} review approved for ${taskId}`);
      return;
    }

    // Review rejected — assess quality and decide action
    const criticalCount = result.issues.filter(
      (i) => i.severity === "critical",
    ).length;
    const majorCount = result.issues.filter(
      (i) => i.severity === "major",
    ).length;

    state.qualityScore = Math.max(0, 100 - criticalCount * 30 - majorCount * 15);

    console.warn(
      `${TAG} review REJECTED for ${taskId}: ${criticalCount} critical, ${majorCount} major issues (quality: ${state.qualityScore})`,
    );

    // Auto-dispatch fix if issues are fixable
    if (criticalCount > 0 || majorCount > 0) {
      const decision = this.assess(taskId, {
        reviewResult: result,
        situation: SITUATION.POOR_QUALITY,
      });
      await this.intervene(taskId, decision);
    }
  }

  /**
   * Check if a task is allowed to be marked as complete.
   * Returns false if review is pending or rejected.
   *
   * @param {string} taskId
   * @returns {{ allowed: boolean, reason: string }}
   */
  canComplete(taskId) {
    const state = this._getTaskState(taskId);
    if (!state) return { allowed: true, reason: "No state tracked" };

    if (state.reviewVerdict === "changes_requested") {
      return {
        allowed: false,
        reason: `Review rejected: ${state.reviewIssues?.length || 0} issue(s) need fixing`,
      };
    }

    return { allowed: true, reason: "OK" };
  }

  // ── Post-Completion Verification ────────────────────────────────────────

  /**
   * Verify a task that claims to be complete.
   * Checks: commits exist, pushed, PR created, tests pass.
   *
   * @param {string} taskId
   * @param {object} completionData — { hasCommits, branch, prUrl, prNumber, output }
   * @returns {{ situation: string, issues: string[] }}
   */
  verifyCompletion(taskId, completionData = {}) {
    const issues = [];
    let situation = SITUATION.HEALTHY;

    if (!completionData.hasCommits) {
      issues.push("No commits detected");
      situation = SITUATION.NO_COMMITS;
    }

    if (completionData.hasCommits && !completionData.prUrl && !completionData.prNumber) {
      // Commits exist but no PR — check if pushed
      issues.push("No PR created");
      situation = issues.includes("No commits detected")
        ? SITUATION.NO_COMMITS
        : SITUATION.PR_NOT_CREATED;
    }

    // Check output for false completion markers
    const output = (completionData.output || "").toLowerCase();
    const planStuckPhrases = [
      "ready to implement",
      "would you like me to",
      "shall i start",
      "here's the plan",
      "here is my plan",
    ];
    if (planStuckPhrases.some((p) => output.includes(p))) {
      issues.push("Output contains planning phrases — likely did not implement");
      situation = SITUATION.PLAN_STUCK;
    }

    // Check for common false completion phrases without evidence
    if (
      !completionData.hasCommits &&
      /task (is )?complete|all done|successfully completed/i.test(output)
    ) {
      issues.push("Claims completion but no commits");
      situation = SITUATION.FALSE_COMPLETION;
    }

    return { situation, issues };
  }

  // ── Query API ───────────────────────────────────────────────────────────

  /**
   * Get full supervisor state for a task.
   * @param {string} taskId
   * @returns {object|null}
   */
  getTaskDiagnostics(taskId) {
    const state = this._getTaskState(taskId);
    if (!state) return null;

    const lastDecision = this._lastDecision.get(taskId) || null;
    const avgHealth = state.healthScores.length > 0
      ? Math.round(state.healthScores.reduce((a, b) => a + b, 0) / state.healthScores.length)
      : null;

    return {
      taskId,
      interventionCount: state.interventionCount,
      lastIntervention: state.lastIntervention,
      lastDecision,
      averageHealthScore: avgHealth,
      currentHealthScore: state.healthScores[state.healthScores.length - 1] || null,
      qualityScore: state.qualityScore,
      reviewVerdict: state.reviewVerdict,
      reviewIssueCount: state.reviewIssues?.length || 0,
      recentSituations: state.situationHistory.slice(-10),
    };
  }

  /**
   * Get diagnostics for ALL tracked tasks.
   * @returns {Array}
   */
  getAllDiagnostics() {
    const result = [];
    for (const taskId of this._taskState.keys()) {
      result.push(this.getTaskDiagnostics(taskId));
    }
    return result;
  }

  /**
   * Get the current overall system health.
   * @returns {object}
   */
  getSystemHealth() {
    let totalHealth = 0;
    let taskCount = 0;
    let blockedCount = 0;
    let activeInterventions = 0;

    for (const [, state] of this._taskState) {
      taskCount++;
      const lastScore = state.healthScores[state.healthScores.length - 1];
      if (typeof lastScore === "number") totalHealth += lastScore;
      if (state.situationHistory.length > 0) {
        const last = state.situationHistory[state.situationHistory.length - 1];
        if (last.situation === SITUATION.AGENT_DEAD || last.situation === SITUATION.NO_RESPONSE_AT_ALL) {
          blockedCount++;
        }
      }
      if (state.interventionCount > 0 && Date.now() - state.lastIntervention < 300_000) {
        activeInterventions++;
      }
    }

    return {
      started: this._started,
      trackedTasks: taskCount,
      averageHealth: taskCount > 0 ? Math.round(totalHealth / taskCount) : 100,
      blockedTasks: blockedCount,
      activeInterventions,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INTERNAL
  // ══════════════════════════════════════════════════════════════════════════

  _ensureTaskState(taskId) {
    if (!this._taskState.has(taskId)) {
      this._taskState.set(taskId, {
        situationHistory: [],
        interventionCount: 0,
        lastIntervention: 0,
        healthScores: [],
        qualityScore: null,
        reviewVerdict: null,
        reviewIssues: null,
      });
    }
    return this._taskState.get(taskId);
  }

  _getTaskState(taskId) {
    return this._taskState.get(taskId) || null;
  }

  /**
   * Gather all health signals from all subsystems for a task.
   * @param {string} taskId
   * @param {object} context
   * @returns {object}
   */
  _gatherSignals(taskId, context) {
    const signals = {
      // Session tracker signals
      sessionProgress: null,
      sessionMessages: null,
      sessionAnalysis: null,

      // Event bus signals
      heartbeatAlive: null,
      lastHeartbeat: null,
      errorPatterns: null,
      recentEvents: null,

      // Anomaly signals
      activeAnomalies: null,

      // Workspace signals
      gitState: null,
      isStuck: null,

      // Context-provided signals
      output: context.output || null,
      error: context.error || null,
      hasCommits: context.hasCommits ?? null,
      branch: context.branch || null,
      prUrl: context.prUrl || null,
    };

    // ── Session tracker ──
    if (this._sessionTracker) {
      try {
        signals.sessionProgress = this._sessionTracker.getProgressStatus(taskId);
        signals.sessionMessages = this._sessionTracker.getLastMessages(taskId);
      } catch { /* subsystem not ready */ }
    }

    // ── Error detector (behavioral analysis) ──
    if (this._errorDetector && signals.sessionMessages?.length) {
      try {
        signals.sessionAnalysis = this._errorDetector.analyzeMessageSequence(
          signals.sessionMessages,
        );
      } catch { /* subsystem not ready */ }
    }

    // ── Event bus ──
    if (this._eventBus) {
      try {
        const liveness = this._eventBus.getAgentLiveness();
        const agentEntry = liveness.find((a) => a.taskId === taskId);
        if (agentEntry) {
          signals.heartbeatAlive = agentEntry.alive;
          signals.lastHeartbeat = agentEntry.lastHeartbeat;
        }
        signals.errorPatterns = this._eventBus.getErrorHistory(taskId);
        signals.recentEvents = this._eventBus.getEventLog({ taskId, limit: 10 });
      } catch { /* subsystem not ready */ }
    }

    // ── Anomaly detector ──
    if (this._anomalyDetector) {
      try {
        if (typeof this._anomalyDetector.getActiveAnomalies === "function") {
          signals.activeAnomalies = this._anomalyDetector.getActiveAnomalies(taskId);
        }
      } catch { /* subsystem not ready */ }
    }

    // ── Workspace monitor ──
    if (this._workspaceMonitor) {
      try {
        if (typeof this._workspaceMonitor.getGitState === "function") {
          signals.gitState = this._workspaceMonitor.getGitState(taskId);
        }
        if (typeof this._workspaceMonitor.isStuck === "function") {
          signals.isStuck = this._workspaceMonitor.isStuck(taskId);
        }
      } catch { /* subsystem not ready */ }
    }

    return signals;
  }

  /**
   * Diagnose the situation based on gathered signals.
   * Priority order: most specific/actionable wins.
   *
   * @param {object} signals
   * @param {object} context
   * @returns {string} SITUATION enum value
   */
  _diagnose(signals, context) {
    // ── Override from context (caller knows the situation) ──
    if (context.situation && Object.values(SITUATION).includes(context.situation)) {
      return context.situation;
    }

    const progress = signals.sessionProgress;
    const analysis = signals.sessionAnalysis;
    const anomalies = signals.activeAnomalies || [];

    // ── Agent completely dead ──
    if (
      progress &&
      progress.totalEvents === 0 &&
      progress.elapsedMs > 5 * 60_000
    ) {
      return SITUATION.NO_RESPONSE_AT_ALL;
    }

    // ── External errors (check first — these aren't the agent's fault) ──
    if (context.error || signals.error) {
      const errText = context.error || signals.error || "";
      if (/429|rate.?limit|too many requests|quota exceeded/i.test(errText)) {
        // Check for flood
        if (signals.errorPatterns?.length >= 3) {
          const recent = signals.errorPatterns.slice(-5);
          const rateLimitCount = recent.filter((e) => e.pattern === "rate_limit").length;
          if (rateLimitCount >= 3) return SITUATION.RATE_LIMIT_FLOOD;
        }
        return SITUATION.RATE_LIMITED;
      }
      if (/ECONNREFUSED|ETIMEDOUT|500|502|503|fetch failed/i.test(errText)) {
        return SITUATION.API_ERROR;
      }
      if (/context.*(too long|exceeded|overflow)|max.*token/i.test(errText) ||
          /context_length_exceeded|prompt_too_long|prompt.*too.*long/i.test(errText) ||
          /This model's maximum context length/i.test(errText) ||
          /token_budget.*exceeded|token.*budget/i.test(errText) ||
          /turn_limit_reached|conversation.*too.*long/i.test(errText) ||
          /string_above_max_length|maximum.*number.*tokens/i.test(errText)) {
        return SITUATION.TOKEN_OVERFLOW;
      }
      if (/model.*not.*supported|model.*error|invalid.*model|model.*not.*found|model.*deprecated/i.test(errText)) {
        return SITUATION.MODEL_ERROR;
      }
      // ── Auth failures — MUST come BEFORE session_expired (which has 'unauthorized')
      if (/invalid.?api.?key|authentication_error|permission_error/i.test(errText) ||
          /401 Unauthorized|403 Forbidden/i.test(errText) ||
          /billing_hard_limit|insufficient_quota/i.test(errText) ||
          /invalid.*credentials|access.?denied|not.?authorized/i.test(errText)) {
        return SITUATION.AUTH_FAILURE;
      }
      // ── Session expired (after auth check since 'unauthorized' overlaps)
      if (/session.*expired|thread.*not.*found/i.test(errText) ||
          /invalid.*session|invalid.*token/i.test(errText)) {
        return SITUATION.SESSION_EXPIRED;
      }
      // ── Content policy (safety filter)
      if (/content_policy|content.?filter|safety_system|safety.*filter/i.test(errText) ||
          /flagged.*content|output.*blocked|response.*blocked/i.test(errText)) {
        return SITUATION.CONTENT_POLICY;
      }
      // ── Codex sandbox/CLI errors
      if (/sandbox.*fail|bwrap.*error|bubblewrap/i.test(errText) ||
          /EPERM.*operation.*not.*permitted/i.test(errText) ||
          /writable_roots|namespace.*error/i.test(errText) ||
          /codex.*(segfault|killed|crash)/i.test(errText)) {
        return SITUATION.CODEX_SANDBOX;
      }
      // ── Invalid config (catch-all for config-related errors)
      if (/config.*invalid|config.*missing|misconfigured/i.test(errText) ||
          /OPENAI_API_KEY.*not.*set|ANTHROPIC_API_KEY.*not.*set/i.test(errText)) {
        return SITUATION.INVALID_CONFIG;
      }
    }

    // ── Anomaly detector signals ──
    for (const anomaly of anomalies) {
      if (anomaly.type === "REBASE_SPIRAL") return SITUATION.REBASE_SPIRAL;
      if (anomaly.type === "THOUGHT_SPINNING") return SITUATION.THOUGHT_SPINNING;
      if (anomaly.type === "SELF_DEBUG_LOOP") return SITUATION.SELF_DEBUG_LOOP;
      if (anomaly.type === "TOOL_CALL_LOOP") return SITUATION.TOOL_LOOP;
      if (anomaly.type === "REPEATED_ERROR") return SITUATION.ERROR_LOOP;
    }

    // ── Session behavioral analysis ──
    if (analysis?.primary) {
      const analysisMap = {
        plan_stuck: SITUATION.PLAN_STUCK,
        tool_loop: SITUATION.TOOL_LOOP,
        analysis_paralysis: SITUATION.ANALYSIS_PARALYSIS,
        needs_clarification: SITUATION.NEEDS_CLARIFICATION,
        false_completion: SITUATION.FALSE_COMPLETION,
        rate_limited: SITUATION.RATE_LIMITED,
      };
      if (analysisMap[analysis.primary]) return analysisMap[analysis.primary];
    }

    // ── Error loop detection (3+ same pattern in recent history) ──
    if (signals.errorPatterns?.length >= 3) {
      const recent = signals.errorPatterns.slice(-5);
      const counts = {};
      for (const e of recent) counts[e.pattern] = (counts[e.pattern] || 0) + 1;
      for (const [pattern, count] of Object.entries(counts)) {
        if (count >= 3) {
          // Map error pattern to specific situation
          if (pattern === "build_failure") return SITUATION.BUILD_FAILURE;
          if (pattern === "git_conflict") return SITUATION.GIT_CONFLICT;
          if (pattern === "plan_stuck") return SITUATION.PLAN_STUCK;
          return SITUATION.ERROR_LOOP;
        }
      }
    }

    // ── Build/test/lint failures from context ──
    if (context.error) {
      const err = context.error.toLowerCase();
      if (/pre-push hook.*fail/i.test(err)) return SITUATION.PRE_PUSH_FAILURE;
      if (/git push.*fail|rejected.*push/i.test(err)) return SITUATION.PUSH_FAILURE;
      if (/go build.*fail|compilation error|cannot find/i.test(err)) return SITUATION.BUILD_FAILURE;
      if (/FAIL\s+\S+|test.*fail/i.test(err)) return SITUATION.TEST_FAILURE;
      if (/golangci-lint|lint.*error/i.test(err)) return SITUATION.LINT_FAILURE;
      if (/merge conflict|CONFLICT/i.test(err)) return SITUATION.GIT_CONFLICT;
    }

    // ── Completion issues ──
    if (context.hasCommits === false && context.output) {
      return SITUATION.NO_COMMITS;
    }
    if (context.hasCommits && !context.prUrl && !context.prNumber) {
      // Has commits but no PR
      const isPushed = context.isPushed ?? true; // assume pushed unless told otherwise
      if (!isPushed) return SITUATION.COMMITS_NOT_PUSHED;
      return SITUATION.PR_NOT_CREATED;
    }

    // ── Review quality ──
    if (context.reviewResult && !context.reviewResult.approved) {
      return SITUATION.POOR_QUALITY;
    }

    // ── Liveness / idle ──
    if (signals.heartbeatAlive === false) {
      return SITUATION.NO_HEARTBEAT;
    }

    if (progress) {
      if (progress.idleMs > 5 * 60_000) return SITUATION.IDLE_HARD;
      if (progress.idleMs > 2 * 60_000) return SITUATION.IDLE_SOFT;
    }

    // ── Git-level stuck ──
    if (signals.isStuck) {
      return SITUATION.IDLE_HARD;
    }

    return SITUATION.HEALTHY;
  }

  /**
   * Compute a health score from 0-100 based on signals.
   * @param {object} signals
   * @returns {number}
   */
  _computeHealthScore(signals) {
    let score = 0;
    const progress = signals.sessionProgress;

    // Has recent events (within last 3 min)
    if (progress && progress.idleMs < 3 * 60_000 && progress.totalEvents > 0) {
      score += HEALTH_WEIGHTS.hasRecentEvents;
    } else if (progress && progress.totalEvents > 0 && progress.idleMs < 5 * 60_000) {
      score += HEALTH_WEIGHTS.hasRecentEvents * 0.5;
    }

    // Has edits or commits
    if (progress?.hasCommits) {
      score += HEALTH_WEIGHTS.hasEditsOrCommits;
    } else if (progress?.hasEdits) {
      score += HEALTH_WEIGHTS.hasEditsOrCommits * 0.7;
    }

    // No error loop
    const errorPatterns = signals.errorPatterns || [];
    const recentErrors = errorPatterns.slice(-5);
    const hasSameErrorLoop = recentErrors.length >= 3 &&
      new Set(recentErrors.map((e) => e.pattern)).size === 1;
    if (!hasSameErrorLoop) {
      score += HEALTH_WEIGHTS.noErrorLoop;
    }

    // Heartbeat alive
    if (signals.heartbeatAlive === true || signals.heartbeatAlive === null) {
      score += HEALTH_WEIGHTS.heartbeatAlive;
    }

    // Not in bad behavioral pattern
    const analysis = signals.sessionAnalysis;
    const badPatterns = ["plan_stuck", "tool_loop", "analysis_paralysis", "false_completion"];
    if (!analysis?.primary || !badPatterns.includes(analysis.primary)) {
      score += HEALTH_WEIGHTS.notInBadPattern;
    }

    // Progress increasing (more events over time)
    if (
      progress &&
      progress.totalEvents > 5 &&
      progress.elapsedMs > 60_000
    ) {
      const eventsPerMin = progress.totalEvents / (progress.elapsedMs / 60_000);
      if (eventsPerMin > 0.5) {
        score += HEALTH_WEIGHTS.progressIncreasing;
      } else if (eventsPerMin > 0.1) {
        score += HEALTH_WEIGHTS.progressIncreasing * 0.5;
      }
    }

    return Math.round(Math.max(0, Math.min(100, score)));
  }

  /**
   * Build a recovery prompt for the given situation. Returns null if no prompt needed.
   * @param {string} situation
   * @param {string} taskId
   * @param {object} context
   * @returns {string|null}
   */
  _buildPrompt(situation, taskId, context) {
    const promptFn = RECOVERY_PROMPTS[situation];
    if (!promptFn) return null;

    const task = this._resolveTask(taskId);
    const state = this._getTaskState(taskId);

    return promptFn({
      taskTitle: task?.title || context.taskTitle || taskId,
      taskId,
      branch: context.branch || task?.branchName || task?.meta?.branch_name,
      attemptCount: state?.interventionCount || 0,
      errorOutput: context.error || context.output || "",
      errorPattern: context.errorPattern || null,
      errorCount: state?.situationHistory.filter(
        (s) => s.situation === situation,
      ).length || 0,
      loopedTools: context.loopedTools || null,
      readCount: context.readCount || null,
      reviewIssues: state?.reviewIssues || [],
    });
  }

  /**
   * Build a human-readable reason string.
   * @param {string} situation
   * @param {object} signals
   * @param {object} context
   * @returns {string}
   */
  _buildReason(situation, signals, context) {
    const progress = signals.sessionProgress;
    const parts = [situation];

    if (progress) {
      parts.push(`idle ${Math.round((progress.idleMs || 0) / 1000)}s`);
      parts.push(`${progress.totalEvents || 0} events`);
      if (progress.hasCommits) parts.push("has-commits");
      else if (progress.hasEdits) parts.push("has-edits");
    }

    if (context.error) {
      parts.push(`err: ${(context.error).slice(0, 60)}`);
    }

    return parts.join(" | ");
  }

  /**
   * Periodic assessment of all active agents.
   * Called by the internal timer.
   */
  _assessAllAgents() {
    if (!this._sessionTracker) return;

    try {
      const sessions = this._sessionTracker.getAllSessions
        ? this._sessionTracker.getAllSessions()
        : [];

      for (const session of sessions) {
        if (session.status !== "active") continue;
        const taskId = session.taskId;
        if (!taskId) continue;

        // Don't re-assess within 10s of last intervention
        const state = this._getTaskState(taskId);
        if (state && Date.now() - state.lastIntervention < 10_000) continue;

        const decision = this.assess(taskId);

        // Only intervene for serious situations (not soft idle)
        if (
          decision.intervention !== INTERVENTION.NONE &&
          decision.situation !== SITUATION.IDLE_SOFT
        ) {
          this.intervene(taskId, decision).catch((err) => {
            console.error(`${TAG} periodic intervention failed for ${taskId}:`, err.message);
          });
        }
      }
    } catch (err) {
      console.error(`${TAG} periodic assessment error:`, err.message || err);
    }
  }

  _resolveTask(taskId) {
    if (!this._getTask) return null;
    try {
      return this._getTask(taskId) || null;
    } catch {
      return null;
    }
  }

  /**
   * Reset all state for a task (call when task starts fresh).
   * @param {string} taskId
   */
  resetTask(taskId) {
    this._taskState.delete(taskId);
    this._lastDecision.delete(taskId);
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an AgentSupervisor instance.
 * @param {object} [opts] — Same as AgentSupervisor constructor
 * @returns {AgentSupervisor}
 */
export function createAgentSupervisor(opts) {
  return new AgentSupervisor(opts);
}
