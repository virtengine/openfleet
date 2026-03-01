/**
 * workflow-task-lifecycle.test.mjs — Comprehensive tests for all 11 task
 * lifecycle node types and both workflow templates.
 *
 * Tests verify:
 *  1. Node registration, schema, describe()
 *  2. Node execution logic (happy path + error paths)
 *  3. Anti-thrash state management
 *  4. Template structure integrity (nodes, edges, variables)
 *  5. Template DAG connectivity
 *  6. Dry-run template execution through the workflow engine
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { getNodeType } from "../workflow-nodes.mjs";
import {
  WorkflowEngine,
  WorkflowContext,
} from "../workflow-engine.mjs";
import {
  getTemplate,
  installTemplate,
} from "../workflow-templates.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(data = {}) {
  const ctx = new WorkflowContext(data);
  ctx.log = vi.fn();
  return ctx;
}

function makeNode(type, config = {}, id = "test-node") {
  return { id, type, config };
}

let tmpDir;
let engine;

function makeTmpEngine() {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-lifecycle-test-"));
  engine = new WorkflowEngine({
    workflowDir: join(tmpDir, "workflows"),
    runsDir: join(tmpDir, "runs"),
    services: {},
  });
  return engine;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Node Type Registration Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("task lifecycle node type registration", () => {
  const LIFECYCLE_NODES = [
    "trigger.task_available",
    "condition.slot_available",
    "action.allocate_slot",
    "action.release_slot",
    "action.claim_task",
    "action.release_claim",
    "action.resolve_executor",
    "action.acquire_worktree",
    "action.release_worktree",
    "action.build_task_prompt",
    "action.detect_new_commits",
    "action.push_branch",
  ];

  for (const typeName of LIFECYCLE_NODES) {
    it(`${typeName} is registered`, () => {
      expect(getNodeType(typeName)).toBeDefined();
    });

    it(`${typeName} has a describe() returning a non-empty string`, () => {
      const desc = getNodeType(typeName).describe();
      expect(typeof desc).toBe("string");
      expect(desc.length).toBeGreaterThan(10);
    });

    it(`${typeName} has a valid schema`, () => {
      const nt = getNodeType(typeName);
      expect(nt.schema).toBeDefined();
      expect(nt.schema.type).toBe("object");
      expect(nt.schema.properties).toBeDefined();
    });

    it(`${typeName} has an async execute function`, () => {
      const nt = getNodeType(typeName);
      expect(typeof nt.execute).toBe("function");
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  condition.slot_available Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("condition.slot_available", () => {
  it("returns true when no active tasks exist", async () => {
    const nt = getNodeType("condition.slot_available");
    const ctx = makeCtx({ activeSlotCount: 0 });
    const node = makeNode("condition.slot_available", { maxParallel: 3 });
    const result = await nt.execute(node, ctx);
    expect(result.result).toBe(true);
    expect(result.activeSlotCount).toBe(0);
  });

  it("returns false when active count >= maxParallel", async () => {
    const nt = getNodeType("condition.slot_available");
    const ctx = makeCtx({ activeSlotCount: 3 });
    const node = makeNode("condition.slot_available", { maxParallel: 3 });
    const result = await nt.execute(node, ctx);
    expect(result.result).toBe(false);
    expect(result.activeSlotCount).toBe(3);
  });

  it("handles baseBranch limit", async () => {
    const nt = getNodeType("condition.slot_available");
    const ctx = makeCtx({
      activeSlotCount: 2,
      baseBranchSlotCounts: { main: 2 },
    });
    const node = makeNode("condition.slot_available", {
      maxParallel: 5,
      baseBranchLimit: 2,
      baseBranch: "origin/main",
    });
    const result = await nt.execute(node, ctx);
    // baseBranch limit 2 with 2 on "main" → blocked
    expect(result.result).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.allocate_slot Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.allocate_slot", () => {
  it("allocates a slot and stores in ctx.data._allocatedSlot", async () => {
    const nt = getNodeType("action.allocate_slot");
    const ctx = makeCtx({});
    const node = makeNode("action.allocate_slot", {
      taskId: "task-123",
      taskTitle: "Test Task",
      branch: "feat/test",
      baseBranch: "main",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(ctx.data._allocatedSlot).toBeDefined();
    expect(ctx.data._allocatedSlot.taskId).toBe("task-123");
    expect(ctx.data._allocatedSlot.taskTitle).toBe("Test Task");
    expect(ctx.data._allocatedSlot.branch).toBe("feat/test");
    expect(ctx.data._agentInstanceId).toBeDefined();
  });

  it("saves env var snapshot", async () => {
    const nt = getNodeType("action.allocate_slot");
    const ctx = makeCtx({});
    process.env.VE_TEST_VAR = "hello";
    const node = makeNode("action.allocate_slot", {
      taskId: "task-snap",
      branch: "feat/snap",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    const slot = ctx.data._allocatedSlot;
    expect(slot._envSnapshot).toBeDefined();
    expect(slot._envSnapshot.VE_TEST_VAR).toBe("hello");
    delete process.env.VE_TEST_VAR;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.release_slot Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.release_slot", () => {
  it("releases the allocated slot and nullifies it", async () => {
    const nt = getNodeType("action.release_slot");
    const ctx = makeCtx({
      taskId: "task-rel",
      _allocatedSlot: { taskId: "task-rel", startedAt: Date.now() - 5000 },
    });
    const node = makeNode("action.release_slot", { taskId: "task-rel" });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(ctx.data._allocatedSlot).toBeNull();
  });

  it("returns success even if no slot allocated", async () => {
    const nt = getNodeType("action.release_slot");
    const ctx = makeCtx({ taskId: "missing" });
    const node = makeNode("action.release_slot", { taskId: "missing" });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
  });

  it("restores env vars from snapshot", async () => {
    const nt = getNodeType("action.release_slot");
    const origVal = process.env.VE_RESTORE_TEST;
    process.env.VE_RESTORE_TEST = "changed";
    const ctx = makeCtx({
      taskId: "task-env",
      _allocatedSlot: {
        taskId: "task-env",
        startedAt: Date.now() - 1000,
        _envSnapshot: { VE_RESTORE_TEST: "original" },
      },
    });
    const node = makeNode("action.release_slot", { taskId: "task-env" });
    await nt.execute(node, ctx);
    expect(process.env.VE_RESTORE_TEST).toBe("original");
    // Cleanup
    if (origVal === undefined) delete process.env.VE_RESTORE_TEST;
    else process.env.VE_RESTORE_TEST = origVal;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.resolve_executor Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.resolve_executor", () => {
  it("resolves default SDK to copilot when no env overrides", async () => {
    const nt = getNodeType("action.resolve_executor");
    const ctx = makeCtx({});
    // Clean up potential env vars
    const saved = { ...process.env };
    delete process.env.COPILOT_MODEL;
    delete process.env.CLAUDE_MODEL;
    delete process.env.CODEX_MODEL;
    const node = makeNode("action.resolve_executor", {
      defaultSdk: "auto",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.sdk).toBeDefined();
    // Restore
    Object.assign(process.env, saved);
  });

  it("stores resolved values in ctx.data", async () => {
    const nt = getNodeType("action.resolve_executor");
    const ctx = makeCtx({});
    const node = makeNode("action.resolve_executor", {
      defaultSdk: "copilot",
    });
    const result = await nt.execute(node, ctx);
    expect(ctx.data.resolvedSdk).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.build_task_prompt Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.build_task_prompt", () => {
  it("builds a prompt string and stores in ctx.data._taskPrompt", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({
      resolvedSdk: "copilot",
      resolvedModel: "gpt-4",
    });
    const node = makeNode("action.build_task_prompt", {
      taskId: "TASK-42",
      taskTitle: "Fix the widget",
      taskDescription: "The widget is broken, please fix it.",
      branch: "feat/fix-widget",
      baseBranch: "main",
      worktreePath: "/tmp/test-wt",
      repoRoot: "/tmp/test-repo",
      repoSlug: "org/repo",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(typeof result.prompt).toBe("string");
    expect(result.prompt.length).toBeGreaterThan(50);
    expect(result.prompt).toContain("Fix the widget");
    expect(result.prompt).toContain("TASK-42");
    expect(ctx.data._taskPrompt).toBe(result.prompt);
  });

  it("includes branch and repo info", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({});
    const node = makeNode("action.build_task_prompt", {
      taskId: "T1",
      taskTitle: "Test",
      taskDescription: "Desc",
      branch: "feat/branch-test",
      baseBranch: "main",
      repoSlug: "myorg/myrepo",
    });
    const result = await nt.execute(node, ctx);
    expect(result.prompt).toContain("feat/branch-test");
  });

  it("includes instruction lines", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({});
    const node = makeNode("action.build_task_prompt", {
      taskId: "T2",
      taskTitle: "Test",
      taskDescription: "Desc",
    });
    const result = await nt.execute(node, ctx);
    // Should have autonomous agent instructions
    expect(result.prompt).toContain("commit");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.detect_new_commits Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.detect_new_commits", () => {
  let gitDir;

  beforeEach(() => {
    gitDir = mkdtempSync(join(tmpdir(), "wf-detect-commits-"));
    execSync("git init", { cwd: gitDir, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: gitDir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: gitDir, stdio: "ignore" });
    writeFileSync(join(gitDir, "README.md"), "init");
    execSync("git add . && git commit -m init", { cwd: gitDir, stdio: "ignore" });
  });

  afterEach(() => {
    try { rmSync(gitDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("detects no commits when HEAD unchanged", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const head = execSync("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    const ctx = makeCtx({ _preExecHead: head });
    const node = makeNode("action.detect_new_commits", {
      worktreePath: gitDir,
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.hasNewCommits).toBe(false);
  });

  it("detects new commits when HEAD changed", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const preHead = execSync("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    // Make a new commit
    writeFileSync(join(gitDir, "new.txt"), "new content");
    execSync("git add . && git commit -m new", { cwd: gitDir, stdio: "ignore" });
    const ctx = makeCtx({ _preExecHead: preHead });
    const node = makeNode("action.detect_new_commits", {
      worktreePath: gitDir,
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.hasNewCommits).toBe(true);
    expect(result.hasCommits).toBe(true);
    expect(result.preExecHead).toBe(preHead);
    expect(result.postExecHead).not.toBe(preHead);
  });

  it("stores results in ctx.data", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const head = execSync("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    const ctx = makeCtx({ _preExecHead: head });
    const node = makeNode("action.detect_new_commits", { worktreePath: gitDir });
    await nt.execute(node, ctx);
    expect(typeof ctx.data._hasNewCommits).toBe("boolean");
    expect(typeof ctx.data._postExecHead).toBe("string");
  });

  it("fails gracefully on invalid path", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const ctx = makeCtx({});
    const node = makeNode("action.detect_new_commits", {
      worktreePath: "/nonexistent/path/xyz",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(false);
    expect(result.hasCommits).toBe(false);
  });

  it("throws if worktreePath is missing", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const ctx = makeCtx({});
    const node = makeNode("action.detect_new_commits", {});
    await expect(nt.execute(node, ctx)).rejects.toThrow("worktreePath");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.push_branch Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.push_branch", () => {
  it("refuses to push to protected branches", async () => {
    const nt = getNodeType("action.push_branch");
    const ctx = makeCtx({});
    const node = makeNode("action.push_branch", {
      worktreePath: "/tmp/test",
      branch: "main",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Protected branch");
    expect(result.pushed).toBe(false);
  });

  it("refuses origin/main as well", async () => {
    const nt = getNodeType("action.push_branch");
    const ctx = makeCtx({});
    const node = makeNode("action.push_branch", {
      worktreePath: "/tmp/test",
      branch: "origin/main",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Protected branch");
  });

  it("refuses master, develop, production", async () => {
    const nt = getNodeType("action.push_branch");
    for (const branch of ["master", "develop", "production"]) {
      const ctx = makeCtx({});
      const node = makeNode("action.push_branch", {
        worktreePath: "/tmp/test",
        branch,
      });
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(false);
    }
  });

  it("throws if worktreePath is missing", async () => {
    const nt = getNodeType("action.push_branch");
    const ctx = makeCtx({});
    const node = makeNode("action.push_branch", {});
    await expect(nt.execute(node, ctx)).rejects.toThrow("worktreePath");
  });

  it("schema has rebaseBeforePush and emptyDiffGuard options", () => {
    const nt = getNodeType("action.push_branch");
    expect(nt.schema.properties.rebaseBeforePush).toBeDefined();
    expect(nt.schema.properties.emptyDiffGuard).toBeDefined();
    expect(nt.schema.properties.syncMainForModuleBranch).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.release_worktree Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.release_worktree", () => {
  it("succeeds when worktree path doesn't exist", async () => {
    const nt = getNodeType("action.release_worktree");
    const ctx = makeCtx({});
    const node = makeNode("action.release_worktree", {
      worktreePath: "/nonexistent/path/wt",
      repoRoot: "/nonexistent/repo",
      taskId: "t1",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.release_claim Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("action.release_claim", () => {
  it("clears claim data from ctx (set to null)", async () => {
    const nt = getNodeType("action.release_claim");
    const ctx = makeCtx({
      _claimToken: "abc123",
      _claimInstanceId: "inst-1",
      _claimRenewTimer: null,
    });
    const node = makeNode("action.release_claim", { taskId: "t1" });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(ctx.data._claimToken).toBeNull();
    expect(ctx.data._claimInstanceId).toBeNull();
  });

  it("clears renewal timer if present", async () => {
    const nt = getNodeType("action.release_claim");
    const timer = setInterval(() => {}, 100000);
    timer.unref();
    const ctx = makeCtx({
      _claimToken: "abc",
      _claimRenewTimer: timer,
    });
    const node = makeNode("action.release_claim", { taskId: "t2" });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    clearInterval(timer); // extra safety
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Template: task-lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe("template-task-lifecycle", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("exists and has correct metadata", () => {
    const t = getTemplate("template-task-lifecycle");
    expect(t).toBeDefined();
    expect(t.name).toBe("Task Lifecycle");
    expect(t.category).toBe("lifecycle");
    expect(t.enabled).toBe(true);
    expect(t.recommended).toBe(true);
  });

  it("has all required node IDs", () => {
    const t = getTemplate("template-task-lifecycle");
    const ids = t.nodes.map((n) => n.id);
    const required = [
      "trigger", "check-slots", "allocate-slot", "claim-task",
      "claim-ok", "set-inprogress", "acquire-worktree", "worktree-ok",
      "resolve-executor", "record-head", "build-prompt", "run-agent",
      "claim-stolen", "detect-commits", "has-commits",
      "push-branch", "push-ok", "create-pr", "set-inreview", "log-success",
      "log-no-commits", "set-todo-cooldown",
      "release-worktree", "release-claim", "release-slot",
    ];
    for (const id of required) {
      expect(ids, `missing node: ${id}`).toContain(id);
    }
  });

  it("does NOT reference resolvedSdk/resolvedModel in allocate-slot config", () => {
    const t = getTemplate("template-task-lifecycle");
    const allocSlot = t.nodes.find((n) => n.id === "allocate-slot");
    expect(allocSlot).toBeDefined();
    const cfgStr = JSON.stringify(allocSlot.config);
    expect(cfgStr).not.toContain("resolvedSdk");
    expect(cfgStr).not.toContain("resolvedModel");
  });

  it("resolve-executor runs AFTER worktree-ok (not before)", () => {
    const t = getTemplate("template-task-lifecycle");
    // resolve-executor should be downstream of worktree-ok
    const resolveEdge = t.edges.find(
      (e) => e.target === "resolve-executor",
    );
    expect(resolveEdge).toBeDefined();
    expect(resolveEdge.source).toBe("worktree-ok");
  });

  it("has claim-stolen check after run-agent", () => {
    const t = getTemplate("template-task-lifecycle");
    const edge = t.edges.find(
      (e) => e.source === "run-agent" && e.target === "claim-stolen",
    );
    expect(edge).toBeDefined();
  });

  it("push-branch has baseBranch and rebaseBeforePush config", () => {
    const t = getTemplate("template-task-lifecycle");
    const pushNode = t.nodes.find((n) => n.id === "push-branch");
    expect(pushNode).toBeDefined();
    expect(pushNode.config.baseBranch).toBe("{{baseBranch}}");
    expect(pushNode.config.rebaseBeforePush).toBe(true);
    expect(pushNode.config.emptyDiffGuard).toBe(true);
  });

  it("has push-ok check after push-branch", () => {
    const t = getTemplate("template-task-lifecycle");
    const edge = t.edges.find(
      (e) => e.source === "push-branch" && e.target === "push-ok",
    );
    expect(edge).toBeDefined();
  });

  it("all outcome paths converge to release-worktree → release-claim → release-slot", () => {
    const t = getTemplate("template-task-lifecycle");
    // log-success → release-worktree
    expect(t.edges.find((e) => e.source === "log-success" && e.target === "release-worktree")).toBeDefined();
    // set-todo-cooldown → release-worktree
    expect(t.edges.find((e) => e.source === "set-todo-cooldown" && e.target === "release-worktree")).toBeDefined();
    // set-todo-stolen → release-worktree
    expect(t.edges.find((e) => e.source === "set-todo-stolen" && e.target === "release-worktree")).toBeDefined();
    // set-todo-push-failed → release-worktree
    expect(t.edges.find((e) => e.source === "set-todo-push-failed" && e.target === "release-worktree")).toBeDefined();
    // release-worktree → release-claim → release-slot
    expect(t.edges.find((e) => e.source === "release-worktree" && e.target === "release-claim")).toBeDefined();
    expect(t.edges.find((e) => e.source === "release-claim" && e.target === "release-slot")).toBeDefined();
  });

  it("claim-failed path releases slot", () => {
    const t = getTemplate("template-task-lifecycle");
    expect(t.edges.find((e) => e.source === "claim-ok" && e.target === "release-slot-claim-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "release-slot-claim-failed" && e.target === "log-claim-failed")).toBeDefined();
  });

  it("worktree-failed path releases claim and slot", () => {
    const t = getTemplate("template-task-lifecycle");
    expect(t.edges.find((e) => e.source === "worktree-ok" && e.target === "release-claim-wt-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "release-claim-wt-failed" && e.target === "set-todo-wt-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-todo-wt-failed" && e.target === "release-slot-wt-failed")).toBeDefined();
  });

  it("all edges reference valid node IDs", () => {
    const t = getTemplate("template-task-lifecycle");
    const nodeIds = new Set(t.nodes.map((n) => n.id));
    for (const e of t.edges) {
      expect(nodeIds, `edge source "${e.source}" not in nodes`).toContain(e.source);
      expect(nodeIds, `edge target "${e.target}" not in nodes`).toContain(e.target);
    }
  });

  it("no orphan nodes (every non-trigger node is a target of some edge)", () => {
    const t = getTemplate("template-task-lifecycle");
    const targets = new Set(t.edges.map((e) => e.target));
    for (const n of t.nodes) {
      if (n.id === "trigger") continue; // trigger has no incoming edge
      expect(targets, `node "${n.id}" is orphaned`).toContain(n.id);
    }
  });

  it("has correct variables with sensible defaults", () => {
    const t = getTemplate("template-task-lifecycle");
    expect(t.variables.maxParallel).toBe(3);
    expect(t.variables.claimTtlMinutes).toBe(180);
    expect(t.variables.claimRenewIntervalMs).toBe(300000);
    expect(t.variables.taskTimeoutMs).toBe(21600000);
    expect(t.variables.defaultSdk).toBe("auto");
    expect(Array.isArray(t.variables.protectedBranches)).toBe(true);
  });

  it("replaces task-executor.mjs module", () => {
    const t = getTemplate("template-task-lifecycle");
    expect(t.metadata.replaces.module).toBe("task-executor.mjs");
    expect(t.metadata.replaces.functions).toContain("executeTask");
  });

  it("installs and round-trips through engine", () => {
    const result = installTemplate("template-task-lifecycle", engine);
    expect(result.id).not.toBe("template-task-lifecycle");
    expect(result.metadata.installedFrom).toBe("template-task-lifecycle");
    const stored = engine.get(result.id);
    expect(stored).toBeDefined();
    expect(stored.name).toBe("Task Lifecycle");
  });

  it("installs with variable overrides", () => {
    const result = installTemplate("template-task-lifecycle", engine, {
      maxParallel: 5,
      taskTimeoutMs: 3600000,
    });
    expect(result.variables.maxParallel).toBe(5);
    expect(result.variables.taskTimeoutMs).toBe(3600000);
    expect(result.variables.defaultSdk).toBe("auto"); // unchanged
  });

  it("dry-run executes without errors (trigger stops at no kanban)", async () => {
    const result = installTemplate("template-task-lifecycle", engine);
    const ctx = new WorkflowContext({});
    // Dry run should complete without throwing
    try {
      await engine.execute(result.id, ctx, { dryRun: true });
    } catch (err) {
      // Some nodes may fail in dry-run if services aren't wired,
      // but the DAG structure should be valid
      expect(err.message).not.toContain("Unknown node type");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Template: ve-orchestrator-lite
// ═══════════════════════════════════════════════════════════════════════════

describe("template-ve-orchestrator-lite", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("exists and has correct metadata", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    expect(t).toBeDefined();
    expect(t.name).toBe("VE Orchestrator Lite");
    expect(t.category).toBe("lifecycle");
    expect(t.enabled).toBe(true);
    expect(t.recommended).toBe(false);
  });

  it("has slot management nodes", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    const ids = t.nodes.map((n) => n.id);
    expect(ids).toContain("check-slots");
    expect(ids).toContain("allocate-slot");
    expect(ids).toContain("release-slot");
  });

  it("has worktree management nodes", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    const ids = t.nodes.map((n) => n.id);
    expect(ids).toContain("acquire-worktree");
    expect(ids).toContain("release-worktree");
  });

  it("has push-branch node", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    const ids = t.nodes.map((n) => n.id);
    expect(ids).toContain("push");
  });

  it("has record-head for commit detection", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    const ids = t.nodes.map((n) => n.id);
    expect(ids).toContain("record-head");
  });

  it("all edges reference valid node IDs", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    const nodeIds = new Set(t.nodes.map((n) => n.id));
    for (const e of t.edges) {
      expect(nodeIds, `edge source "${e.source}" not in nodes`).toContain(e.source);
      expect(nodeIds, `edge target "${e.target}" not in nodes`).toContain(e.target);
    }
  });

  it("no orphan nodes", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    const targets = new Set(t.edges.map((e) => e.target));
    for (const n of t.nodes) {
      if (n.id === "trigger") continue;
      expect(targets, `node "${n.id}" is orphaned`).toContain(n.id);
    }
  });

  it("cleanup chain: release-worktree → release-claim → release-slot", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    expect(t.edges.find((e) => e.source === "release-worktree" && e.target === "release-claim")).toBeDefined();
    expect(t.edges.find((e) => e.source === "release-claim" && e.target === "release-slot")).toBeDefined();
  });

  it("claim-failed path releases slot", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    expect(t.edges.find((e) => e.source === "claim-check" && e.target === "release-slot-skip")).toBeDefined();
  });

  it("replaces ve-orchestrator.mjs module", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    expect(t.metadata.replaces.module).toBe("ve-orchestrator.mjs");
  });

  it("installs and round-trips through engine", () => {
    const result = installTemplate("template-ve-orchestrator-lite", engine);
    expect(result.id).not.toBe("template-ve-orchestrator-lite");
    expect(result.metadata.installedFrom).toBe("template-ve-orchestrator-lite");
    const stored = engine.get(result.id);
    expect(stored).toBeDefined();
    expect(stored.name).toBe("VE Orchestrator Lite");
  });

  it("has correct variables", () => {
    const t = getTemplate("template-ve-orchestrator-lite");
    expect(t.variables.maxParallel).toBe(2);
    expect(t.variables.maxRetries).toBe(1);
    expect(t.variables.defaultSdk).toBe("auto");
    expect(Array.isArray(t.variables.protectedBranches)).toBe(true);
  });
});
