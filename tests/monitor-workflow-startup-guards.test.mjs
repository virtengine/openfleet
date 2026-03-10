import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("monitor workflow startup guards", () => {
  const monitorSource = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");

  it("initializes workflow automation before runtime subsystems in non-test mode", () => {
    expect(monitorSource).toContain("if (!isMonitorTestRuntime) {");
    expect(monitorSource).toContain("await ensureWorkflowAutomationEngine().catch(() => {});");
    expect(monitorSource).toContain("// ── Task Management Subsystem Initialization");
    expect(
      monitorSource.indexOf("await ensureWorkflowAutomationEngine().catch(() => {});"),
    ).toBeLessThan(
      monitorSource.indexOf("// ── Task Management Subsystem Initialization"),
    );
  });

  it("disables self-restart watcher by default for internal and hybrid executor modes", () => {
    expect(monitorSource).toContain("function isSelfRestartWatcherEnabled()");
    expect(monitorSource).toContain('toLowerCase() === "internal"');
    expect(monitorSource).toContain('toLowerCase() === "hybrid"');
    expect(monitorSource).toContain(
      "Auto self-restart from file churn causes unnecessary restart storms.",
    );
  });

  it("wires task-store start guards into workflow automation services", () => {
    expect(monitorSource).toContain("taskStore: {");
    expect(monitorSource).toContain("canStartTask,");
  });

  it("auto-disables stale task-batch-pr workflows when workflowDefaults no longer request them", () => {
    expect(monitorSource).toContain('import("../workflow/workflow-templates.mjs")');
    expect(monitorSource).toContain('const staleWorkflowTemplateIds = ["template-task-batch-pr"]');
    expect(monitorSource).toContain("workflowTemplates.resolveWorkflowTemplateIds({");
    expect(monitorSource).toContain("requestedTemplateIds.has(installedFrom)");
    expect(monitorSource).toContain("auto-disabled stale workflow");
  });

  it("kicks schedule-driven workflow polling immediately when workflow lifecycle owns dispatch", () => {
    expect(monitorSource).toContain("let pollWorkflowSchedulesOnce = async () => {};");
    expect(
      monitorSource.indexOf("let pollWorkflowSchedulesOnce = async () => {}"),
    ).toBeLessThan(
      monitorSource.indexOf('"stale-dispatch-unstick"'),
    );
    expect(monitorSource).toContain('pollWorkflowSchedulesOnce = async function pollWorkflowSchedulesOnce(');
    expect(monitorSource).toContain('const includeTaskPoll = opts?.includeTaskPoll !== false;');
    expect(monitorSource).not.toContain('_lastRunAt: Date.now()');
    expect(monitorSource).toContain('if (triggerNode?.type === "trigger.task_available" || triggerNode?.type === "trigger.task_low") {');
    expect(monitorSource).toContain('"stale-dispatch-unstick"');
    expect(monitorSource).toContain('"stale-dispatch-task-poll-unstick"');
    expect(monitorSource).toContain('throwOnError: true');
    expect(monitorSource).toContain('requireEngine: true');
    expect(
      monitorSource.indexOf('internalTaskExecutor.start();'),
    ).toBeLessThan(
      monitorSource.indexOf('"stale-dispatch-task-poll-unstick"'),
    );
  });

  it("kicks non-task schedule polling during workflow automation startup", () => {
    expect(
      monitorSource.indexOf('await ensureWorkflowAutomationEngine().catch(() => {});'),
    ).toBeLessThan(
      monitorSource.indexOf('"stale-dispatch-unstick"'),
    );
  });

  it("defines bounded workflow recovery policy and structured telemetry", () => {
    expect(monitorSource).toContain("const DEFAULT_WORKFLOW_RECOVERY_POLICY = Object.freeze({");
    expect(monitorSource).toContain("function normalizeWorkflowRecoveryPolicy(candidate = {})");
    expect(monitorSource).toContain("applyWorkflowRecoveryPolicy(configWorkflowRecovery, \"startup-config\")");
    expect(monitorSource).toContain("applyWorkflowRecoveryPolicy(");
    expect(monitorSource).toContain("emitWorkflowRecoveryTelemetry(\"policy_updated\"");
    expect(monitorSource).toContain("emitWorkflowRecoveryTelemetry(\"attempt\"");
    expect(monitorSource).toContain("emitWorkflowRecoveryTelemetry(\"suppressed\"");
    expect(monitorSource).toContain("emitWorkflowRecoveryTelemetry(\"retry_scheduled\"");
    expect(monitorSource).toContain("emitWorkflowRecoveryTelemetry(\"escalated\"");
    expect(monitorSource).toContain("component: \"monitor.workflow-recovery\"");
  });

  it("runs workflow-history unstick through the same bounded self-healing policy", () => {
    expect(monitorSource).toContain('"workflow-history-unstick"');
    expect(monitorSource).toContain("engine?.resumeInterruptedRuns");
  });

  it("requires npm start lifecycle for dev-mode self-restart watcher by default", () => {
    expect(monitorSource).toContain("process.env.npm_lifecycle_event");
    expect(monitorSource).toContain('npmLifecycleEvent === "start"');
    expect(monitorSource).toContain('npmLifecycleEvent.startsWith("start:")');
    expect(monitorSource).toContain(
      "CLI command mode in source checkout",
    );
  });
  it("uses BOSUN_PROMPT_PLANNER path before workspace-root planner fallback", () => {
    expect(monitorSource).toContain("process.env.BOSUN_PROMPT_PLANNER");
    expect(monitorSource).toContain("BOSUN_PROMPT_PLANNER=");
  });

  it("guards backend task-id resolution against unresolved template tokens", () => {
    expect(monitorSource).toContain("function hasUnresolvedTemplateToken(value)");
    expect(monitorSource).toContain("if (!rawId || hasUnresolvedTemplateToken(rawId)) return null;");
  });

  it("lets explicit review-agent env override workflow replacement", () => {
    expect(
      monitorSource.indexOf("const explicit = process.env.INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED;"),
    ).toBeLessThan(
      monitorSource.indexOf("if (isWorkflowReplacingModule(\"review-agent.mjs\")) return false;"),
    );
  });

  it("resets stale inreview tasks without PR metadata during review-agent rehydrate", () => {
    expect(monitorSource).toContain("const hasReviewReference = Boolean(prUrl || prNumber || branchName);");
    expect(monitorSource).toContain(
      "review rehydrate reset ${taskId} to todo: missing prUrl/prNumber/branchName",
    );
    expect(monitorSource).toContain("setInternalTaskStatus(taskId, \"todo\", \"review-agent-rehydrate\")");
    expect(monitorSource).toContain("await updateTaskStatus(taskId, \"todo\");");
  });

});
