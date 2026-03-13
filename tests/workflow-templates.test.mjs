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
  resolveWorkflowTemplateConfig,
  normalizeTemplateOverridesById,
  applyWorkflowTemplateState,
  updateWorkflowFromTemplate,
  reconcileInstalledTemplates,
  installTemplate,
  installTemplateSet,
} from "../workflow/workflow-templates.mjs";
import {
  WorkflowEngine,
  getNodeType,
  registerNodeType,
} from "../workflow/workflow-engine.mjs";

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

  it("weekly fitness summary template includes evaluator metrics and follow-up materialization", () => {
    const template = getTemplate("template-weekly-fitness-summary");
    expect(template).toBeDefined();
    expect(template?.category).toBe("planning");
    expect(template?.trigger).toBe("trigger.schedule");

    expect(template?.variables?.lookbackDays).toBe(7);
    expect(template?.variables?.maxFollowupTasks).toBe(4);
    expect(template?.variables?.createFollowupTasks).toBe(true);

    const taskNode = template.nodes.find((n) => n.id === "task-metrics");
    expect(taskNode?.type).toBe("action.bosun_cli");
    expect(taskNode?.config?.subcommand).toBe("task list");
    expect(taskNode?.config?.args).toContain("--json");

    const summaryNode = template.nodes.find((n) => n.id === "summarize-fitness-metrics");
    expect(summaryNode?.type).toBe("action.set_variable");
    expect(summaryNode?.config?.key).toBe("fitnessSummary");

    const latestArtifactNode = template.nodes.find((n) => n.id === "persist-fitness-summary");
    expect(latestArtifactNode?.type).toBe("action.write_file");
    expect(latestArtifactNode?.config?.path).toBe(".bosun/workflow-runs/weekly-fitness-summary.latest.json");

    const evaluateNode = template.nodes.find((n) => n.id === "evaluate-fitness");
    expect(evaluateNode?.type).toBe("action.run_agent");
    const prompt = String(evaluateNode?.config?.prompt || "").toLowerCase();
    expect(prompt).toContain("throughput");
    expect(prompt).toContain("regression rate");
    expect(prompt).toContain("merge success");
    expect(prompt).toContain("reopened tasks");
    expect(prompt).toContain("debt growth");
    expect(prompt).toContain("confidence");
    expect(prompt).toContain("weekly fitness json");

    const materializeNode = template.nodes.find((n) => n.id === "materialize-followups");
    expect(materializeNode?.type).toBe("action.materialize_planner_tasks");
    expect(materializeNode?.config?.maxTasks).toBe("{{maxFollowupTasks}}");

    const artifactEdge = template.edges.find(
      (e) => e.source === "persist-fitness-summary" && e.target === "evaluate-fitness",
    );
    expect(artifactEdge).toBeDefined();

    const createFlowEdge = template.edges.find(
      (e) => e.source === "has-followups" && e.target === "build-followup-json",
    );
    expect(createFlowEdge).toBeDefined();
  });

  it("backend agent template triggers on task_assigned without restrictive filter", () => {
    const template = getTemplate("template-backend-agent");
    expect(template).toBeDefined();

    const triggerNode = template.nodes.find((n) => n.id === "trigger");
    expect(triggerNode?.type).toBe("trigger.task_assigned");
    // No restrictive filter — triggers on any assigned task (language-agnostic)
    expect(triggerNode?.config?.filter).toBeUndefined();
  });

  it("agent templates only advance to inreview after a real PR is linked", () => {
    const backendTemplate = getTemplate("template-backend-agent");
    expect(backendTemplate).toBeDefined();
    const backendGate = backendTemplate.nodes.find((n) => n.id === "pr-created");
    const backendRetryGate = backendTemplate.nodes.find((n) => n.id === "pr-created-retry");
    expect(backendGate?.config?.expression).toContain("prNumber");
    expect(backendGate?.config?.expression).toContain("prUrl");
    expect(backendGate?.config?.expression).not.toContain("success === true");
    expect(backendRetryGate?.config?.expression).toContain("prNumber");
    expect(backendRetryGate?.config?.expression).toContain("prUrl");
    expect(backendRetryGate?.config?.expression).not.toContain("success === true");
  });

  it("task lifecycle template passes resolved executor outputs into run-agent phases", () => {
    const template = getTemplate("template-task-lifecycle");
    expect(template).toBeDefined();

    for (const phaseNodeId of ["run-agent-plan", "run-agent-tests", "run-agent-implement"]) {
      const runAgent = template.nodes.find((n) => n.id === phaseNodeId);
      expect(runAgent?.type).toBe("action.run_agent");
      expect(runAgent?.config?.sdk).toBe("{{resolvedSdk}}");
      expect(runAgent?.config?.model).toBe("{{resolvedModel}}");
      expect(runAgent?.config?.agentProfile).toBe("{{agentProfile}}");
    }
  });

  it("continuation loop template exposes configurable turn/stuck controls", () => {
    const template = getTemplate("template-continuation-loop");
    expect(template).toBeDefined();
    expect(template?.trigger).toBe("trigger.manual");

    expect(template?.variables?.maxTurns).toBe(8);
    expect(template?.variables?.terminalStates).toEqual(["done", "cancelled"]);
    expect(template?.variables?.stuckThresholdMs).toBe(300000);
    expect(template?.variables?.onStuck).toBe("escalate");

    const emitNode = template?.nodes?.find((n) => n.id === "emit-stuck");
    expect(emitNode?.type).toBe("action.emit_event");
    expect(emitNode?.config?.eventType).toBe("session-stuck");

    const routeNode = template?.nodes?.find((n) => n.id === "stuck-route");
    expect(routeNode?.type).toBe("condition.switch");
    expect(routeNode?.config?.cases?.retry).toBe("retry");
    expect(routeNode?.config?.cases?.escalate).toBe("escalate");
    expect(routeNode?.config?.cases?.pause).toBe("pause");
  });

  it("pr merge strategy template listens to review, approval, and opened aliases", () => {
    const template = getTemplate("template-pr-merge-strategy");
    expect(template).toBeDefined();

    const triggerNode = template.nodes.find((n) => n.id === "trigger");
    expect(triggerNode?.type).toBe("trigger.pr_event");
    expect(triggerNode?.config?.event).toBe("review_requested");
    expect(triggerNode?.config?.events).toEqual(["review_requested", "approved", "opened"]);
  });

  it("continuation loop template includes stuck handling and terminal-state exits", () => {
    const template = getTemplate("template-continuation-loop");
    expect(template).toBeDefined();
    expect(template?.trigger).toBe("trigger.manual");
    expect(template?.variables?.onStuck).toBe("escalate");
    expect(template?.variables?.terminalStates).toEqual(["done", "cancelled"]);

    const pollTask = template.nodes.find((n) => n.id === "poll-task");
    const captureProgress = template.nodes.find((n) => n.id === "capture-progress");
    const deriveSignature = template.nodes.find((n) => n.id === "derive-signature");
    const stuckSwitch = template.nodes.find((n) => n.id === "stuck-route");
    const endTerminal = template.nodes.find((n) => n.id === "end-terminal");
    const endMaxTurns = template.nodes.find((n) => n.id === "end-max-turns");
    const stuckEvent = template.nodes.find((n) => n.id === "emit-stuck");

    expect(pollTask?.type).toBe("action.bosun_function");
    expect(pollTask?.config?.function).toBe("tasks.get");
    expect(stuckSwitch?.type).toBe("condition.switch");
    expect(stuckEvent?.type).toBe("action.emit_event");
    expect(endTerminal?.type).toBe("flow.end");
    expect(endMaxTurns?.type).toBe("flow.end");
    expect(captureProgress?.config?.command).toContain("git status --porcelain=v1");
    expect(captureProgress?.config?.command).toContain("statusDigest");
    expect(deriveSignature?.config?.value).toContain("statusDigest");

    const loopBackEdge = template.edges.find(
      (e) => e.source === "increment-turn" && e.target === "poll-task",
    );
    expect(loopBackEdge?.backEdge).toBe(true);
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

  it("listTemplates exposes capability booleans and counts", () => {
    const list = listTemplates();
    const keys = ["branch", "join", "gate", "universal", "end"];

    for (const item of list) {
      expect(item.capabilities).toBeDefined();
      expect(item.capabilityCounts).toBeDefined();
      for (const key of keys) {
        expect(typeof item.capabilities[key]).toBe("boolean");
        expect(typeof item.capabilityCounts[key]).toBe("number");
        expect(item.capabilityCounts[key]).toBeGreaterThanOrEqual(0);
        if (!item.capabilities[key]) {
          expect(item.capabilityCounts[key]).toBe(0);
        }
      }
    }

    const hasAnyCapability = list.some((item) => keys.some((key) => item.capabilities[key]));
    expect(hasAnyCapability).toBe(true);
  });

  it("listTemplates exposes variables array with key/defaultValue/type", () => {
    const list = listTemplates();
    // At least some templates should have variables
    const withVars = list.filter((t) => t.variables && t.variables.length > 0);
    expect(withVars.length).toBeGreaterThan(0);

    for (const item of withVars) {
      for (const v of item.variables) {
        expect(typeof v.key).toBe("string");
        expect(v).toHaveProperty("defaultValue");
        expect(["text", "number", "toggle"]).toContain(v.type);
        expect(typeof v.required).toBe("boolean");
        expect(["text", "number", "toggle", "json", "select"]).toContain(v.input);
        expect(Array.isArray(v.options)).toBe(true);
      }
    }
  });

  it("listTemplates exposes trigger field from template definition", () => {
    const list = listTemplates();
    for (const item of list) {
      // trigger should be present (either string/object or null)
      expect(item).toHaveProperty("trigger");
    }
    // Find a template that has a trigger defined  
    const withTrigger = list.filter((t) => t.trigger != null);
    expect(withTrigger.length).toBeGreaterThan(0);
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
      "template-task-orphan-worktree-recovery",
      "template-task-status-transition-manager",
      // template-pr-conflict-resolver deliberately excluded — superseded by
      // template-bosun-pr-watchdog which owns conflict detection, CI checks,
      // diff-safety review, and merge in one consolidated workflow.
      "template-agent-session-monitor",
      "template-release-pipeline",
      "template-backend-agent",
      "template-incident-response",
      "template-dependency-audit",
      "template-task-archiver",
      "template-sdk-conflict-resolver",
      "template-sync-engine",
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

  it("force-updates customized workflows for selected template ids even without updateAvailable", () => {
    const installed = installTemplate("template-error-recovery", engine);
    const wf = engine.get(installed.id);
    wf.variables.customNote = "edited";
    applyWorkflowTemplateState(wf);
    wf.metadata.templateState.updateAvailable = false;
    engine.save(wf);

    const result = reconcileInstalledTemplates(engine, {
      autoUpdateUnmodified: true,
      forceUpdateTemplateIds: ["template-error-recovery"],
    });
    expect(result.autoUpdated).toBe(1);
    expect(result.forceUpdated).toEqual([wf.id]);

    const refreshed = engine.get(wf.id);
    expect(refreshed.metadata.templateState.updateAvailable).toBe(false);
    expect(refreshed.metadata.templateState.isCustomized).toBe(false);
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
  it("uses task-available triggers for batch task processing templates", () => {
    const batchProcessor = getTemplate("template-task-batch-processor");
    const batchPr = getTemplate("template-task-batch-pr");

    expect(batchProcessor?.trigger).toBe("trigger.task_available");
    expect(batchPr?.trigger).toBe("trigger.task_available");

    const batchProcessorTriggerNode = batchProcessor?.nodes?.find((node) => node.id === "trigger");
    const batchPrTriggerNode = batchPr?.nodes?.find((node) => node.id === "trigger");

    expect(batchProcessorTriggerNode?.type).toBe("trigger.task_available");
    expect(batchPrTriggerNode?.type).toBe("trigger.task_available");
  });

  it("filters batch task templates to workspace-backed backlog tasks before dispatch", () => {
    const batchProcessor = getTemplate("template-task-batch-processor");
    const batchPr = getTemplate("template-task-batch-pr");
    const queryScripts = [
      batchProcessor?.nodes?.find((node) => node.id === "query-tasks")?.config?.args?.[1],
      batchPr?.nodes?.find((node) => node.id === "query-tasks")?.config?.args?.[1],
    ];

    for (const script of queryScripts) {
      expect(script).toContain("const filtered = (tasks || []).filter((task) => {");
      expect(script).toContain('const repository = typeof task?.repository === "string" ? task.repository.trim() : "";');
      expect(script).toContain('const workspace = typeof task?.workspace === "string" ? task.workspace.trim() : "";');
      expect(script).toContain("repository.length > 0 && workspace.length > 0");
    }
  });

  it("wires batch summary notifications to the loop fan-out output", () => {
    const batchProcessor = getTemplate("template-task-batch-processor");
    const recordNode = batchProcessor?.nodes?.find((node) => node.id === "record-results");
    const notifyNode = batchProcessor?.nodes?.find((node) => node.id === "notify-complete");

    expect(recordNode?.config?.value).toBe("{{dispatch-tasks}}");
    expect(notifyNode?.config?.message).toContain("{{batchResult.successCount}}/{{batchResult.totalItems}}");
  });

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

  it("resolves workflowFirst profile by id without falling back", () => {
    const profile = getWorkflowSetupProfile("workflowFirst");
    expect(profile.id).toBe("workflowFirst");
    expect(profile.templateIds).toContain("template-task-lifecycle");
  });

  it("resolveWorkflowTemplateIds accepts workflowFirst profile id", () => {
    const resolved = resolveWorkflowTemplateIds({ profileId: "workflowFirst" });
    expect(resolved).toContain("template-task-lifecycle");
    expect(resolved).toContain("template-task-batch-processor");
  });

  it("resolves typed workflows into template ids and overrides", () => {
    const resolved = resolveWorkflowTemplateIds({
      profileId: "manual",
      workflows: [
        {
          type: "continuation-loop",
          enabled: true,
          maxTurns: "6",
          terminalStates: "done,cancelled",
          onStuck: "pause",
        },
      ],
    });

    expect(resolved).toContain("template-continuation-loop");

    const config = resolveWorkflowTemplateConfig([
      {
        type: "continuation-loop",
        enabled: true,
        worktreePath: "/tmp/worktree/task-1",
        maxTurns: "6",
        terminalStates: "done,cancelled",
        onStuck: "pause",
        sdk: "copilot",
        model: "claude-opus-4.6",
        timeoutMs: "900000",
      },
    ]);
    expect(config.templateIds).toEqual(["template-continuation-loop"]);
    expect(config.overridesById["template-continuation-loop"]).toEqual({
      worktreePath: "/tmp/worktree/task-1",
      maxTurns: 6,
      terminalStates: ["done", "cancelled"],
      onStuck: "pause",
      sdk: "copilot",
      model: "claude-opus-4.6",
      timeoutMs: 900000,
    });
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

  it("normalizes template overrides by selected template ids and variable types", () => {
    const normalized = normalizeTemplateOverridesById(
      {
        "template-anomaly-watchdog": {
          stallThresholdMs: "600000",
          notifyOnStall: "false",
          ignored: "value",
        },
        "template-nope": {
          anything: "goes",
        },
      },
      ["template-anomaly-watchdog"],
    );

    expect(normalized).toEqual({
      "template-anomaly-watchdog": {
        stallThresholdMs: 600000,
      },
    });
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
    // error-recovery auto-installs task-repair-worktree (grouped flow).
    // installTemplateSet sees the child as already installed → skips it.
    // So installed=2 (error-recovery, task-planner), skipped=1 (task-repair-worktree), errors=1.
    expect(result.installed.length).toBe(2);
    expect(result.skipped.length).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].id).toBe("template-nope");
    // Verify all 3 valid templates are actually present in the engine
    const all = engine.list();
    expect(all.length).toBe(3);

    const second = installTemplateSet(engine, [
      "template-error-recovery",
      "template-task-planner",
    ]);
    expect(second.installed.length).toBe(0);
    // error-recovery expands to include task-repair-worktree, so 3 skipped
    expect(second.skipped.length).toBe(3);
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
  it("PR watchdog queues auto-merge after review instead of waiting for a later pass", () => {
    const watchdogTemplate = getTemplate("template-bosun-pr-watchdog");
    const fetchNode = watchdogTemplate.nodes.find((n) => n.id === "fetch-and-classify");
    const reviewNode = watchdogTemplate.nodes.find((n) => n.id === "programmatic-review");

    expect(fetchNode?.config?.command).toContain("pendingChecks:hasPend");
    expect(reviewNode?.config?.command).toContain("mergeArgs.push('--auto')");
    expect(reviewNode?.config?.command).toContain("reason:'ci_failed'");
    expect(reviewNode?.config?.command).toContain("reason:'ci_pending'");
    expect(reviewNode?.config?.command).toContain("--json','name,state,bucket'");
    expect(reviewNode?.config?.command).not.toContain("name,state,conclusion");
  });

  it("PR watchdog and GitHub sync pass node outputs via template interpolation env vars", () => {
    const watchdogTemplate = getTemplate("template-bosun-pr-watchdog");
    const syncTemplate = getTemplate("template-github-kanban-sync");

    const watchdogFixNode = watchdogTemplate.nodes.find((n) => n.id === "programmatic-fix");
    const watchdogReviewNode = watchdogTemplate.nodes.find((n) => n.id === "programmatic-review");
    const syncNode = syncTemplate.nodes.find((n) => n.id === "sync-programmatic");
    const syncCommand = syncNode?.config?.command || "";

    expect(watchdogFixNode?.config?.env?.BOSUN_FETCH_AND_CLASSIFY)
      .toBe("{{$ctx.getNodeOutput('fetch-and-classify')?.output || '{}'}}");
    expect(watchdogReviewNode?.config?.env?.BOSUN_FETCH_AND_CLASSIFY)
      .toBe("{{$ctx.getNodeOutput('fetch-and-classify')?.output || '{}'}}");
    expect(syncNode?.config?.env?.BOSUN_FETCH_PR_STATE)
      .toBe("{{$ctx.getNodeOutput('fetch-pr-state')?.output || '{}'}}");
    expect(syncCommand).toContain("reviewStatus");
    expect(syncCommand).toContain("changes_requested_pending_fix");    expect(syncCommand).toContain("local_progress_state");
    expect(syncCommand).toContain("parseJsonObject(raw)");
    expect(syncCommand).toContain("const task=parseJsonObject(raw)");
    expect(syncCommand).toContain("current==='todo'||current==='inprogress'");
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
    await import("../workflow/workflow-nodes.mjs");
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
    expect(withReplaces.length).toBeGreaterThanOrEqual(14);

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


