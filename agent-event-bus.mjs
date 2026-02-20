/**
 * agent-event-bus.mjs — Real-time agent lifecycle event bus
 *
 * Bridges agent-endpoint self-reports, task-executor callbacks,
 * error-detector classifications, and agent-hooks results into a
 * single unified event stream that:
 *
 *   1. Pushes to WebSocket clients for instant UI updates (zero-polling)
 *   2. Triggers auto-actions (retry, review, cooldown, block)
 *   3. Maintains a queryable in-memory event log with error pattern tracking
 *   4. Monitors agent liveness via heartbeat staleness detection
 *   5. Provides hooks for external subscribers (Telegram, logging, etc.)
 *
 * This module is the "nervous system" connecting the back-end orchestrator
 * to the front-end UI in real time with no polling latency.
 *
 * EXPORTS:
 *   createAgentEventBus(options) → AgentEventBus instance
 *   AgentEventBus class
 *   AGENT_EVENT  — Frozen enum of all event types
 */

const TAG = "[agent-event-bus]";

// ── Event Types ─────────────────────────────────────────────────────────────

/**
 * All possible agent lifecycle event types.
 * These map 1:1 to WS message types the UI listens for.
 */
export const AGENT_EVENT = Object.freeze({
  // ── Task lifecycle ──
  TASK_QUEUED: "agent:task-queued",
  TASK_STARTED: "agent:task-started",
  TASK_COMPLETED: "agent:task-completed",
  TASK_FAILED: "agent:task-failed",
  TASK_BLOCKED: "agent:task-blocked",
  TASK_STATUS_CHANGE: "agent:task-status-change",

  // ── Agent self-reports (from agent-endpoint) ──
  AGENT_HEARTBEAT: "agent:heartbeat",
  AGENT_COMPLETE: "agent:complete",
  AGENT_ERROR: "agent:error",

  // ── Auto-actions ──
  AUTO_RETRY: "agent:auto-retry",
  AUTO_REVIEW: "agent:auto-review",
  AUTO_COOLDOWN: "agent:auto-cooldown",
  AUTO_BLOCK: "agent:auto-block",
  AUTO_NEW_SESSION: "agent:auto-new-session",
  EXECUTOR_PAUSED: "agent:executor-paused",
  EXECUTOR_RESUMED: "agent:executor-resumed",

  // ── Error tracking ──
  ERROR_CLASSIFIED: "agent:error-classified",
  ERROR_PATTERN_DETECTED: "agent:error-pattern-detected",
  ERROR_THRESHOLD_REACHED: "agent:error-threshold-reached",

  // ── Liveness ──
  AGENT_ALIVE: "agent:alive",
  AGENT_STALE: "agent:stale",

  // ── Hook results (from agent-hooks.mjs) ──
  HOOK_PASSED: "agent:hook-passed",
  HOOK_FAILED: "agent:hook-failed",
});

// ── Default config ──────────────────────────────────────────────────────────

const DEFAULTS = {
  /** Max events kept in the in-memory ring buffer */
  maxEventLogSize: 500,
  /** Heartbeat staleness threshold (ms) — if no heartbeat for this long, emit AGENT_STALE */
  staleThresholdMs: 90_000,
  /** How often to check for stale agents (ms) */
  staleCheckIntervalMs: 30_000,
  /** Max error pattern history per task */
  maxErrorPatternsPerTask: 50,
  /** Cooldown between duplicate event broadcasts (ms) — prevents event storms */
  dedupeWindowMs: 500,
  /** Max auto-action retries before blocking */
  maxAutoRetries: 5,
};

// ── AgentEventBus Class ─────────────────────────────────────────────────────

export class AgentEventBus {
  /**
   * @param {object} options
   * @param {Function} [options.broadcastUiEvent]     — (channels, type, payload) => void
   * @param {object}   [options.errorDetector]        — ErrorDetector instance
   * @param {object}   [options.reviewAgent]          — ReviewAgent instance
   * @param {Function} [options.sendTelegram]         — (msg) => void
   * @param {Function} [options.getTask]              — (taskId) => task object
   * @param {Function} [options.setTaskStatus]        — (taskId, status, source) => void
   * @param {number}   [options.maxEventLogSize]
   * @param {number}   [options.staleThresholdMs]
   * @param {number}   [options.staleCheckIntervalMs]
   * @param {number}   [options.maxAutoRetries]
   */
  constructor(options = {}) {
    this._broadcastUiEvent = options.broadcastUiEvent || null;
    this._errorDetector = options.errorDetector || null;
    this._reviewAgent = options.reviewAgent || null;
    this._sendTelegram = options.sendTelegram || null;
    this._getTask = options.getTask || null;
    this._setTaskStatus = options.setTaskStatus || null;

    this._maxEventLogSize = options.maxEventLogSize || DEFAULTS.maxEventLogSize;
    this._staleThresholdMs =
      options.staleThresholdMs || DEFAULTS.staleThresholdMs;
    this._staleCheckIntervalMs =
      options.staleCheckIntervalMs || DEFAULTS.staleCheckIntervalMs;
    this._maxAutoRetries =
      options.maxAutoRetries ?? DEFAULTS.maxAutoRetries;

    /** @type {Array<{type: string, taskId: string, payload: object, ts: number}>} ring buffer */
    this._eventLog = [];

    /** @type {Map<string, number>} taskId → last heartbeat timestamp */
    this._heartbeats = new Map();

    /** @type {Map<string, Array<{pattern:string, ts:number, action:string, confidence:number}>>} */
    this._errorHistory = new Map();

    /** @type {Map<string, {retryCount:number, lastRetryAt:number, cooldownUntil:number}>} */
    this._autoActionState = new Map();

    /** @type {Set<Function>} external listeners */
    this._listeners = new Set();

    /** @type {Map<string, number>} dedup key → last emit timestamp */
    this._recentEmits = new Map();

    /** @type {ReturnType<typeof setInterval>|null} */
    this._staleCheckTimer = null;

    /** @type {boolean} */
    this._started = false;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  start() {
    if (this._started) return;
    this._started = true;
    this._staleCheckTimer = setInterval(
      () => this._checkStaleAgents(),
      this._staleCheckIntervalMs,
    );
    console.log(
      `${TAG} started (stale-check=${this._staleCheckIntervalMs}ms, log-cap=${this._maxEventLogSize})`,
    );
  }

  stop() {
    this._started = false;
    if (this._staleCheckTimer) {
      clearInterval(this._staleCheckTimer);
      this._staleCheckTimer = null;
    }
    console.log(`${TAG} stopped`);
  }

  // ── External Listener API ──────────────────────────────────────────────

  /**
   * Register a listener for all agent events.
   * @param {(event: {type:string,taskId:string,payload:object,ts:number}) => void} fn
   * @returns {() => void} unsubscribe
   */
  addListener(fn) {
    if (typeof fn !== "function") return () => {};
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // ── Core Emit ──────────────────────────────────────────────────────────

  /**
   * Emit an agent lifecycle event.
   *
   * @param {string} type    — One of AGENT_EVENT values
   * @param {string} taskId
   * @param {object} payload
   * @param {object} [opts]
   * @param {boolean} [opts.skipBroadcast]
   */
  emit(type, taskId, payload = {}, opts = {}) {
    const ts = Date.now();
    const event = { type, taskId, payload, ts };

    // ── Dedup
    const key = `${type}:${taskId}`;
    const last = this._recentEmits.get(key) || 0;
    if (ts - last < DEFAULTS.dedupeWindowMs) return;
    this._recentEmits.set(key, ts);
    if (this._recentEmits.size > 200) {
      const cutoff = ts - DEFAULTS.dedupeWindowMs * 2;
      for (const [k, v] of this._recentEmits) {
        if (v < cutoff) this._recentEmits.delete(k);
      }
    }

    // ── Ring buffer
    this._eventLog.push(event);
    if (this._eventLog.length > this._maxEventLogSize) {
      this._eventLog.shift();
    }

    // ── WS broadcast
    if (!opts.skipBroadcast) {
      this._broadcastToUi(event);
    }

    // ── External listeners
    for (const fn of this._listeners) {
      try {
        fn(event);
      } catch (err) {
        console.warn(`${TAG} listener error:`, err.message || err);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  HOOK METHODS — called from monitor.mjs / agent-endpoint callbacks
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Task started by executor.
   * @param {object} task
   * @param {object} slot — { sdk, agentInstanceId, branch, worktreePath }
   */
  onTaskStarted(task, slot) {
    const taskId = task?.id || task?.task_id || "unknown";
    this.emit(AGENT_EVENT.TASK_STARTED, taskId, {
      title: task?.title || "",
      sdk: slot?.sdk || "unknown",
      agentInstanceId: slot?.agentInstanceId ?? null,
      branch: slot?.branch || null,
      worktreePath: slot?.worktreePath || null,
    });
    if (!this._autoActionState.has(taskId)) {
      this._autoActionState.set(taskId, {
        retryCount: 0,
        lastRetryAt: 0,
        cooldownUntil: 0,
      });
    }
  }

  /**
   * Task completed by executor (post-execution).
   * @param {object} task
   * @param {object} result — { attempts, success, hasCommits, branch, prUrl, prNumber }
   */
  onTaskCompleted(task, result) {
    const taskId = task?.id || task?.task_id || "unknown";
    this.emit(AGENT_EVENT.TASK_COMPLETED, taskId, {
      title: task?.title || "",
      attempts: result?.attempts || 1,
      success: !!result?.success,
      hasCommits: !!result?.hasCommits,
      branch: result?.branch || task?.branchName || null,
      prUrl: result?.prUrl || null,
      prNumber: result?.prNumber || null,
    });
    this._autoActionState.delete(taskId);

    // Auto-review
    if (result?.success && this._reviewAgent) {
      this._triggerAutoReview(task, result);
    }
  }

  /**
   * Task failed in executor.
   * @param {object} task
   * @param {Error|string} err
   */
  onTaskFailed(task, err) {
    const taskId = task?.id || task?.task_id || "unknown";
    const errorMsg =
      typeof err === "string" ? err : err?.message || String(err);

    this.emit(AGENT_EVENT.TASK_FAILED, taskId, {
      title: task?.title || "",
      error: errorMsg,
    });

    if (this._errorDetector) {
      const cls = this._errorDetector.classify(errorMsg, "");
      this._handleClassification(taskId, cls, errorMsg);
    }
  }

  /**
   * Agent self-reported completion via /complete endpoint.
   * @param {string} taskId
   * @param {object} body — { hasCommits, branch, prUrl, prNumber, output }
   */
  onAgentComplete(taskId, body = {}) {
    this.emit(AGENT_EVENT.AGENT_COMPLETE, taskId, {
      hasCommits: !!body.hasCommits,
      branch: body.branch || null,
      prUrl: body.prUrl || null,
      prNumber: body.prNumber || null,
    });

    if (body.hasCommits && this._setTaskStatus) {
      try {
        this._setTaskStatus(taskId, "inreview", "agent-event-bus");
      } catch { /* best-effort */ }
    }

    if (this._reviewAgent) {
      const task = this._resolveTask(taskId);
      if (task) this._triggerAutoReview(task, body);
    }
  }

  /**
   * Agent self-reported error via /error endpoint.
   * @param {string} taskId
   * @param {object} body — { error, pattern, output }
   */
  onAgentError(taskId, body = {}) {
    const errorMsg = body.error || "Unknown error";
    const output = body.output || "";

    this.emit(AGENT_EVENT.AGENT_ERROR, taskId, {
      error: errorMsg,
      pattern: body.pattern || null,
    });

    if (this._errorDetector) {
      const cls = this._errorDetector.classify(output, errorMsg);
      this._handleClassification(taskId, cls, errorMsg);
    }
  }

  /**
   * Agent heartbeat.
   * @param {string} taskId
   * @param {object} body — { message }
   */
  onAgentHeartbeat(taskId, body = {}) {
    this._heartbeats.set(taskId, Date.now());
    this.emit(AGENT_EVENT.AGENT_HEARTBEAT, taskId, {
      message: body.message || null,
      alive: true,
    });
  }

  /**
   * Agent status changed via agent-endpoint /status.
   * @param {string} taskId
   * @param {string} newStatus
   * @param {string} [source]
   */
  onStatusChange(taskId, newStatus, source = "agent") {
    this.emit(AGENT_EVENT.TASK_STATUS_CHANGE, taskId, {
      status: newStatus,
      source,
    });

    if (this._setTaskStatus) {
      try {
        this._setTaskStatus(taskId, newStatus, source || "agent-event-bus");
      } catch { /* best-effort */ }
    }

    if (newStatus === "blocked") {
      this.emit(AGENT_EVENT.TASK_BLOCKED, taskId, { source });
      if (this._sendTelegram) {
        const task = this._resolveTask(taskId);
        const title = task?.title || taskId;
        this._sendTelegram(`🛑 Task blocked: "${title}" (source: ${source})`);
      }
    }
  }

  /**
   * Executor paused.
   * @param {string} [reason]
   */
  onExecutorPaused(reason) {
    this.emit(AGENT_EVENT.EXECUTOR_PAUSED, "system", {
      reason: reason || "manual",
    });
    if (this._sendTelegram) {
      this._sendTelegram(`⏸️ Executor paused: ${reason || "manual"}`);
    }
  }

  /**
   * Executor resumed.
   */
  onExecutorResumed() {
    this.emit(AGENT_EVENT.EXECUTOR_RESUMED, "system", {});
  }

  /**
   * Hook execution result (from agent-hooks.mjs).
   * @param {string} taskId
   * @param {string} hookEvent — e.g. "PrePush"
   * @param {boolean} passed
   * @param {object} details — { hookId, output, durationMs }
   */
  onHookResult(taskId, hookEvent, passed, details = {}) {
    const type = passed ? AGENT_EVENT.HOOK_PASSED : AGENT_EVENT.HOOK_FAILED;
    this.emit(type, taskId, {
      hookEvent,
      hookId: details.hookId || null,
      output: details.output || null,
      durationMs: details.durationMs || null,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  QUERY API — used by UI routes to fetch state
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get event log with optional filters.
   * @param {object} [filter]
   * @param {string} [filter.taskId]
   * @param {string} [filter.type]
   * @param {number} [filter.since] — timestamp
   * @param {number} [filter.limit]
   * @returns {Array}
   */
  getEventLog(filter = {}) {
    let events = this._eventLog;
    if (filter.taskId) events = events.filter((e) => e.taskId === filter.taskId);
    if (filter.type) events = events.filter((e) => e.type === filter.type);
    if (filter.since) events = events.filter((e) => e.ts >= filter.since);
    if (filter.limit) events = events.slice(-filter.limit);
    return events;
  }

  /**
   * Get error history for a task.
   * @param {string} taskId
   * @returns {Array}
   */
  getErrorHistory(taskId) {
    return this._errorHistory.get(taskId) || [];
  }

  /**
   * Aggregated error pattern summary across all tasks.
   * @returns {object} { [pattern]: { count, lastSeen, tasks:string[] } }
   */
  getErrorPatternSummary() {
    const summary = {};
    for (const [taskId, errors] of this._errorHistory) {
      for (const err of errors) {
        if (!summary[err.pattern]) {
          summary[err.pattern] = { count: 0, lastSeen: 0, tasks: new Set() };
        }
        summary[err.pattern].count++;
        summary[err.pattern].lastSeen = Math.max(
          summary[err.pattern].lastSeen,
          err.ts,
        );
        summary[err.pattern].tasks.add(taskId);
      }
    }
    for (const key of Object.keys(summary)) {
      summary[key].tasks = Array.from(summary[key].tasks);
    }
    return summary;
  }

  /**
   * Agent liveness status.
   * @returns {Array<{taskId:string, lastHeartbeat:number, alive:boolean, staleSinceMs:number|null}>}
   */
  getAgentLiveness() {
    const now = Date.now();
    const result = [];
    for (const [taskId, lastHb] of this._heartbeats) {
      const elapsed = now - lastHb;
      result.push({
        taskId,
        lastHeartbeat: lastHb,
        alive: elapsed < this._staleThresholdMs,
        staleSinceMs: elapsed >= this._staleThresholdMs ? elapsed : null,
      });
    }
    return result;
  }

  /**
   * Full system status.
   * @returns {object}
   */
  getStatus() {
    return {
      started: this._started,
      eventLogSize: this._eventLog.length,
      trackedAgents: this._heartbeats.size,
      errorTrackedTasks: this._errorHistory.size,
      autoActionTasks: this._autoActionState.size,
      listenerCount: this._listeners.size,
      liveness: this.getAgentLiveness(),
      errorPatterns: this.getErrorPatternSummary(),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INTERNAL
  // ══════════════════════════════════════════════════════════════════════════

  _broadcastToUi(event) {
    if (!this._broadcastUiEvent) return;
    try {
      this._broadcastUiEvent(
        ["agents", "tasks", "overview"],
        event.type,
        { taskId: event.taskId, ...event.payload, ts: event.ts },
      );
    } catch (err) {
      console.warn(`${TAG} WS broadcast error:`, err.message || err);
    }
  }

  _handleClassification(taskId, classification, rawError) {
    const ts = Date.now();
    if (!this._errorHistory.has(taskId)) {
      this._errorHistory.set(taskId, []);
    }
    const history = this._errorHistory.get(taskId);

    let recovery = null;
    if (this._errorDetector) {
      recovery = this._errorDetector.recordError(taskId, classification);
    }

    const action = recovery?.action || "manual";
    history.push({
      pattern: classification.pattern,
      ts,
      action,
      confidence: classification.confidence,
      details: classification.details || "",
      rawMatch: classification.rawMatch || null,
    });

    // Trim
    if (history.length > DEFAULTS.maxErrorPatternsPerTask) {
      history.splice(0, history.length - DEFAULTS.maxErrorPatternsPerTask);
    }

    // Emit
    this.emit(
      AGENT_EVENT.ERROR_CLASSIFIED,
      taskId,
      {
        pattern: classification.pattern,
        confidence: classification.confidence,
        details: classification.details || "",
        action,
        errorCount: recovery?.errorCount || 0,
      },
      { skipBroadcast: false },
    );

    this._detectPatternTrend(taskId);
    this._executeAutoAction(taskId, action, recovery, classification, rawError);
  }

  /**
   * @param {string} taskId
   * @param {string} action
   * @param {object|null} recovery
   * @param {object} classification
   * @param {string} rawError
   */
  _executeAutoAction(taskId, action, recovery, classification, rawError) {
    const state = this._autoActionState.get(taskId) || {
      retryCount: 0,
      lastRetryAt: 0,
      cooldownUntil: 0,
    };
    const now = Date.now();

    if (state.cooldownUntil > now) {
      console.log(
        `${TAG} ${taskId} in cooldown until ${new Date(state.cooldownUntil).toISOString()}`,
      );
      return;
    }

    switch (action) {
      case "retry_with_prompt": {
        if (state.retryCount >= this._maxAutoRetries) {
          console.log(`${TAG} ${taskId} exhausted retries (${state.retryCount})`);
          this._executeAutoAction(taskId, "block", recovery, classification, rawError);
          return;
        }
        state.retryCount++;
        state.lastRetryAt = now;
        this._autoActionState.set(taskId, state);

        this.emit(AGENT_EVENT.AUTO_RETRY, taskId, {
          retryCount: state.retryCount,
          maxRetries: this._maxAutoRetries,
          reason: recovery?.reason || "error detected",
          prompt: recovery?.prompt || null,
          pattern: classification?.pattern,
        });
        console.log(
          `${TAG} auto-retry #${state.retryCount}/${this._maxAutoRetries} for ${taskId} (${classification?.pattern || "?"})`,
        );
        break;
      }

      case "cooldown": {
        const cooldownMs = recovery?.cooldownMs || 60_000;
        state.cooldownUntil = now + cooldownMs;
        this._autoActionState.set(taskId, state);

        this.emit(AGENT_EVENT.AUTO_COOLDOWN, taskId, {
          cooldownMs,
          cooldownUntil: state.cooldownUntil,
          reason: recovery?.reason || "rate limited",
          pattern: classification?.pattern,
        });
        console.log(
          `${TAG} cooldown ${cooldownMs}ms for ${taskId} (${classification?.pattern || "?"})`,
        );
        break;
      }

      case "block": {
        this.emit(AGENT_EVENT.AUTO_BLOCK, taskId, {
          reason: recovery?.reason || "too many errors",
          errorCount: recovery?.errorCount || 0,
          pattern: classification?.pattern,
        });

        if (this._setTaskStatus) {
          try {
            this._setTaskStatus(taskId, "blocked", "agent-event-bus");
          } catch { /* best-effort */ }
        }
        if (this._sendTelegram) {
          const task = this._resolveTask(taskId);
          const title = task?.title || taskId;
          this._sendTelegram(
            `🛑 Auto-blocked: "${title}" — ${recovery?.reason || "too many errors"}`,
          );
        }
        console.log(
          `${TAG} auto-blocked ${taskId}: ${recovery?.reason || "threshold"}`,
        );
        break;
      }

      case "new_session": {
        state.retryCount++;
        state.lastRetryAt = now;
        this._autoActionState.set(taskId, state);

        this.emit(AGENT_EVENT.AUTO_NEW_SESSION, taskId, {
          reason: recovery?.reason || "session expired / token overflow",
          retryCount: state.retryCount,
          pattern: classification?.pattern,
        });
        console.log(
          `${TAG} new-session for ${taskId}: ${recovery?.reason || "overflow"}`,
        );
        break;
      }

      case "pause_executor": {
        this.emit(AGENT_EVENT.EXECUTOR_PAUSED, "system", {
          reason: recovery?.reason || "rate limit flood",
          triggeredBy: taskId,
        });
        if (this._sendTelegram) {
          this._sendTelegram(
            `⏸️ Executor auto-paused: ${recovery?.reason || "rate limit flood"}`,
          );
        }
        console.log(`${TAG} executor paused: ${recovery?.reason}`);
        break;
      }

      case "manual":
      default: {
        console.log(
          `${TAG} manual review needed for ${taskId}: ${recovery?.reason || rawError}`,
        );
        if (this._sendTelegram && (recovery?.errorCount || 0) >= 3) {
          const task = this._resolveTask(taskId);
          const title = task?.title || taskId;
          this._sendTelegram(
            `⚠️ "${title}" needs manual review: ${recovery?.reason || "repeated errors"}`,
          );
        }
        break;
      }
    }
  }

  _detectPatternTrend(taskId) {
    const history = this._errorHistory.get(taskId);
    if (!history || history.length < 3) return;

    const recent = history.slice(-5);
    const counts = {};
    for (const e of recent) counts[e.pattern] = (counts[e.pattern] || 0) + 1;

    for (const [pattern, count] of Object.entries(counts)) {
      if (count >= 3) {
        this.emit(AGENT_EVENT.ERROR_PATTERN_DETECTED, taskId, {
          pattern,
          frequency: count,
          window: recent.length,
          message: `"${pattern}" appeared ${count}/${recent.length} times recently`,
        });
      }
    }

    if (history.length >= DEFAULTS.maxAutoRetries) {
      const tail = history.slice(-DEFAULTS.maxAutoRetries);
      const allUnresolvable = tail.every(
        (e) => e.action === "block" || e.action === "manual",
      );
      if (allUnresolvable) {
        this.emit(AGENT_EVENT.ERROR_THRESHOLD_REACHED, taskId, {
          totalErrors: history.length,
          message: `${taskId}: ${history.length} errors, all recent unresolvable`,
        });
      }
    }
  }

  _checkStaleAgents() {
    const now = Date.now();
    for (const [taskId, lastHb] of this._heartbeats) {
      const elapsed = now - lastHb;
      if (elapsed >= this._staleThresholdMs) {
        this.emit(AGENT_EVENT.AGENT_STALE, taskId, {
          lastHeartbeat: lastHb,
          staleSinceMs: elapsed,
        });
        this._heartbeats.delete(taskId);
      }
    }
  }

  _triggerAutoReview(task, result) {
    if (!this._reviewAgent) return;
    const taskId = task?.id || task?.task_id || "unknown";
    try {
      this._reviewAgent.queueReview({
        id: taskId,
        title: task?.title || "",
        prNumber: result?.prNumber,
        branchName:
          result?.branch || task?.branchName || task?.meta?.branch_name,
        description: task?.description || "",
      });
      this.emit(AGENT_EVENT.AUTO_REVIEW, taskId, {
        title: task?.title || "",
        branch: result?.branch || task?.branchName || null,
        prNumber: result?.prNumber || null,
      });
      console.log(`${TAG} auto-review queued for ${taskId}`);
    } catch (err) {
      console.warn(
        `${TAG} auto-review failed for ${taskId}: ${err.message || err}`,
      );
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
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an AgentEventBus instance.
 * @param {object} [options] — Same as AgentEventBus constructor
 * @returns {AgentEventBus}
 */
export function createAgentEventBus(options) {
  return new AgentEventBus(options);
}
