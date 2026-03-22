import { describe, expect, it } from "vitest";

describe("workflow node copilot action helpers", () => {
  it("exports node copilot action presets with expected actions", async () => {
    const mod = await import("../server/ui-server.mjs");
    expect(typeof mod.getWorkflowNodeCopilotActionPresets).toBe("function");
    const presets = mod.getWorkflowNodeCopilotActionPresets();
    expect(Array.isArray(presets)).toBe(true);
    expect(presets.map((entry) => entry.id)).toEqual([
      "explain",
      "fix",
      "retry",
      "generate-test",
      "summarize-output",
    ]);
  });

  it("builds bounded workflow-node copilot payloads with metadata and evidence", async () => {
    const mod = await import("../server/ui-server.mjs");
    const workflow = {
      id: "wf-demo",
      name: "Demo Workflow",
      description: "Workflow used in tests",
      metadata: { owner: "ops", tags: ["demo", "workflow"] },
      nodes: [
        {
          id: "node-fail",
          type: "action.run_command",
          label: "Run tests",
          config: { command: "npm test", retries: 2, notes: "x".repeat(8000) },
        },
        {
          id: "node-next",
          type: "action.write_file",
          config: { path: "report.txt" },
        },
      ],
      edges: [
        { source: "node-fail", target: "node-next" },
      ],
    };
    const run = {
      runId: "run-123",
      workflowId: "wf-demo",
      workflowName: "Demo Workflow",
      status: "failed",
      detail: {
        nodeStatuses: { "node-fail": "failed", "node-next": "pending" },
        nodeOutputs: {
          "node-fail": {
            summary: "Command failed",
            stdout: "log ".repeat(2000),
            stderr: "error ".repeat(1500),
          },
        },
        errors: [
          { nodeId: "node-fail", message: "Tests failed", stack: "trace ".repeat(600) },
        ],
        logs: [
          { nodeId: "node-fail", level: "error", message: "boom" },
        ],
        issueAdvisor: { recommendedAction: "inspect_failure", summary: "Investigate node-fail" },
      },
      ledger: {
        events: [
          { timestamp: Date.now(), eventType: "node.failed", nodeId: "node-fail", status: "failed", error: "Tests failed" },
        ],
      },
    };

    expect(typeof mod.buildWorkflowNodeCopilotActionPayload).toBe("function");
    const payload = mod.buildWorkflowNodeCopilotActionPayload(workflow, {
      actionId: "fix",
      nodeId: "node-fail",
      wfMod: { listNodeTypes: () => [{ type: "action.run_command", description: "Runs a shell command", schema: { properties: { command: {}, retries: {} } } }] },
      run,
      evaluation: {
        remediation: {
          summary: "Increase retries or fix command",
          fixActions: [{ nodeId: "node-fail", type: "check_config", action: { field: "config.command" } }],
        },
      },
      retryOptions: {
        recommendedMode: "from_failed",
        recommendedReason: "Retry only the failed branch",
        options: [{ mode: "from_failed", label: "Retry failed node" }],
      },
      nodeForensics: { suspects: ["bad command", "missing dependency"] },
    });

    expect(payload?.prompt).toContain("Node Copilot Action");
    expect(payload?.prompt).toContain("fix");
    expect(payload?.prompt).toContain("Demo Workflow");
    expect(payload?.prompt).toContain("node-fail");
    expect(payload?.prompt).toContain("Workflow Metadata");
    expect(payload?.prompt).toContain("Recent Run Evidence");
    expect(payload?.context?.scope).toBe("workflow-node-action");
    expect(payload?.context?.actionId).toBe("fix");
    expect(payload?.context?.nodeId).toBe("node-fail");
    expect(payload?.context?.runId).toBe("run-123");
    expect(payload?.context?.workflowId).toBe("wf-demo");
    expect(payload?.prompt.length).toBeLessThanOrEqual(30000);
    expect(payload?.context?.bounded).toBe(true);
  });
});
