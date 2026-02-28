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
  applyWorkflowTemplateState,
  updateWorkflowFromTemplate,
  reconcileInstalledTemplates,
  installTemplate,
  installTemplateSet,
} from "../workflow-templates.mjs";
import {
  WorkflowEngine,
  getNodeType,
  registerNodeType,
} from "../workflow-engine.mjs";

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

function collectStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectStrings(entry, out);
  }
  return out;
}

function ensureExperimentalWorkflowNodeTypesRegistered() {
  const registerIfMissing = (type, handler) => {
    if (getNodeType(type)) return;
    registerNodeType(type, handler);
  };

  registerIfMissing("meeting.start", {
    describe: () => "Start a meeting session",
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        executor: { type: "string" },
        wakePhrase: { type: "string" },
      },
    },
    async execute(node, ctx) {
      return {
        success: true,
        sessionId: `meeting-${ctx.id}`,
        title: ctx.resolve(node.config?.title || ""),
        executor: ctx.resolve(node.config?.executor || ""),
        wakePhrase: ctx.resolve(node.config?.wakePhrase || ""),
      };
    },
  });

  registerIfMissing("meeting.send", {
    describe: () => "Send a meeting message",
    schema: {
      type: "object",
      properties: {
        message: { type: "string" },
        role: { type: "string" },
      },
    },
    async execute(node, ctx) {
      return {
        success: true,
        message: ctx.resolve(node.config?.message || ""),
        role: ctx.resolve(node.config?.role || "system"),
      };
    },
  });

  registerIfMissing("meeting.transcript", {
    describe: () => "Capture meeting transcript",
    schema: {
      type: "object",
      properties: {
        format: { type: "string" },
      },
    },
    async execute(node, ctx) {
      const format = ctx.resolve(node.config?.format || "markdown");
      return {
        success: true,
        format,
        transcript: "bosun wake transcript summary with actionable planning outcomes",
      };
    },
  });

  registerIfMissing("meeting.vision", {
    describe: () => "Analyze meeting frame",
    schema: {
      type: "object",
      properties: {
        frameDataUrl: { type: "string" },
        source: { type: "string" },
      },
    },
    async execute(node, ctx) {
      return {
        success: true,
        analyzed: Boolean(ctx.resolve(node.config?.frameDataUrl || "")),
        summary: "Vision summary mock",
      };
    },
  });

  registerIfMissing("meeting.finalize", {
    describe: () => "Finalize meeting session",
    schema: {
      type: "object",
      properties: {
        status: { type: "string" },
      },
    },
    async execute(node, ctx) {
      return {
        success: true,
        status: ctx.resolve(node.config?.status || "completed"),
      };
    },
  });

  registerIfMissing("trigger.meeting.wake_phrase", {
    describe: () => "Wake phrase trigger",
    schema: {
      type: "object",
      properties: {
        wakePhrase: { type: "string" },
        text: { type: "string" },
      },
    },
    async execute(node, ctx) {
      const phrase = String(ctx.resolve(node.config?.wakePhrase || "")).toLowerCase();
      const text = String(ctx.resolve(node.config?.text || "")).toLowerCase();
      return {
        triggered: Boolean(phrase) && text.includes(phrase),
      };
    },
  });

  registerIfMissing("action.execute_workflow", {
    describe: () => "Execute a child workflow",
    schema: {
      type: "object",
      properties: {
        workflowId: { type: "string" },
        mode: { type: "string" },
        input: { type: "object" },
        inheritContext: { type: "boolean" },
        includeKeys: { type: "array" },
        outputVariable: { type: "string" },
        failOnChildError: { type: "boolean" },
      },
    },
    async execute(node, ctx) {
      const workflowId = String(ctx.resolve(node.config?.workflowId || "")).trim();
      if (!workflowId) {
        return { success: false, status: "failed", error: "workflowId is required" };
      }
      return {
        success: true,
        status: node.config?.mode === "dispatch" ? "dispatched" : "completed",
        workflowId,
        runId: `child-${ctx.id}`,
      };
    },
  });
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

  it("every template variable is referenced by node/edge config", () => {
    for (const t of WORKFLOW_TEMPLATES) {
      const keys = Object.keys(t.variables || {});
      if (keys.length === 0) continue;
      const strings = collectStrings({ nodes: t.nodes, edges: t.edges });
      for (const key of keys) {
        const used = strings.some((text) =>
          text.includes(`{{${key}}}`) ||
          text.includes(`$data?.${key}`) ||
          text.includes(`$data.${key}`),
        );
        expect(
          used,
          `${t.id}: variable "${key}" is never referenced in node/edge config`,
        ).toBe(true);
      }
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

  it("task planner template materializes planner output before success notification", () => {
    const planner = getTemplate("template-task-planner");
    expect(planner).toBeDefined();

    expect(planner.variables?.taskCount).toBe(5);
    expect(planner.variables?.prompt).toBe("");
    expect(typeof planner.variables?.plannerContext).toBe("string");

    const trigger = planner.nodes.find((n) => n.id === "trigger");
    expect(trigger?.config?.threshold).toBe("{{minTodoCount}}");

    const runPlanner = planner.nodes.find((n) => n.id === "run-planner");
    expect(runPlanner?.config?.taskCount).toBe("{{taskCount}}");
    expect(runPlanner?.config?.context).toBe("{{plannerContext}}");
    expect(runPlanner?.config?.prompt).toBe("{{prompt}}");

    const materialize = planner.nodes.find((n) => n.id === "materialize-tasks");
    expect(materialize).toBeDefined();
    expect(materialize.type).toBe("action.materialize_planner_tasks");
    expect(materialize.config?.failOnZero).toBe(true);
    expect(materialize.config?.maxTasks).toBe("{{taskCount}}");

    const edgeToMaterialize = planner.edges.find(
      (e) => e.source === "run-planner" && e.target === "materialize-tasks",
    );
    const edgeToCheck = planner.edges.find(
      (e) => e.source === "materialize-tasks" && e.target === "check-result",
    );
    expect(edgeToMaterialize).toBeDefined();
    expect(edgeToCheck).toBeDefined();
  });

  it("meeting subworkflow chain template includes meeting and child workflow nodes", () => {
    const template = getTemplate("template-meeting-subworkflow-chain");
    expect(template).toBeDefined();

    expect(template.variables?.sessionTitle).toBe("Sprint Planning Sync");
    expect(template.variables?.meetingExecutor).toBe("codex");
    expect(template.variables?.wakePhrase).toBe("bosun wake");
    expect(template.variables?.childWorkflowId).toBe("template-task-planner");

    const startNode = template.nodes.find((n) => n.id === "meeting-start");
    const visionNode = template.nodes.find((n) => n.id === "meeting-vision");
    const transcriptNode = template.nodes.find((n) => n.id === "meeting-transcript");
    const wakeTriggerNode = template.nodes.find((n) => n.id === "wake-phrase-trigger");
    const chainNode = template.nodes.find((n) => n.id === "execute-child-workflow");
    const finalizeNode = template.nodes.find((n) => n.id === "meeting-finalize");
    const guardNode = template.nodes.find((n) => n.id === "guard-transcript");

    expect(startNode?.type).toBe("meeting.start");
    expect(visionNode?.type).toBe("meeting.vision");
    expect(transcriptNode?.type).toBe("meeting.transcript");
    expect(wakeTriggerNode?.type).toBe("trigger.meeting.wake_phrase");
    expect(chainNode?.type).toBe("action.execute_workflow");
    expect(finalizeNode?.type).toBe("meeting.finalize");
    expect(guardNode?.type).toBe("condition.expression");
    expect(chainNode?.config?.workflowId).toBe("{{childWorkflowId}}");
    expect(chainNode?.config?.mode).toBe("sync");
    expect(chainNode?.config?.failOnChildError).toBe(false);

    const guardToChain = template.edges.find(
      (e) => e.source === "guard-transcript" && e.target === "execute-child-workflow",
    );
    const guardToNotify = template.edges.find(
      (e) => e.source === "guard-transcript" && e.target === "notify-guard-failed",
    );
    expect(guardToChain).toBeDefined();
    expect(guardToNotify).toBeDefined();
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
      // template-pr-conflict-resolver deliberately excluded — superseded by
      // template-bosun-pr-watchdog which owns conflict detection, CI checks,
      // diff-safety review, and merge in one consolidated workflow.
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
    expect(result.metadata.templateState).toBeDefined();
    expect(result.metadata.templateState.isCustomized).toBe(false);
    expect(result.metadata.templateState.updateAvailable).toBe(false);
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

describe("template drift + update behavior", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("marks workflow as customized when fingerprint drifts", () => {
    const installed = installTemplate("template-error-recovery", engine);
    const wf = engine.get(installed.id);
    wf.variables.customNote = "edited";
    applyWorkflowTemplateState(wf);

    expect(wf.metadata.templateState.isCustomized).toBe(true);
    expect(wf.metadata.templateState.updateAvailable).toBe(false);
  });

  it("auto-updates unmodified workflows when template version drift is detected", () => {
    const installed = installTemplate("template-error-recovery", engine);
    const wf = engine.get(installed.id);
    wf.metadata.templateState.installedTemplateFingerprint = "0000-outdated";
    wf.metadata.templateState.installedTemplateVersion = "0000-outdated";
    wf.metadata.templateState.updateAvailable = true;
    engine.save(wf);

    const result = reconcileInstalledTemplates(engine, { autoUpdateUnmodified: true });
    expect(result.autoUpdated).toBe(1);

    const refreshed = engine.get(installed.id);
    expect(refreshed.metadata.templateState.updateAvailable).toBe(false);
    expect(refreshed.metadata.templateState.isCustomized).toBe(false);
  });

  it("does not auto-update customized workflows with updates available", () => {
    const installed = installTemplate("template-error-recovery", engine);
    const wf = engine.get(installed.id);
    wf.variables.customNote = "edited";
    applyWorkflowTemplateState(wf);
    wf.metadata.templateState.installedTemplateFingerprint = "0000-outdated";
    wf.metadata.templateState.installedTemplateVersion = "0000-outdated";
    wf.metadata.templateState.updateAvailable = true;
    engine.save(wf);

    const result = reconcileInstalledTemplates(engine, { autoUpdateUnmodified: true });
    expect(result.autoUpdated).toBe(0);
    expect(result.customized.some((entry) => entry.workflowId === wf.id)).toBe(true);
    expect(result.updateAvailable.some((entry) => entry.workflowId === wf.id)).toBe(true);
  });

  it("supports copy update mode for customized workflows", () => {
    const installed = installTemplate("template-error-recovery", engine);
    const wf = engine.get(installed.id);
    wf.variables.customNote = "edited";
    applyWorkflowTemplateState(wf);
    engine.save(wf);

    const copied = updateWorkflowFromTemplate(engine, wf.id, { mode: "copy" });
    expect(copied.id).not.toBe(wf.id);
    expect(copied.name).toContain("(Updated)");
    expect(copied.metadata.templateState.updateAvailable).toBe(false);
    expect(copied.metadata.templateState.isCustomized).toBe(false);
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
    const autonomous = profiles.find((profile) => profile.id === "autonomous");
    expect(autonomous?.templateIds).toContain("template-bosun-pr-watchdog");
    expect(autonomous?.templateIds).not.toContain("template-pr-conflict-resolver");
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
  it("uses supported gh pr checks fields for merge strategy", () => {
    const mergeTemplate = getTemplate("template-pr-merge-strategy");
    expect(mergeTemplate).toBeDefined();

    const checkCi = mergeTemplate.nodes.find((n) => n.id === "check-ci");
    expect(checkCi?.config?.command).toContain("gh pr checks");
    expect(checkCi?.config?.command).toContain("--json name,state");
    expect(checkCi?.config?.command).not.toContain("conclusion");
  });

  it("conflict resolver is superseded by watchdog and defers merge to it", () => {
    const resolverTemplate = getTemplate("template-pr-conflict-resolver");
    expect(resolverTemplate).toBeDefined();
    // Conflict resolver is no longer recommended — Bosun PR Watchdog supersedes it.
    expect(resolverTemplate.recommended).toBeFalsy();
    expect(resolverTemplate.enabled).toBe(false);
    // Must filter to bosun-attached PRs only — never touch external PRs.
    const listNode = resolverTemplate.nodes.find((n) => n.id === "list-prs");
    expect(listNode?.config?.command).toContain("--label bosun-attached");
    // Must NOT contain a direct merge call — merge is deferred to watchdog.
    const hasMergeCall = resolverTemplate.nodes.some(
      (n) => typeof n.config?.command === "string" && n.config.command.includes("gh pr merge")
    );
    expect(hasMergeCall).toBe(false);
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

  it("PR watchdog fetch-and-classify inline script has no // line comments (would break single-line eval)", () => {
    const watchdogTemplate = getTemplate("template-bosun-pr-watchdog");
    expect(watchdogTemplate).toBeDefined();
    const fetchNode = watchdogTemplate.nodes.find((n) => n.id === "fetch-and-classify");
    expect(fetchNode).toBeDefined();
    const cmd = fetchNode.config?.command || "";
    // The script is joined into a single line for `node -e "..."`.
    // Any `//` line comment would comment out all subsequent code on that line,
    // causing SyntaxError: Unexpected end of input.
    expect(cmd).not.toMatch(/\/\/(?!\*)/); // no `//` comments
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
    ensureExperimentalWorkflowNodeTypesRegistered();
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
