import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../workflow/workflow-nodes/triggers.mjs";
import "../workflow/workflow-nodes/actions.mjs";
import "../workflow/workflow-nodes/flow.mjs";
import { getNodeType } from "../workflow/workflow-engine.mjs";
import { _resetSingleton, getSessionTracker } from "../infra/session-tracker.mjs";

describe("workflow modular actions", () => {
  beforeEach(() => {
    _resetSingleton({ persistDir: null });
  });

  afterEach(() => {
    _resetSingleton({ persistDir: null });
    vi.restoreAllMocks();
  });

  it("registers merge-aware push_branch schema in the modular action registry", () => {
    const nodeType = getNodeType("action.push_branch");

    expect(nodeType).toBeDefined();
    expect(nodeType.schema.properties.mergeBaseBeforePush).toBeDefined();
    expect(nodeType.schema.properties.mergeBaseBeforePush.default).toBe(false);
    expect(nodeType.schema.properties.autoResolveMergeConflicts).toBeDefined();
    expect(nodeType.schema.properties.conflictResolverSdk).toBeDefined();
    expect(nodeType.schema.properties.skipHooks).toBeDefined();
  });

  it("propagates blocked delegated workflow outcomes into the task session", async () => {
    const nodeType = getNodeType("action.run_agent");
    const node = {
      id: "run-agent",
      type: "action.run_agent",
      config: {
        prompt: "Implement the requested change end-to-end.",
        failOnError: false,
      },
    };
    const ctx = {
      id: "run-1",
      data: {
        taskId: "TASK-123",
        task: {
          id: "TASK-123",
          title: "Fix push blockage",
          description: "Resolve the pre-push blockage and preserve implementation state.",
          taskUrl: "https://example.test/tasks/TASK-123",
        },
      },
      resolve(value) {
        return value;
      },
      log: vi.fn(),
    };
    const engine = {
      services: {},
      list: () => [
        {
          id: "delegate-workflow",
          name: "Delegate Workflow",
          enabled: true,
          metadata: { replaces: { module: "primary-agent.mjs" } },
          nodes: [{ id: "trigger", type: "trigger.task_assigned", config: {} }],
        },
      ],
      execute: vi.fn().mockResolvedValue({
        id: "child-run",
        errors: [],
        data: {
          _workflowTerminalStatus: "completed",
          _workflowTerminalOutput: {
            blockedReason: "blocked_by_repo",
            implementationState: "implementation_done_commit_blocked",
            error: "pre-push hook declined",
          },
        },
      }),
    };

    const result = await nodeType.execute(node, ctx, engine);
    const session = getSessionTracker().getSessionById("TASK-123");

    expect(engine.execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: false,
      delegated: true,
      subStatus: "implementation_done_commit_blocked",
      blockedReason: "blocked_by_repo",
      implementationState: "implementation_done_commit_blocked",
    });
    expect(session?.status).toBe("implementation_done_commit_blocked");
  });
});
