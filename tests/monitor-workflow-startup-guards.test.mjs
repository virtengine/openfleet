import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("monitor workflow startup guards", () => {
  const monitorSource = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

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
});

