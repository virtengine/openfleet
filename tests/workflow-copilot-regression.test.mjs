import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRunCopilotContextPayload,
  buildWorkflowCopilotContextPayload,
} from "../server/ui-server.mjs";

describe("workflow copilot integration surfaces", () => {
  const workflowUiSource = readFileSync(resolve(process.cwd(), "ui/tabs/workflows.js"), "utf8");
  const sessionListSource = readFileSync(resolve(process.cwd(), "ui/components/session-list.js"), "utf8");
  const serverSource = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");

  it("adds workflow and node copilot entry points in the workflows UI", () => {
    expect(workflowUiSource).toContain("Explain With Bosun");
    expect(workflowUiSource).toContain("Ask Bosun About Node");
    expect(workflowUiSource).toContain("Ask Bosun About This Node");
    expect(workflowUiSource).toContain("Fix This Node");
    expect(workflowUiSource).toContain("Generate Test");
    expect(workflowUiSource).toContain("Summarize Output");
    expect(workflowUiSource).toContain("Retry Node");
    expect(workflowUiSource).toContain("/copilot-context");
  });

  it("allows seeded workflow copilot sessions to bypass fresh-session reuse", () => {
    expect(sessionListSource).toContain("const allowReuseFresh = options?.reuseFresh !== false;");
    expect(sessionListSource).toContain("if (allowReuseFresh) {");
  });

  it("exposes server-side workflow and run copilot context builders", () => {
    expect(serverSource).toContain("function buildWorkflowCopilotContextPayload");
    expect(serverSource).toContain("function buildRunCopilotContextPayload");
    expect(serverSource).toContain("function buildWorkflowNodeCopilotActionPayload");
    expect(serverSource).toContain("function getWorkflowNodeCopilotActionPresets");
    expect(serverSource).toContain('action === "copilot-context"');
  });

  it("builds workflow node action payloads with bounded context", () => {
    const workflow = {
      id: "wf-1",
      name: "Demo Workflow",
      metadata: { owner: "ops" },
      nodes: [
        { id: "node-a", type: "action.run_agent", label: "Agent", config: { prompt: "x".repeat(5000), retries: 2 } },
        { id: "node-b", type: "notify.send_message", label: "Notify", config: { channel: "ops" } },
      ],
      edges: [{ source: "node-a", target: "node-b" }],
    };

    const payload = buildWorkflowCopilotContextPayload(workflow, {
      nodeId: "node-a",
      intent: "generate-test",
    });

    expect(payload.context.scope).toBe("workflow-node-action");
    expect(payload.context.intent).toBe("generate-test");
    expect(payload.context.action).toBe("generate-test");
    expect(payload.context.nodeId).toBe("node-a");
    expect(payload.prompt).toContain("Workflow Metadata");
    expect(payload.prompt).toContain("Recent Run Evidence");
    expect(payload.prompt).toContain("Action Inputs");
    expect(payload.prompt).toContain("Generate Test");
    expect(payload.prompt.length).toBeLessThan(32000);
  });

  it("builds run node action payloads with outputs and evidence", () => {
    const run = {
      runId: "run-1",
      workflowId: "wf-1",
      workflowName: "Demo Workflow",
      status: "failed",
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      detail: {
        nodeStatuses: { "node-a": "failed", "node-b": "pending" },
        nodeOutputs: { "node-a": { summary: "boom", log: "y".repeat(5000) } },
        dagState: {
          workflowSnapshot: {
            id: "wf-1",
            name: "Demo Workflow",
            metadata: { owner: "ops" },
            nodes: [
              { id: "node-a", type: "action.run_agent", label: "Agent", config: { prompt: "fix me" } },
              { id: "node-b", type: "notify.send_message", label: "Notify", config: { channel: "ops" } },
            ],
            edges: [{ source: "node-a", target: "node-b" }],
          },
        },
        issueAdvisor: { recommendedAction: "inspect_failure", summary: "Node A failed validation" },
      },
      ledger: {
        events: [
          { timestamp: Date.now(), eventType: "node.failed", nodeId: "node-a", error: "ValidationError" },
        ],
      },
      errors: [{ nodeId: "node-a", message: "ValidationError" }],
    };

    const payload = buildRunCopilotContextPayload(run, {
      nodeId: "node-a",
      intent: "summarize-output",
      retryOptions: { modes: ["from_failed"] },
      evaluation: { remediation: { suggestion: "check prompt" } },
      forensics: { trace: ["x", "y"] },
    });

    expect(payload.context.scope).toBe("run-node-action");
    expect(payload.context.intent).toBe("summarize-output");
    expect(payload.context.action).toBe("summarize-output");
    expect(payload.context.nodeId).toBe("node-a");
    expect(payload.prompt).toContain("Recent Run Evidence");
    expect(payload.prompt).toContain("Action Inputs");
    expect(payload.prompt).toContain("summarize-output");
    expect(payload.prompt.length).toBeLessThan(32000);
  });

  it("exposes reusable node action presets in the workflow UI", () => {
    expect(workflowUiSource).toContain("NODE_COPILOT_ACTION_PRESETS");
    expect(workflowUiSource).toContain("openWorkflowNodeAction");
    expect(workflowUiSource).toContain("openRunNodeAction");
    expect(workflowUiSource).toContain("Workflow node actions");
    expect(workflowUiSource).toContain("Action result");
  });
});

