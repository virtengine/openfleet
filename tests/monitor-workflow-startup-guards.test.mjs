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

  it("kicks schedule-driven workflow polling immediately when workflow lifecycle owns dispatch", () => {
    expect(monitorSource).toContain("let pollWorkflowSchedulesOnce = async () => {};");
    expect(
      monitorSource.indexOf("let pollWorkflowSchedulesOnce = async () => {}"),
    ).toBeLessThan(
      monitorSource.indexOf('void pollWorkflowSchedulesOnce("startup", { includeTaskPoll: false }).catch((err) => {'),
    );
    expect(monitorSource).toContain('pollWorkflowSchedulesOnce = async function pollWorkflowSchedulesOnce(');
    expect(monitorSource).toContain('const includeTaskPoll = opts?.includeTaskPoll !== false;');
    expect(monitorSource).toContain('if (triggerNode?.type === "trigger.task_available" || triggerNode?.type === "trigger.task_low") {');
    expect(monitorSource).toContain('void pollWorkflowSchedulesOnce("startup", { includeTaskPoll: false }).catch((err) => {');
    expect(monitorSource).toContain('void pollWorkflowSchedulesOnce("startup").catch((err) => {');
    expect(
      monitorSource.indexOf('internalTaskExecutor.start();'),
    ).toBeLessThan(
      monitorSource.indexOf('void pollWorkflowSchedulesOnce("startup").catch((err) => {'),
    );
  });

  it("kicks non-task schedule polling during workflow automation startup", () => {
    expect(
      monitorSource.indexOf('await ensureWorkflowAutomationEngine().catch(() => {});'),
    ).toBeLessThan(
      monitorSource.indexOf('void pollWorkflowSchedulesOnce("startup", { includeTaskPoll: false }).catch((err) => {'),
    );
  });

  it("requires npm start lifecycle for dev-mode self-restart watcher by default", () => {
    expect(monitorSource).toContain("process.env.npm_lifecycle_event");
    expect(monitorSource).toContain('npmLifecycleEvent === "start"');
    expect(monitorSource).toContain('npmLifecycleEvent.startsWith("start:")');
    expect(monitorSource).toContain(
      "CLI command mode in source checkout",
    );
  });
  it("guards backend task-id resolution against unresolved template tokens", () => {
    expect(monitorSource).toContain("function hasUnresolvedTemplateToken(value)");
    expect(monitorSource).toContain("if (!rawId || hasUnresolvedTemplateToken(rawId)) return null;");
  });

});
