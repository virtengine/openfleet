import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

describe("async safety guards", () => {
  const monitorSource = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  const analyzerSource = readFileSync(
    resolve(process.cwd(), "agent-work-analyzer.mjs"),
    "utf8",
  );
  const poolSource = readFileSync(resolve(process.cwd(), "agent-pool.mjs"), "utf8");
  const updateSource = readFileSync(resolve(process.cwd(), "update-check.mjs"), "utf8");

  it("handles monitor failure promises with explicit catch guards", () => {
    expect(monitorSource).toContain(
      'handleMonitorFailure("uncaughtException", err).catch((failureErr) => {',
    );
    expect(monitorSource).toContain(
      'handleMonitorFailure("unhandledRejection", err).catch((failureErr) => {',
    );
    expect(monitorSource).toContain(
      'handleMonitorFailure(reason, error).catch((failureErr) => {',
    );
  });

  it("guards agent-work-analyzer stuck sweep interval", () => {
    expect(analyzerSource).toContain("runStuckSweep().catch((err) => {");
  });

  it("guards agent-pool fire-and-forget registry operations", () => {
    expect(poolSource).toContain(
      "ensureThreadRegistryLoaded().catch((err) => {",
    );
    expect(poolSource).toContain(
      "invalidateThreadAsync(taskKey).catch((err) => {",
    );
  });

  it("guards auto-update poll scheduling", () => {
    expect(updateSource).toContain("const runPollSafely = () => {");
    expect(updateSource).toContain(
      "autoUpdateTimer = setInterval(runPollSafely, intervalMs);",
    );
    expect(updateSource).not.toContain(
      "autoUpdateTimer = setInterval(() => void poll(), intervalMs);",
    );
  });

  it("guards monitor detached scheduler callbacks", () => {
    expect(monitorSource).toContain('runDetached("agent-alerts:poll"');
    expect(monitorSource).toContain('runDetached("task-planner-status:interval"');
    expect(monitorSource).toContain('runDetached("telegram-notifier:tick"');
    expect(monitorSource).toContain('runDetached("vk-recovery:network"');
    expect(monitorSource).toContain('runDetached("vk-session-discovery:periodic"');
    expect(monitorSource).toContain('runDetached("merge-strategy:wait-recheck"');
    expect(monitorSource).toContain('runDetached("task-assessment:recheck"');
    expect(monitorSource).toContain('runDetached("config-reload:env-change"');
    expect(monitorSource).toContain('runDetached("start-process:hard-cap-retry"');
    expect(monitorSource).not.toContain('void pollAgentAlerts()');
    expect(monitorSource).not.toContain('void publishTaskPlannerStatus("interval")');
    expect(monitorSource).not.toContain('void triggerVibeKanbanRecovery(');
    expect(monitorSource).not.toContain('void refreshVkSessionStreams("startup")');
    expect(monitorSource).not.toContain('void refreshVkSessionStreams("periodic")');
    expect(monitorSource).not.toContain('void startProcess()');
    expect(monitorSource).not.toContain('void startVibeKanbanProcess()');
    expect(monitorSource).not.toContain("      setTimeout(\n        () => {\n          void runMergeStrategyAnalysis({");
    expect(monitorSource).not.toContain("      setTimeout(() => {\n        void runTaskAssessment({");
    expect(monitorSource).not.toContain('void reloadConfig(reason || "env-change")');
  });
});


