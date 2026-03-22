import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowExecutionLedger } from "../workflow/execution-ledger.mjs";

let tmpDir;
let ledger;

function makeLedger() {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-ledger-test-"));
  ledger = new WorkflowExecutionLedger({ runsDir: tmpDir });
  return ledger;
}

describe("WorkflowExecutionLedger", () => {
  beforeEach(() => makeLedger());
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it("records causal parent-child and recovery edges in a replayable run graph", () => {
    ledger.appendEvent({
      eventType: "run.start",
      runId: "root-run",
      rootRunId: "root-run",
      workflowId: "wf-main",
      workflowName: "Main",
      status: "running",
      meta: { runKind: "workflow", taskId: "task-1" },
      timestamp: "2026-03-22T10:00:00.000Z",
    });
    ledger.appendEvent({
      eventType: "child.run.spawned",
      runId: "root-run",
      rootRunId: "root-run",
      workflowId: "wf-main",
      nodeId: "delegate",
      meta: { childRunId: "child-run", childRunKind: "agent", edgeType: "delegated" },
      timestamp: "2026-03-22T10:00:01.000Z",
    });
    ledger.appendEvent({
      eventType: "run.start",
      runId: "child-run",
      rootRunId: "root-run",
      parentRunId: "root-run",
      workflowId: "wf-agent",
      workflowName: "Agent",
      status: "running",
      meta: { runKind: "agent", parentNodeId: "delegate" },
      timestamp: "2026-03-22T10:00:02.000Z",
    });
    ledger.appendEvent({
      eventType: "run.recovery_scheduled",
      runId: "child-run",
      rootRunId: "root-run",
      parentRunId: "root-run",
      workflowId: "wf-agent",
      status: "failed",
      attempt: 1,
      reason: "process_crash",
      meta: { recoveryRunId: "recovery-run", recoveryKind: "resume" },
      timestamp: "2026-03-22T10:00:03.000Z",
    });
    ledger.appendEvent({
      eventType: "run.start",
      runId: "recovery-run",
      rootRunId: "root-run",
      parentRunId: "root-run",
      retryOf: "child-run",
      retryMode: "from_failed",
      workflowId: "wf-agent",
      workflowName: "Agent",
      status: "running",
      meta: { runKind: "recovery", recoveryAttempt: 1 },
      timestamp: "2026-03-22T10:00:04.000Z",
    });

    const graph = ledger.getRunGraph("root-run");

    expect(graph.rootRunId).toBe("root-run");
    expect(graph.runs.map((run) => run.runId).sort()).toEqual(["child-run", "recovery-run", "root-run"]);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromRunId: "root-run", toRunId: "child-run", edgeType: "delegated" }),
      expect.objectContaining({ fromRunId: "child-run", toRunId: "recovery-run", edgeType: "recovery" }),
    ]));
    expect(graph.runs.find((run) => run.runId === "recovery-run")?.recovery?.attempt).toBe(1);
  });

  it("rebuilds node timelines and tool execution summaries from ledger events", () => {
    ledger.appendEvent({ eventType: "run.start", runId: "run-1", workflowId: "wf", timestamp: "2026-03-22T10:00:00.000Z" });
    ledger.appendEvent({ eventType: "node.started", runId: "run-1", workflowId: "wf", nodeId: "n1", nodeType: "action", nodeLabel: "Fetch", status: "running", timestamp: "2026-03-22T10:00:01.000Z" });
    ledger.appendEvent({ eventType: "tool.execution", runId: "run-1", workflowId: "wf", nodeId: "n1", meta: { toolName: "web.search", invocationId: "tool-1" }, timestamp: "2026-03-22T10:00:02.000Z" });
    ledger.appendEvent({ eventType: "node.completed", runId: "run-1", workflowId: "wf", nodeId: "n1", status: "completed", durationMs: 250, timestamp: "2026-03-22T10:00:03.000Z" });
    ledger.appendEvent({ eventType: "run.end", runId: "run-1", workflowId: "wf", status: "completed", timestamp: "2026-03-22T10:00:04.000Z" });

    const replay = ledger.replayRun("run-1");

    expect(replay.run.runId).toBe("run-1");
    expect(replay.timeline).toHaveLength(5);
    expect(replay.nodes.n1.status).toBe("completed");
    expect(replay.nodes.n1.tools).toEqual([
      expect.objectContaining({ toolName: "web.search", invocationId: "tool-1" }),
    ]);
  });

  it("detects duplicate runs from durable ledger state", () => {
    ledger.appendEvent({
      eventType: "run.start",
      runId: "older-run",
      workflowId: "wf",
      status: "running",
      timestamp: "2026-03-22T10:00:00.000Z",
      meta: { dedupKey: "task:123", runKind: "task" },
    });
    ledger.appendEvent({
      eventType: "run.start",
      runId: "newer-run",
      workflowId: "wf",
      status: "running",
      timestamp: "2026-03-22T10:00:05.000Z",
      meta: { dedupKey: "task:123", runKind: "task" },
    });

    const duplicates = ledger.findDuplicateRuns("task:123");

    expect(duplicates.latestRunId).toBe("newer-run");
    expect(duplicates.duplicateRunIds).toEqual(["older-run"]);
  });
});

it("lists ledger-backed run summaries and graph diffs for child executions", () => {
  ledger.appendEvent({
    eventType: "run.start",
    runId: "root-task-run",
    rootRunId: "root-task-run",
    workflowId: "wf-task",
    workflowName: "Task",
    status: "running",
    timestamp: "2026-03-22T10:00:00.000Z",
    meta: { taskId: "task-42", taskTitle: "Ledger test", dedupKey: "task:42", runKind: "task" },
  });
  ledger.appendEvent({
    eventType: "child.run.spawned",
    runId: "root-task-run",
    rootRunId: "root-task-run",
    workflowId: "wf-task",
    nodeId: "delegate-agent",
    timestamp: "2026-03-22T10:00:01.000Z",
    meta: { childRunId: "agent-run-1", edgeType: "delegated" },
  });
  ledger.appendEvent({
    eventType: "run.start",
    runId: "agent-run-1",
    rootRunId: "root-task-run",
    parentRunId: "root-task-run",
    workflowId: "wf-agent",
    workflowName: "Agent Delegate",
    status: "running",
    timestamp: "2026-03-22T10:00:02.000Z",
    meta: { taskId: "task-42", runKind: "agent", parentNodeId: "delegate-agent" },
  });
  ledger.appendEvent({ eventType: "run.end", runId: "agent-run-1", rootRunId: "root-task-run", workflowId: "wf-agent", status: "completed", timestamp: "2026-03-22T10:00:03.000Z" });
  ledger.appendEvent({ eventType: "run.end", runId: "root-task-run", rootRunId: "root-task-run", workflowId: "wf-task", status: "completed", timestamp: "2026-03-22T10:00:04.000Z" });

  const summaries = ledger.listRunSummaries({ taskId: "task-42" });
  const graph = ledger.getRunGraph("root-task-run");

  expect(summaries.map((entry) => entry.runId)).toEqual(["agent-run-1", "root-task-run"]);
  expect(summaries.find((entry) => entry.runId === "root-task-run")?.childRunCount).toBe(1);
  expect(graph?.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ fromRunId: "root-task-run", toRunId: "agent-run-1", edgeType: "delegated" }),
  ]));
});



it("exposes latest active task runs and recovery attempts from durable ledger state", () => {
  ledger.appendEvent({
    eventType: "run.start",
    runId: "task-run-1",
    rootRunId: "task-run-1",
    workflowId: "wf-task",
    status: "running",
    timestamp: "2026-03-22T10:00:00.000Z",
    meta: { taskId: "task-99", dedupKey: "task:99", runKind: "task" },
  });
  ledger.appendEvent({
    eventType: "run.error",
    runId: "task-run-1",
    rootRunId: "task-run-1",
    workflowId: "wf-task",
    status: "failed",
    timestamp: "2026-03-22T10:01:00.000Z",
  });
  ledger.appendEvent({
    eventType: "run.start",
    runId: "task-run-2",
    rootRunId: "task-run-1",
    parentRunId: "task-run-1",
    retryOf: "task-run-1",
    retryMode: "from_failed",
    workflowId: "wf-task",
    status: "paused",
    timestamp: "2026-03-22T10:02:00.000Z",
    meta: { taskId: "task-99", dedupKey: "task:99", runKind: "recovery", recoveryAttempt: 1 },
  });

  const latestTaskRun = ledger.getLatestTaskRun("task-99");
  const latestActiveTaskRun = ledger.getLatestActiveTaskRun("task-99");
  const activeSummaries = ledger.listActiveRunSummaries({ taskId: "task-99", includeGraphs: false });
  const recoveryAttempts = ledger.getRecoveryAttempts("task-run-1");

  expect(latestTaskRun?.runId).toBe("task-run-2");
  expect(latestActiveTaskRun?.runId).toBe("task-run-2");
  expect(activeSummaries.map((entry) => entry.runId)).toEqual(["task-run-2"]);
  expect(recoveryAttempts.map((entry) => entry.runId)).toEqual(["task-run-2"]);
});
