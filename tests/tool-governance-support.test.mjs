import { describe, expect, it } from "vitest";

import {
  buildToolExecutionEnvelope,
  mergeToolRuntimeContext,
  normalizeToolRuntimeContext,
} from "../agent/tool-runtime-context.mjs";
import {
  composeToolRegistryEntries,
  createToolRegistry,
  resolveToolDefinition,
} from "../agent/tool-registry.mjs";
import {
  createToolApprovalManager,
  evaluateToolApproval,
} from "../agent/tool-approval-manager.mjs";
import {
  createToolNetworkPolicy,
  evaluateToolNetworkPolicy,
} from "../agent/tool-network-policy.mjs";
import {
  truncateText,
  truncateToolOutput,
} from "../agent/tool-output-truncation.mjs";

describe("tool governance support", () => {
  it("normalizes runtime context and builds a stable execution envelope", () => {
    const context = normalizeToolRuntimeContext({
      sessionId: "session-1",
      surface: "tui",
      approvalMode: "manual",
      requestedHosts: ["api.openai.com"],
      metadata: { step: "plan" },
    }, {
      cwd: "C:/repo",
      repoRoot: "C:/repo",
      agentProfileId: "architect",
      approval: { scopeType: "harness-run", scopeId: "run-1" },
    });
    const merged = mergeToolRuntimeContext(
      { sessionId: "session-1", metadata: { keep: true } },
      { runId: "run-2", metadata: { step: "apply" } },
    );
    const envelope = buildToolExecutionEnvelope("list_tasks", { limit: 2 }, context);

    expect(context).toMatchObject({
      cwd: "C:/repo",
      repoRoot: "C:/repo",
      sessionId: "session-1",
      agentProfileId: "architect",
      surface: "tui",
      approval: {
        mode: "manual",
        scopeType: "harness-run",
        scopeId: "run-1",
      },
      network: {
        mode: "inherit",
        requestedHosts: ["api.openai.com"],
      },
    });
    expect(merged).toMatchObject({
      sessionId: "session-1",
      runId: "run-2",
      metadata: { keep: true, step: "apply" },
    });
    expect(envelope).toMatchObject({
      toolName: "list_tasks",
      args: { limit: 2 },
      context: { sessionId: "session-1" },
    });
  });

  it("composes tool registry entries and resolves aliases", async () => {
    const registry = createToolRegistry([
      {
        source: "builtin",
        definitions: [
          {
            id: "list_tasks",
            description: "List active tasks.",
            aliases: ["tasks.list"],
            tags: ["read"],
          },
        ],
      },
      {
        source: "workspace",
        definitions: [
          {
            id: "list_tasks",
            tags: ["kanban"],
            allowedHosts: ["api.openai.com"],
            handler: async (args) => ({ ok: true, args }),
          },
        ],
      },
    ]);
    const entries = composeToolRegistryEntries([
      {
        source: "builtin",
        definitions: [{ id: "list_tasks", aliases: ["tasks.list"] }],
      },
    ]);
    const resolved = resolveToolDefinition("tasks.list", registry.listTools());
    const executed = await registry.execute("list_tasks", { limit: 5 }, {});

    expect(entries).toHaveLength(1);
    expect(resolved).toMatchObject({
      id: "list_tasks",
      aliases: ["tasks.list"],
      tags: ["read", "kanban"],
      allowedHosts: ["api.openai.com"],
    });
    expect(executed).toEqual({ ok: true, args: { limit: 5 } });
  });

  it("evaluates approval requirements with pending and approved outcomes", () => {
    const riskyTool = { id: "push_branch", requiresApproval: true, riskLevel: "high" };
    const pending = evaluateToolApproval(riskyTool, {
      sessionId: "session-2",
      approval: { mode: "manual" },
    });
    const manager = createToolApprovalManager({ allowlistedTools: ["list_tasks"] });
    const approved = manager.evaluate(riskyTool, {
      runId: "run-3",
      approval: { decision: "approved", mode: "manual" },
    });
    const safe = manager.evaluate({ id: "list_tasks" }, {});

    expect(pending).toMatchObject({
      approvalRequired: true,
      approvalState: "pending",
      blocked: true,
      scopeType: "harness-run",
      scopeId: "session-2",
    });
    expect(approved).toMatchObject({
      approvalRequired: true,
      approvalState: "approved",
      blocked: false,
      scopeId: "run-3",
    });
    expect(safe).toMatchObject({
      approvalRequired: false,
      approvalState: "not_required",
      blocked: false,
    });
  });

  it("enforces network policy for restricted and blocked hosts", () => {
    const tool = {
      id: "fetch_remote_context",
      networkAccess: "restricted",
      allowedHosts: ["api.openai.com"],
      blockedHosts: ["169.254.169.254"],
    };
    const allowed = evaluateToolNetworkPolicy(tool, {
      requestedHosts: ["api.openai.com"],
    });
    const manager = createToolNetworkPolicy();
    const blocked = manager.evaluate(tool, {
      requestedHosts: ["169.254.169.254"],
    });

    expect(allowed).toMatchObject({
      mode: "restricted",
      allowed: true,
      blocked: false,
    });
    expect(blocked).toMatchObject({
      allowed: false,
      blocked: true,
      reason: "Host 169.254.169.254 is blocked by policy.",
    });
  });

  it("truncates oversized text and JSON outputs with bounded previews", () => {
    const text = truncateText("x".repeat(120), { maxChars: 48, tailChars: 8 });
    const structured = truncateToolOutput({
      lines: Array.from({ length: 24 }, (_, index) => `line-${index}-${"y".repeat(12)}`),
    }, {
      maxChars: 96,
      tailChars: 16,
    });

    expect(text.truncated).toBe(true);
    expect(text.text).toContain("…truncated");
    expect(structured.truncated).toBe(true);
    expect(structured.format).toBe("json");
    expect(structured.data).toEqual(expect.objectContaining({
      truncated: true,
      preview: expect.stringContaining("…truncated"),
    }));
  });
});
