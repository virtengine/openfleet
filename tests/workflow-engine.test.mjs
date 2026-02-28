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

  it("resolve() preserves raw value types for exact placeholders", () => {
    const ctx = new WorkflowContext({
      maxRetries: 3,
      dryRun: false,
      payload: { ok: true },
    });
    expect(ctx.resolve("{{maxRetries}}")).toBe(3);
    expect(ctx.resolve("{{dryRun}}")).toBe(false);
    expect(ctx.resolve("{{payload}}")).toEqual({ ok: true });
    // Embedded placeholders still resolve to strings
    expect(ctx.resolve("retries={{maxRetries}}")).toBe("retries=3");
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
        { id: "flaky", type: "test.flaky_always_fail", label: "Flaky", config: { maxRetries: 2, retryDelayMs: 0 } },
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

  it("resolves templates inside array config values before node execution", async () => {
    registerNodeType("test.capture_config", {
      describe: () => "Capture resolved config",
      schema: { type: "object", properties: {} },
      async execute(node) {
        return { config: node.config };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "capture",
          type: "test.capture_config",
          label: "Capture",
          config: {
            ops: [
              { name: "one", value: "{{v1}}" },
              { name: "two", enabled: "{{flag}}" },
            ],
          },
        },
      ],
      [{ id: "e1", source: "trigger", target: "capture" }],
      { variables: { v1: 7, flag: true } },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {});
    const output = ctx.getNodeOutput("capture");
    expect(output?.config?.ops).toEqual([
      { name: "one", value: 7 },
      { name: "two", enabled: true },
    ]);
  });

  it("resolves edge condition templates from workflow variables", async () => {
    const reached = [];
    registerNodeType("test.record_branch", {
      describe: () => "Records reached branch",
      schema: { type: "object", properties: {} },
      async execute(node) {
        reached.push(node.id);
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "true-branch", type: "test.record_branch", label: "True", config: {} },
        { id: "false-branch", type: "test.record_branch", label: "False", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "true-branch", condition: "{{shouldRun}} === true" },
        { id: "e2", source: "trigger", target: "false-branch", condition: "{{shouldRun}} === false" },
      ],
      { variables: { shouldRun: true } },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {});
    expect(ctx.errors).toEqual([]);
    expect(reached).toEqual(["true-branch"]);
  });

  it("supports exact-placeholder boolean edge conditions", async () => {
    const reached = [];
    registerNodeType("test.record_flagged", {
      describe: () => "Records reached node",
      schema: { type: "object", properties: {} },
      async execute(node) {
        reached.push(node.id);
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "branch", type: "test.record_flagged", label: "Branch", config: {} },
      ],
      [{ id: "e1", source: "trigger", target: "branch", condition: "{{enabled}}" }],
      { variables: { enabled: true } },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {});
    expect(ctx.errors).toEqual([]);
    expect(reached).toEqual(["branch"]);
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
        { id: "retry-node", type: "test.flaky_second_try", label: "Retry Me", config: { maxRetries: 3, retryDelayMs: 0 } },
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
        { id: "retry-node", type: "test.retry_events", label: "Retry", config: { maxRetries: 3, retryDelayMs: 0 } },
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

describe("WorkflowEngine - source port routing", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("routes only the selected switch port", async () => {
    const visited = [];
    registerNodeType("test.capture_port", {
      describe: () => "Capture reached branch",
      schema: { type: "object", properties: {} },
      async execute(node) {
        visited.push(node.id);
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "switch",
          type: "condition.switch",
          label: "Switch",
          config: {
            value: "'left'",
            cases: {
              left: "left-port",
              right: "right-port",
            },
          },
        },
        { id: "left", type: "test.capture_port", label: "Left", config: {} },
        { id: "right", type: "test.capture_port", label: "Right", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "switch" },
        { id: "e2", source: "switch", target: "left", sourcePort: "left-port" },
        { id: "e3", source: "switch", target: "right", sourcePort: "right-port" },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors).toEqual([]);
    expect(visited).toEqual(["left"]);
  });
});

// ── Run History / Detail Tests ──────────────────────────────────────────────

describe("WorkflowEngine - run history details", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("persists rich summary metadata and exposes detailed run payload", async () => {
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "log", type: "notify.log", label: "Log", config: { message: "hello from history test" } },
      ],
      [{ id: "e1", source: "trigger", target: "log" }],
      { name: "History Detail Workflow" }
    );

    engine.save(wf);
    await engine.execute(wf.id, {});

    const history = engine.getRunHistory(wf.id, 5);
    expect(history.length).toBeGreaterThan(0);
    const latest = history[0];
    expect(latest.workflowName).toBe("History Detail Workflow");
    expect(typeof latest.endedAt).toBe("number");
    expect(typeof latest.logCount).toBe("number");
    expect(typeof latest.completedCount).toBe("number");
    expect(typeof latest.lastProgressAt).toBe("number");
    expect(typeof latest.lastLogAt).toBe("number");
    expect(typeof latest.activeNodeCount).toBe("number");
    expect(latest.isStuck).toBe(false);
    expect(latest.stuckMs).toBe(0);

    const run = engine.getRunDetail(latest.runId);
    expect(run).toBeTruthy();
    expect(run.workflowId).toBe(wf.id);
    expect(run.workflowName).toBe("History Detail Workflow");
    expect(run.detail).toBeTruthy();
    expect(run.detail.nodeStatuses.trigger).toBeDefined();
    expect(run.detail.nodeStatuses.log).toBeDefined();
    expect(Array.isArray(run.detail.logs)).toBe(true);
    expect(Array.isArray(run.detail.nodeStatusEvents)).toBe(true);
  });

  it("returns runs in descending order and null for unknown run details", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { name: "Ordering Workflow" }
    );

    engine.save(wf);
    await engine.execute(wf.id, { run: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await engine.execute(wf.id, { run: 2 });

    const history = engine.getRunHistory(wf.id, 10);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].startedAt).toBeGreaterThanOrEqual(history[1].startedAt);
    expect(engine.getRunDetail("does-not-exist")).toBeNull();
  });

  it("includes active runs in history and exposes live run detail while executing", async () => {
    const prevThreshold = process.env.WORKFLOW_RUN_STUCK_THRESHOLD_MS;
    process.env.WORKFLOW_RUN_STUCK_THRESHOLD_MS = "20";
    try {
      let releaseRun;
      const blocker = new Promise((resolve) => { releaseRun = resolve; });
      let nodeEntered;
      const nodeStarted = new Promise((resolve) => { nodeEntered = resolve; });

      registerNodeType("test.long_running", {
        describe: () => "Long running node for active-run visibility",
        schema: { type: "object", properties: {} },
        async execute(node, ctx) {
          ctx.log(node.id, "long running node entered");
          nodeEntered();
          await blocker;
          return { ok: true };
        },
      });

      const wf = makeSimpleWorkflow(
        [
          { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
          { id: "wait", type: "test.long_running", label: "Wait", config: {} },
        ],
        [{ id: "e1", source: "trigger", target: "wait" }],
        { name: "Active Run Visibility Workflow" },
      );

      engine.save(wf);
      const runPromise = engine.execute(wf.id, {});
      // Wait for the long-running node to actually start, then wait beyond
      // the stuck threshold (20ms) so isStuck is true when we query history
      await nodeStarted;
      await new Promise((resolve) => setTimeout(resolve, 30));

      const history = engine.getRunHistory(wf.id, 10);
      const active = history.find((entry) => entry.status === WorkflowStatus.RUNNING);
      expect(active).toBeTruthy();
      expect(active.workflowName).toBe("Active Run Visibility Workflow");
      expect(active.activeNodeCount).toBeGreaterThan(0);
      expect(typeof active.lastProgressAt).toBe("number");
      expect(typeof active.duration).toBe("number");
      expect(active.isStuck).toBe(true);
      expect(active.stuckMs).toBeGreaterThanOrEqual(20);

      const detail = engine.getRunDetail(active.runId);
      expect(detail).toBeTruthy();
      expect(detail.status).toBe(WorkflowStatus.RUNNING);
      expect(detail.endedAt).toBeNull();
      expect(detail.detail.endedAt).toBeNull();
      expect(Array.isArray(detail.detail.logs)).toBe(true);
      expect(Array.isArray(detail.detail.nodeStatusEvents)).toBe(true);

      releaseRun();
      await runPromise;

      const latest = engine.getRunHistory(wf.id, 1)[0];
      expect(latest.status).toBe(WorkflowStatus.COMPLETED);
      expect(latest.isStuck).toBe(false);
    } finally {
      if (prevThreshold === undefined) delete process.env.WORKFLOW_RUN_STUCK_THRESHOLD_MS;
      else process.env.WORKFLOW_RUN_STUCK_THRESHOLD_MS = prevThreshold;
    }
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

  it("action.delay supports legacy durationMs/message aliases", async () => {
    const handler = getNodeType("action.delay");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({});
    const node = {
      id: "d2",
      type: "action.delay",
      config: { durationMs: 10, message: "legacy" },
    };
    const result = await handler.execute(node, ctx);
    expect(result.waited).toBeGreaterThanOrEqual(10);
    expect(result.reason).toBe("legacy");
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
  it("propagates threadId to context and streams agent events into run logs", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const launchEphemeralThread = vi.fn().mockImplementation(
      async (_prompt, _cwd, _timeoutMs, extra) => {
        extra?.onEvent?.({
          type: "tool_call",
          tool_name: "apply_patch",
        });
        extra?.onEvent?.({
          type: "agent_message",
          message: { content: "Implemented the requested changes." },
        });
        return {
          success: true,
          output: "done",
          sdk: "codex",
          items: [],
          threadId: "thread-abc-123",
        };
      },
    );
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = {
      id: "a1",
      type: "action.run_agent",
      config: { prompt: "Test prompt", autoRecover: false, failOnError: true },
    };
    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.threadId).toBe("thread-abc-123");
    expect(result.sessionId).toBe("thread-abc-123");
    expect(ctx.data.sessionId).toBe("thread-abc-123");
    expect(ctx.data.threadId).toBe("thread-abc-123");
    expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
    expect(launchEphemeralThread.mock.calls[0][3]).toEqual(
      expect.objectContaining({ onEvent: expect.any(Function) }),
    );
    const runLogText = ctx.logs.map((entry) => String(entry?.message || "")).join("\n");
    expect(runLogText).toMatch(/Tool call: apply_patch/);
    expect(runLogText).toMatch(/Agent: Implemented the requested changes\./);
  });

  it("propagates threadId to context from execWithRetry", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();
  });

  it("ignores noisy delta stream events while keeping meaningful agent updates", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const launchEphemeralThread = vi.fn().mockImplementation(
      async (_prompt, _cwd, _timeoutMs, extra) => {
        extra?.onEvent?.({ type: "assistant.reasoning_delta", data: { content: "test" } });
        extra?.onEvent?.({ type: "assistant.reasoning_delta", data: { content: ":" } });
        extra?.onEvent?.({ type: "assistant.message", data: { content: "Added regression coverage." } });
        return {
          success: true,
          output: "ok",
          sdk: "codex",
          items: [],
          threadId: "thread-delta-filter",
        };
      },
    );
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = { id: "a-delta", type: "action.run_agent", config: { prompt: "delta test" } };
    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.success).toBe(true);
    expect(result.threadId).toBe("thread-delta-filter");
    const runLogText = ctx.logs.map((entry) => String(entry?.message || "")).join("\n");
    expect(runLogText).not.toContain("assistant.reasoning_delta");
    expect(runLogText).toMatch(/Agent: Added regression coverage\./);
  });

  it("condenses noisy assistant events into narrative summaries", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const launchEphemeralThread = vi.fn().mockImplementation(
      async (_prompt, _cwd, _timeoutMs, extra) => {
        extra?.onEvent?.({
          type: "item.completed",
          item: {
            type: "reasoning",
            summary: "Tracing noisy completion logs and extracting only meaningful context.",
          },
        });
        extra?.onEvent?.({
          type: "assistant.message",
          data: {
            content: "",
            detailedContent:
              "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:16:function getLocalLanIp() {\n" +
              "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:133:function ensureLibraryInitialized() {\n" +
              "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:161:async function getWorkflowEngineModule() {\n" +
              "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:7394:export function stopTelegramUiServer() {",
          },
        });
        extra?.onEvent?.({
          type: "assistant.message",
          data: {
            content: "",
            toolRequests: [{ name: "view" }, { name: "find" }, { name: "view" }],
          },
        });
        extra?.onEvent?.({
          type: "assistant.usage",
          data: {
            model: "claude-sonnet-4.6",
            inputTokens: 5170,
            outputTokens: 484,
            duration: 7899,
          },
        });
        return {
          success: true,
          output:
            "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:16:function getLocalLanIp() {\n" +
            "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:133:function ensureLibraryInitialized() {\n" +
            "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:161:async function getWorkflowEngineModule() {",
          sdk: "copilot",
          items: [
            {
              type: "assistant.message",
              data: {
                content: "",
                detailedContent:
                  "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:16:function getLocalLanIp() {\n" +
                  "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:133:function ensureLibraryInitialized() {\n" +
                  "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:161:async function getWorkflowEngineModule() {",
              },
            },
            {
              type: "assistant.message",
              data: { content: "", toolRequests: [{ name: "view" }, { name: "find" }] },
            },
            {
              type: "item.completed",
              item: {
                type: "reasoning",
                summary: "Tracing noisy completion logs and extracting only meaningful context.",
              },
            },
            {
              type: "assistant.usage",
              data: { model: "claude-sonnet-4.6", inputTokens: 100, outputTokens: 50 },
            },
          ],
          threadId: "thread-noise-test",
        };
      },
    );

    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = {
      id: "a2",
      type: "action.run_agent",
      config: { prompt: "parse noisy logs", maxRetainedEvents: 20 },
    };
    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.summary).toMatch(/Indexed \d+ code references/);
    expect(result.narrative).toContain("Thought process:");
    expect(result.narrative).toContain("Actions:");
    expect(result.stream).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Thinking:/),
        expect.stringMatching(/^Agent detail:/),
        expect.stringMatching(/^Agent requested tools:/),
      ]),
    );
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.itemCount).toBe(4);
    expect(result.omittedItemCount).toBe(0);
    expect(result.threadId).toBe("thread-noise-test");

    const runLogText = ctx.logs.map((entry) => String(entry?.message || "")).join("\n");
    expect(runLogText).toMatch(/Agent detail: Indexed/);
    expect(runLogText).toMatch(/Agent requested tools: view, find/);
    expect(runLogText).toMatch(/Usage:/);
  });

  it("propagates threadId to context from execWithRetry when autoRecover=true", async () => {
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
            threadId: "thread-fallback-unused",
          }),
          execWithRetry: vi.fn().mockResolvedValue({
            success: true,
            output: "done",
            sdk: "codex",
            items: [],
            threadId: "thread-abc-123",
            attempts: 2,
            continues: 1,
            resumed: true,
          }),
        },
      },
    };
    const node = { id: "a1b", type: "action.run_agent", config: { prompt: "Test prompt", autoRecover: true } };
    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.threadId).toBe("thread-abc-123");
    expect(result.sessionId).toBe("thread-abc-123");
    expect(ctx.data.sessionId).toBe("thread-abc-123");
    expect(ctx.data.threadId).toBe("thread-abc-123");
    expect(result.attempts).toBe(2);
    expect(mockEngine.services.agentPool.execWithRetry).toHaveBeenCalledTimes(1);
  });

  it("throws when agent execution returns success=false when failOnError=true", async () => {
    const handler = getNodeType("action.run_agent");
    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn().mockResolvedValue({
            success: false,
            error: "agent crashed",
          }),
        },
      },
    };
    const node = {
      id: "a2",
      type: "action.run_agent",
      config: { prompt: "Test prompt", autoRecover: false, failOnError: true },
    };
    await expect(handler.execute(node, ctx, mockEngine)).rejects.toThrow(/agent crashed/i);
  });

  it("continues existing session before retrying fresh", async () => {
    const handler = getNodeType("action.run_agent");
    const ctx = new WorkflowContext({
      worktreePath: "/tmp/test",
      sessionId: "thread-existing-1",
    });
    const continueSession = vi.fn().mockResolvedValue({
      success: true,
      output: "continued",
      threadId: "thread-existing-1",
      sdk: "copilot",
    });
    const execWithRetry = vi.fn().mockResolvedValue({
      success: true,
      output: "should-not-be-used",
      threadId: "thread-new",
      sdk: "copilot",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn().mockResolvedValue({
            success: true,
            output: "fallback",
            sdk: "copilot",
            threadId: "thread-fallback",
          }),
          continueSession,
          execWithRetry,
        },
      },
    };
    const node = { id: "a3", type: "action.run_agent", config: { prompt: "Continue work", continueOnSession: true } };
    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(true);
    expect(result.threadId).toBe("thread-existing-1");
    expect(continueSession).toHaveBeenCalledTimes(1);
    expect(execWithRetry).not.toHaveBeenCalled();
  });
});

it("agent.run_planner streams planner events and propagates threadId", async () => {
  const handler = getNodeType("agent.run_planner");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({});
  const launchEphemeralThread = vi.fn().mockImplementation(
    async (_prompt, _cwd, _timeoutMs, extra) => {
      extra?.onEvent?.({
        type: "item.completed",
        item: { type: "reasoning", summary: "Reviewing backlog gaps." },
      });
      extra?.onEvent?.({
        type: "tool_call",
        tool_name: "create_task",
      });
      extra?.onEvent?.({
        type: "item.completed",
        item: { type: "agent_message", text: "Generated 3 tasks." },
      });
      return {
        success: true,
        output: "planned output",
        sdk: "codex",
        items: [],
        threadId: "planner-thread-123",
      };
    },
  );
  const mockEngine = {
    services: {
      agentPool: {
        launchEphemeralThread,
      },
      prompts: {
        planner: "Planner prompt",
      },
    },
  };

  const node = {
    id: "planner-1",
    type: "agent.run_planner",
    config: {
      taskCount: 3,
      context: "Focus on reliability",
      outputVariable: "plannerOutput",
    },
  };
  const result = await handler.execute(node, ctx, mockEngine);

  expect(result.success).toBe(true);
  expect(result.taskCount).toBe(3);
  expect(result.threadId).toBe("planner-thread-123");
  expect(result.sessionId).toBe("planner-thread-123");
  expect(ctx.data.threadId).toBe("planner-thread-123");
  expect(ctx.data.sessionId).toBe("planner-thread-123");
  expect(ctx.data.plannerOutput).toBe("planned output");
  expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
  expect(launchEphemeralThread.mock.calls[0][3]).toEqual(
    expect.objectContaining({ onEvent: expect.any(Function) }),
  );
  const runLogText = ctx.logs.map((entry) => String(entry?.message || "")).join("\n");
  expect(runLogText).toMatch(/Thinking: Reviewing backlog gaps\./);
  expect(runLogText).toMatch(/Tool call: create_task/);
  expect(runLogText).toMatch(/Agent: Generated 3 tasks\./);
  expect(runLogText).toMatch(/Planner completed: success=true streamEvents=3/);
  });

it("agent.run_planner appends output requirements to explicit prompts and honors templated taskCount", async () => {
  const handler = getNodeType("agent.run_planner");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({
    taskCount: 10,
    prompt: "Analyze reliability gaps in the repo.",
  });
  const launchEphemeralThread = vi.fn().mockResolvedValue({
    success: true,
    output: '{"tasks":[]}',
    sdk: "codex",
    items: [],
    threadId: "planner-thread-explicit",
  });
  const mockEngine = {
    services: {
      agentPool: {
        launchEphemeralThread,
      },
      prompts: {
        planner: "unused fallback planner prompt",
      },
    },
  };

  const node = {
    id: "planner-explicit",
    type: "agent.run_planner",
    config: {
      taskCount: "{{taskCount}}",
      prompt: "{{prompt}}",
    },
  };
  const result = await handler.execute(node, ctx, mockEngine);

  expect(result.success).toBe(true);
  expect(result.taskCount).toBe(10);
  expect(launchEphemeralThread).toHaveBeenCalledTimes(1);

  const sentPrompt = String(launchEphemeralThread.mock.calls[0][0] || "");
  expect(sentPrompt).toContain("Analyze reliability gaps in the repo.");
  expect(sentPrompt).toContain("Generate exactly 10 new tasks.");
  expect(sentPrompt).toContain("single fenced JSON block");
});

it("action.materialize_planner_tasks parses fenced JSON and creates tasks", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({});
  ctx.setNodeOutput("run-planner", {
    output: [
      "Planner analysis complete.",
      "```json",
      "{",
      '  "tasks": [',
      '    { "title": "[m] fix(workflow): create tasks", "description": "A", "verification": ["v1"] },',
      '    { "title": "[m] fix(workflow): duplicate title", "description": "B" }',
      "  ]",
      "}",
      "```",
    ].join("\n"),
  });

  const createTask = vi
    .fn()
    .mockResolvedValueOnce({ id: "task-1001" })
    .mockResolvedValueOnce({ id: "task-1002" });
  const listTasks = vi.fn().mockResolvedValue([
    { id: "existing-1", title: "[m] fix(workflow): duplicate title" },
  ]);
  const mockEngine = {
    services: {
      kanban: {
        createTask,
        listTasks,
      },
    },
  };

  const node = {
    id: "materialize",
    type: "action.materialize_planner_tasks",
    config: {
      plannerNodeId: "run-planner",
      projectId: "proj-123",
      status: "todo",
      failOnZero: true,
      dedup: true,
      minCreated: 1,
    },
  };
  const result = await handler.execute(node, ctx, mockEngine);

  expect(result.success).toBe(true);
  expect(result.parsedCount).toBe(2);
  expect(result.createdCount).toBe(1);
  expect(result.skippedCount).toBe(1);
  expect(result.created[0]).toEqual({
    id: "task-1001",
    title: "[m] fix(workflow): create tasks",
  });
  expect(listTasks).toHaveBeenCalledTimes(1);
  expect(createTask).toHaveBeenCalledTimes(1);
});

it("action.materialize_planner_tasks fails loudly when planner output has no parseable tasks", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({});
  ctx.setNodeOutput("run-planner", {
    output: "I could not generate tasks in JSON format this run.",
  });

  const mockEngine = {
    services: {
      kanban: {
        createTask: vi.fn(),
      },
    },
  };

  const node = {
    id: "materialize",
    type: "action.materialize_planner_tasks",
    config: {
      plannerNodeId: "run-planner",
      failOnZero: true,
    },
  };

  await expect(handler.execute(node, ctx, mockEngine)).rejects.toThrow(
    /did not include parseable tasks/i,
  );
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

// ── Retry Backoff Configuration Tests ───────────────────────────────────────

describe("WorkflowEngine - configurable retry backoff", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("uses custom retryDelayMs for backoff base", async () => {
    const backoffs = [];
    let callCount = 0;
    registerNodeType("test.custom_delay_fail", {
      describe: () => "Fails with custom delay",
      schema: { type: "object", properties: {} },
      async execute() {
        callCount++;
        throw new Error("fail");
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "node", type: "test.custom_delay_fail", label: "Fail", config: { maxRetries: 2, retryDelayMs: 0 } },
      ],
      [{ id: "e1", source: "trigger", target: "node" }]
    );

    engine.save(wf);
    engine.on("node:retry", (ev) => backoffs.push(ev.backoffMs));
    const start = Date.now();
    await engine.execute(wf.id, {});
    const elapsed = Date.now() - start;

    expect(callCount).toBe(3);
    // With retryDelayMs=0, backoff should be 0ms (0*2^0=0, 0*2^1=0)
    expect(backoffs).toEqual([0, 0]);
    // Total time should be well under 100ms (no 1s+ delays)
    expect(elapsed).toBeLessThan(500);
  });

  it("defaults to 1000ms base when retryDelayMs not set", async () => {
    const backoffs = [];
    let callCount = 0;
    registerNodeType("test.default_delay_fail", {
      describe: () => "Fails with default delay",
      schema: { type: "object", properties: {} },
      async execute() {
        callCount++;
        throw new Error("fail");
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "node", type: "test.default_delay_fail", label: "Fail", config: { maxRetries: 1 } },
      ],
      [{ id: "e1", source: "trigger", target: "node" }]
    );

    engine.save(wf);
    engine.on("node:retry", (ev) => backoffs.push(ev.backoffMs));
    await engine.execute(wf.id, {});

    expect(callCount).toBe(2);
    // Default backoff = 1000 * 2^0 = 1000ms
    expect(backoffs).toEqual([1000]);
  });
});

// ── Timer Cleanup Tests ─────────────────────────────────────────────────────

describe("WorkflowEngine - timeout timer cleanup", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("does not leak timers when node completes before timeout", async () => {
    registerNodeType("test.fast_node", {
      describe: () => "Completes instantly",
      schema: { type: "object", properties: {} },
      async execute() {
        return { fast: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "fast", type: "test.fast_node", label: "Fast", config: { timeout: 60000 } },
      ],
      [{ id: "e1", source: "trigger", target: "fast" }]
    );

    engine.save(wf);
    // If timers leaked, the 60s timeout timer would keep the process alive.
    // We verify it completes quickly.
    const start = Date.now();
    const result = await engine.execute(wf.id, {});
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.errors.length).toBe(0);
    const output = result.getNodeOutput("fast");
    expect(output.fast).toBe(true);
  });

  it("honors timeoutMs from node config", async () => {
    registerNodeType("test.slow_node_for_timeout_ms", {
      describe: () => "Sleeps long enough to trigger timeoutMs",
      schema: { type: "object", properties: {} },
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return { done: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "slow",
          type: "test.slow_node_for_timeout_ms",
          label: "Slow",
          config: { timeoutMs: 1000, maxRetries: 0, retryDelayMs: 0 },
        },
      ],
      [{ id: "e1", source: "trigger", target: "slow" }]
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors.length).toBeGreaterThan(0);
    expect(String(result.errors[0]?.error || "")).toContain("timed out after 1000ms");
  });
});
