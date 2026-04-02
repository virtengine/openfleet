import { describe, expect, it } from "vitest";

import { createHarnessSessionManager } from "../agent/session-manager.mjs";
import {
  beginWorkflowLinkedSessionExecution,
  finalizeWorkflowLinkedSessionExecution,
} from "../workflow/harness-session-node.mjs";

describe("session manager cutover", () => {
  it("keeps interactive, workflow, and subagent sessions on one canonical lineage graph", () => {
    const sessionManager = createHarnessSessionManager();

    sessionManager.beginExternalSession({
      sessionId: "chat-session-root",
      threadId: "chat-thread-root",
      scope: "primary",
      sessionType: "primary",
      taskKey: "TASK-CUTOVER",
      cwd: process.cwd(),
      metadata: {
        surface: "chat",
      },
      source: "chat",
    });
    sessionManager.registerExecution("chat-session-root", {
      sessionType: "primary",
      taskKey: "TASK-CUTOVER",
      threadId: "chat-thread-root",
      cwd: process.cwd(),
      status: "running",
      scope: "primary",
      metadata: {
        surface: "chat",
      },
    });

    const workflowContext = {
      id: "workflow-run-1",
      data: {
        _workflowId: "wf-cutover",
        _workflowName: "Harness Cutover",
        _workflowSessionId: "chat-session-root",
        _workflowRootSessionId: "chat-session-root",
        _workflowParentSessionId: "chat-session-root",
        _workflowRootRunId: "workflow-run-1",
        _workflowDelegationDepth: 0,
        taskId: "TASK-CUTOVER",
        taskTitle: "Cutover proof",
      },
    };
    const workflowNode = {
      id: "workflow-agent",
      label: "Workflow Agent",
    };

    const workflowLink = beginWorkflowLinkedSessionExecution(
      workflowContext,
      workflowNode,
      { services: { sessionManager } },
      {
        sessionId: "workflow-session-1",
        threadId: "workflow-thread-1",
        parentSessionId: "chat-session-root",
        rootSessionId: "chat-session-root",
        taskId: "TASK-CUTOVER",
        taskTitle: "Cutover proof",
        taskKey: "TASK-CUTOVER:workflow",
        cwd: process.cwd(),
        metadata: {
          surface: "workflow",
        },
      },
    );

    const child = sessionManager.createChildSession("workflow-session-1", {
      sessionId: "subagent-session-1",
      threadId: "subagent-thread-1",
      sessionType: "subagent",
      taskKey: "TASK-CUTOVER:subagent",
      metadata: {
        surface: "subagent",
      },
    });

    const finalized = finalizeWorkflowLinkedSessionExecution(workflowLink, {
      success: true,
      status: "completed",
      threadId: "workflow-thread-1",
      result: {
        ok: true,
        source: "workflow",
      },
    });
    sessionManager.finalizeExternalExecution("chat-session-root", {
      success: true,
      status: "completed",
      threadId: "chat-thread-root",
      result: {
        ok: true,
        source: "chat",
      },
    });

    const workflowSession = sessionManager.getSession("workflow-session-1");
    const subagentView = sessionManager.getLineageView("subagent-session-1");
    const workflowView = sessionManager.getLineageView("workflow-session-1");
    const replay = sessionManager.getReplaySnapshot("workflow-session-1");

    expect(child).toMatchObject({
      sessionId: "subagent-session-1",
      parentSessionId: "workflow-session-1",
      rootSessionId: "chat-session-root",
      lineageDepth: 2,
    });
    expect(workflowSession).toMatchObject({
      sessionId: "workflow-session-1",
      parentSessionId: "chat-session-root",
      rootSessionId: "chat-session-root",
      status: "completed",
      metadata: expect.objectContaining({
        surface: "workflow",
      }),
    });
    expect(workflowView).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          sessionId: "workflow-session-1",
        }),
        parent: expect.objectContaining({
          sessionId: "chat-session-root",
        }),
        descendants: expect.arrayContaining([
          expect.objectContaining({
            sessionId: "subagent-session-1",
          }),
        ]),
      }),
    );
    expect(subagentView.parent).toEqual(
      expect.objectContaining({
        sessionId: "workflow-session-1",
      }),
    );
    expect(replay.lineage).toEqual(
      expect.objectContaining({
        parentSessionId: "chat-session-root",
        childSessionIds: expect.arrayContaining(["subagent-session-1"]),
      }),
    );
    expect(finalized).toEqual(
      expect.objectContaining({
        sessionId: "workflow-session-1",
        status: "completed",
        lineage: expect.objectContaining({
          workflowId: "wf-cutover",
          parentSessionId: "chat-session-root",
          rootSessionId: "chat-session-root",
          childSessionId: "workflow-session-1",
        }),
      }),
    );
  });
});
