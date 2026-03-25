import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["BOSUN_OTEL_ENDPOINT"];

describe("infra/tracing", () => {
  let originalEnv = {};

  beforeEach(() => {
    vi.resetModules();
    originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    delete process.env.BOSUN_OTEL_ENDPOINT;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    const tracing = await import("../infra/tracing.mjs");
    await tracing.shutdownTracing();
    vi.restoreAllMocks();
  });

  it("degrades to a no-op provider when no endpoint is configured", async () => {
    const tracing = await import("../infra/tracing.mjs");

    const result = await tracing.setupTracing();

    expect(result.enabled).toBe(false);
    expect(tracing.getTracingState().enabled).toBe(false);
    await expect(
      tracing.traceTaskExecution({ taskId: "task-1" }, async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("prefers explicit endpoint over environment configuration", async () => {
    process.env.BOSUN_OTEL_ENDPOINT = "http://env.example/v1/traces";
    const tracing = await import("../infra/tracing.mjs");

    const result = await tracing.setupTracing("http://explicit.example/v1/traces");

    expect(result.enabled).toBe(true);
    expect(result.endpoint).toBe("http://explicit.example/v1/traces");
    expect(tracing.getTracingState().endpoint).toBe("http://explicit.example/v1/traces");
  });

  it("records wrapper spans and auto-attaches errors", async () => {
    const tracing = await import("../infra/tracing.mjs");
    await tracing.setupTracing("http://collector.example/v1/traces");

    const success = await tracing.traceTaskExecution(
      { taskId: "task-42", title: "Ship tracing", sdk: "codex", model: "gpt-5" },
      async () => tracing.traceToolCall({ toolName: "mcp.search", tokensUsed: 11 }, async () => "done"),
    );

    expect(success).toBe("done");

    await expect(
      tracing.traceLLMCall({ model: "gpt-5", provider: "openai" }, async () => {
        throw new Error("upstream failure");
      }),
    ).rejects.toThrow("upstream failure");

    const finishedSpans = tracing.getFinishedSpans();
    const taskSpan = finishedSpans.find((span) => span.name === "bosun.task.execute");
    const toolSpan = finishedSpans.find((span) => span.name === "bosun.tool.call");
    const llmSpan = finishedSpans.find((span) => span.name === "bosun.llm.call");

    expect(taskSpan.attributes["bosun.task.id"]).toBe("task-42");
    expect(toolSpan.attributes["bosun.tool.name"]).toBe("mcp.search");
    expect(llmSpan.status.code).toBe("ERROR");
    expect(llmSpan.exceptions[0].message).toContain("upstream failure");
  });

  it("creates child spans with parent trace context", async () => {
    const tracing = await import("../infra/tracing.mjs");
    await tracing.setupTracing("http://collector.example/v1/traces");

    await tracing.traceTaskExecution({ taskId: "task-parent" }, async () =>
      tracing.traceAgentSession({ sessionId: "session-1", sdk: "codex" }, async () =>
        tracing.traceToolCall({ toolName: "shell.exec" }, async () => "ok"),
      ),
    );

    const finishedSpans = tracing.getFinishedSpans();
    const taskSpan = finishedSpans.find((span) => span.name === "bosun.task.execute");
    const sessionSpan = finishedSpans.find((span) => span.name === "bosun.agent.session");
    const toolSpan = finishedSpans.find((span) => span.name === "bosun.tool.call");

    expect(sessionSpan.traceId).toBe(taskSpan.traceId);
    expect(sessionSpan.parentSpanId).toBe(taskSpan.spanId);
    expect(toolSpan.parentSpanId).toBe(sessionSpan.spanId);
  });

  it("records task metrics with trace exemplars", async () => {
    const tracing = await import("../infra/tracing.mjs");
    await tracing.setupTracing("http://collector.example/v1/traces");

    await tracing.traceTaskExecution(
      { taskId: "task-metrics", model: "gpt-5" },
      async () => ({ inputTokens: 10, outputTokens: 15, costUsd: 0.25 }),
    );

    const metrics = tracing.getMetricSnapshot();
    const hist = metrics.histograms.get("bosun.task.duration");
    const tokens = metrics.counters.get("bosun.task.tokens.total");
    const cost = metrics.counters.get("bosun.task.cost.usd");

    expect(hist?.length).toBe(1);
    expect(hist?.[0]?.attributes?.["trace.trace_id"]).toBeTruthy();
    expect(tokens?.[0]?.value).toBe(25);
    expect(cost?.[0]?.value).toBe(0.25);
  });

  it("accepts stored task carriers to continue task execution traces", async () => {
    const tracing = await import("../infra/tracing.mjs");
    await tracing.setupTracing("http://collector.example/v1/traces");

    const remoteTraceparent = "00-99999999999999999999999999999999-8888888888888888-01";

    await tracing.traceTaskExecution(
      {
        taskId: "task-carrier",
        workflowId: "wf-carrier",
        workflowRunId: "run-carrier",
        carrier: { traceparent: remoteTraceparent },
      },
      async () => "ok",
    );

    const finishedSpans = tracing.getFinishedSpans();
    const taskSpan = finishedSpans.find(
      (span) => span.name === "bosun.task.execute" && span.attributes["bosun.task.id"] === "task-carrier",
    );

    expect(taskSpan.traceId).toBe("99999999999999999999999999999999");
    expect(taskSpan.parentSpanId).toBe("8888888888888888");
    expect(taskSpan.attributes["bosun.workflow.id"]).toBe("wf-carrier");
    expect(taskSpan.attributes["bosun.workflow.run_id"]).toBe("run-carrier");
  });

  it("continues a remote parent trace across workflow, task, and agent spans", async () => {
    const tracing = await import("../infra/tracing.mjs");
    await tracing.setupTracing("http://collector.example/v1/traces");

    const remoteTraceparent = "00-11111111111111111111111111111111-2222222222222222-01";

    await tracing.withIncomingTraceContext(
      { traceparent: remoteTraceparent },
      { name: "bosun.http.request", attributes: { "http.route": "/api/workflows/demo/execute" } },
      async () => tracing.traceWorkflowRun(
        {
          workflowId: "wf-demo",
          workflowRunId: "run-demo",
          taskId: "task-demo",
          agentId: "agent-demo",
        },
        async () => tracing.traceTaskExecution(
          {
            taskId: "task-demo",
            workflowId: "wf-demo",
            workflowRunId: "run-demo",
            agentId: "agent-demo",
          },
          async () => tracing.traceAgentSession(
            {
              sessionId: "session-demo",
              sdk: "codex",
              workflowId: "wf-demo",
              workflowRunId: "run-demo",
              taskId: "task-demo",
              agentId: "agent-demo",
            },
            async () => "ok",
          ),
        ),
      ),
    );

    const finishedSpans = tracing.getFinishedSpans();
    const httpSpan = finishedSpans.find((span) => span.name === "bosun.http.request");
    const workflowSpan = finishedSpans.find((span) => span.name === "bosun.workflow.run");
    const taskSpan = finishedSpans.find((span) => span.name === "bosun.task.execute");
    const agentSpan = finishedSpans.find((span) => span.name === "bosun.agent.session");

    expect(httpSpan.traceId).toBe("11111111111111111111111111111111");
    expect(httpSpan.parentSpanId).toBe("2222222222222222");
    expect(workflowSpan.traceId).toBe(httpSpan.traceId);
    expect(workflowSpan.parentSpanId).toBe(httpSpan.spanId);
    expect(taskSpan.traceId).toBe(httpSpan.traceId);
    expect(taskSpan.parentSpanId).toBe(workflowSpan.spanId);
    expect(agentSpan.traceId).toBe(httpSpan.traceId);
    expect(agentSpan.parentSpanId).toBe(taskSpan.spanId);
    expect(workflowSpan.attributes).toEqual(
      expect.objectContaining({
        "bosun.workflow.id": "wf-demo",
        "bosun.workflow.run_id": "run-demo",
        "bosun.task.id": "task-demo",
        "bosun.agent.id": "agent-demo",
      }),
    );
    expect(taskSpan.attributes).toEqual(
      expect.objectContaining({
        "bosun.workflow.id": "wf-demo",
        "bosun.workflow.run_id": "run-demo",
        "bosun.task.id": "task-demo",
        "bosun.agent.id": "agent-demo",
      }),
    );
    expect(agentSpan.attributes).toEqual(
      expect.objectContaining({
        "bosun.workflow.id": "wf-demo",
        "bosun.workflow.run_id": "run-demo",
        "bosun.task.id": "task-demo",
        "bosun.agent.id": "agent-demo",
      }),
    );
  }, 12000);
});



