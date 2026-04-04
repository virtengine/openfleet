import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { WorkflowContext } from "../workflow/workflow-engine.mjs";
import {
  appendDelegationAuditEvent,
  buildDelegationWatchdogDecision,
  extractDelegationGuardMap,
  getDelegationAuditTrail,
  normalizeDelegationGuardMap,
} from "../workflow/delegation-runtime.mjs";

const workflowNodesSource = readFileSync(
  resolve(process.cwd(), "workflow", "workflow-nodes.mjs"),
  "utf8",
);
const workflowBoundaryDoc = readFileSync(
  resolve(process.cwd(), "workflow", "workflow-harness-boundaries.md"),
  "utf8",
);

describe("workflow harness boundaries", () => {
  it("keeps workflow-nodes.mjs as a composition shell over modular registrars", () => {
    expect(workflowNodesSource).toContain('import "./workflow-nodes/definitions.mjs";');
    expect(workflowNodesSource).toContain('import "./workflow-nodes/actions.mjs";');
    expect(workflowNodesSource).toContain('import "./workflow-nodes/flow.mjs";');
    expect(workflowNodesSource).toContain('export { registerNodeType, getNodeType, listNodeTypes, unregisterNodeType } from "./workflow-engine.mjs";');
    expect(workflowNodesSource).not.toContain("registerBuiltinNodeType(");
    expect(workflowNodesSource).not.toContain("runWorkflowNode(");
  });

  it("documents delegation-runtime as the shared owner for delegation watchdog and audit state", () => {
    expect(workflowBoundaryDoc).toContain("`workflow/delegation-runtime.mjs` owns delegation watchdog interpretation");
    expect(workflowBoundaryDoc).toContain("`workflow/workflow-nodes.mjs` is the public composition shell");
    expect(workflowBoundaryDoc).toContain("`workflow/workflow-nodes/agent.mjs` and `workflow/workflow-nodes/validation.mjs`");
    expect(workflowBoundaryDoc).toContain("they may not own provider routing, session lifecycle, or tool policy");
  });

  it("normalizes delegation guard and audit state through the shared runtime helpers", () => {
    const ctx = new WorkflowContext({
      _delegationTransitionGuards: {
        " assign-1 ": {
          transitionKey: "assign-1",
          status: "assigned",
        },
      },
      _delegationAuditTrail: [
        { type: "complete", at: 20, timestamp: "2026-04-03T00:00:20.000Z" },
        { type: "assign", at: 10, timestamp: "2026-04-03T00:00:10.000Z" },
      ],
    });

    expect(normalizeDelegationGuardMap(ctx.data._delegationTransitionGuards)).toEqual({
      "assign-1": {
        transitionKey: "assign-1",
        status: "assigned",
      },
    });
    expect(getDelegationAuditTrail(ctx).map((entry) => entry.type)).toEqual(["assign", "complete"]);

    appendDelegationAuditEvent(ctx, {
      type: "owner-mismatch",
      taskId: "task-1",
      claimToken: "claim-1",
      instanceId: "instance-1",
      at: 30,
    });
    appendDelegationAuditEvent(ctx, {
      type: "owner-mismatch",
      taskId: "task-1",
      claimToken: "claim-1",
      instanceId: "instance-1",
      at: 40,
    });

    expect(ctx.getDelegationAuditTrail().filter((entry) => entry.type === "owner-mismatch")).toHaveLength(1);
    expect(extractDelegationGuardMap({
      data: {
        _delegationTransitionGuards: ctx.data._delegationTransitionGuards,
      },
    })).toEqual({
      "assign-1": {
        transitionKey: "assign-1",
        status: "assigned",
      },
    });
  });

  it("makes watchdog retry and exhaustion decisions from canonical delegation state", () => {
    const startedAt = Date.now() - 10_000;

    expect(buildDelegationWatchdogDecision({
      startedAt,
      data: {
        _delegationWatchdog: {
          nodeId: "delegate-node",
          state: "delegated",
          timeoutMs: 1000,
          maxRecoveries: 2,
          recoveryAttempts: 1,
          startedAt,
        },
      },
    })).toMatchObject({
      type: "retry",
      mode: "from_failed",
      nodeId: "delegate-node",
      maxRecoveries: 2,
      recoveryAttempts: 1,
    });

    expect(buildDelegationWatchdogDecision({
      startedAt,
      data: {
        _delegationWatchdog: {
          nodeId: "delegate-node",
          state: "stalled",
          timeoutMs: 1000,
          maxRecoveries: 1,
          recoveryAttempts: 1,
          startedAt,
        },
      },
    })).toMatchObject({
      type: "exhausted",
      nodeId: "delegate-node",
      maxRecoveries: 1,
      recoveryAttempts: 1,
    });

    expect(buildDelegationWatchdogDecision({
      startedAt,
      data: {
        _delegationWatchdog: {
          nodeId: "task-scoped",
          state: "delegated",
          taskScoped: true,
          timeoutMs: 1000,
          startedAt,
        },
      },
    })).toBeNull();
  });
});
