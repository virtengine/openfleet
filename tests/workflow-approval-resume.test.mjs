import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowEngine } from "../workflow/workflow-engine.mjs";

describe("WorkflowEngine approvals", () => {
  let tempDir;
  let runsDir;
  let engine;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bosun-wf-approval-"));
    runsDir = join(tempDir, "workflow-runs");
    mkdirSync(runsDir, { recursive: true });
    engine = new WorkflowEngine({ runsDir });
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it("records durable pending approvals and handles duplicate callbacks idempotently", async () => {
    const runId = "run-approval-1";
    const detail = {
      id: runId,
      status: "paused",
      data: {
        _workflowId: "wf-1",
        _workflowName: "WF 1",
        _approval: {
          checkpointId: "checkpoint-1",
          callbackId: null,
          status: "waiting",
          nodeId: "node-1",
          nodeLabel: "Approval",
          summary: "Need approval",
        },
      },
    };
    writeFileSync(join(runsDir, ${runId}.json), ${JSON.stringify(detail, null, 2)}\n, "utf8");
    writeFileSync(join(runsDir, "index.json"), JSON.stringify({ runs: [{ runId, workflowId: "wf-1", workflowName: "WF 1", status: "paused" }] }, null, 2), "utf8");

    const pending = engine.getPendingApproval(runId);
    expect(pending).toMatchObject({ runId, pending: true });
    expect(pending.approval).toMatchObject({ checkpointId: "checkpoint-1", status: "waiting" });

    const first = await engine.resolveApproval(runId, {
      decision: "approved",
      checkpointId: "checkpoint-1",
      callbackId: "callback-1",
      actor: "tester",
      payload: { ok: true },
    });
    expect(first).toMatchObject({ ok: true, duplicate: false, resumed: true });

    const second = await engine.resolveApproval(runId, {
      decision: "approved",
      checkpointId: "checkpoint-1",
      callbackId: "callback-1",
      actor: "tester",
    });
    expect(second).toMatchObject({ ok: true, duplicate: true, resumed: false });

    const persisted = JSON.parse(readFileSync(join(runsDir, ${runId}.json), "utf8"));
    expect(persisted.data._approval).toMatchObject({
      checkpointId: "checkpoint-1",
      callbackId: "callback-1",
      decision: "approved",
      actor: "tester",
      status: "approved",
    });
  });

  it("resumes paused approval runs from durable state", async () => {
    const runId = "run-approval-2";
    const detail = {
      id: runId,
      status: "paused",
      data: {
        _workflowId: "wf-2",
        _workflowName: "WF 2",
        _approval: {
          checkpointId: "checkpoint-2",
          status: "waiting",
          nodeId: "node-2",
          nodeLabel: "Approval 2",
          summary: "Resume me",
        },
      },
    };
    writeFileSync(join(runsDir, ${runId}.json), ${JSON.stringify(detail, null, 2)}\n, "utf8");
    writeFileSync(join(runsDir, "index.json"), JSON.stringify({ runs: [{ runId, workflowId: "wf-2", workflowName: "WF 2", status: "paused", resumable: true }] }, null, 2), "utf8");

    const unresolved = await engine.resumeRun(runId, { actor: "ui" });
    expect(unresolved).toMatchObject({ ok: false, resumed: false, reason: "approval_pending" });

    const result = await engine.resolveApproval(runId, {
      decision: "approved",
      checkpointId: "checkpoint-2",
      callbackId: "callback-2",
      actor: "ui",
    });
    expect(result).toMatchObject({ ok: true, resumed: true });

    const next = engine.getPendingApproval(runId);
    expect(next.approval).toMatchObject({ status: "approved", decision: "approved", actor: "ui" });
  });

  it("tracks duplicate callback telemetry without mutating the original approval decision", () => {
    const runId = "run-approval-3";
    const detail = {
      id: runId,
      status: "paused",
      data: {
        _workflowId: "wf-3",
        _workflowName: "WF 3",
        _approval: {
          checkpointId: "checkpoint-3",
          callbackId: "callback-3",
          status: "approved",
          decision: "approved",
          nodeId: "node-3",
          nodeLabel: "Approval 3",
          summary: "Already approved",
          actor: "tester",
          duplicateCallbackIds: [],
        },
      },
    };
    writeFileSync(join(runsDir, ${runId}.json), ${JSON.stringify(detail, null, 2)}\n, "utf8");
    writeFileSync(join(runsDir, "index.json"), JSON.stringify({ runs: [{ runId, workflowId: "wf-3", workflowName: "WF 3", status: "paused", resumable: false }] }, null, 2), "utf8");

    const duplicate = engine.recordApprovalDecision(runId, {
      decision: "approved",
      checkpointId: "checkpoint-3",
      callbackId: "callback-3",
      actor: "other-user",
    });

    expect(duplicate).toMatchObject({ applied: true, duplicate: true });
    expect(duplicate.approval).toMatchObject({
      callbackId: "callback-3",
      decision: "approved",
      actor: "tester",
      status: "approved",
    });
  });
});
