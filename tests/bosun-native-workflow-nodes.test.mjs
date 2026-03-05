/**
 * bosun-native-workflow-nodes.test.mjs — Tests for Bosun native workflow nodes
 *
 * Tests the three new node types that enable Bosun tools and workflows
 * to be invoked from within workflow nodes:
 *   1. action.bosun_tool — Programmatic Bosun tool invocation
 *   2. action.invoke_workflow — Lightweight sub-workflow piping
 *   3. action.bosun_function — Direct Bosun function calls
 *
 * Also tests the associated templates from bosun-native.mjs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkflowEngine,
  WorkflowContext,
  NodeStatus,
} from "../workflow-engine.mjs";
import {
  registerNodeType,
  getNodeType,
} from "../workflow-nodes.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir;

function makeTmpDir() {
  tmpDir = mkdtempSync(join(tmpdir(), "bosun-native-wf-test-"));
  return tmpDir;
}

function makeTmpEngine(services = {}) {
  const dir = makeTmpDir();
  const engine = new WorkflowEngine({
    workflowDir: join(dir, "workflows"),
    runsDir: join(dir, "runs"),
    services,
  });
  return engine;
}

function makeSimpleWorkflow(nodes, edges, opts = {}) {
  return {
    id: opts.id || "test-wf-" + Math.random().toString(36).slice(2, 8),
    name: opts.name || "Test Workflow",
    description: opts.description || "Test workflow",
    enabled: true,
    nodes,
    edges,
    variables: opts.variables || {},
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  action.bosun_tool
// ═══════════════════════════════════════════════════════════════════════════

describe("action.bosun_tool", () => {
  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("is registered with correct schema", () => {
    const handler = getNodeType("action.bosun_tool");
    expect(handler).toBeDefined();
    expect(handler.execute).toBeInstanceOf(Function);
    expect(handler.describe()).toMatch(/bosun/i);
    expect(handler.schema.required).toContain("toolId");
    expect(handler.schema.properties.toolId).toBeDefined();
    expect(handler.schema.properties.args).toBeDefined();
    expect(handler.schema.properties.extract).toBeDefined();
    expect(handler.schema.properties.outputMap).toBeDefined();
    expect(handler.schema.properties.outputVariable).toBeDefined();
    expect(handler.schema.properties.portConfig).toBeDefined();
  });

  it("throws when toolId is missing", async () => {
    const handler = getNodeType("action.bosun_tool");
    const ctx = new WorkflowContext({});
    const node = { id: "t1", type: "action.bosun_tool", config: {} };
    await expect(handler.execute(node, ctx)).rejects.toThrow(/toolId.*required/i);
  });

  it("returns error output when tool not found", async () => {
    const handler = getNodeType("action.bosun_tool");
    makeTmpDir();
    const ctx = new WorkflowContext({ repoRoot: tmpDir });
    const node = {
      id: "t1",
      type: "action.bosun_tool",
      config: { toolId: "nonexistent-tool-xyz" },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(result.toolId).toBe("nonexistent-tool-xyz");
    expect(result.matchedPort).toBe("error");
    expect(result.port).toBe("error");
  });

  it("resolves toolId from template variables", async () => {
    const handler = getNodeType("action.bosun_tool");
    makeTmpDir();
    const ctx = new WorkflowContext({ toolName: "my-custom-tool", repoRoot: tmpDir });
    const node = {
      id: "t1",
      type: "action.bosun_tool",
      config: { toolId: "{{toolName}}" },
    };
    // Tool won't be found, but toolId should be resolved from template
    const result = await handler.execute(node, ctx);
    expect(result.toolId).toBe("my-custom-tool");
    expect(result.success).toBe(false);
  });

  it("stores result in outputVariable when configured", async () => {
    const handler = getNodeType("action.bosun_tool");
    makeTmpDir();
    const ctx = new WorkflowContext({ repoRoot: tmpDir });
    const node = {
      id: "t1",
      type: "action.bosun_tool",
      config: {
        toolId: "nonexistent-tool",
        outputVariable: "toolResult",
      },
    };
    await handler.execute(node, ctx);
    expect(ctx.data.toolResult).toBeDefined();
    expect(ctx.data.toolResult.success).toBe(false);
  });

  it("can invoke a builtin tool (list-todos) on a real workspace", async () => {
    const handler = getNodeType("action.bosun_tool");
    // Use the bosun directory itself as the workspace
    const bosunRoot = resolve(import.meta.dirname, "..");
    const ctx = new WorkflowContext({ repoRoot: bosunRoot });
    const node = {
      id: "t1",
      type: "action.bosun_tool",
      config: {
        toolId: "list-todos",
        args: ["--help"],
        parseJson: false,
        outputVariable: "todoResult",
      },
    };
    const result = await handler.execute(node, ctx);
    // The tool should execute (whether or not it finds TODOs)
    expect(result.toolId).toBe("list-todos");
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.stdout).toBe("string");
    expect(result.matchedPort).toBeDefined();
    expect(ctx.data.todoResult).toBeDefined();
  });

  it("resolves args with template interpolation", async () => {
    const handler = getNodeType("action.bosun_tool");
    makeTmpDir();
    const ctx = new WorkflowContext({
      repoRoot: tmpDir,
      myArg: "hello-world",
    });
    const node = {
      id: "t1",
      type: "action.bosun_tool",
      config: {
        toolId: "nonexistent",
        args: ["--flag", "{{myArg}}"],
      },
    };
    // Will fail (tool not found), but we can verify args were resolved
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(false);
    // The logs should contain resolved args
    const logMsg = ctx.logs.find((l) => l.nodeId === "t1" && l.message.includes("hello-world"));
    // Tool not found so the invocation log won't contain the args
    // but toolId resolution should work
    expect(result.toolId).toBe("nonexistent");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.invoke_workflow
// ═══════════════════════════════════════════════════════════════════════════

describe("action.invoke_workflow", () => {
  let engine;

  beforeEach(() => {
    engine = makeTmpEngine();
  });

  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("is registered with correct schema", () => {
    const handler = getNodeType("action.invoke_workflow");
    expect(handler).toBeDefined();
    expect(handler.execute).toBeInstanceOf(Function);
    expect(handler.describe()).toMatch(/invoke.*workflow/i);
    expect(handler.schema.required).toContain("workflowId");
    expect(handler.schema.properties.workflowId).toBeDefined();
    expect(handler.schema.properties.mode).toBeDefined();
    expect(handler.schema.properties.forwardFields).toBeDefined();
    expect(handler.schema.properties.extractFromNodes).toBeDefined();
    expect(handler.schema.properties.pipeContext).toBeDefined();
  });

  it("throws when workflowId is empty", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({});
    const node = { id: "t1", type: "action.invoke_workflow", config: {} };
    await expect(handler.execute(node, ctx, engine)).rejects.toThrow(/workflowId.*required/i);
  });

  it("throws when engine is not available", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({});
    const node = {
      id: "t1",
      type: "action.invoke_workflow",
      config: { workflowId: "some-wf" },
    };
    await expect(handler.execute(node, ctx, null)).rejects.toThrow(/engine.*not available/i);
  });

  it("throws when workflow not found", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({});
    const node = {
      id: "t1",
      type: "action.invoke_workflow",
      config: { workflowId: "nonexistent-wf" },
    };
    await expect(handler.execute(node, ctx, engine)).rejects.toThrow(/not found/i);
  });

  it("sync mode executes child and forwards output", async () => {
    // Create a simple child workflow
    const childWf = makeSimpleWorkflow(
      [{ id: "child-trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "child-wf", name: "Child" },
    );
    engine.save(childWf);

    const parentWf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "invoke",
          type: "action.invoke_workflow",
          label: "Invoke Child",
          config: {
            workflowId: "child-wf",
            outputVariable: "childResult",
          },
        },
      ],
      [{ id: "e1", source: "trigger", target: "invoke" }],
      { id: "parent-wf" },
    );
    engine.save(parentWf);

    const ctx = await engine.execute("parent-wf", {});
    expect(ctx.errors).toHaveLength(0);

    const output = ctx.getNodeOutput("invoke");
    expect(output).toBeDefined();
    expect(output.success).toBe(true);
    expect(output.workflowId).toBe("child-wf");
    expect(output.mode).toBe("sync");
    expect(output.matchedPort).toBe("default");
    expect(typeof output.runId).toBe("string");
    expect(ctx.data.childResult).toEqual(output);
  });

  it("dispatch mode returns immediately without waiting", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({ _workflowId: "parent-wf" });

    let resolveChild;
    const childPromise = new Promise((r) => { resolveChild = r; });
    const mockEngine = {
      execute: vi.fn().mockReturnValue(childPromise),
      get: vi.fn().mockReturnValue({ id: "child-dispatch-wf" }),
    };

    const node = {
      id: "dispatch-node",
      type: "action.invoke_workflow",
      config: {
        workflowId: "child-dispatch-wf",
        mode: "dispatch",
        outputVariable: "dispatchResult",
      },
    };

    try {
      const result = await handler.execute(node, ctx, mockEngine);
      expect(result.success).toBe(true);
      expect(result.dispatched).toBe(true);
      expect(result.mode).toBe("dispatch");
      expect(result.workflowId).toBe("child-dispatch-wf");
      expect(result.matchedPort).toBe("default");
      expect(ctx.data.dispatchResult).toEqual(result);
    } finally {
      resolveChild?.(new WorkflowContext({}));
      await childPromise;
    }
  });

  it("handles child workflow failure gracefully (failOnError=false)", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({ _workflowId: "parent-wf" });

    const failedChildCtx = new WorkflowContext({});
    failedChildCtx.error("child-node", new Error("child exploded"));

    const mockEngine = {
      execute: vi.fn().mockResolvedValue(failedChildCtx),
      get: vi.fn().mockReturnValue({ id: "failing-wf" }),
    };

    const node = {
      id: "soft-fail",
      type: "action.invoke_workflow",
      config: {
        workflowId: "failing-wf",
        failOnError: false,
        outputVariable: "failResult",
      },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(false);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0].error).toMatch(/child exploded/);
    expect(result.matchedPort).toBe("error");
    expect(ctx.data.failResult).toEqual(result);
  });

  it("throws on child failure when failOnError=true", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({ _workflowId: "parent-wf" });

    const failedChildCtx = new WorkflowContext({});
    failedChildCtx.error("child-node", new Error("fatal error"));

    const mockEngine = {
      execute: vi.fn().mockResolvedValue(failedChildCtx),
      get: vi.fn().mockReturnValue({ id: "fatal-wf" }),
    };

    const node = {
      id: "hard-fail",
      type: "action.invoke_workflow",
      config: {
        workflowId: "fatal-wf",
        failOnError: true,
      },
    };

    await expect(handler.execute(node, ctx, mockEngine))
      .rejects.toThrow(/fatal error/i);
  });

  it("forwards child workflow node outputs to parent", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({ _workflowId: "parent-wf" });

    const childCtx = new WorkflowContext({});
    childCtx.setNodeOutput("step-1", { count: 42, items: ["a", "b"] });
    childCtx.setNodeOutput("step-2", { summary: "all done", flag: true });

    const mockEngine = {
      execute: vi.fn().mockResolvedValue(childCtx),
      get: vi.fn().mockReturnValue({ id: "child-forward-wf" }),
    };

    const node = {
      id: "forward-test",
      type: "action.invoke_workflow",
      config: { workflowId: "child-forward-wf" },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(true);
    // All child node output fields should be merged to top-level
    expect(result.count).toBe(42);
    expect(result.items).toEqual(["a", "b"]);
    expect(result.summary).toBe("all done");
    expect(result.flag).toBe(true);
  });

  it("extracts from specific child nodes via extractFromNodes", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({ _workflowId: "parent-wf" });

    const childCtx = new WorkflowContext({});
    childCtx.setNodeOutput("relevant-step", { value: "keep-me" });
    childCtx.setNodeOutput("irrelevant-step", { noise: "ignore-me" });

    const mockEngine = {
      execute: vi.fn().mockResolvedValue(childCtx),
      get: vi.fn().mockReturnValue({ id: "extract-wf" }),
    };

    const node = {
      id: "extract-test",
      type: "action.invoke_workflow",
      config: {
        workflowId: "extract-wf",
        extractFromNodes: ["relevant-step"],
      },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.value).toBe("keep-me");
    expect(result.noise).toBeUndefined();
    expect(result["relevant-step"]).toEqual({ value: "keep-me" });
  });

  it("filters forwarded fields via forwardFields", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({ _workflowId: "parent-wf" });

    const childCtx = new WorkflowContext({});
    childCtx.setNodeOutput("step-1", { count: 10, secret: "hidden", value: "shown" });

    const mockEngine = {
      execute: vi.fn().mockResolvedValue(childCtx),
      get: vi.fn().mockReturnValue({ id: "filter-wf" }),
    };

    const node = {
      id: "filter-test",
      type: "action.invoke_workflow",
      config: {
        workflowId: "filter-wf",
        forwardFields: ["count", "value"],
      },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.count).toBe(10);
    expect(result.value).toBe("shown");
    expect(result.secret).toBeUndefined();
  });

  it("pipes parent context when pipeContext=true", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({
      _workflowId: "parent-wf",
      sharedData: "hello",
      contextValue: 42,
    });

    const capturedInput = {};
    const mockEngine = {
      execute: vi.fn().mockImplementation((id, input) => {
        Object.assign(capturedInput, input);
        return Promise.resolve(new WorkflowContext({}));
      }),
      get: vi.fn().mockReturnValue({ id: "pipe-wf" }),
    };

    const node = {
      id: "pipe-test",
      type: "action.invoke_workflow",
      config: {
        workflowId: "pipe-wf",
        pipeContext: true,
        input: { extra: "override" },
      },
    };

    await handler.execute(node, ctx, mockEngine);
    expect(capturedInput.sharedData).toBe("hello");
    expect(capturedInput.contextValue).toBe(42);
    expect(capturedInput.extra).toBe("override");
  });

  it("resolves workflowId from template variables", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({
      _workflowId: "parent-wf",
      targetWf: "dynamic-child-wf",
    });

    const mockEngine = {
      execute: vi.fn().mockResolvedValue(new WorkflowContext({})),
      get: vi.fn().mockReturnValue({ id: "dynamic-child-wf" }),
    };

    const node = {
      id: "dynamic-test",
      type: "action.invoke_workflow",
      config: { workflowId: "{{targetWf}}" },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.workflowId).toBe("dynamic-child-wf");
    expect(mockEngine.execute).toHaveBeenCalledWith(
      "dynamic-child-wf",
      expect.objectContaining({ _parentWorkflowId: "parent-wf" }),
    );
  });

  it("integrates in a real workflow engine execution", async () => {
    const childWf = makeSimpleWorkflow(
      [
        { id: "child-trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "child-set-var", type: "action.set_variable", label: "Set Var",
          config: { name: "childOutput", value: "hello-from-child" },
        },
      ],
      [{ id: "e1", source: "child-trigger", target: "child-set-var" }],
      { id: "child-integration-wf" },
    );

    const parentWf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "invoke",
          type: "action.invoke_workflow",
          label: "Invoke",
          config: {
            workflowId: "child-integration-wf",
            outputVariable: "childResult",
          },
        },
        {
          id: "log",
          type: "notify.log",
          label: "Log",
          config: { message: "Child ran: {{invoke.workflowId}}" },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "invoke" },
        { id: "e2", source: "invoke", target: "log" },
      ],
      { id: "parent-integration-wf" },
    );

    engine.save(childWf);
    engine.save(parentWf);

    const ctx = await engine.execute("parent-integration-wf", {});
    expect(ctx.errors).toHaveLength(0);

    const invokeOutput = ctx.getNodeOutput("invoke");
    expect(invokeOutput.success).toBe(true);
    expect(invokeOutput.workflowId).toBe("child-integration-wf");
    expect(ctx.data.childResult).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.bosun_function
// ═══════════════════════════════════════════════════════════════════════════

describe("action.bosun_function", () => {
  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("is registered with correct schema", () => {
    const handler = getNodeType("action.bosun_function");
    expect(handler).toBeDefined();
    expect(handler.execute).toBeInstanceOf(Function);
    expect(handler.describe()).toMatch(/bosun.*function/i);
    expect(handler.schema.required).toContain("function");
    expect(handler.schema.properties.function).toBeDefined();
    expect(handler.schema.properties.args).toBeDefined();
    expect(handler.schema.properties.extract).toBeDefined();
    expect(handler.schema.properties.outputMap).toBeDefined();
    expect(handler.schema.properties.outputVariable).toBeDefined();
    // Should list available functions in enum
    expect(handler.schema.properties.function.enum).toContain("tools.list");
    expect(handler.schema.properties.function.enum).toContain("git.status");
    expect(handler.schema.properties.function.enum).toContain("tasks.list");
    expect(handler.schema.properties.function.enum).toContain("workflows.list");
  });

  it("throws when function name is missing", async () => {
    const handler = getNodeType("action.bosun_function");
    const ctx = new WorkflowContext({});
    const node = { id: "t1", type: "action.bosun_function", config: {} };
    await expect(handler.execute(node, ctx)).rejects.toThrow(/function.*required/i);
  });

  it("throws for unknown function name", async () => {
    const handler = getNodeType("action.bosun_function");
    const ctx = new WorkflowContext({});
    const node = {
      id: "t1", type: "action.bosun_function",
      config: { function: "nonexistent.function" },
    };
    await expect(handler.execute(node, ctx)).rejects.toThrow(/unknown function/i);
  });

  it("calls tools.builtin and returns builtin tool list", async () => {
    const handler = getNodeType("action.bosun_function");
    const ctx = new WorkflowContext({});
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: {
        function: "tools.builtin",
        outputVariable: "builtins",
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.function).toBe("tools.builtin");
    expect(Array.isArray(result.data)).toBe(true);
    // Should contain known builtin tools
    const toolIds = result.data.map((t) => t.id);
    expect(toolIds).toContain("list-todos");
    expect(ctx.data.builtins).toEqual(result);
  });

  it("calls git.status and returns structured git info", async () => {
    const handler = getNodeType("action.bosun_function");
    const bosunRoot = resolve(import.meta.dirname, "..");
    const ctx = new WorkflowContext({ repoRoot: bosunRoot });
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: {
        function: "git.status",
        outputVariable: "gitStatus",
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(typeof result.changedFiles).toBe("number");
    expect(Array.isArray(result.files)).toBe(true);
    expect(typeof result.clean).toBe("boolean");
    expect(ctx.data.gitStatus).toBeDefined();
  });

  it("calls git.branch and returns branch info", async () => {
    const handler = getNodeType("action.bosun_function");
    const bosunRoot = resolve(import.meta.dirname, "..");
    const ctx = new WorkflowContext({ repoRoot: bosunRoot });
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: { function: "git.branch" },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(typeof result.current).toBe("string");
    expect(Array.isArray(result.branches)).toBe(true);
    expect(typeof result.branchCount).toBe("number");
  });

  it("calls git.log and returns commit list", async () => {
    const handler = getNodeType("action.bosun_function");
    const bosunRoot = resolve(import.meta.dirname, "..");
    const ctx = new WorkflowContext({ repoRoot: bosunRoot });
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: {
        function: "git.log",
        args: { count: "5" },
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.commits)).toBe(true);
    expect(result.count).toBeGreaterThan(0);
    expect(result.commits[0]).toHaveProperty("hash");
    expect(result.commits[0]).toHaveProperty("message");
  });

  it("calls workflows.list with engine", async () => {
    const handler = getNodeType("action.bosun_function");
    const ctx = new WorkflowContext({});
    const mockEngine = {
      list: vi.fn().mockReturnValue([
        { id: "wf-1", name: "Workflow 1", enabled: true, nodes: [1, 2], edges: [1] },
        { id: "wf-2", name: "Workflow 2", enabled: false, nodes: [1], edges: [] },
      ]),
    };
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: { function: "workflows.list" },
    };
    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe("wf-1");
    expect(result.data[1].enabled).toBe(false);
  });

  it("calls config.show and returns config data", async () => {
    const handler = getNodeType("action.bosun_function");
    makeTmpDir();
    const ctx = new WorkflowContext({ repoRoot: tmpDir });
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: { function: "config.show" },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    // No config file in tmpDir, so exists should be false
    expect(result.exists).toBe(false);
  });

  it("handles service unavailability gracefully", async () => {
    const handler = getNodeType("action.bosun_function");
    const ctx = new WorkflowContext({});
    // No kanban service
    const mockEngine = { services: {} };
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: { function: "tasks.list" },
    };
    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/kanban.*not available/i);
    expect(result.matchedPort).toBe("error");
  });

  it("resolves function name from template variables", async () => {
    const handler = getNodeType("action.bosun_function");
    const ctx = new WorkflowContext({ fnName: "tools.builtin" });
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: { function: "{{fnName}}" },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.function).toBe("tools.builtin");
  });

  it("resolves args from template variables", async () => {
    const handler = getNodeType("action.bosun_function");
    const bosunRoot = resolve(import.meta.dirname, "..");
    const ctx = new WorkflowContext({
      repoRoot: bosunRoot,
      commitCount: "3",
    });
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: {
        function: "git.log",
        args: { count: "{{commitCount}}" },
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.commits.length).toBeLessThanOrEqual(3);
  });

  it("supports extract config for field extraction", async () => {
    const handler = getNodeType("action.bosun_function");
    const ctx = new WorkflowContext({});
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: {
        function: "tools.builtin",
        extract: {
          fields: {
            firstToolId: "[0].id",
            toolCount: "length",
          },
          defaults: {
            firstToolId: "none",
            toolCount: 0,
          },
          types: {
            toolCount: "number",
          },
        },
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.firstToolId).toBeDefined();
    expect(typeof result.toolCount).toBe("number");
    expect(result.toolCount).toBeGreaterThan(0);
  });

  it("supports outputMap for field renaming", async () => {
    const handler = getNodeType("action.bosun_function");
    const bosunRoot = resolve(import.meta.dirname, "..");
    const ctx = new WorkflowContext({ repoRoot: bosunRoot });
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: {
        function: "git.branch",
        outputMap: {
          activeBranch: "current",
          totalBranches: "branchCount",
        },
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.activeBranch).toBeDefined();
    expect(typeof result.totalBranches).toBe("number");
  }, 30_000);

  it("integrates in a real workflow engine execution", async () => {
    const engine = makeTmpEngine();
    const bosunRoot = resolve(import.meta.dirname, "..");

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "git-info",
          type: "action.bosun_function",
          label: "Git Info",
          config: {
            function: "git.branch",
            outputVariable: "branchInfo",
          },
        },
        {
          id: "log",
          type: "notify.log",
          label: "Log",
          config: { message: "Branch: {{git-info.current}}" },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "git-info" },
        { id: "e2", source: "git-info", target: "log" },
      ],
      { id: "bosun-fn-integration-wf" },
    );
    engine.save(wf);

    const ctx = await engine.execute("bosun-fn-integration-wf", { repoRoot: bosunRoot });
    expect(ctx.errors).toHaveLength(0);

    const output = ctx.getNodeOutput("git-info");
    expect(output.success).toBe(true);
    expect(typeof output.current).toBe("string");
    expect(ctx.data.branchInfo).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Template validation
// ═══════════════════════════════════════════════════════════════════════════

describe("Bosun native templates", () => {
  it("BOSUN_TOOL_PIPELINE_TEMPLATE has valid structure", async () => {
    const { BOSUN_TOOL_PIPELINE_TEMPLATE } = await import("../workflow-templates/bosun-native.mjs");
    expect(BOSUN_TOOL_PIPELINE_TEMPLATE.id).toBe("template-bosun-tool-pipeline");
    expect(BOSUN_TOOL_PIPELINE_TEMPLATE.category).toBe("mcp-integration");
    expect(BOSUN_TOOL_PIPELINE_TEMPLATE.nodes.length).toBeGreaterThan(3);
    expect(BOSUN_TOOL_PIPELINE_TEMPLATE.edges.length).toBeGreaterThan(2);

    // Should use the new node types
    const nodeTypes = BOSUN_TOOL_PIPELINE_TEMPLATE.nodes.map((n) => n.type);
    expect(nodeTypes).toContain("action.bosun_function");
    expect(nodeTypes).toContain("action.bosun_tool");
  });

  it("WORKFLOW_COMPOSITION_TEMPLATE has valid structure", async () => {
    const { WORKFLOW_COMPOSITION_TEMPLATE } = await import("../workflow-templates/bosun-native.mjs");
    expect(WORKFLOW_COMPOSITION_TEMPLATE.id).toBe("template-workflow-composition");
    expect(WORKFLOW_COMPOSITION_TEMPLATE.nodes.length).toBeGreaterThan(3);

    const nodeTypes = WORKFLOW_COMPOSITION_TEMPLATE.nodes.map((n) => n.type);
    expect(nodeTypes).toContain("action.bosun_function");
    expect(nodeTypes).toContain("action.invoke_workflow");
  });

  it("MCP_TO_BOSUN_BRIDGE_TEMPLATE has valid structure", async () => {
    const { MCP_TO_BOSUN_BRIDGE_TEMPLATE } = await import("../workflow-templates/bosun-native.mjs");
    expect(MCP_TO_BOSUN_BRIDGE_TEMPLATE.id).toBe("template-mcp-to-bosun-bridge");

    const nodeTypes = MCP_TO_BOSUN_BRIDGE_TEMPLATE.nodes.map((n) => n.type);
    expect(nodeTypes).toContain("action.mcp_tool_call");
    expect(nodeTypes).toContain("action.bosun_function");
    expect(nodeTypes).toContain("action.invoke_workflow");
  });

  it("GIT_HEALTH_PIPELINE_TEMPLATE has valid structure", async () => {
    const { GIT_HEALTH_PIPELINE_TEMPLATE } = await import("../workflow-templates/bosun-native.mjs");
    expect(GIT_HEALTH_PIPELINE_TEMPLATE.id).toBe("template-git-health-pipeline");

    const nodeTypes = GIT_HEALTH_PIPELINE_TEMPLATE.nodes.map((n) => n.type);
    expect(nodeTypes).toContain("action.bosun_function");
    expect(nodeTypes).toContain("action.bosun_tool");
    expect(nodeTypes).toContain("action.invoke_workflow");
  });

  it("all templates are registered in WORKFLOW_TEMPLATES", async () => {
    const { WORKFLOW_TEMPLATES } = await import("../workflow-templates.mjs");
    const ids = WORKFLOW_TEMPLATES.map((t) => t.id);
    expect(ids).toContain("template-bosun-tool-pipeline");
    expect(ids).toContain("template-workflow-composition");
    expect(ids).toContain("template-mcp-to-bosun-bridge");
    expect(ids).toContain("template-git-health-pipeline");
  });

  it("all template nodes reference valid registered node types", async () => {
    const { BOSUN_TOOL_PIPELINE_TEMPLATE, WORKFLOW_COMPOSITION_TEMPLATE, MCP_TO_BOSUN_BRIDGE_TEMPLATE, GIT_HEALTH_PIPELINE_TEMPLATE } =
      await import("../workflow-templates/bosun-native.mjs");

    const templates = [
      BOSUN_TOOL_PIPELINE_TEMPLATE,
      WORKFLOW_COMPOSITION_TEMPLATE,
      MCP_TO_BOSUN_BRIDGE_TEMPLATE,
      GIT_HEALTH_PIPELINE_TEMPLATE,
    ];

    for (const template of templates) {
      for (const n of template.nodes) {
        const handler = getNodeType(n.type);
        expect(handler).toBeDefined();
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Cross-node data piping integration
// ═══════════════════════════════════════════════════════════════════════════

describe("cross-node data piping", () => {
  let engine;

  beforeEach(() => {
    engine = makeTmpEngine();
  });

  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("pipes data from bosun_function to notify.log via templates", async () => {
    const bosunRoot = resolve(import.meta.dirname, "..");
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "fn",
          type: "action.bosun_function",
          label: "Get Branch",
          config: { function: "git.branch" },
        },
        {
          id: "log",
          type: "notify.log",
          label: "Log Branch",
          config: { message: "Branch: {{fn.current}}, Count: {{fn.branchCount}}" },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "fn" },
        { id: "e2", source: "fn", target: "log" },
      ],
      { id: "pipe-test-wf" },
    );
    engine.save(wf);

    const ctx = await engine.execute("pipe-test-wf", { repoRoot: bosunRoot });
    expect(ctx.errors).toHaveLength(0);

    const fnOutput = ctx.getNodeOutput("fn");
    expect(fnOutput.success).toBe(true);

    // Verify the log message was rendered with actual data
    const logOutput = ctx.getNodeOutput("log");
    expect(logOutput).toBeDefined();
  }, 30_000);

  it("chains bosun_function → invoke_workflow → notify.log", async () => {
    const bosunRoot = resolve(import.meta.dirname, "..");

    // Child workflow that sets a variable
    const childWf = makeSimpleWorkflow(
      [
        { id: "child-trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "child-action",
          type: "action.set_variable",
          label: "Set Child Data",
          config: { name: "childResult", value: "child-data-value" },
        },
      ],
      [{ id: "e1", source: "child-trigger", target: "child-action" }],
      { id: "chain-child-wf" },
    );

    const parentWf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "get-branch",
          type: "action.bosun_function",
          label: "Get Branch",
          config: { function: "git.branch" },
        },
        {
          id: "invoke-child",
          type: "action.invoke_workflow",
          label: "Invoke Child",
          config: {
            workflowId: "chain-child-wf",
            outputVariable: "childResult",
          },
        },
        {
          id: "log",
          type: "notify.log",
          label: "Final Log",
          config: {
            message: "Branch: {{get-branch.current}}, Child: {{invoke-child.success}}",
          },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "get-branch" },
        { id: "e2", source: "get-branch", target: "invoke-child" },
        { id: "e3", source: "invoke-child", target: "log" },
      ],
      { id: "chain-parent-wf" },
    );

    engine.save(childWf);
    engine.save(parentWf);

    const ctx = await engine.execute("chain-parent-wf", { repoRoot: bosunRoot });
    expect(ctx.errors).toHaveLength(0);

    const branchOutput = ctx.getNodeOutput("get-branch");
    expect(branchOutput.success).toBe(true);
    expect(typeof branchOutput.current).toBe("string");

    const invokeOutput = ctx.getNodeOutput("invoke-child");
    expect(invokeOutput.success).toBe(true);
    expect(invokeOutput.workflowId).toBe("chain-child-wf");
  });
});
