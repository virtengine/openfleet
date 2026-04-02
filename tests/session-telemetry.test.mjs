import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createHarnessObservabilitySpine,
  exportHarnessTelemetryTrace,
  flushHarnessTelemetryRuntimeForTests,
  resetHarnessObservabilitySpinesForTests,
} from "../infra/session-telemetry.mjs";

describe("session telemetry spine", () => {
  const tempDirs = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
    resetHarnessObservabilitySpinesForTests();
  });

  it("projects canonical events into live summaries, metrics, provider usage, and trace export", () => {
    const spine = createHarnessObservabilitySpine({ persist: false });

    spine.recordEvent({
      timestamp: "2026-04-02T08:00:00.000Z",
      eventType: "provider.turn.completed",
      source: "agent-event-bus",
      category: "provider",
      taskId: "task-1",
      sessionId: "session-1",
      threadId: "thread-1",
      runId: "run-1",
      providerId: "openai-api",
      modelId: "gpt-5.4",
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      status: "completed",
      latencyMs: 180,
      costUsd: 0.12,
      tokenUsage: {
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
      },
      summary: "provider turn complete",
    });

    spine.recordEvent({
      timestamp: "2026-04-02T08:00:01.000Z",
      eventType: "tool.execution.completed",
      source: "session-tracker",
      category: "tool",
      taskId: "task-1",
      sessionId: "session-1",
      threadId: "thread-1",
      runId: "run-1",
      toolId: "apply_patch",
      toolName: "apply_patch",
      status: "completed",
      durationMs: 45,
      retryCount: 1,
    });

    spine.recordEvent({
      timestamp: "2026-04-02T08:00:02.000Z",
      eventType: "approval.resolved",
      source: "workflow-execution-ledger",
      category: "approval",
      taskId: "task-1",
      sessionId: "session-1",
      runId: "run-1",
      approvalId: "approval-1",
      actor: "operator",
      status: "approved",
    });

    const summary = spine.getSummary();
    expect(summary.eventCount).toBe(3);
    expect(summary.live.sessions[0]).toEqual(expect.objectContaining({
      sessionId: "session-1",
      taskId: "task-1",
      totalEvents: 3,
      totalTokens: 200,
      totalCostUsd: 0.12,
      lastApprovalId: "approval-1",
      lastToolName: "apply_patch",
    }));
    expect(summary.metrics.totals).toEqual(expect.objectContaining({
      events: 3,
      totalTokens: 200,
      costUsd: 0.12,
      retries: 1,
      approvals: 1,
    }));
    expect(summary.providers[0]).toEqual(expect.objectContaining({
      providerId: "openai-api",
      modelId: "gpt-5.4",
      requests: 1,
      totalTokens: 200,
    }));
    expect(summary.live.tools[0]).toEqual(expect.objectContaining({
      toolName: "apply_patch",
      totalCalls: 1,
      totalRetries: 1,
    }));

    const trace = exportHarnessTelemetryTrace({ taskId: "task-1" }, { persist: false });
    expect(trace.traceEvents).toHaveLength(0);

    const exportedTrace = spine.exportTrace({ taskId: "task-1" });
    expect(exportedTrace.traceEvents).toHaveLength(3);
    expect(exportedTrace.traceEvents[0]).toEqual(expect.objectContaining({
      name: "provider.turn.completed",
      cat: "provider",
    }));
  });

  it("batches persistence in the JS telemetry runtime and reports hot-path status", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "bosun-telemetry-runtime-"));
    tempDirs.push(configDir);
    const spine = createHarnessObservabilitySpine({
      persist: true,
      configDir,
      maxInMemoryEvents: 16,
    });

    for (let index = 0; index < 3; index += 1) {
      spine.recordEvent({
        timestamp: `2026-04-02T09:00:0${index}.000Z`,
        eventType: "workflow.node.complete",
        source: "workflow-engine",
        category: "workflow",
        taskId: "task-hot-path",
        sessionId: "session-hot-path",
        runId: "run-hot-path",
        status: "completed",
        summary: `workflow node ${index}`,
      });
    }

    await flushHarnessTelemetryRuntimeForTests();

    const summary = spine.getSummary();
    expect(summary.hotPath.exec).toEqual(expect.objectContaining({
      available: true,
      service: "exec",
      reason: "javascript",
    }));
    expect(summary.hotPath.telemetry).toEqual(expect.objectContaining({
      available: true,
      service: "telemetry",
      reason: "javascript",
      processedEvents: 3,
      persistedEvents: 3,
      persistBatches: 1,
    }));
  });
});
