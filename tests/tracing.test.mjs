import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig } from "../config/config.mjs";
import {
  getTracingState,
  recordAgentEvent,
  resetTracingForTests,
  setupTracing,
  traceAgentSession,
  traceLLMCall,
  traceTaskExecution,
  traceToolCall,
} from "../infra/tracing.mjs";

describe("infra/tracing", () => {
  let rootDir;

  afterEach(async () => {
    await resetTracingForTests();
    vi.unstubAllEnvs();
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = null;
    }
  });

  it("loads tracing config from bosun.config.json", () => {
    rootDir = mkdtempSync(join(tmpdir(), "bosun-tracing-config-"));
    writeFileSync(join(rootDir, "bosun.config.json"), JSON.stringify({ tracing: { enabled: true, endpoint: "http://localhost:4318/v1/traces", sampleRate: 0.5 } }));
    const config = loadConfig(["node", "bosun", "--config-dir", rootDir]);
    expect(config.tracing.enabled).toBe(true);
    expect(config.tracing.endpoint).toBe("http://localhost:4318/v1/traces");
    expect(config.tracing.sampleRate).toBe(0.5);
  });

  it("lets BOSUN_OTEL_ENDPOINT override file config", () => {
    rootDir = mkdtempSync(join(tmpdir(), "bosun-tracing-config-"));
    writeFileSync(join(rootDir, "bosun.config.json"), JSON.stringify({ tracing: { enabled: false, endpoint: "http://file-endpoint" } }));
    vi.stubEnv("BOSUN_OTEL_ENDPOINT", "http://env-endpoint");
    const config = loadConfig(["node", "bosun", "--config-dir", rootDir]);
    expect(config.tracing.enabled).toBe(true);
    expect(config.tracing.endpoint).toBe("http://env-endpoint");
  });

  it("is a no-op when no endpoint is configured", async () => {
    const state = await setupTracing({ enabled: true, endpoint: "" });
    expect(state.enabled).toBe(false);
    const result = await traceTaskExecution({ taskId: "task-1" }, async () => 42);
    expect(result).toBe(42);
    expect(getTracingState().enabled).toBe(false);
  });

  it("enables tracing when endpoint is configured", async () => {
    const state = await setupTracing({ enabled: true, endpoint: "http://127.0.0.1:4318/v1/traces", serviceName: "bosun-test" });
    expect(state.enabled).toBe(true);
    expect(state.config.endpoint).toBe("http://127.0.0.1:4318/v1/traces");
    expect(getTracingState().tracer).toBeTruthy();
  });

  it("records task, agent, tool, and llm spans with metrics", async () => {
    await setupTracing({ enabled: true, endpoint: "http://127.0.0.1:4318/v1/traces", serviceName: "bosun-test" });
    await traceTaskExecution({ taskId: "task-42", title: "Ship tracing", priority: "high", assignee: "bosun", sdk: "codex", model: "gpt-5", branch: "feat/otel" }, async () => {
      return traceAgentSession({ sessionId: "session-1", taskId: "task-42", sdk: "codex", threadKey: "thread-1", startTime: 123, tokensBudget: 2048 }, async () => {
        await traceToolCall({ toolName: "search_tool_bm25", taskId: "task-42", tokensUsed: 12 }, async () => "ok");
        await traceLLMCall({ model: "gpt-5", provider: "openai", taskId: "task-42", inputTokens: 100, outputTokens: 25, costUsd: 0.12, latencyMs: 50 }, async () => "done");
      });
    });
    const tracingState = getTracingState();
    expect(tracingState.testSpans.map((span) => span.name)).toEqual(expect.arrayContaining(["bosun.task.execution", "bosun.agent.session", "bosun.tool.call", "bosun.llm.call"]));
    expect(tracingState.metrics.taskTokensTotal).toBe(125);
    expect(tracingState.metrics.taskCostUsd).toBeCloseTo(0.12, 5);
    expect(tracingState.metrics.activeSessions).toBe(0);
  });

  it("records errors and increments error metrics", async () => {
    await setupTracing({ enabled: true, endpoint: "http://127.0.0.1:4318/v1/traces", serviceName: "bosun-test" });
    await expect(traceToolCall({ toolName: "failing-tool", taskId: "task-err" }, async () => { throw new TypeError("boom"); })).rejects.toThrow("boom");
    const tracingState = getTracingState();
    const span = tracingState.testSpans.find((entry) => entry.name === "bosun.tool.call");
    expect(span.exceptions).toHaveLength(1);
    expect(span.attributes["bosun.tool.name"]).toBe("failing-tool");
    expect(tracingState.metrics.errorsByType.TypeError).toBe(1);
  });

  it("attaches agent bus events as span events when active spans exist", async () => {
    await setupTracing({ enabled: true, endpoint: "http://127.0.0.1:4318/v1/traces", serviceName: "bosun-test" });
    await traceTaskExecution({ taskId: "task-events" }, async () => {
      recordAgentEvent({ type: "agent:task-started", taskId: "task-events", payload: { title: "Tracing" }, ts: Date.now() });
    });
    const taskSpan = getTracingState().testSpans.find((entry) => entry.name === "bosun.task.execution");
    expect(taskSpan.events).toEqual(expect.arrayContaining([expect.objectContaining({ name: "agent:task-started" })]));
  });
});
