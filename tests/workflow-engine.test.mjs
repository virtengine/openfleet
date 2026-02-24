import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkflowEngine,
  WorkflowContext,
  NodeStatus,
  WorkflowStatus,
} from "../workflow-engine.mjs";
import {
  registerNodeType,
  getNodeType,
} from "../workflow-nodes.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir;
let engine;

function makeTmpEngine(services = {}) {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-engine-test-"));
  engine = new WorkflowEngine({
    workflowDir: join(tmpDir, "workflows"),
    runsDir: join(tmpDir, "runs"),
    services,
  });
  return engine;
}

function makeSimpleWorkflow(nodes, edges, opts = {}) {
  return {
    id: opts.id || "test-wf-" + Math.random().toString(36).slice(2, 8),
    name: opts.name || "Test Workflow",
    description: opts.description || "Test workflow for engine tests",
    enabled: true,
    nodes,
    edges,
    variables: opts.variables || {},
  };
}

// ── WorkflowContext Tests ───────────────────────────────────────────────────

describe("WorkflowContext", () => {
  it("initializes with data and tracks node outputs", () => {
    const ctx = new WorkflowContext({ foo: "bar" });
    expect(ctx.data.foo).toBe("bar");
    expect(ctx.nodeOutputs.size).toBe(0);
    expect(ctx.nodeStatuses.size).toBe(0);
    expect(ctx.logs).toEqual([]);
    expect(ctx.errors).toEqual([]);
  });

  it("tracks retry attempts", () => {
    const ctx = new WorkflowContext();
    expect(ctx.getRetryCount("node-1")).toBe(0);
    expect(ctx.incrementRetry("node-1")).toBe(1);
    expect(ctx.incrementRetry("node-1")).toBe(2);
    expect(ctx.getRetryCount("node-1")).toBe(2);
    expect(ctx.getRetryCount("node-2")).toBe(0);
  });

  it("fork() creates independent clone with upstream data", () => {
    const ctx = new WorkflowContext({ shared: "original" });
    ctx.setNodeOutput("upstream-1", { result: 42 });
    ctx.variables.v1 = "hello";

    const forked = ctx.fork({ item: "apple", _loopIndex: 0 });

    expect(forked.data.shared).toBe("original");
    expect(forked.data.item).toBe("apple");
    expect(forked.data._loopIndex).toBe(0);
    expect(forked.variables.v1).toBe("hello");
    // Can access upstream node outputs
    expect(forked.getNodeOutput("upstream-1")).toEqual({ result: 42 });

    // Mutations on forked do NOT affect original
    forked.data.shared = "mutated";
    expect(ctx.data.shared).toBe("original");
  });

  it("toJSON() includes retryAttempts", () => {
    const ctx = new WorkflowContext();
    ctx.incrementRetry("n1");
    ctx.incrementRetry("n1");
    const json = ctx.toJSON();
    expect(json.retryAttempts).toEqual({ n1: 2 });
    expect(json.nodeOutputs).toBeDefined();
    expect(json.nodeStatuses).toBeDefined();
  });

  it("resolve() interpolates templates from data and node outputs", () => {
    const ctx = new WorkflowContext({ name: "Alice" });
    ctx.setNodeOutput("step1", { count: 5 });
    expect(ctx.resolve("Hello {{name}}")).toBe("Hello Alice");
    expect(ctx.resolve("Count: {{step1.count}}")).toBe("Count: 5");
    expect(ctx.resolve("{{missing}}")).toBe("{{missing}}");
    expect(ctx.resolve(42)).toBe(42); // Non-strings pass through
  });
});

// ── Engine Retry Tests ──────────────────────────────────────────────────────

describe("WorkflowEngine - retry logic", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("retries a failing node up to maxRetries then fails", async () => {
    let callCount = 0;
    registerNodeType("test.flaky_always_fail", {
      describe: () => "Always fails for testing",
      schema: { type: "object", properties: {} },
      async execute() {
        callCount++;
        throw new Error("always fails");
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "flaky", type: "test.flaky_always_fail", label: "Flaky", config: { maxRetries: 2 } },
      ],
      [{ id: "e1", source: "trigger", target: "flaky" }]
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    // 1 initial attempt + 2 retries = 3 total calls
    expect(callCount).toBe(3);
    // execute() returns a WorkflowContext — check errors array for failure
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("retries then succeeds on second attempt", async () => {
    let callCount = 0;
    registerNodeType("test.flaky_second_try", {
      describe: () => "Fails first, succeeds second",
      schema: { type: "object", properties: {} },
      async execute() {
        callCount++;
        if (callCount < 2) throw new Error("first try fails");
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "retry-node", type: "test.flaky_second_try", label: "Retry Me", config: { maxRetries: 3 } },
      ],
      [{ id: "e1", source: "trigger", target: "retry-node" }]
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(callCount).toBe(2);
    expect(result.errors.length).toBe(0);
  });

  it("skips retry when retryable is false", async () => {
    let callCount = 0;
    registerNodeType("test.no_retry", {
      describe: () => "Fails, no retry allowed",
      schema: { type: "object", properties: {} },
      async execute() {
        callCount++;
        throw new Error("no retry");
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "fail", type: "test.no_retry", label: "No Retry", config: { retryable: false } },
      ],
      [{ id: "e1", source: "trigger", target: "fail" }]
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(callCount).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("emits node:retry events", async () => {
    let retryEvents = [];
    let callCount = 0;
    registerNodeType("test.retry_events", {
      describe: () => "Fails twice then passes",
      schema: { type: "object", properties: {} },
      async execute() {
        callCount++;
        if (callCount <= 2) throw new Error("try again");
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "retry-node", type: "test.retry_events", label: "Retry", config: { maxRetries: 3 } },
      ],
      [{ id: "e1", source: "trigger", target: "retry-node" }]
    );

    engine.save(wf);
    engine.on("node:retry", (ev) => retryEvents.push(ev));
    await engine.execute(wf.id, {});
    expect(retryEvents.length).toBe(2);
    expect(retryEvents[0].attempt).toBe(1);
    expect(retryEvents[1].attempt).toBe(2);
  });
});

// ── Engine Loop Iteration Tests ─────────────────────────────────────────────

describe("WorkflowEngine - loop.for_each", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("actually iterates downstream nodes per item", async () => {
    const executed = [];
    registerNodeType("test.collect_item", {
      describe: () => "Collects item from context",
      schema: { type: "object", properties: {} },
      async execute(node, ctx) {
        const item = ctx.data.item;
        executed.push(item);
        return { collected: item };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "loop", type: "loop.for_each", label: "Loop Items", config: { items: '["a","b","c"]', variable: "item" } },
        { id: "collect", type: "test.collect_item", label: "Collect", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "loop" },
        { id: "e2", source: "loop", target: "collect" },
      ]
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors.length).toBe(0);
    expect(executed).toEqual(["a", "b", "c"]);
  });

  it("emits loop:iteration events", async () => {
    const iterations = [];
    registerNodeType("test.noop_loop", {
      describe: () => "Noop",
      schema: { type: "object", properties: {} },
      async execute() { return { ok: true }; },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "loop", type: "loop.for_each", label: "Loop", config: { items: '[1,2]', variable: "item" } },
        { id: "body", type: "test.noop_loop", label: "Body", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "loop" },
        { id: "e2", source: "loop", target: "body" },
      ]
    );

    engine.save(wf);
    engine.on("loop:iteration", (ev) => iterations.push(ev));
    await engine.execute(wf.id, {});
    expect(iterations.length).toBe(2);
    expect(iterations[0]).toEqual({ nodeId: "loop", index: 0, total: 2 });
    expect(iterations[1]).toEqual({ nodeId: "loop", index: 1, total: 2 });
  });
});

// ── Node Type Tests ─────────────────────────────────────────────────────────

describe("New node types", () => {
  it("trigger.anomaly matches by type and severity", async () => {
    const handler = getNodeType("trigger.anomaly");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      anomalyType: "stuck_agent",
      severity: "high",
      agentId: "codex-1",
    });

    const node = { id: "t1", type: "trigger.anomaly", config: { anomalyType: "stuck_agent", minSeverity: "medium" } };
    const result = await handler.execute(node, ctx);
    expect(result.triggered).toBe(true);
    expect(result.anomalyType).toBe("stuck_agent");
  });

  it("trigger.anomaly rejects low severity when minSeverity is high", async () => {
    const handler = getNodeType("trigger.anomaly");
    const ctx = new WorkflowContext({ anomalyType: "stuck_agent", severity: "low" });
    const node = { id: "t1", type: "trigger.anomaly", config: { minSeverity: "high" } };
    const result = await handler.execute(node, ctx);
    expect(result.triggered).toBe(false);
  });

  it("trigger.anomaly filters by agent regex", async () => {
    const handler = getNodeType("trigger.anomaly");
    const ctx = new WorkflowContext({ anomalyType: "error_spike", severity: "critical", agentId: "frontend-agent-1" });
    const node = { id: "t1", type: "trigger.anomaly", config: { agentFilter: "frontend" } };
    const result = await handler.execute(node, ctx);
    expect(result.triggered).toBe(true);

    const node2 = { id: "t2", type: "trigger.anomaly", config: { agentFilter: "backend" } };
    const result2 = await handler.execute(node2, ctx);
    expect(result2.triggered).toBe(false);
  });

  it("trigger.scheduled_once resolves relative time expressions", async () => {
    const handler = getNodeType("trigger.scheduled_once");
    const ctx = new WorkflowContext({});

    // Already past
    const node = { id: "t1", type: "trigger.scheduled_once", config: { runAt: new Date(Date.now() - 1000).toISOString() } };
    const result = await handler.execute(node, ctx);
    expect(result.triggered).toBe(true);
    expect(result.remainingMs).toBe(0);

    // Future
    const node2 = { id: "t2", type: "trigger.scheduled_once", config: { runAt: "+30m" } };
    const result2 = await handler.execute(node2, ctx);
    expect(result2.triggered).toBe(false);
    expect(result2.remainingMs).toBeGreaterThan(0);
  });

  it("action.delay supports seconds, minutes, hours", async () => {
    const handler = getNodeType("action.delay");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({});
    // Use very small values for fast test
    const node = { id: "d1", type: "action.delay", config: { ms: 10, reason: "test" } };
    const result = await handler.execute(node, ctx);
    expect(result.waited).toBeGreaterThanOrEqual(10);
    expect(result.reason).toBe("test");
  });

  it("flow.gate opens on condition", async () => {
    const handler = getNodeType("flow.gate");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ ready: true });
    const engine = { emit: vi.fn() };
    const node = {
      id: "g1",
      type: "flow.gate",
      config: { mode: "condition", condition: "$data.ready === true", timeoutMs: 1000, pollIntervalMs: 50 },
    };
    const result = await handler.execute(node, ctx, engine);
    expect(result.gateOpened).toBe(true);
    expect(result.mode).toBe("condition");
    expect(result.waited).toBeLessThan(1000);
  });

  it("flow.gate timeout mode waits then proceeds", async () => {
    const handler = getNodeType("flow.gate");
    const ctx = new WorkflowContext({});
    const engine = { emit: vi.fn() };
    const node = {
      id: "g2",
      type: "flow.gate",
      config: { mode: "timeout", timeoutMs: 50 },
    };
    const result = await handler.execute(node, ctx, engine);
    expect(result.gateOpened).toBe(true);
    expect(result.waited).toBe(50);
  });
});

// ── Session Chaining Tests ──────────────────────────────────────────────────

describe("Session chaining - action.run_agent", () => {
  it("propagates threadId to context", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn().mockResolvedValue({
            success: true,
            output: "done",
            sdk: "codex",
            items: [],
            threadId: "thread-abc-123",
          }),
        },
      },
    };

    const node = { id: "a1", type: "action.run_agent", config: { prompt: "Test prompt" } };
    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.threadId).toBe("thread-abc-123");
    expect(result.sessionId).toBe("thread-abc-123");
    expect(ctx.data.sessionId).toBe("thread-abc-123");
    expect(ctx.data.threadId).toBe("thread-abc-123");
  });
});

// ── Anomaly Detector Integration Tests ──────────────────────────────────────

describe("Anomaly → Workflow bridge", () => {
  it("wrapAnomalyCallback fires workflow triggers", async () => {
    const { wrapAnomalyCallback, setWorkflowEngine } = await import("../anomaly-detector.mjs");

    const mockEvaluate = vi.fn();
    setWorkflowEngine({ evaluateTriggers: mockEvaluate });

    const originalCb = vi.fn();
    const wrapped = wrapAnomalyCallback(originalCb);

    const anomaly = {
      type: "stuck_agent",
      severity: "high",
      processId: "proc-123",
      shortId: "proc-1",
      message: "Agent stuck for 10m",
      action: "kill",
      taskTitle: "Fix the bug",
      data: { foo: "bar" },
    };

    wrapped(anomaly);

    // Original callback still called
    expect(originalCb).toHaveBeenCalledWith(anomaly);

    // Workflow engine gets trigger
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(mockEvaluate).toHaveBeenCalledWith("anomaly", expect.objectContaining({
      anomalyType: "stuck_agent",
      severity: "high",
      agentId: "proc-123",
    }));

    // Clean up
    setWorkflowEngine(null);
  });
});

// ── Template Dedup Tests ────────────────────────────────────────────────────

describe("Template dedup on install", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("rejects installing a template that is already installed", async () => {
    const { installTemplate } = await import("../workflow-templates.mjs");

    // Install once - should succeed
    const wf = installTemplate("template-pr-merge-strategy", engine);
    expect(wf).toBeDefined();
    expect(wf.metadata.installedFrom).toBe("template-pr-merge-strategy");

    // Install again - should throw
    expect(() => installTemplate("template-pr-merge-strategy", engine)).toThrow(/already installed/i);
  });
});
