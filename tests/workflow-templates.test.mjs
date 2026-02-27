import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WORKFLOW_TEMPLATES,
  TEMPLATE_CATEGORIES,
  getTemplate,
  listTemplates,
  listWorkflowSetupProfiles,
  getWorkflowSetupProfile,
  resolveWorkflowTemplateIds,
  installTemplate,
  installTemplateSet,
} from "../workflow-templates.mjs";
import { WorkflowEngine } from "../workflow-engine.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir;
let engine;

function makeTmpEngine() {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-tpl-test-"));
  engine = new WorkflowEngine({
    workflowDir: join(tmpDir, "workflows"),
    runsDir: join(tmpDir, "runs"),
    services: {},
  });
  return engine;
}

// ── Template Structural Validation ──────────────────────────────────────────

describe("workflow-templates", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("exports a frozen array of templates", () => {
    expect(Array.isArray(WORKFLOW_TEMPLATES)).toBe(true);
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThanOrEqual(24);
    expect(Object.isFrozen(WORKFLOW_TEMPLATES)).toBe(true);
  });

  it("every template has required fields", () => {
    for (const t of WORKFLOW_TEMPLATES) {
      expect(t.id).toMatch(/^template-/);
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.category).toBeDefined();
      expect(TEMPLATE_CATEGORIES).toHaveProperty(t.category);
      expect(Array.isArray(t.nodes)).toBe(true);
      expect(t.nodes.length).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(t.edges)).toBe(true);
      expect(t.edges.length).toBeGreaterThanOrEqual(1);
      expect(t.metadata).toBeDefined();
      expect(typeof t.metadata.author).toBe("string");
      expect(Array.isArray(t.metadata.tags)).toBe(true);
    }
  });

  it("all template IDs are unique", () => {
    const ids = WORKFLOW_TEMPLATES.map((t) => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("every node has id, type, label, position", () => {
    for (const t of WORKFLOW_TEMPLATES) {
      for (const n of t.nodes) {
        expect(typeof n.id, `${t.id} → node missing id`).toBe("string");
        expect(typeof n.type, `${t.id}/${n.id} → missing type`).toBe("string");
        expect(typeof n.label, `${t.id}/${n.id} → missing label`).toBe("string");
        expect(n.position, `${t.id}/${n.id} → missing position`).toBeDefined();
        expect(typeof n.position.x).toBe("number");
        expect(typeof n.position.y).toBe("number");
      }
    }
  });

  it("every node ID within a template is unique", () => {
    for (const t of WORKFLOW_TEMPLATES) {
      const ids = t.nodes.map((n) => n.id);
      const uniq = new Set(ids);
      expect(uniq.size, `Duplicate node IDs in ${t.id}`).toBe(ids.length);
    }
  });

  it("every edge references valid source and target nodes", () => {
    for (const t of WORKFLOW_TEMPLATES) {
      const nodeIds = new Set(t.nodes.map((n) => n.id));
      for (const e of t.edges) {
        expect(nodeIds.has(e.source), `${t.id}: edge source "${e.source}" not found`).toBe(true);
        expect(nodeIds.has(e.target), `${t.id}: edge target "${e.target}" not found`).toBe(true);
      }
    }
  });

  it("every template has at least one trigger node", () => {
    for (const t of WORKFLOW_TEMPLATES) {
      const triggers = t.nodes.filter((n) => n.type.startsWith("trigger."));
      expect(triggers.length, `${t.id} has no trigger node`).toBeGreaterThanOrEqual(1);
    }
  });

  it("no orphaned nodes (every non-trigger connects via edges)", () => {
    for (const t of WORKFLOW_TEMPLATES) {
      const connected = new Set();
      for (const e of t.edges) {
        connected.add(e.source);
        connected.add(e.target);
      }
      for (const n of t.nodes) {
        // Trigger nodes with no incoming edges are expected entry points
        if (n.type.startsWith("trigger.")) continue;
        expect(connected.has(n.id), `${t.id}: node "${n.id}" is orphaned (not in any edge)`).toBe(true);
      }
    }
  });
});

// ── Template API ────────────────────────────────────────────────────────────

describe("template API functions", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("getTemplate returns template by ID", () => {
    const t = getTemplate("template-pr-merge-strategy");
    expect(t).toBeDefined();
    expect(t.name).toBe("PR Merge Strategy");
  });

  it("getTemplate returns null for unknown ID", () => {
    expect(getTemplate("template-does-not-exist")).toBeNull();
  });

  it("listTemplates returns summaries with recommended/enabled fields", () => {
    const list = listTemplates();
    expect(list.length).toBe(WORKFLOW_TEMPLATES.length);
    for (const item of list) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.name).toBe("string");
      expect(typeof item.recommended).toBe("boolean");
      expect(typeof item.enabled).toBe("boolean");
      expect(typeof item.categoryLabel).toBe("string");
      expect(typeof item.categoryIcon).toBe("string");
      expect(typeof item.nodeCount).toBe("number");
      expect(typeof item.edgeCount).toBe("number");
    }
  });

  it("recommended templates are marked correctly", () => {
    const list = listTemplates();
    const recommended = list.filter((t) => t.recommended);
    expect(recommended.length).toBeGreaterThanOrEqual(4);

    // These should all be recommended
    const expectedRecommended = [
      "template-pr-merge-strategy",
      "template-review-agent",
      "template-task-planner",
      "template-error-recovery",
      "template-anomaly-watchdog",
      "template-workspace-hygiene",
      "template-task-finalization-guard",
      "template-task-repair-worktree",
      "template-task-status-transition-manager",
      "template-pr-conflict-resolver",
      "template-agent-session-monitor",
      "template-release-pipeline",
      "template-backend-agent",
      "template-incident-response",
      "template-dependency-audit",
    ];
    for (const id of expectedRecommended) {
      const item = list.find((t) => t.id === id);
      expect(item?.recommended, `${id} should be recommended`).toBe(true);
    }
  });

  it("installTemplate creates a new workflow with unique ID", () => {
    const result = installTemplate("template-error-recovery", engine);
    expect(result.id).not.toBe("template-error-recovery");
    expect(result.metadata.installedFrom).toBe("template-error-recovery");
    expect(result.nodes.length).toBeGreaterThan(0);

    // Verify it was saved to the engine
    const stored = engine.get(result.id);
    expect(stored).toBeDefined();
    expect(stored.name).toBe("Error Recovery");
  });

  it("installTemplate applies variable overrides", () => {
    const result = installTemplate("template-anomaly-watchdog", engine, {
      stallThresholdMs: 600000,
      customVar: "hello",
    });
    expect(result.variables.stallThresholdMs).toBe(600000);
    expect(result.variables.customVar).toBe("hello");
  });

  it("installTemplate throws for unknown template", () => {
    expect(() => installTemplate("template-nope", engine)).toThrow(/not found/);
  });
});

describe("workflow setup profiles", () => {
  it("exposes built-in setup profiles with template selections", () => {
    const profiles = listWorkflowSetupProfiles();
    const ids = profiles.map((profile) => profile.id);
    expect(ids).toContain("manual");
    expect(ids).toContain("balanced");
    expect(ids).toContain("autonomous");
    for (const profile of profiles) {
      expect(Array.isArray(profile.templateIds)).toBe(true);
      expect(profile.templateIds.length).toBeGreaterThan(0);
      expect(typeof profile.workflowAutomationEnabled).toBe("boolean");
    }
  });

  it("returns balanced profile as fallback", () => {
    const profile = getWorkflowSetupProfile("nope");
    expect(profile.id).toBe("balanced");
    expect(Array.isArray(profile.templateIds)).toBe(true);
    expect(profile.templateIds.length).toBeGreaterThan(0);
  });

  it("resolves explicit template lists and filters unknown IDs", () => {
    const resolved = resolveWorkflowTemplateIds({
      profileId: "manual",
      templateIds: [
        "template-task-planner",
        "template-nope",
        "template-task-planner",
        "template-error-recovery",
      ],
    });
    expect(resolved).toEqual([
      "template-task-planner",
      "template-error-recovery",
    ]);
  });
});

describe("installTemplateSet", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("installs only the requested templates and skips duplicates", () => {
    const result = installTemplateSet(engine, [
      "template-error-recovery",
      "template-task-planner",
      "template-nope",
    ]);
    expect(result.installed.length).toBe(2);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].id).toBe("template-nope");

    const second = installTemplateSet(engine, [
      "template-error-recovery",
      "template-task-planner",
    ]);
    expect(second.installed.length).toBe(0);
    expect(second.skipped.length).toBe(2);
  });
});

describe("health check template reliability behavior", () => {
  it("uses cross-platform commands for git and daemon checks", () => {
    const template = getTemplate("template-health-check");
    expect(template).toBeDefined();

    const checkGit = template.nodes.find((n) => n.id === "check-git");
    const checkAgents = template.nodes.find((n) => n.id === "check-agents");

    expect(checkGit?.config?.command).toContain("node -e");
    expect(checkGit?.config?.command).not.toMatch(/\bgrep\b/);
    expect(checkAgents?.config?.command).toContain("node -e");
    expect(checkAgents?.config?.command).not.toContain("2>/dev/null");
    expect(checkAgents?.config?.command).toContain("bosun --daemon-status");
  });

  it("flags issues when command checks fail even without doctor ERROR/CRITICAL text", () => {
    const template = getTemplate("template-health-check");
    const hasIssuesNode = template.nodes.find((n) => n.id === "has-issues");
    const expr = hasIssuesNode?.config?.expression;
    expect(typeof expr).toBe("string");

    const makeCtx = (outputs) => ({
      getNodeOutput: (id) => outputs[id],
    });
    const evaluate = new Function("$data", "$ctx", "$output", `return (${expr});`);

    const failedGit = evaluate({}, makeCtx({
      "check-config": { success: true, output: "Status: OK" },
      "check-git": { success: false, error: "command failed" },
      "check-agents": { success: true, output: "running" },
    }), {});
    expect(failedGit).toBe(true);

    const allHealthy = evaluate({}, makeCtx({
      "check-config": { success: true, output: "Status: OK" },
      "check-git": { success: true, output: "" },
      "check-agents": { success: true, output: "running" },
    }), {});
    expect(allHealthy).toBe(false);
  });
});

describe("github template CLI compatibility", () => {
  it("uses supported gh pr checks fields for merge strategy and conflict resolver", () => {
    const mergeTemplate = getTemplate("template-pr-merge-strategy");
    const resolverTemplate = getTemplate("template-pr-conflict-resolver");
    expect(mergeTemplate).toBeDefined();
    expect(resolverTemplate).toBeDefined();

    const checkCi = mergeTemplate.nodes.find((n) => n.id === "check-ci");
    const verifyCi = resolverTemplate.nodes.find((n) => n.id === "verify-ci");

    expect(checkCi?.config?.command).toContain("gh pr checks");
    expect(checkCi?.config?.command).toContain("--json name,state");
    expect(checkCi?.config?.command).not.toContain("conclusion");

    expect(verifyCi?.config?.command).toContain("gh pr checks");
    expect(verifyCi?.config?.command).toContain("--json name,state");
    expect(verifyCi?.config?.command).not.toContain("conclusion");
    expect(verifyCi?.config?.command).not.toMatch(/\|\s*head\b/);
  });

  it("merge strategy CI gate treats unsupported/malformed output as not passed", () => {
    const mergeTemplate = getTemplate("template-pr-merge-strategy");
    const ciPassedNode = mergeTemplate.nodes.find((n) => n.id === "ci-passed");
    const expr = ciPassedNode?.config?.expression;
    expect(typeof expr).toBe("string");

    const makeCtx = (outputs) => ({
      getNodeOutput: (id) => outputs[id],
    });
    const evaluate = new Function("$data", "$ctx", "$output", `return (${expr});`);

    const malformed = evaluate({}, makeCtx({
      "check-ci": { passed: true, output: "not-json" },
    }), {});
    expect(malformed).toBe(false);

    const failedState = evaluate({}, makeCtx({
      "check-ci": { passed: true, output: JSON.stringify([{ name: "ci", state: "FAILURE" }]) },
    }), {});
    expect(failedState).toBe(false);

    const allPassing = evaluate({}, makeCtx({
      "check-ci": { passed: true, output: JSON.stringify([{ name: "ci", state: "SUCCESS" }]) },
    }), {});
    expect(allPassing).toBe(true);
  });
});

// ── Dry-Run Execution ───────────────────────────────────────────────────────

describe("template dry-run execution", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  beforeEach(async () => {
    // Side-effect import registers built-in workflow node types once per test process.
    await import("../workflow-nodes.mjs");
  });

  for (const template of WORKFLOW_TEMPLATES) {
    it(`template "${template.id}" dry-run executes without errors`, async () => {
      const installed = installTemplate(template.id, engine);
      const ctx = await engine.execute(installed.id, {}, { dryRun: true, force: true });
      expect(ctx, `Dry-run failed for ${template.id}`).toBeDefined();
      expect(
        ctx.errors || [],
        `Dry-run produced runtime errors for ${template.id}`
      ).toEqual([]);
    });
  }
});

// ── Replaces Metadata ───────────────────────────────────────────────────────

describe("template replaces metadata", () => {
  it("templates that replace modules have valid replaces metadata", () => {
    const withReplaces = WORKFLOW_TEMPLATES.filter(
      (t) => t.metadata?.replaces?.module
    );
    expect(withReplaces.length).toBeGreaterThanOrEqual(11);

    for (const t of withReplaces) {
      const r = t.metadata.replaces;
      expect(typeof r.module, `${t.id}: replaces.module must be a string`).toBe("string");
      expect(r.module).toMatch(/\.mjs$/);
      expect(Array.isArray(r.functions), `${t.id}: replaces.functions`).toBe(true);
      expect(r.functions.length).toBeGreaterThan(0);
      expect(typeof r.description, `${t.id}: replaces.description`).toBe("string");
    }
  });

  it("no two templates replace the exact same functions in a module", () => {
    // Multiple templates CAN replace _different functions_ in the same module.
    // But the same function should not be claimed by two templates.
    const functionMap = new Map(); // "module:function" → templateId
    for (const t of WORKFLOW_TEMPLATES) {
      const r = t.metadata?.replaces;
      if (!r?.module || !r?.functions) continue;
      for (const fn of r.functions) {
        const key = `${r.module}:${fn}`;
        expect(functionMap.has(key), `Function "${key}" replaced by both "${functionMap.get(key)}" and "${t.id}"`).toBe(false);
        functionMap.set(key, t.id);
      }
    }
  });
});

// ── Category Coverage ───────────────────────────────────────────────────────

describe("template category coverage", () => {
  it("every used category is defined in TEMPLATE_CATEGORIES", () => {
    const usedCategories = new Set(WORKFLOW_TEMPLATES.map((t) => t.category));
    for (const cat of usedCategories) {
      expect(TEMPLATE_CATEGORIES).toHaveProperty(cat);
    }
  });

  it("categories have valid structure", () => {
    for (const [key, val] of Object.entries(TEMPLATE_CATEGORIES)) {
      expect(typeof val.label).toBe("string");
      expect(typeof val.icon).toBe("string");
      expect(typeof val.order).toBe("number");
    }
  });
});
