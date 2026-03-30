import { describe, it, expect, vi } from "vitest";

import { getNodeType } from "../workflow/workflow-nodes.mjs";
import { WorkflowContext } from "../workflow/workflow-engine.mjs";
import { getTemplate } from "../workflow/workflow-templates.mjs";

function makeCtx(data = {}) {
  const ctx = new WorkflowContext(data);
  ctx.log = vi.fn();
  return ctx;
}

describe("worktree recovery regressions", () => {
  it("classifies the latest retry-acquire failure when deciding blocked worktree recovery", async () => {
    const t = getTemplate("template-task-lifecycle");
    const node = t.nodes.find((entry) => entry.id === "wt-failure-blocking");
    const nt = getNodeType("condition.expression");
    const ctx = makeCtx({});
    ctx.setNodeOutput("acquire-worktree", {
      success: false,
      retryable: true,
      error: "initial reuse failure",
    });
    ctx.setNodeOutput("retry-acquire-wt", {
      success: false,
      retryable: false,
      blockedReason: "retry hit branch refresh conflict",
    });

    const result = await nt.execute(node, ctx);
    expect(result.result).toBe(true);
  });

  it("stores blocked worktree recovery context on the task record and repair handoff", () => {
    const t = getTemplate("template-task-lifecycle");
    const annotateNode = t.nodes.find((entry) => entry.id === "annotate-blocked-wt-failed");
    const dispatchNode = t.nodes.find((entry) => entry.id === "dispatch-wt-repair");
    const notifyNode = t.nodes.find((entry) => entry.id === "notify-wt-failed");
    const metaPatch = annotateNode.config.args?.fields?.meta || "";

    expect(metaPatch).toContain("retry-acquire-wt");
    expect(metaPatch).toContain("repoRoot");
    expect(metaPatch).toContain("defaultTargetBranch");
    expect(dispatchNode.config.input.error).toContain("retry-acquire-wt");
    expect(notifyNode.config.message).toContain("retry-acquire-wt");
  });

  it("accepts blocked-task recovery context from internal branchName and workspace fields", async () => {
    const t = getTemplate("template-recover-blocked-task");
    const node = t.nodes.find((entry) => entry.id === "check-context");
    const nt = getNodeType("condition.expression");
    const ctx = makeCtx({
      item: {
        taskId: "blocked-task-1",
        branchName: "task/blocked-task-1",
        workspace: "/tmp/repo-root",
      },
    });

    const result = await nt.execute(node, ctx);
    expect(result.result).toBe(true);
  });

  it("blocked-worktree recovery sweep queries branchName and workspace-backed context", () => {
    const t = getTemplate("template-recover-blocked-worktrees");
    const node = t.nodes.find((entry) => entry.id === "query-blocked");

    expect(node.config.args[1]).toContain("branchName");
    expect(node.config.args[1]).toContain("workspace");
    expect(node.config.args[1]).toContain("worktreeFailure");
  });
});