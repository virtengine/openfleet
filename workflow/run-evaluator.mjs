/**
 * run-evaluator.mjs — Post-run quality evaluation and remediation suggestions.
 *
 * Evaluates completed/failed workflow runs to produce quality scores,
 * grade classifications, and actionable remediation suggestions.
 */

// ── Score / Grade Constants ─────────────────────────────────────────────────

const PENALTY_FAILED_NODE = 10;
const PENALTY_RETRIED_NODE = 5;
const PENALTY_SKIPPED_NODE = 2;
const PENALTY_SLOW_RUN_MS = 5 * 60 * 1000; // 5 minutes
const PENALTY_SLOW_RUN = 5;
const PENALTY_SLOW_NODE_MS = 2 * 60 * 1000; // 2 minutes
const PENALTY_SLOW_NODE = 10;
const PENALTY_HIGH_ERROR_RATE = 20;
const HIGH_ERROR_RATE_THRESHOLD = 0.5;

function computeGrade(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

// ── RunEvaluator ────────────────────────────────────────────────────────────

export class RunEvaluator {
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
      const penalty = failedNodes * PENALTY_FAILED_NODE;
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
      const penalty = retriedNodes * PENALTY_RETRIED_NODE;
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
      score -= skippedNodes * PENALTY_SKIPPED_NODE;
    }

    // Penalty: slow total duration
    if (totalDurationMs > PENALTY_SLOW_RUN_MS) {
      score -= PENALTY_SLOW_RUN;
      issues.push({
        severity: "warning",
        nodeId: null,
        message: `Run took ${Math.round(totalDurationMs / 1000)}s (>${Math.round(PENALTY_SLOW_RUN_MS / 1000)}s threshold)`,
        suggestion: "Consider optimising slow nodes or splitting workflow",
      });
    }

    // Penalty: any single node > 2 min
    if (slowestNode.durationMs > PENALTY_SLOW_NODE_MS) {
      score -= PENALTY_SLOW_NODE;
      issues.push({
        severity: "warning",
        nodeId: slowestNode.nodeId,
        message: `Slowest node took ${Math.round(slowestNode.durationMs / 1000)}s`,
        suggestion: "Consider adding a timeout or batching work",
      });
    }

    // Penalty: high error rate
    if (errorRate > HIGH_ERROR_RATE_THRESHOLD) {
      score -= PENALTY_HIGH_ERROR_RATE;
      issues.push({
        severity: "error",
        nodeId: null,
        message: `Error rate is ${Math.round(errorRate * 100)}% (>${Math.round(HIGH_ERROR_RATE_THRESHOLD * 100)}% threshold)`,
        suggestion: "Review workflow design — most nodes are failing",
      });
    }

    score = Math.max(0, Math.min(100, score));
    const grade = computeGrade(score);

    // ── Remediation ───────────────────────────────────────────────────
    const remediation = this._buildRemediation(nodeStatuses, errors, metrics);

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
        fixActions: [],
        suggestedRetryMode: null,
      },
    };
  }

  _buildRemediation(nodeStatuses, errors, metrics) {
    const fixActions = [];
    const failedNodeIds = [];

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

    let suggestedRetryMode = null;
    if (failedNodeIds.length === 1) {
      suggestedRetryMode = "from_failed";
    } else if (failedNodeIds.length > 1) {
      suggestedRetryMode = "from_scratch";
    }

    const canAutoFix = fixActions.length > 0 &&
      fixActions.every((a) => a.type === "increase_timeout" || a.type === "check_config");

    return { canAutoFix, fixActions, suggestedRetryMode };
  }

  _suggestFixForError(errMsg) {
    if (!errMsg) return null;
    if (/timed?\s*out/i.test(errMsg)) return "Increase node timeout";
    if (/not\s*found/i.test(errMsg) || /does\s*not\s*exist/i.test(errMsg)) return "Check configuration paths/IDs";
    if (/permission|unauthorized|forbidden/i.test(errMsg)) return "Check permissions/credentials";
    return "Review error details";
  }
}
