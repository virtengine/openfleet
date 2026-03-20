/**
 * run-evaluator.mjs — Post-run quality evaluation and remediation suggestions.
 *
 * Evaluates completed/failed workflow runs to produce quality scores,
 * grade classifications, and actionable remediation suggestions.
 *
 * Features:
 *   - Configurable penalty/threshold values
 *   - Auto-trigger integration via engine run:complete event
 *   - Evaluation history persistence with trend analysis
 *   - Per-workflow evaluation tracks
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const TAG = "[run-evaluator]";

// ── Default penalties (all configurable via constructor) ────────────────────

const DEFAULTS = {
  penaltyFailedNode: 10,
  penaltyRetriedNode: 5,
  penaltySkippedNode: 2,
  penaltySlowRunMs: 5 * 60 * 1000,
  penaltySlowRun: 5,
  penaltySlowNodeMs: 2 * 60 * 1000,
  penaltySlowNode: 10,
  penaltyHighErrorRate: 20,
  highErrorRateThreshold: 0.5,
  maxHistoryPerWorkflow: 50,
};

function computeGrade(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

// ── RunEvaluator ────────────────────────────────────────────────────────────

export class RunEvaluator {
  #config;
  #historyPath = null;
  /** @type {Map<string, Array<{ runId: string, score: number, grade: string, timestamp: string }>>} */
  #history = new Map();
  #autoTriggerEngine = null;

  /**
   * @param {object} [opts] — override any default penalty / threshold
   * @param {string} [opts.configDir] — enables evaluation history persistence
   * @param {number} [opts.penaltyFailedNode]
   * @param {number} [opts.penaltyRetriedNode]
   * @param {number} [opts.penaltySkippedNode]
   * @param {number} [opts.penaltySlowRunMs]
   * @param {number} [opts.penaltySlowRun]
   * @param {number} [opts.penaltySlowNodeMs]
   * @param {number} [opts.penaltySlowNode]
   * @param {number} [opts.penaltyHighErrorRate]
   * @param {number} [opts.highErrorRateThreshold]
   * @param {number} [opts.maxHistoryPerWorkflow]
   */
  constructor(opts = {}) {
    this.#config = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (opts[key] !== undefined && typeof opts[key] === "number") {
        this.#config[key] = opts[key];
      }
    }
    if (opts.configDir) {
      const bosunDir = resolve(opts.configDir, ".bosun");
      this.#historyPath = resolve(bosunDir, "evaluation-history.json");
      this.#loadHistory();
    }
  }

  /**
   * Attach to a workflow engine for auto-triggered evaluation.
   * Listens to `run:complete` events and evaluates automatically.
   *
   * @param {object} engine — must expose `.on(event, handler)` and `.getRunDetail(runId)`
   * @returns {void}
   */
  attachToEngine(engine) {
    if (!engine?.on || !engine?.getRunDetail) return;
    this.#autoTriggerEngine = engine;
    engine.on("run:complete", (evt) => {
      try {
        const detail = engine.getRunDetail(evt?.runId);
        if (detail) {
          const result = this.evaluate(detail);
          // Store in history
          this.#recordHistory(evt?.workflowId || "unknown", evt?.runId, result);
        }
      } catch (err) {
        console.warn(`${TAG} auto-evaluation failed: ${err?.message || err}`);
      }
    });
  }

  /**
   * Evaluate a completed/failed run and return quality metrics + remediation.
   *
   * @param {object} runDetail - The run detail object (from engine.getRunDetail())
   * @returns {{ score: number, grade: string, issues: Array, metrics: object, remediation: object }}
   */
  evaluate(runDetail) {
    if (!runDetail) {
      return this._emptyResult("No run detail provided");
    }

    const detail = runDetail.detail || runDetail;
    const nodeStatuses = detail.nodeStatuses || {};
    const nodeOutputs = detail.nodeOutputs || {};
    const retryAttempts = detail.retryAttempts || {};
    const errors = Array.isArray(detail.errors) ? detail.errors : [];
    const nodeTimings = detail.nodeTimings || {};

    // ── Compute metrics ───────────────────────────────────────────────
    const totalDurationMs = Number.isFinite(detail.duration)
      ? detail.duration
      : (detail.startedAt && detail.endedAt
          ? Math.max(0, detail.endedAt - detail.startedAt)
          : 0);

    let failedNodes = 0;
    let completedNodes = 0;
    let skippedNodes = 0;
    let retriedNodes = 0;
    let totalNodeCount = 0;
    let slowestNode = { nodeId: null, durationMs: 0 };
    let totalNodeDurationMs = 0;
    const nodeDurations = {};

    for (const [nodeId, status] of Object.entries(nodeStatuses)) {
      totalNodeCount++;
      if (status === "completed") completedNodes++;
      if (status === "failed") failedNodes++;
      if (status === "skipped") skippedNodes++;

      const retries = Number(retryAttempts[nodeId]) || 0;
      if (retries > 0) retriedNodes++;

      const timing = nodeTimings[nodeId];
      if (timing?.startedAt && timing?.endedAt) {
        const dur = Math.max(0, timing.endedAt - timing.startedAt);
        nodeDurations[nodeId] = dur;
        totalNodeDurationMs += dur;
        if (dur > slowestNode.durationMs) {
          slowestNode = { nodeId, durationMs: dur };
        }
      }
    }

    const avgNodeDurationMs = totalNodeCount > 0
      ? Math.round(totalNodeDurationMs / totalNodeCount)
      : 0;
    const executedNodes = completedNodes + failedNodes;
    const errorRate = executedNodes > 0 ? failedNodes / executedNodes : 0;

    const metrics = {
      totalDurationMs,
      avgNodeDurationMs,
      slowestNode: slowestNode.nodeId ? slowestNode : null,
      failedNodes,
      completedNodes,
      retriedNodes,
      skippedNodes,
      totalNodeCount,
      errorRate: Math.round(errorRate * 1000) / 1000,
    };

    // ── Compute score ─────────────────────────────────────────────────
    let score = 100;
    const issues = [];

    // Penalty: failed nodes
    if (failedNodes > 0) {
      const penalty = failedNodes * this.#config.penaltyFailedNode;
      score -= penalty;
      for (const [nodeId, status] of Object.entries(nodeStatuses)) {
        if (status === "failed") {
          const nodeErrors = errors.filter((e) => e.nodeId === nodeId);
          const errMsg = nodeErrors.length > 0 ? nodeErrors[0].error : "Unknown error";
          issues.push({
            severity: "error",
            nodeId,
            message: `Node failed: ${errMsg}`,
            suggestion: this._suggestFixForError(errMsg),
          });
        }
      }
    }

    // Penalty: retried nodes
    if (retriedNodes > 0) {
      const penalty = retriedNodes * this.#config.penaltyRetriedNode;
      score -= penalty;
      for (const [nodeId, count] of Object.entries(retryAttempts)) {
        if (Number(count) > 0) {
          issues.push({
            severity: "warning",
            nodeId,
            message: `Node required ${count} retries`,
            suggestion: "Check for transient failures or increase retry delay",
          });
        }
      }
    }

    // Penalty: skipped nodes
    if (skippedNodes > 0) {
      score -= skippedNodes * this.#config.penaltySkippedNode;
    }

    // Penalty: slow total duration
    if (totalDurationMs > this.#config.penaltySlowRunMs) {
      score -= this.#config.penaltySlowRun;
      issues.push({
        severity: "warning",
        nodeId: null,
        message: `Run took ${Math.round(totalDurationMs / 1000)}s (>${Math.round(this.#config.penaltySlowRunMs / 1000)}s threshold)`,
        suggestion: "Consider optimising slow nodes or splitting workflow",
      });
    }

    // Penalty: any single node > threshold
    if (slowestNode.durationMs > this.#config.penaltySlowNodeMs) {
      score -= this.#config.penaltySlowNode;
      issues.push({
        severity: "warning",
        nodeId: slowestNode.nodeId,
        message: `Slowest node took ${Math.round(slowestNode.durationMs / 1000)}s`,
        suggestion: "Consider adding a timeout or batching work",
      });
    }

    // Penalty: high error rate
    if (errorRate > this.#config.highErrorRateThreshold) {
      score -= this.#config.penaltyHighErrorRate;
      issues.push({
        severity: "error",
        nodeId: null,
        message: `Error rate is ${Math.round(errorRate * 100)}% (>${Math.round(this.#config.highErrorRateThreshold * 100)}% threshold)`,
        suggestion: "Review workflow design — most nodes are failing",
      });
    }

    score = Math.max(0, Math.min(100, score));
    const grade = computeGrade(score);

    // ── Remediation ───────────────────────────────────────────────────
    const remediation = this._buildRemediation(runDetail, detail, nodeStatuses, errors, metrics, retryAttempts);

    return { score, grade, issues, metrics, remediation };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  _emptyResult(reason) {
    return {
      score: 0,
      grade: "F",
      issues: [{ severity: "error", nodeId: null, message: reason, suggestion: null }],
      metrics: {
        totalDurationMs: 0,
        avgNodeDurationMs: 0,
        slowestNode: null,
        failedNodes: 0,
        completedNodes: 0,
        retriedNodes: 0,
        skippedNodes: 0,
        totalNodeCount: 0,
        errorRate: 0,
      },
      remediation: {
        canAutoFix: false,
        canAutoRetry: false,
        fixActions: [],
        suggestedRetryMode: null,
        retryReason: null,
        summary: reason,
      },
    };
  }

  _buildRemediation(runDetail, detail, nodeStatuses, errors, metrics, retryAttempts = {}) {
    const fixActions = [];
    const failedNodeIds = [];
    const issueAdvisor =
      detail?.issueAdvisor && typeof detail.issueAdvisor === "object"
        ? detail.issueAdvisor
        : null;
    const dagState =
      detail?.dagState && typeof detail.dagState === "object"
        ? detail.dagState
        : null;

    for (const [nodeId, status] of Object.entries(nodeStatuses)) {
      if (status !== "failed") continue;
      failedNodeIds.push(nodeId);

      const nodeErrors = errors.filter((e) => e.nodeId === nodeId);
      const errMsg = nodeErrors.length > 0 ? nodeErrors[0].error : "";

      if (/timed?\s*out/i.test(errMsg)) {
        fixActions.push({
          type: "increase_timeout",
          nodeId,
          description: "Increase node timeout",
          action: { field: "config.timeoutMs", suggestion: "double" },
        });
      } else if (/not\s*found/i.test(errMsg) || /does\s*not\s*exist/i.test(errMsg)) {
        fixActions.push({
          type: "check_config",
          nodeId,
          description: "Check node configuration — referenced resource not found",
          action: { field: "config", suggestion: "verify" },
        });
      } else if (/permission|unauthorized|forbidden/i.test(errMsg)) {
        fixActions.push({
          type: "check_permissions",
          nodeId,
          description: "Permission error — check credentials/access",
          action: { field: "config", suggestion: "verify_access" },
        });
      } else if (errMsg) {
        fixActions.push({
          type: "review_error",
          nodeId,
          description: `Review error: ${errMsg.slice(0, 120)}`,
          action: { field: null, suggestion: "manual_review" },
        });
      }
    }

    for (const [nodeId, count] of Object.entries(retryAttempts || {})) {
      const retries = Number(count) || 0;
      if (retries <= 0) continue;
      fixActions.push({
        type: "tune_retry_policy",
        nodeId,
        description: `Node retried ${retries} time(s) — review retry delay or transient dependency handling`,
        action: { field: "config.retryDelayMs", suggestion: "increase_or_backoff" },
      });
    }

    let suggestedRetryMode = null;
    let retryReason = null;
    if (issueAdvisor?.recommendedAction === "resume_remaining") {
      suggestedRetryMode = "from_failed";
      retryReason = "issue_advisor.resume_remaining";
    } else if (issueAdvisor?.recommendedAction === "replan_from_failed") {
      suggestedRetryMode = "from_scratch";
      retryReason = "issue_advisor.replan_from_failed";
      fixActions.push({
        type: "replan_workflow",
        nodeId: failedNodeIds[0] || null,
        description: "Issue advisor recommends replanning from the failed boundary before re-running.",
        action: { field: null, suggestion: "replan" },
      });
    } else if (issueAdvisor?.recommendedAction === "inspect_failure") {
      suggestedRetryMode = null;
      retryReason = "issue_advisor.inspect_failure";
      fixActions.push({
        type: "inspect_failure",
        nodeId: failedNodeIds[0] || null,
        description: "Inspect failure details before retrying; resume state may not be trustworthy yet.",
        action: { field: null, suggestion: "inspect" },
      });
    } else if (failedNodeIds.length === 1) {
      suggestedRetryMode = "from_failed";
      retryReason = "failed_node_count.single";
    } else if (failedNodeIds.length > 1) {
      suggestedRetryMode = "from_scratch";
      retryReason = "failed_node_count.multiple";
    }

    const canAutoFix = fixActions.length > 0 &&
      fixActions.every((a) => a.type === "increase_timeout" || a.type === "check_config");

    const canAutoRetry = Boolean(
      suggestedRetryMode &&
      issueAdvisor?.recommendedAction !== "inspect_failure",
    );
    const summary = issueAdvisor?.summary ||
      (failedNodeIds.length
        ? `Detected ${failedNodeIds.length} failed node(s); recommended retry is ${suggestedRetryMode || "manual review"}.`
        : "No remediation required.");

    return {
      canAutoFix,
      canAutoRetry,
      fixActions,
      suggestedRetryMode,
      retryReason,
      failedNodeIds,
      lineage: {
        rootRunId: runDetail?.rootRunId || dagState?.rootRunId || null,
        parentRunId: runDetail?.parentRunId || dagState?.parentRunId || null,
        retryOf: runDetail?.retryOf || dagState?.retryOf || null,
      },
      summary,
    };
  }

  _suggestFixForError(errMsg) {
    if (!errMsg) return null;
    if (/timed?\s*out/i.test(errMsg)) return "Increase node timeout";
    if (/not\s*found/i.test(errMsg) || /does\s*not\s*exist/i.test(errMsg)) return "Check configuration paths/IDs";
    if (/permission|unauthorized|forbidden/i.test(errMsg)) return "Check permissions/credentials";
    return "Review error details";
  }

  // ── History & Trends ──────────────────────────────────────────────────

  /**
   * Get evaluation history for a workflow.
   * @param {string} workflowId
   * @param {number} [limit=20]
   * @returns {Array<{ runId: string, score: number, grade: string, timestamp: string }>}
   */
  getHistory(workflowId) {
    return this.#history.get(workflowId) || [];
  }

  /**
   * Get trend data for a workflow (average score over recent evaluations).
   * @param {string} workflowId
   * @returns {{ avgScore: number, trend: "improving"|"stable"|"declining", evaluationCount: number, recentGrades: string[] }|null}
   */
  getTrend(workflowId) {
    const entries = this.#history.get(workflowId);
    if (!entries || entries.length === 0) return null;

    const scores = entries.map((e) => e.score);
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    const recentGrades = entries.slice(-5).map((e) => e.grade);

    // Determine trend by comparing first half vs second half
    let trend = "stable";
    if (scores.length >= 4) {
      const mid = Math.floor(scores.length / 2);
      const firstHalf = scores.slice(0, mid);
      const secondHalf = scores.slice(mid);
      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
      if (secondAvg - firstAvg > 5) trend = "improving";
      else if (firstAvg - secondAvg > 5) trend = "declining";
    }

    return { avgScore, trend, evaluationCount: entries.length, recentGrades };
  }

  #recordHistory(workflowId, runId, result) {
    if (!this.#history.has(workflowId)) {
      this.#history.set(workflowId, []);
    }
    const entries = this.#history.get(workflowId);
    entries.push({
      runId: runId || "unknown",
      score: result.score,
      grade: result.grade,
      timestamp: new Date().toISOString(),
    });
    while (entries.length > this.#config.maxHistoryPerWorkflow) {
      entries.shift();
    }
    this.#saveHistory();
  }

  // ── Persistence ───────────────────────────────────────────────────────

  #loadHistory() {
    if (!this.#historyPath) return;
    try {
      if (!existsSync(this.#historyPath)) return;
      const raw = readFileSync(this.#historyPath, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        for (const [wfId, entries] of Object.entries(data)) {
          if (Array.isArray(entries)) {
            this.#history.set(wfId, entries);
          }
        }
      }
    } catch (err) {
      console.warn(`${TAG} failed to load evaluation history: ${err?.message || err}`);
    }
  }

  #saveHistory() {
    if (!this.#historyPath) return;
    try {
      const dir = dirname(this.#historyPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data = {};
      for (const [wfId, entries] of this.#history) {
        data[wfId] = entries;
      }
      writeFileSync(this.#historyPath, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.warn(`${TAG} failed to save evaluation history: ${err?.message || err}`);
    }
  }
}
