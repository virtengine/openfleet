#!/usr/bin/env node

import { performance } from "node:perf_hooks";

import { createToolOrchestrator } from "../agent/tool-orchestrator.mjs";
import { createHarnessObservabilitySpine, resetHarnessObservabilitySpinesForTests } from "../infra/session-telemetry.mjs";

const SESSION_COUNT = Math.max(4, Number.parseInt(process.env.BOSUN_BENCH_SESSIONS || "12", 10) || 12);
const EVENTS_PER_SESSION = Math.max(10, Number.parseInt(process.env.BOSUN_BENCH_EVENTS_PER_SESSION || "180", 10) || 180);
const TOOL_CALLS = Math.max(4, Number.parseInt(process.env.BOSUN_BENCH_TOOL_CALLS || "48", 10) || 48);

function buildEvent(sessionIndex, eventIndex) {
  const taskId = `bench-task-${sessionIndex}`;
  const sessionId = `bench-session-${sessionIndex}`;
  const runId = `bench-run-${sessionIndex}`;
  const cycle = eventIndex % 3;
  if (cycle === 0) {
    return {
      eventType: "provider.turn.completed",
      source: "agent-pool",
      category: "provider",
      taskId,
      sessionId,
      runId,
      providerId: "openai-api",
      modelId: "gpt-5.4",
      status: "completed",
      latencyMs: 140 + (eventIndex % 11),
      tokenUsage: {
        inputTokens: 80 + eventIndex,
        outputTokens: 40 + (eventIndex % 17),
        totalTokens: 120 + eventIndex + (eventIndex % 17),
      },
    };
  }
  if (cycle === 1) {
    return {
      eventType: "workflow.node.complete",
      source: "workflow-engine",
      category: "workflow",
      taskId,
      sessionId,
      runId,
      workflowId: "bench-workflow",
      workflowName: "Harness Bench",
      status: "completed",
      durationMs: 25 + (eventIndex % 9),
      summary: "workflow node completed",
    };
  }
  return {
    eventType: "tool.execution.completed",
    source: "agent-event-bus",
    category: "tool",
    taskId,
    sessionId,
    runId,
    toolName: "apply_patch",
    status: "completed",
    retryCount: eventIndex % 2,
    durationMs: 12 + (eventIndex % 7),
    summary: "tool run completed",
  };
}

async function main() {
  resetHarnessObservabilitySpinesForTests();
  const telemetry = createHarnessObservabilitySpine({
    persist: false,
    maxInMemoryEvents: SESSION_COUNT * EVENTS_PER_SESSION,
  });
  const toolOrchestrator = createToolOrchestrator({
    truncation: {
      maxChars: 512,
      tailChars: 72,
    },
    executeTool: async (_toolName, args) => ({
      ok: true,
      args,
      lines: Array.from({ length: 24 }, (_, index) => `line-${index}-${"x".repeat(40)}`),
    }),
  });

  const telemetryStart = performance.now();
  await Promise.all(
    Array.from({ length: SESSION_COUNT }, async (_, sessionIndex) => {
      for (let eventIndex = 0; eventIndex < EVENTS_PER_SESSION; eventIndex += 1) {
        telemetry.recordEvent(buildEvent(sessionIndex, eventIndex));
      }
    }),
  );
  await telemetry.flush();
  const telemetryDurationMs = performance.now() - telemetryStart;

  const toolStart = performance.now();
  await Promise.all(
    Array.from({ length: TOOL_CALLS }, (_, index) =>
      toolOrchestrator.execute("bench_tool", {
        call: index,
        payload: "y".repeat(2048),
      }, {
        sessionId: `bench-tool-${index}`,
      })),
  );
  const toolDurationMs = performance.now() - toolStart;

  const summary = telemetry.getSummary();
  const totalEvents = SESSION_COUNT * EVENTS_PER_SESSION;
  const result = {
    sessions: SESSION_COUNT,
    toolCalls: TOOL_CALLS,
    totalEvents,
    telemetryDurationMs: Number(telemetryDurationMs.toFixed(2)),
    toolDurationMs: Number(toolDurationMs.toFixed(2)),
    telemetryEventsPerSecond: Number(((totalEvents / telemetryDurationMs) * 1000).toFixed(2)),
    toolCallsPerSecond: Number(((TOOL_CALLS / toolDurationMs) * 1000).toFixed(2)),
    hotPath: summary.hotPath,
    metrics: summary.metrics?.totals || null,
  };

  console.log(JSON.stringify(result, null, 2));
}

await main();
