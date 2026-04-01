import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  expireApprovalRequest,
  getHarnessRunApprovalRequest,
  resolveApprovalQueuePath,
  resolveApprovalRequest,
  upsertHarnessRunApprovalRequest,
} from "../workflow/approval-queue.mjs";

const tempRoots = [];

function createHarnessRunFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), "bosun-harness-approval-queue-"));
  tempRoots.push(repoRoot);
  const runPath = resolve(repoRoot, ".cache", "harness", "runs", "run-123.json");
  mkdirSync(dirname(runPath), { recursive: true });
  writeFileSync(
    runPath,
    JSON.stringify({
      runId: "run-123",
      taskId: "TASK-123",
      status: "running",
      approvals: [],
      latestApproval: null,
    }, null, 2) + "\n",
    "utf8",
  );
  return { repoRoot, runPath };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const repoRoot = tempRoots.pop();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

describe("workflow approval queue", () => {
  it("persists harness-run approval resolutions into the approval queue and run record", () => {
    const { repoRoot, runPath } = createHarnessRunFixture();
    const created = upsertHarnessRunApprovalRequest({
      runId: "run-123",
      taskId: "TASK-123",
      taskTitle: "Harness Task",
      stageId: "gate",
      stageType: "gate",
      requestedBy: "harness",
      reason: "Harness run requires operator approval.",
      preview: "Waiting for operator.",
      mode: "manual",
      timeoutMs: 30_000,
    }, { repoRoot });

    expect(created.request).toMatchObject({
      requestId: "harness-run:run-123",
      scopeType: "harness-run",
      scopeId: "run-123",
      status: "pending",
      stageId: "gate",
    });
    expect(getHarnessRunApprovalRequest("run-123", { repoRoot })).toMatchObject({
      requestId: "harness-run:run-123",
      status: "pending",
    });

    const resolved = resolveApprovalRequest("harness-run:run-123", {
      repoRoot,
      decision: "approved",
      actorId: "reviewer",
      note: "Proceed.",
    });

    expect(resolved.request).toMatchObject({
      requestId: "harness-run:run-123",
      status: "approved",
      resolution: expect.objectContaining({
        actorId: "reviewer",
        note: "Proceed.",
      }),
    });
    expect(resolved.updateResult).toMatchObject({
      runId: "run-123",
      latestApproval: expect.objectContaining({
        requestId: "harness-run:run-123",
        decision: "approved",
        actorId: "reviewer",
        note: "Proceed.",
      }),
    });

    const queuePath = resolveApprovalQueuePath(repoRoot);
    expect(existsSync(queuePath)).toBe(true);
    expect(readJson(queuePath)).toMatchObject({
      version: 1,
      requests: [
        expect.objectContaining({
          requestId: "harness-run:run-123",
          status: "approved",
        }),
      ],
    });
    expect(readJson(runPath)).toMatchObject({
      latestApproval: expect.objectContaining({
        requestId: "harness-run:run-123",
        decision: "approved",
        actorId: "reviewer",
        note: "Proceed.",
      }),
      approvals: [
        expect.objectContaining({
          requestId: "harness-run:run-123",
          decision: "approved",
        }),
      ],
    });
  });

  it("marks harness-run approvals expired and appends the timeout resolution to the run record", () => {
    const { repoRoot, runPath } = createHarnessRunFixture();
    upsertHarnessRunApprovalRequest({
      runId: "run-123",
      taskId: "TASK-123",
      stageId: "gate",
      reason: "Timed approval gate.",
      timeoutMs: 1_000,
    }, { repoRoot });

    const expired = expireApprovalRequest("harness-run:run-123", {
      repoRoot,
      actorId: "system:timeout",
      note: "Approval gate timed out.",
    });

    expect(expired.request).toMatchObject({
      requestId: "harness-run:run-123",
      status: "expired",
      resolution: expect.objectContaining({
        actorId: "system:timeout",
        note: "Approval gate timed out.",
      }),
    });
    expect(expired.updateResult).toMatchObject({
      runId: "run-123",
      latestApproval: expect.objectContaining({
        requestId: "harness-run:run-123",
        decision: "expired",
        actorId: "system:timeout",
      }),
    });
    expect(readJson(runPath)).toMatchObject({
      latestApproval: expect.objectContaining({
        requestId: "harness-run:run-123",
        decision: "expired",
      }),
      approvals: [
        expect.objectContaining({
          requestId: "harness-run:run-123",
          decision: "expired",
        }),
      ],
    });
  });
});
