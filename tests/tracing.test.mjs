import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig } from "../config/config.mjs";
import {
  beginLlmCallSpan,
  endLlmCallSpan,
  getTracingState,
  recordAgentError,
  recordAgentEvent,
  recordAgentIntervention,
  resetTracingForTests,
  setupTracing,
  traceAgentSession,
  traceLLMCall,
  traceTaskExecution,
  traceToolCall,
  trackSessionLifecycle,
  updateLlmCallSpan,
} from "../infra/tracing.mjs";

describe("infra/tracing", () => {
  let rootDir;
  let originalEnv;

  afterEach(async () => {
    await resetTracingForTests();
    if (originalEnv) {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      originalEnv = null;
    }
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = null;
    }
  });

  function stubEnv(key, value) {
    if (!originalEnv) originalEnv = {};
    if (!(key in originalEnv)) originalEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  it("loads tracing config from bosun.config.json", () => {
    rootDir = mkdtempSync(join(tmpdir(), "bosun-tracing-config-"));
    writeFileSync(
      join(rootDir, "bosun.config.json"),
      JSON.stringify({
        tracing: {
          enabled: true,
          endpoint: "http://localhost:4318/v1/traces",
          sampleRate: 0.5,
        },
      }),
    );
    const config = loadConfig(["node", "bosun", "--config-dir", rootDir]);
    expect(config.tracing.enabled).toBe(true);
    expect(config.tracing.endpoint).toBe("http://localhost:4318/v1/traces");
    expect(config.tracing.sampleRate).toBe(0.5);
  });

  it("lets BOSUN_OTEL_ENDPOINT override file config", () => {
    rootDir = mkdtempSync(join(tmpdir(), "bosun-tracing-config-"));
    writeFileSync(
      join(rootDir, "bosun.config.json"),
      JSON.stringify({ tracing: { enabled: false, endpoint: "http://file-endpoint" } }),
    );
    stubEnv("BOSUN_OTEL_ENDPOINT", "http://env-endpoint");
    const config = loadConfig(["node", "bosun", "--config-dir", rootDir]);
    expect(config.tracing.enabled).toBe(true);
    expect(config.tracing.endpoint).toBe("http://env-endpoint");
  });

  it("is a no-op when no endpoint is configured", async () => {
    const tracingState = await setupTracing({ enabled: true, endpoint: "" });
    expect(tracingState.enabled).toBe(false);
    const result = await traceTaskExecution({ taskId: "task-1" }, async () => 42);
    expect(result).toBe(42);
    expect(getTracingState().enabled).toBe(false);
  });

  it("enables tracing when endpoint is configured", async () => {
    const tracingState = await setupTracing({
      enabled: true,
      endpoint: "http://127.0.0.1:4318/v1/traces",
      serviceName: "bosun-test",
    });
    expect(tracingState.enabled).toBe(true);
    expect(tracingState.config.endpoint).toBe("http://127.0.0.1:4318/v1/traces");
    expect(getTracingState().tracer).toBeTruthy();
  });

  it("creates a grafana dashboard template artifact", async () => {
    expect(existsSync("grafana/bosun-otel-dashboard.json")).toBe(true);
  });

  it("records task, agent, tool, and llm spans with metrics", async () => {
    await setupTracing({
      enabled: true,
      endpoint: "http://127.0.0.1:4318/v1/traces",
      serviceName: "bosun-test",
    });

    await traceTaskExecution(
      {
        taskId: "task-42",
        title: "Ship tracing",
        priority: "high",
        assignee: "bosun",
        sdk: "codex",
        model: "gpt-5",
        branch: "feat/otel",
      },
      async () =>
        traceAgentSession(
          {
            sessionId: "session-1",
            taskId: "task-42",
            sdk: "codex",
            threadKey: "thread-1",
            startTime: 123,
            tokensBudget: 2048,
          },
          async () => {
            await traceToolCall(
              { toolName: "search_tool_bm25", taskId: "task-42", tokensUsed: 12 },
              async () => "ok",
            );
            await traceLLMCall(
              {
                model: "gpt-5",
                provider: "openai",
                taskId: "task-42",
                inputTokens: 100,
                outputTokens: 25,
                costUsd: 0.12,
                latencyMs: 50,
              },
              async () => "done",
            );
          },
        ),
    );

    const tracingState = getTracingState();
    expect(tracingState.testSpans.map((span) => span.name)).toEqual(
      expect.arrayContaining([
        "bosun.task.execution",
        "bosun.agent.session",
        "bosun.tool.call",
        "bosun.llm.call",
      ]),
    );
    expect(tracingState.metrics.taskTokensTotal).toBe(125);
    expect(tracingState.metrics.taskCostUsd).toBeCloseTo(0.12, 5);
    expect(tracingState.metrics.activeSessions).toBe(0);
  });

  it("records errors and increments error metrics", async () => {
    await setupTracing({
      enabled: true,
      endpoint: "http://127.0.0.1:4318/v1/traces",
      serviceName: "bosun-test",
    });

    await expect(
      traceToolCall({ toolName: "failing-tool", taskId: "task-err" }, async () => {
        throw new TypeError("boom");
      }),
    ).rejects.toThrow("boom");

    const tracingState = getTracingState();
    const span = tracingState.testSpans.find((entry) => entry.name === "bosun.tool.call");
    expect(span.exceptions).toHaveLength(1);
    expect(span.attributes["bosun.tool.name"]).toBe("failing-tool");
    expect(tracingState.metrics.errorsByType.TypeError).toBe(1);
  });

  it("attaches agent bus events as span events when active spans exist", async () => {
    await setupTracing({
      enabled: true,
      endpoint: "http://127.0.0.1:4318/v1/traces",
      serviceName: "bosun-test",
    });

    await traceTaskExecution({ taskId: "task-events" }, async () => {
      recordAgentEvent({
        type: "agent:task-started",
        taskId: "task-events",
        payload: { title: "Tracing" },
        ts: Date.now(),
      });
    });

    const taskSpan = getTracingState().testSpans.find(
      (entry) => entry.name === "bosun.task.execution",
    );
    expect(taskSpan.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "agent:task-started" })]),
    );
  });

  it("tracks session lifecycle and intervention metrics", async () => {
    await setupTracing({
      enabled: true,
      endpoint: "http://127.0.0.1:4318/v1/traces",
      serviceName: "bosun-test",
    });

    await traceTaskExecution({ taskId: "task-session" }, async () => {
      await traceAgentSession({ sessionId: "session-life", taskId: "task-session", sdk: "codex" }, async () => {
        recordAgentIntervention("force_new_thread", {
          taskId: "task-session",
          sessionId: "session-life",
        });
      });
    });

    const tracingState = getTracingState();
    expect(tracingState.metrics.interventionsByType.force_new_thread).toBe(1);
    const sessionSpan = tracingState.testSpans.find(
      (entry) => entry.name === "bosun.agent.session",
    );
    expect(sessionSpan.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "session.lifecycle.start" }),
        expect.objectContaining({ name: "session.lifecycle.end" }),
      ]),
    );
  });

  it("tracks detached session lifecycle spans and active session gauge", async () => {
    await setupTracing({
      enabled: true,
      endpoint: "http://127.0.0.1:4318/v1/traces",
      serviceName: "bosun-test",
    });

    trackSessionLifecycle({ reason: "session-created", sessionId: "s-1", taskId: "task-lifecycle" });
    expect(getTracingState().metrics.activeSessions).toBe(1);

    trackSessionLifecycle({
      reason: "session-health-change",
      sessionId: "s-1",
      taskId: "task-lifecycle",
      attributes: { score: 0.8 },
    });
    trackSessionLifecycle({ reason: "session-ended", sessionId: "s-1", taskId: "task-lifecycle" });

    const lifecycleSpan = getTracingState().testSpans.find(
      (entry) => entry.name === "bosun.session.lifecycle",
    );
    expect(lifecycleSpan.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "session-health-change" }),
        expect.objectContaining({ name: "session-ended" }),
      ]),
    );
    expect(getTracingState().metrics.activeSessions).toBe(0);
  });

  it("tracks incremental llm spans from event-bus style updates", async () => {
    await setupTracing({
      enabled: true,
      endpoint: "http://127.0.0.1:4318/v1/traces",
      serviceName: "bosun-test",
    });

    await traceTaskExecution({ taskId: "task-llm-stream" }, async () => {
      beginLlmCallSpan("llm-1", {
        taskId: "task-llm-stream",
        "gen_ai.request.model": "gpt-5",
        "gen_ai.system": "openai",
      });
      updateLlmCallSpan(
        "llm-1",
        {
          "bosun.llm.input_tokens": 55,
          "bosun.llm.output_tokens": 34,
          "bosun.llm.cost_usd": 0.015,
        },
        "stream-update",
      );
      endLlmCallSpan("llm-1", {
        attributes: {
          taskId: "task-llm-stream",
          inputTokens: 55,
          outputTokens: 34,
          costUsd: 0.015,
        },
      });
    });

    const llmSpan = getTracingState().testSpans.find((entry) => entry.name === "bosun.llm.call");
    expect(llmSpan.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "stream-update" })]),
    );
    expect(getTracingState().metrics.taskTokensTotal).toBe(89);
    expect(getTracingState().metrics.taskCostUsd).toBeCloseTo(0.015, 5);
  });

  it("tracks explicit agent error metrics by type", async () => {
    await setupTracing({
      enabled: true,
      endpoint: "http://127.0.0.1:4318/v1/traces",
      serviceName: "bosun-test",
    });

    recordAgentError("TimeoutError", { sdk: "codex" });
    expect(getTracingState().metrics.errorsByType.TimeoutError).toBe(1);
  });
});
