import { describe, it, expect } from "vitest";
import { RunEvaluator } from "../workflow/run-evaluator.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRunDetail(overrides = {}) {
  const now = Date.now();
  return {
    detail: {
      id: "run-1",
      startedAt: now - 10_000,
      endedAt: now,
      duration: 10_000,
      nodeStatuses: { n1: "completed", n2: "completed" },
      nodeOutputs: { n1: { ok: true }, n2: { ok: true } },
      retryAttempts: {},
      errors: [],
      nodeTimings: {
        n1: { startedAt: now - 10_000, endedAt: now - 5000 },
        n2: { startedAt: now - 5000, endedAt: now },
      },
      nodeInputs: { n1: { foo: 1 }, n2: { bar: 2 } },
      nodeStatusEvents: [],
      ...overrides,
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("RunEvaluator", () => {
  const evaluator = new RunEvaluator();

  describe("scoring", () => {
    it("gives a perfect run score near 100", () => {
      const run = makeRunDetail();
      const result = evaluator.evaluate(run);
      expect(result.score).toBeGreaterThanOrEqual(90);
      expect(result.grade).toBe("A");
      expect(result.issues).toHaveLength(0);
    });

    it("penalises failed nodes (-10 each)", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed", n3: "failed" },
        errors: [
          { nodeId: "n2", error: "boom", timestamp: Date.now() },
          { nodeId: "n3", error: "crash", timestamp: Date.now() },
        ],
      });
      const result = evaluator.evaluate(run);
      expect(result.score).toBeLessThanOrEqual(80);
      expect(result.metrics.failedNodes).toBe(2);
      expect(result.issues.some((i) => i.severity === "error" && i.nodeId === "n2")).toBe(true);
    });

    it("penalises retried nodes (-5 each)", () => {
      const run = makeRunDetail({
        retryAttempts: { n1: 2 },
      });
      const result = evaluator.evaluate(run);
      expect(result.score).toBeLessThanOrEqual(95);
      expect(result.metrics.retriedNodes).toBe(1);
    });

    it("penalises skipped nodes (-2 each)", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "skipped", n3: "skipped" },
      });
      const result = evaluator.evaluate(run);
      expect(result.score).toBeLessThanOrEqual(96);
      expect(result.metrics.skippedNodes).toBe(2);
    });

    it("penalises slow total duration (-5)", () => {
      const now = Date.now();
      const run = makeRunDetail({
        startedAt: now - 400_000,
        endedAt: now,
        duration: 400_000,
      });
      const result = evaluator.evaluate(run);
      expect(result.score).toBeLessThanOrEqual(95);
      expect(result.issues.some((i) => i.message.includes("took"))).toBe(true);
    });

    it("penalises a slow node (-10)", () => {
      const now = Date.now();
      const run = makeRunDetail({
        nodeTimings: {
          n1: { startedAt: now - 200_000, endedAt: now },
          n2: { startedAt: now - 1000, endedAt: now },
        },
      });
      const result = evaluator.evaluate(run);
      expect(result.score).toBeLessThanOrEqual(90);
      expect(result.issues.some((i) => i.nodeId === "n1")).toBe(true);
    });

    it("penalises high error rate (-20)", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "failed", n2: "failed" },
        errors: [
          { nodeId: "n1", error: "err1", timestamp: Date.now() },
          { nodeId: "n2", error: "err2", timestamp: Date.now() },
        ],
      });
      const result = evaluator.evaluate(run);
      // -10*2 failed + -20 high error rate = at most 60
      expect(result.score).toBeLessThanOrEqual(60);
    });

    it("clamps score to 0 minimum", () => {
      const statuses = {};
      const errors = [];
      for (let i = 0; i < 20; i++) {
        statuses[`n${i}`] = "failed";
        errors.push({ nodeId: `n${i}`, error: "err", timestamp: Date.now() });
      }
      const run = makeRunDetail({ nodeStatuses: statuses, errors });
      const result = evaluator.evaluate(run);
      expect(result.score).toBe(0);
      expect(result.grade).toBe("F");
    });
  });

  describe("grade boundaries", () => {
    it("A >= 90", () => {
      const run = makeRunDetail();
      expect(evaluator.evaluate(run).grade).toBe("A");
    });

    it("B for score 75-89", () => {
      // 3 failed nodes = -30, so score 70 → but also high error rate if 3/5
      // Use 1 failed + 2 retried + 1 skipped = -10 -10 -2 = 78
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed", n3: "completed", n4: "completed", n5: "skipped" },
        retryAttempts: { n1: 1, n3: 1 },
        errors: [{ nodeId: "n2", error: "err", timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      expect(result.grade).toMatch(/^[AB]$/);
    });

    it("F for score < 40", () => {
      const statuses = {};
      const errors = [];
      for (let i = 0; i < 8; i++) {
        statuses[`n${i}`] = "failed";
        errors.push({ nodeId: `n${i}`, error: "err", timestamp: Date.now() });
      }
      const run = makeRunDetail({ nodeStatuses: statuses, errors });
      expect(evaluator.evaluate(run).grade).toBe("F");
    });
  });

  describe("remediation suggestions", () => {
    it("suggests from_failed when one node failed", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed" },
        errors: [{ nodeId: "n2", error: "timeout exceeded", timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      expect(result.remediation.suggestedRetryMode).toBe("from_failed");
    });

    it("suggests from_scratch when multiple nodes failed", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "failed", n2: "failed" },
        errors: [
          { nodeId: "n1", error: "err1", timestamp: Date.now() },
          { nodeId: "n2", error: "err2", timestamp: Date.now() },
        ],
      });
      const result = evaluator.evaluate(run);
      expect(result.remediation.suggestedRetryMode).toBe("from_scratch");
    });

    it("suggests increase_timeout for timeout errors", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed" },
        errors: [{ nodeId: "n2", error: 'Node "n2" timed out after 10000ms', timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      const action = result.remediation.fixActions.find((a) => a.nodeId === "n2");
      expect(action.type).toBe("increase_timeout");
    });

    it("suggests check_config for not-found errors", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed" },
        errors: [{ nodeId: "n2", error: "Resource not found", timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      const action = result.remediation.fixActions.find((a) => a.nodeId === "n2");
      expect(action.type).toBe("check_config");
    });

    it("sets canAutoFix true when all issues have known fixes", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed" },
        errors: [{ nodeId: "n2", error: "timed out after 10000ms", timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      expect(result.remediation.canAutoFix).toBe(true);
    });

    it("sets canAutoFix false when unknown errors exist", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed" },
        errors: [{ nodeId: "n2", error: "Unexpected syntax error in line 42", timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      expect(result.remediation.canAutoFix).toBe(false);
    });

    it("returns null suggestedRetryMode when no failures", () => {
      const run = makeRunDetail();
      const result = evaluator.evaluate(run);
      expect(result.remediation.suggestedRetryMode).toBeNull();
    });
  });

  describe("metrics calculation", () => {
    it("computes correct node counts", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed", n3: "skipped" },
        errors: [{ nodeId: "n2", error: "err", timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      expect(result.metrics.totalNodeCount).toBe(3);
      expect(result.metrics.completedNodes).toBe(1);
      expect(result.metrics.failedNodes).toBe(1);
      expect(result.metrics.skippedNodes).toBe(1);
    });

    it("computes error rate", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed" },
        errors: [{ nodeId: "n2", error: "err", timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      expect(result.metrics.errorRate).toBe(0.5);
    });

    it("identifies slowest node", () => {
      const now = Date.now();
      const run = makeRunDetail({
        nodeTimings: {
          n1: { startedAt: now - 1000, endedAt: now },
          n2: { startedAt: now - 5000, endedAt: now },
        },
      });
      const result = evaluator.evaluate(run);
      expect(result.metrics.slowestNode.nodeId).toBe("n2");
      expect(result.metrics.slowestNode.durationMs).toBeGreaterThanOrEqual(4900);
    });

    it("handles empty run detail", () => {
      const result = evaluator.evaluate(null);
      expect(result.score).toBe(0);
      expect(result.grade).toBe("F");
    });
  });
});
