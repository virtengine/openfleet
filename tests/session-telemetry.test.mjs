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

  it("projects artifact mutations and subagent lineage into live views, metrics, and filters", () => {
    const spine = createHarnessObservabilitySpine({ persist: false });

    spine.recordEvent({
      timestamp: "2026-04-03T08:00:00.000Z",
      eventType: "patch_applied",
      source: "internal-harness-control-plane",
      category: "artifact",
      taskId: "task-artifact-1",
      sessionId: "session-artifact-1",
      runId: "run-artifact-1",
      artifactId: "artifact-1",
      artifactPath: "server/ui-server.mjs",
      patchHash: "patch-1",
      status: "completed",
      summary: "patched ui server",
    });

    spine.recordEvent({
      timestamp: "2026-04-03T08:00:01.000Z",
      eventType: "subagent_completed",
      source: "internal-harness-control-plane",
      category: "subagent",
      taskId: "task-artifact-1",
      sessionId: "session-artifact-1",
      runId: "run-artifact-1",
      childSessionId: "session-child-1",
      childTaskId: "task-child-1",
      subagentId: "subagent-1",
      status: "completed",
      summary: "delegate finished",
    });

    const summary = spine.getSummary();
    expect(summary.live.sessions[0]).toEqual(expect.objectContaining({
      artifactMutations: 1,
      subagentEvents: 1,
      lastArtifactPath: "server/ui-server.mjs",
      childSessionIds: ["session-child-1"],
      childTaskIds: ["task-child-1"],
    }));
    expect(summary.live.runs[0]).toEqual(expect.objectContaining({
      artifactMutations: 1,
      subagentEvents: 1,
      childSessionIds: ["session-child-1"],
      childTaskIds: ["task-child-1"],
    }));
    expect(summary.live.artifacts[0]).toEqual(expect.objectContaining({
      artifactId: "artifact-1",
      artifactPath: "server/ui-server.mjs",
      patchHash: "patch-1",
      lastEventType: "patch_applied",
    }));
    expect(summary.live.subagents[0]).toEqual(expect.objectContaining({
      subagentId: "subagent-1",
      childSessionId: "session-child-1",
      childTaskId: "task-child-1",
      parentSessionId: "session-artifact-1",
      parentTaskId: "task-artifact-1",
    }));
    expect(summary.metrics.totals).toEqual(expect.objectContaining({
      artifactMutations: 1,
      subagentEvents: 1,
    }));
    expect(summary.metrics.byCategory).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "artifact", count: 1 }),
      expect.objectContaining({ key: "subagent", count: 1 }),
    ]));

    expect(spine.listEvents({ filePath: "server/ui-server.mjs" })).toHaveLength(1);
    expect(spine.listEvents({ childSessionId: "session-child-1" })).toHaveLength(1);
    expect(spine.listEvents({ subagentId: "subagent-1" })).toHaveLength(1);

    const exportedTrace = spine.exportTrace({ runId: "run-artifact-1" });
    expect(exportedTrace.traceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "patch_applied",
        args: expect.objectContaining({
          artifactPath: "server/ui-server.mjs",
          patchHash: "patch-1",
        }),
      }),
      expect.objectContaining({
        name: "subagent_completed",
        args: expect.objectContaining({
          childSessionId: "session-child-1",
          childTaskId: "task-child-1",
          subagentId: "subagent-1",
        }),
      }),
    ]));
  });

  it("batches persistence in the JS telemetry runtime and reports hot-path status", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "bosun-telemetry-runtime-"));
    tempDirs.push(configDir);
    const spine = createHarnessObservabilitySpine({
      persist: true,
      configDir,
      maxInMemoryEvents: 16,
      maxPersistBatchEvents: 2,
    });

    for (let index = 0; index < 5; index += 1) {
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
      processedEvents: 5,
      persistedEvents: 5,
      persistBatches: 3,
      maxPersistBatchEvents: 2,
    }));
  });

  it("keeps a bounded in-memory ring buffer while preserving full processed and persisted counts", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "bosun-telemetry-ring-"));
    tempDirs.push(configDir);
    const spine = createHarnessObservabilitySpine({
      persist: true,
      configDir,
      maxInMemoryEvents: 100,
      maxPersistBatchEvents: 8,
    });

    for (let index = 0; index < 106; index += 1) {
      spine.recordEvent({
        timestamp: `2026-04-02T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        eventType: "workflow.node.complete",
        source: "workflow-engine",
        category: "workflow",
        taskId: "task-ring",
        sessionId: "session-ring",
        runId: "run-ring",
        status: "completed",
        summary: `workflow node ${index}`,
      });
    }

    await flushHarnessTelemetryRuntimeForTests();

    const summary = spine.getSummary();
    expect(summary.eventCount).toBe(100);
    expect(summary.hotPath.telemetry).toEqual(expect.objectContaining({
      droppedEvents: 6,
      processedEvents: 106,
      persistedEvents: 106,
      inMemoryEvents: 100,
    }));
  });
});
